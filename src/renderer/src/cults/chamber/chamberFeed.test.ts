import { describe, expect, it } from 'vitest'
import type { CultMemberDetail, CultPipelineEntry, CultRunDetail, PipelineMember } from '../../../../shared/cults/cultApi'
import { memberDetail, runDetail } from '../../__mocks__/fakeCults'
import { IDLE_QUIPS } from './bubbleLines'
import { advanceFeed, LAST_MINUTE_MS, startFeed, type ChamberFeed, type FeedInput } from './chamberFeed'
import { MAGOS_ID, type ChamberEvent } from './chamberState'

/** The feed opens at 12:10, ten minutes into a 30-minute run. */
const T0 = Date.parse('2026-11-27T12:10:00.000Z')
const at = (ms: number): string => new Date(T0 + ms).toISOString()

const MAGOS = memberDetail()
const idle = (chatId: string, joined: number): CultMemberDetail => memberDetail({
  chatId, role: 'acolyte', displayName: `Acolyte ${chatId}`, joinedAt: `2026-11-27T12:0${joined}:00.000Z`,
  activity: { working: false, tool: null, at: at(0) }
})
const A = idle('a', 1)
const B = idle('b', 2)
const working = (member: CultMemberDetail, tool: { name: string; target: string } | null = null): CultMemberDetail =>
  ({ ...member, activity: { working: true, tool, at: at(0) } })

function run(members: CultMemberDetail[] = [MAGOS, A, B], patch: Parameters<typeof runDetail>[0] = {}): CultRunDetail {
  return runDetail(patch, members)
}

const who = (member: CultMemberDetail): PipelineMember => ({ chatId: member.chatId, displayName: member.displayName, role: member.role })

function entry(seq: number, from: CultMemberDetail, to: CultMemberDetail[], text: string): CultPipelineEntry {
  return {
    seq, at: at(seq * 1000), kind: 'message', eventKind: null, sender: who(from), recipients: to.map(who), orderId: null,
    messageIds: [`m${seq}`], inReplyTo: null, text, truncated: false
  }
}

/** Entries sent before the feed opened. */
const HISTORY: CultPipelineEntry[] = [
  { ...entry(1, MAGOS, [A], 'Old order.'), at: at(-60_000) },
  { ...entry(2, A, [MAGOS], 'Old report.'), at: at(-30_000) }
]

/** A started feed and a step function that keeps it. */
function open(input: Partial<FeedInput> = {}): { start: ChamberEvent[]; step(next: Partial<FeedInput>): ChamberEvent[] } {
  const first = { run: run(), entries: [], now: T0, ...input }
  const started = startFeed(first, 11)
  let feed: ChamberFeed = started.feed
  let last: FeedInput = first
  return {
    start: started.events,
    step(next) {
      last = { ...last, ...next }
      const stepped = advanceFeed(feed, last)
      feed = stepped.feed
      return stepped.events
    }
  }
}

describe('chamberFeed: opening on the run as it is', () => {
  it('places the acolytes already there, who works, the run state and flags, with no bubble and no history', () => {
    const feed = open({ run: run([working(MAGOS), working(A, { name: 'edit', target: 'x.ts' }), B], { runningSince: '2026-11-27T11:40:30.000Z' }),
      entries: HISTORY })
    expect(feed.start).toEqual([
      { type: 'memberJoined', id: 'a', present: true }, { type: 'working', id: 'a', on: true },
      { type: 'memberJoined', id: 'b', present: true },
      { type: 'runState', runState: 'running' },
      { type: 'magosBusy', on: true }, { type: 'lastMinute', on: true }
    ])
  })

  it('never replays entries sent before it opened, though they arrive in later pages', () => {
    const feed = open()
    expect(feed.step({ entries: HISTORY })).toEqual([])
    expect(feed.step({ entries: [...HISTORY, entry(3, B, [MAGOS], 'New report.')] }))
      .toEqual([{ type: 'bubble', id: 'b', text: 'New report.' }, { type: 'reportSent', from: 'b' }])
  })

  it('leaves departed members out', () => {
    const feed = open({ run: run([MAGOS, A, { ...B, leftAt: at(-1000) }]) })
    expect(feed.start.filter((event) => event.type === 'memberJoined')).toEqual([{ type: 'memberJoined', id: 'a', present: true }])
  })
})

