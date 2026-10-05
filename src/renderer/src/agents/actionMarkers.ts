/**
 * What a Dark Mechanicus tool call becomes in a chat, free of React: a compact marker such as "claimed
 * DM-12", "accepted DM-12" or "sprint report filed" that opens the ticket or epic it is about. The calls
 * are known by the names the adapters give them: `mcp__darkmechanicus__<tool>` (Claude) and
 * `darkmechanicus.<tool>` (Codex).
 *
 * What a call is about comes from what it carries. Its input names ids (`ticketId`, `attemptId`,
 * `runId`, `epicId`), each taken only as a whole id; a call the server answered may also name them, and a
 * ticket key, in its result, which counts only when it names exactly one of that kind (a result cut at
 * 500 characters is still read, as text). The input wins over the result. Which ticket an attempt or run
 * belongs to is not known here: the marker resolves the key and the epic through the desktop's read
 * commands (`chatLookup`), and says "a ticket" until it has. The text of a marker is made of the phrases
 * below and a ticket key, never of an input or a claim token.
 */
import { maskClaimTokens } from '../../../core/claimTokenMask'
import type { ChatItem } from '../../../shared/agents/chat'

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>

/** What a call is about, as far as the call itself says; every part is null when it does not say. */
export interface MarkerTarget {
  epicId: string | null
  runId: string | null
  ticketId: string | null
  attemptId: string | null
  /** A display key such as DM-12. */
  ticketKey: string | null
}

export interface MarkerModel {
  /** The tool without its server prefix, e.g. `claim_ticket`. */
  tool: string
  status: ToolCallItem['status']
  target: MarkerTarget
}

const DARK_MECHANICUS_TOOL = /^(?:mcp__darkmechanicus__|darkmechanicus\.)([a-z_]+)$/

const ID_BODY = '[0-9a-hjkmnp-tv-z]{26}'
/** Not part of a longer word on either side; a claim token's dot and secret may follow, and are never read. */
const BEFORE = '(?<![A-Za-z0-9_])'
const AFTER = '(?![A-Za-z0-9_])'
const KEY = /"key"\s*:\s*"([A-Z][A-Z0-9]*-\d+)"/g

type IdKind = 'ticketId' | 'attemptId' | 'runId' | 'epicId'

const PREFIX: Readonly<Record<IdKind, string>> = { ticketId: 'tk', attemptId: 'at', runId: 'rn', epicId: 'ep' }
const EXACT: Readonly<Record<IdKind, RegExp>> = {
  ticketId: new RegExp(`^${PREFIX.ticketId}_${ID_BODY}$`),
  attemptId: new RegExp(`^${PREFIX.attemptId}_${ID_BODY}$`),
  runId: new RegExp(`^${PREFIX.runId}_${ID_BODY}$`),
  epicId: new RegExp(`^${PREFIX.epicId}_${ID_BODY}$`)
}
const WITHIN: Readonly<Record<IdKind, RegExp>> = {
  ticketId: new RegExp(`${BEFORE}${PREFIX.ticketId}_${ID_BODY}${AFTER}`, 'g'),
  attemptId: new RegExp(`${BEFORE}${PREFIX.attemptId}_${ID_BODY}${AFTER}`, 'g'),
  runId: new RegExp(`${BEFORE}${PREFIX.runId}_${ID_BODY}${AFTER}`, 'g'),
  epicId: new RegExp(`${BEFORE}${PREFIX.epicId}_${ID_BODY}${AFTER}`, 'g')
}

function exactId(value: unknown, kind: IdKind): string | null {
  return typeof value === 'string' && EXACT[kind].test(value) ? value : null
}

/** The one distinct match in a text; null for none or several, because a wrong ticket is worse than none. */
function onlyMatch(text: string | null, pattern: RegExp, group = 0): string | null {
  if (text === null) {
    return null
  }
  const found = new Set([...text.matchAll(pattern)].map((match) => match[group] ?? ''))
  return found.size === 1 ? ([...found][0] ?? null) : null
}

function idOf(call: ToolCallItem, kind: IdKind): string | null {
  const fromInput = exactId(call.input[kind], kind)
  if (fromInput !== null || call.status !== 'completed') {
    return fromInput
  }
  return onlyMatch(call.resultSummary, WITHIN[kind])
}

/** Whether a tool is one of the Dark Mechanicus server's, however the agent names it. */
export function isActionTool(name: string): boolean {
  return DARK_MECHANICUS_TOOL.test(name)
}

