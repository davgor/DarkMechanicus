/**
 * The live chamber's feed (pure): consecutive run snapshots and the run's pipeline entries become chamber events,
 * each exactly once. A snapshot is compared with the facts the feed last took from one, so the same snapshot (or an
 * older poll of the same facts) adds nothing. A pipeline entry is handled once by its `seq`; an entry sent before the
 * feed started is history and never animates, however many pages it takes to arrive. Starting a feed shows the run as
 * it is now: its acolytes, who works, the run state and flags, with no bubble and no pipeline effect.
 *
 * Main records an `order_all` in the same step as its messages (`CultPipeline.exclusive`), so the pipeline never
 * serves an order's messages alone; an order comes as one entry and one `orderSent` to all.
 */
import type { CultPipelineEntry, CultRunDetail, PipelineMember } from '../../../../shared/cults/cultApi'
import type { RunState } from '../../../../shared/cults/runState'
import { remainingMs } from '../../../../shared/cults/runState'
import { activityLine, drawQuip, mailLine, quipDue, type QuipTimer } from './bubbleLines'
import { MAGOS_ID, type ChamberEvent } from './chamberState'

type ChamberRunState = Extract<ChamberEvent, { type: 'runState' }>['runState']

/** A timed run with less than this left shows the last-minute warning. */
export const LAST_MINUTE_MS = 60_000

const CHAMBER_STATE: Readonly<Record<RunState, ChamberRunState>> = {
  starting: 'running',
  running: 'running',
  paused: 'paused',
  shutting_down: 'ending',
  ended: 'ended'
}

/** What the chamber shows of one live acolyte: whether it works, and its last tool call as a key. */
interface AcolyteFacts {
  working: boolean
  tool: string | null
}

/** What of a snapshot the chamber shows. */
interface RoomFacts {
  runState: ChamberRunState
  acolytes: ReadonlyMap<string, AcolyteFacts>
  magosBusy: boolean
  petition: boolean
  lastMinute: boolean
}

export interface ChamberFeed {
  facts: RoomFacts
  /** The highest pipeline `seq` handled; entries at or below it are never handled again. */
  seq: number
  /** When the feed started (ms): a pipeline entry sent earlier is history. */
  since: number
  /** Each idle acolyte's quip timing. */
  quips: ReadonlyMap<string, QuipTimer>
  randomState: number
}

/** The latest run snapshot, the run's pipeline entries in `seq` order (`useCultPipeline`) and the time (ms). */
export interface FeedInput {
  run: CultRunDetail
  entries: readonly CultPipelineEntry[]
  now: number
}

interface FeedStep {
  feed: ChamberFeed
  events: ChamberEvent[]
}

const toolKey = (tool: { name: string; target: string } | null): string | null =>
  tool === null ? null : `${tool.name}\u0000${tool.target}`

function chamberRunState(run: CultRunDetail['run']): ChamberRunState {
  const state = CHAMBER_STATE[run.state]
  return state === 'ended' && run.endReason === 'killed' ? 'killed' : state
}

/** A timed run under a minute from its limit, until it ends; never an unlimited one. */
function inLastMinute(run: CultRunDetail['run'], now: number): boolean {
  if (run.state === 'ended' || run.state === 'shutting_down') return false
  const left = remainingMs(run, new Date(now).toISOString())
  return left !== null && left < LAST_MINUTE_MS
}

function factsOf(run: CultRunDetail, now: number): RoomFacts {
  const live = run.members.filter((member) => member.leftAt === null)
  const magos = live.find((member) => member.role === 'magos')
  const acolytes = live.filter((member) => member.role === 'acolyte').map((member): [string, AcolyteFacts] =>
    [member.chatId, { working: member.activity?.working === true, tool: toolKey(member.activity?.tool ?? null) }])
  return {
    runState: chamberRunState(run.run),
    acolytes: new Map(acolytes),
    magosBusy: magos?.activity?.working === true,
    petition: run.petitions.some((petition) => petition.state === 'pending'),
    lastMinute: inLastMinute(run.run, now)
  }
}

const NO_FACTS: RoomFacts = { runState: 'idle', acolytes: new Map(), magosBusy: false, petition: false, lastMinute: false }

function rosterEvents(before: RoomFacts, after: RoomFacts): ChamberEvent[] {
  const left = [...before.acolytes.keys()].filter((id) => !after.acolytes.has(id))
  const joined = [...after.acolytes.keys()].filter((id) => !before.acolytes.has(id))
  const working = [...after.acolytes].filter(([id, facts]) => (before.acolytes.get(id)?.working ?? false) !== facts.working)
  return [
    ...left.map((id): ChamberEvent => ({ type: 'memberLeft', id })),
    ...joined.map((id): ChamberEvent => ({ type: 'memberJoined', id })),
    ...working.map(([id, facts]): ChamberEvent => ({ type: 'working', id, on: facts.working }))
  ]
}

/** A bubble for each acolyte whose last tool call changed. */
function activityEvents(before: RoomFacts, run: CultRunDetail): ChamberEvent[] {
  return run.members.flatMap((member): ChamberEvent[] => {
    const tool = member.activity?.tool ?? null
    if (member.role !== 'acolyte' || member.leftAt !== null || tool === null) return []
    if (before.acolytes.get(member.chatId)?.tool === toolKey(tool)) return []
    return [{ type: 'bubble', id: member.chatId, text: activityLine(tool) }]
  })
}