describe('chamberFeed: snapshot changes', () => {
  it('maps a member added or removed to memberJoined or memberLeft', () => {
    const feed = open({ run: run([MAGOS, A]) })
    expect(feed.step({ run: run([MAGOS, A, B]) })).toEqual([{ type: 'memberJoined', id: 'b' }])
    expect(feed.step({ run: run([MAGOS, A, { ...B, leftAt: at(5000) }]) })).toEqual([{ type: 'memberLeft', id: 'b' }])
    expect(feed.step({ run: run([MAGOS]) })).toEqual([{ type: 'memberLeft', id: 'a' }])
  })

  it('maps a working change to working, and a new acolyte that works at once to joined then working', () => {
    const feed = open({ run: run([MAGOS, A]) })
    expect(feed.step({ run: run([MAGOS, working(A)]) })).toEqual([{ type: 'working', id: 'a', on: true }])
    expect(feed.step({ run: run([MAGOS, A]) })).toEqual([{ type: 'working', id: 'a', on: false }])
    expect(feed.step({ run: run([MAGOS, A, working(B)]) })).toEqual([{ type: 'memberJoined', id: 'b' }, { type: 'working', id: 'b', on: true }])
  })

  it('maps an activity change to a Mechanicus bubble, once per tool call', () => {
    const feed = open()
    const editing = working(A, { name: 'edit', target: 'cults/CultPage.tsx' })
    expect(feed.step({ run: run([MAGOS, editing, B]) }))
      .toEqual([{ type: 'working', id: 'a', on: true }, { type: 'bubble', id: 'a', text: 'Sanctifying cults/CultPage.tsx' }])
    expect(feed.step({ run: run([MAGOS, { ...editing, activity: { ...editing.activity!, at: at(9000) } }, B]) })).toEqual([])
    expect(feed.step({ run: run([MAGOS, working(A, { name: 'bash', target: '<b>npm test</b>' }), B]) }))
      .toEqual([{ type: 'bubble', id: 'a', text: 'Invoking the rite of <b>npm test</b>' }])
  })
})

describe('chamberFeed: room flags', () => {
  it('maps the Magos working to magosBusy, a pending petition to petitionPending and the run state to runState', () => {
    const feed = open()
    expect(feed.step({ run: run([working(MAGOS), A, B]) })).toEqual([{ type: 'magosBusy', on: true }])
    const petitioned = { ...run([working(MAGOS), A, B]), petitions: [{ id: 'p', runId: 'run_1', kind: 'allow_save' as const, additional: null,
      folderPath: null, reason: 'r', state: 'pending' as const, granted: null, createdAt: at(0), decidedAt: null }] }
    expect(feed.step({ run: petitioned })).toEqual([{ type: 'petitionPending', on: true }])
    expect(feed.step({ run: { ...petitioned, petitions: [{ ...petitioned.petitions[0]!, state: 'approved' }] } }))
      .toEqual([{ type: 'petitionPending', on: false }])
    expect(feed.step({ run: run([MAGOS, A, B], { state: 'paused', runningSince: null, accumulatedRunningMs: 600_000 }) }))
      .toEqual([{ type: 'runState', runState: 'paused' }, { type: 'magosBusy', on: false }])
    expect(feed.step({ run: run([MAGOS, A, B], { state: 'ended', endReason: 'killed', runningSince: null }) }))
      .toEqual([{ type: 'runState', runState: 'killed' }])
  })

  it('turns lastMinute on under 60 s of a timed run, off when it ends, and never for an Unlimited run', () => {
    // Everyone works, so no idle quip joins the events.
    const busy = (patch: Parameters<typeof runDetail>[0] = {}): CultRunDetail => run([MAGOS, working(A), working(B)], patch)
    const feed = open({ run: busy() })
    const left = (ms: number): number => T0 + 20 * 60_000 - ms
    expect(feed.step({ now: left(LAST_MINUTE_MS) })).toEqual([])
    expect(feed.step({ now: left(LAST_MINUTE_MS - 1) })).toEqual([{ type: 'lastMinute', on: true }])
    expect(feed.step({ now: left(10_000) })).toEqual([])
    expect(feed.step({ run: busy({ state: 'shutting_down' }) }))
      .toEqual([{ type: 'runState', runState: 'ending' }, { type: 'lastMinute', on: false }])

    const unlimited = open({ run: busy({ timeLimitMs: null }) })
    expect(unlimited.start.some((event) => event.type === 'lastMinute')).toBe(false)
    expect(unlimited.step({ now: T0 + 365 * 24 * 3_600_000 }).some((event) => event.type === 'lastMinute')).toBe(false)
  })

  it('gives nothing for the same snapshot twice', () => {
    const feed = open()
    const changed = run([working(MAGOS), working(A, { name: 'read', target: 'a.md' }), B, idle('c', 3)])
    expect(feed.step({ run: changed })).not.toEqual([])
    expect(feed.step({ run: changed })).toEqual([])
    expect(feed.step({ run: structuredClone(changed) })).toEqual([])
  })
})