/** The marker of a Dark Mechanicus call; null for any other call. */
export function actionMarker(call: ToolCallItem): MarkerModel | null {
  const tool = DARK_MECHANICUS_TOOL.exec(call.name)?.[1]
  if (tool === undefined) {
    return null
  }
  const target: MarkerTarget = {
    epicId: idOf(call, 'epicId'),
    runId: idOf(call, 'runId'),
    ticketId: idOf(call, 'ticketId'),
    attemptId: idOf(call, 'attemptId'),
    ticketKey: call.status === 'completed' ? onlyMatch(call.resultSummary, KEY, 1) : null
  }
  return { tool, status: call.status, target }
}

/** How a tool reads while it runs, once it is done, and when it was refused or denied; `{ticket}` is the ticket's key. */
interface Phrases {
  doing: string
  done: string
  failed: string
}

const PHRASES: Readonly<Record<string, Phrases>> = {
  start_run: { doing: 'starting the run', done: 'started the run', failed: 'could not start the run' },
  takeover_run: { doing: 'taking over the run', done: 'took over the run', failed: 'could not take over the run' },
  pause_run: { doing: 'pausing the run', done: 'paused the run', failed: 'could not pause the run' },
  resume_run: { doing: 'resuming the run', done: 'resumed the run', failed: 'could not resume the run' },
  cancel_run: { doing: 'canceling the run', done: 'canceled the run', failed: 'could not cancel the run' },
  claim_ticket: { doing: 'claiming {ticket}', done: 'claimed {ticket}', failed: 'could not claim {ticket}' },
  heartbeat_attempt: { doing: 'heartbeat for {ticket}', done: 'heartbeat for {ticket}', failed: 'heartbeat for {ticket} refused' },
  submit_attempt: { doing: 'submitting {ticket}', done: 'submitted {ticket}', failed: 'could not submit {ticket}' },
  fail_attempt: { doing: 'failing {ticket}', done: 'marked {ticket} failed', failed: 'could not fail {ticket}' },
  accept_attempt: { doing: 'accepting {ticket}', done: 'accepted {ticket}', failed: 'could not accept {ticket}' },
  reject_attempt: { doing: 'rejecting {ticket}', done: 'rejected {ticket}', failed: 'could not reject {ticket}' },
  reconcile_attempt: { doing: 'reconciling {ticket}', done: 'reconciled {ticket}', failed: 'could not reconcile {ticket}' },
  carry_forward_ticket: { doing: 'carrying forward {ticket}', done: 'carried forward {ticket}', failed: 'could not carry forward {ticket}' },
  record_row_check: { doing: 'recording a row check', done: 'recorded a row check', failed: 'could not record a row check' },
  get_ready_tickets: { doing: 'listing the ready tickets', done: 'listed the ready tickets', failed: 'could not list the ready tickets' },
  submit_sprint_report: { doing: 'filing the sprint report', done: 'sprint report filed', failed: 'sprint report refused' },
  get_checkpoint: { doing: 'reading the checkpoint', done: 'read the checkpoint', failed: 'could not read the checkpoint' },
  advance_sprint: { doing: 'advancing the sprint', done: 'advanced the sprint', failed: 'could not advance the sprint' },
  redraft_next_sprint: { doing: 'redrafting the next sprint', done: 'redrafted the next sprint', failed: 'could not redraft the next sprint' }
}

/** A tool with no phrase of its own reads as its name: "list epics". */
function plainPhrases(tool: string): Phrases {
  const words = tool.replaceAll('_', ' ')
  return { doing: `${words}…`, done: words, failed: `${words} failed` }
}

/** The marker's words for a call in `status`; a null key says "a ticket", which is all a marker may say of a ticket it cannot name. */
export function markerText(marker: Pick<MarkerModel, 'tool' | 'status'>, ticketKey: string | null): string {
  const phrases = PHRASES[marker.tool] ?? plainPhrases(marker.tool)
  const phrase = marker.status === 'running' ? phrases.doing : marker.status === 'completed' ? phrases.done : phrases.failed
  return phrase.replace('{ticket}', ticketKey ?? 'a ticket')
}

const MAX_DETAIL = 140

/** The server's own words for why a call was refused (its error message, else the first line of the result), masked and cut short; null when the call did not fail. */
export function failureDetail(call: ToolCallItem): string | null {
  if ((call.status !== 'failed' && call.status !== 'denied') || call.resultSummary === null) {
    return null
  }
  const text = maskClaimTokens(errorMessageOf(call.resultSummary) ?? call.resultSummary)
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') {
    return null
  }
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text
}

/** `error.message` of a JSON result such as `{"ok":false,"error":{"code":"stale_claim","message":"..."}}`; null for anything else. */
function errorMessageOf(result: string): string | null {
  try {
    const parsed: unknown = JSON.parse(result)
    const error = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined
    const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined
    return typeof message === 'string' ? message : null
  } catch {
    return null
  }
}