function flagEvents(before: RoomFacts, after: RoomFacts): ChamberEvent[] {
  const events: ChamberEvent[] = []
  if (before.magosBusy !== after.magosBusy) events.push({ type: 'magosBusy', on: after.magosBusy })
  if (before.petition !== after.petition) events.push({ type: 'petitionPending', on: after.petition })
  if (before.lastMinute !== after.lastMinute) events.push({ type: 'lastMinute', on: after.lastMinute })
  return events
}

/** The events from what the chamber showed to `after`, with a bubble for each acolyte whose last tool call changed. */
function snapshotEvents(before: RoomFacts, after: RoomFacts, run: CultRunDetail): ChamberEvent[] {
  const state: ChamberEvent[] = before.runState === after.runState ? [] : [{ type: 'runState', runState: after.runState }]
  return [...state, ...rosterEvents(before, after), ...activityEvents(before, run), ...flagEvents(before, after)]
}


/** The packet a message sends: an order, a report or peer mail. */
function mailEvent(entry: CultPipelineEntry, from: PipelineMember, to: PipelineMember): ChamberEvent | null {
  if (from.role === 'magos') return to.role === 'magos' ? null : { type: 'orderSent', to: to.chatId, orderId: `seq:${entry.seq}` }
  if (to.role === 'magos') return { type: 'reportSent', from: from.chatId }
  return from.chatId === to.chatId ? null : { type: 'peerMail', from: from.chatId, to: to.chatId }
}

/** One entry's events: its packet (one ring for an order to all), and its sender's bubble with the first line. */
function entryEvents(entry: CultPipelineEntry): ChamberEvent[] {
  const from = entry.sender
  const to = entry.recipients[0]
  if (entry.kind === 'event' || from === null || to === undefined) return []
  const packet: ChamberEvent | null = entry.kind === 'order_all'
    ? { type: 'orderSent', to: 'all', orderId: entry.orderId ?? `seq:${entry.seq}` } : mailEvent(entry, from, to)
  if (packet === null) return []
  const line = mailLine(entry.text)
  const speaker = from.role === 'magos' ? MAGOS_ID : from.chatId
  return line === null ? [packet] : [{ type: 'bubble', id: speaker, text: line }, packet]
}

/** The entries after `seq`, oldest first; the list is in `seq` order, so only its tail is read. */
function freshEntries(entries: readonly CultPipelineEntry[], seq: number): CultPipelineEntry[] {
  let start = entries.length
  while (start > 0 && entries[start - 1]!.seq > seq) start -= 1
  return entries.slice(start)
}

function pipelineEvents(feed: ChamberFeed, entries: readonly CultPipelineEntry[]): { seq: number; events: ChamberEvent[] } {
  const fresh = freshEntries(entries, feed.seq)
  const events = fresh.filter((entry) => Date.parse(entry.at) >= feed.since).flatMap(entryEvents)
  return { seq: fresh.at(-1)?.seq ?? feed.seq, events }
}

/** Idle timing for each live acolyte: it starts when the acolyte is first seen idle and stops while it works. */
function idleTimers(quips: ReadonlyMap<string, QuipTimer>, facts: RoomFacts, now: number): Map<string, QuipTimer> {
  return new Map([...facts.acolytes].map(([id, { working }]): [string, QuipTimer] => {
    const timer = quips.get(id) ?? { idleSince: null, lastQuipAt: null }
    return [id, { ...timer, idleSince: working ? null : (timer.idleSince ?? now) }]
  }))
}

/** A quip for each acolyte idle long enough and not quipping lately, while the run is running. */
function quipEvents(feed: ChamberFeed, now: number): { feed: ChamberFeed; events: ChamberEvent[] } {
  if (feed.facts.runState !== 'running') return { feed, events: [] }
  const quips = new Map(feed.quips)
  const events: ChamberEvent[] = []
  let { randomState } = feed
  for (const [id, timer] of quips) {
    if (!quipDue(timer, now)) continue
    const [text, next] = drawQuip(randomState)
    randomState = next
    quips.set(id, { ...timer, lastQuipAt: now })
    events.push({ type: 'bubble', id, text })
  }
  return { feed: { ...feed, quips, randomState }, events }
}

/**
 * A feed for the run as it is now (its pipeline so far is history), with the events that show it: each acolyte already
 * in the room (no beam), who works, then the run state and flags.
 */
export function startFeed({ run, entries, now }: FeedInput, seed: number): FeedStep {
  const facts = factsOf(run, now)
  const feed: ChamberFeed = {
    facts, seq: entries.at(-1)?.seq ?? 0, since: now, quips: idleTimers(new Map(), facts, now),
    randomState: Math.floor(Number.isFinite(seed) ? seed : 0) | 0
  }
  const present = [...facts.acolytes].flatMap(([id, { working }]): ChamberEvent[] =>
    [{ type: 'memberJoined', id, present: true }, ...(working ? [{ type: 'working' as const, id, on: true }] : [])])
  const state: ChamberEvent = { type: 'runState', runState: facts.runState }
  return { feed, events: [...present, state, ...flagEvents(NO_FACTS, facts)] }
}

/** The events new since `feed`: the snapshot's changes, new pipeline entries, then any quip that is due. */
export function advanceFeed(feed: ChamberFeed, { run, entries, now }: FeedInput): FeedStep {
  const facts = factsOf(run, now)
  const snapshot = snapshotEvents(feed.facts, facts, run)
  const pipeline = pipelineEvents(feed, entries)
  const quipped = quipEvents({ ...feed, facts, seq: pipeline.seq, quips: idleTimers(feed.quips, facts, now) }, now)
  return { feed: quipped.feed, events: [...snapshot, ...pipeline.events, ...quipped.events] }
}