describe('chamberFeed: pipeline entries', () => {
  it('maps the Magos to one acolyte to orderSent{to} with a bubble of the mail\'s first line', () => {
    const feed = open()
    expect(feed.step({ entries: [entry(3, MAGOS, [A], '\n  Draft the shrine layout.\nThen the tickets.')] })).toEqual([
      { type: 'bubble', id: MAGOS_ID, text: 'Draft the shrine layout.' },
      { type: 'orderSent', to: 'a', orderId: 'seq:3' }
    ])
  })

  it('maps an order_all group to exactly one orderSent{to:"all"}', () => {
    const feed = open()
    const order: CultPipelineEntry = { ...entry(3, MAGOS, [A, B], 'Conclude your reports.'), kind: 'order_all', eventKind: 'order_all', orderId: 'co_1', messageIds: ['o1', 'o2'] }
    const events = feed.step({ entries: [order] })
    expect(events.filter((event) => event.type === 'orderSent')).toEqual([{ type: 'orderSent', to: 'all', orderId: 'co_1' }])
    expect(events).toEqual([{ type: 'bubble', id: MAGOS_ID, text: 'Conclude your reports.' }, { type: 'orderSent', to: 'all', orderId: 'co_1' }])
  })

  it('maps an acolyte to the Magos to reportSent and an acolyte to an acolyte to peerMail', () => {
    const feed = open()
    expect(feed.step({ entries: [entry(3, A, [MAGOS], 'Layout drafted.'), entry(4, B, [A], '<b>Schema</b> first.')] })).toEqual([
      { type: 'bubble', id: 'a', text: 'Layout drafted.' }, { type: 'reportSent', from: 'a' },
      { type: 'bubble', id: 'b', text: '<b>Schema</b> first.' }, { type: 'peerMail', from: 'b', to: 'a' }
    ])
  })

  it('caps a mail bubble at 60 characters and leaves out a bubble for a blank body', () => {
    const feed = open()
    const events = feed.step({ entries: [entry(3, A, [MAGOS], 'x'.repeat(90)), entry(4, B, [MAGOS], '  \n ')] })
    expect(events).toEqual([
      { type: 'bubble', id: 'a', text: `${'x'.repeat(59)}…` }, { type: 'reportSent', from: 'a' }, { type: 'reportSent', from: 'b' }
    ])
  })
})

describe('chamberFeed: pipeline entries once', () => {
  it('ignores run events and entries without a sender or recipient', () => {
    const feed = open()
    const event: CultPipelineEntry = { ...entry(3, A, [], 'Acolyte a was summoned.'), kind: 'event', eventKind: 'summoned', messageIds: [] }
    expect(feed.step({ entries: [event, { ...entry(4, A, [MAGOS], 'x'), sender: null }, entry(5, A, [], 'y')] })).toEqual([])
  })

  it('animates each entry once across repeated and overlapping pages', () => {
    const feed = open()
    const first = [entry(3, A, [MAGOS], 'One.'), entry(4, B, [MAGOS], 'Two.')]
    expect(feed.step({ entries: first })).toHaveLength(4)
    expect(feed.step({ entries: first })).toEqual([])
    expect(feed.step({ entries: [...first, entry(5, A, [B], 'Three.')] }))
      .toEqual([{ type: 'bubble', id: 'a', text: 'Three.' }, { type: 'peerMail', from: 'a', to: 'b' }])
    expect(feed.step({ entries: [entry(4, B, [MAGOS], 'Two.'), entry(5, A, [B], 'Three.')] })).toEqual([])
  })

  it('animates an order once when its message shown alone is replaced by its group', () => {
    const feed = open()
    const alone: CultPipelineEntry = { ...entry(3, MAGOS, [A], 'Kneel.'), messageIds: ['o1'] }
    expect(feed.step({ entries: [alone] })).toHaveLength(2)
    const group: CultPipelineEntry = { ...entry(5, MAGOS, [A, B], 'Kneel.'), kind: 'order_all', eventKind: 'order_all', orderId: 'co_9', messageIds: ['o1', 'o2'] }
    expect(feed.step({ entries: [group] }).filter((event) => event.type === 'orderSent')).toEqual([{ type: 'orderSent', to: 'all', orderId: 'co_9' }])
    expect(feed.step({ entries: [group] })).toEqual([])
  })
})

describe('chamberFeed: idle quips', () => {
  const quips = (events: ChamberEvent[]): string[] =>
    events.flatMap((event) => (event.type === 'bubble' && IDLE_QUIPS.includes(event.text) ? [event.id] : []))

  it('quips after 20 s idle, at most once every 30 s per acolyte, never while working or paused', () => {
    const feed = open({ run: run([MAGOS, A, working(B)]) })
    expect(quips(feed.step({ now: T0 + 19_999 }))).toEqual([])
    expect(quips(feed.step({ now: T0 + 20_000 }))).toEqual(['a'])
    expect(quips(feed.step({ now: T0 + 49_999 }))).toEqual([])
    expect(quips(feed.step({ now: T0 + 50_000 }))).toEqual(['a'])
    expect(quips(feed.step({ now: T0 + 50_000, run: run([MAGOS, A, B]) }))).toEqual([])
    expect(quips(feed.step({ now: T0 + 70_000 }))).toEqual(['b'])
    const paused = run([MAGOS, A, B], { state: 'paused', runningSince: null, accumulatedRunningMs: 600_000 })
    expect(quips(feed.step({ now: T0 + 200_000, run: paused }))).toEqual([])
  })

  it('restarts the idle wait after the acolyte works', () => {
    const feed = open({ run: run([MAGOS, A]) })
    feed.step({ now: T0 + 15_000, run: run([MAGOS, working(A)]) })
    feed.step({ now: T0 + 16_000, run: run([MAGOS, A]) })
    expect(quips(feed.step({ now: T0 + 35_999 }))).toEqual([])
    expect(quips(feed.step({ now: T0 + 36_000 }))).toEqual(['a'])
  })

  it('draws the same quips for the same seed', () => {
    const lines = (): string[] => {
      const feed = open({ run: run([MAGOS, A, B]) })
      return [20_000, 50_000, 80_000].flatMap((ms) => feed.step({ now: T0 + ms }).map((event) => (event.type === 'bubble' ? event.text : '')))
    }
    expect(lines()).toEqual(lines())
    expect(lines()).toHaveLength(6)
  })
})
