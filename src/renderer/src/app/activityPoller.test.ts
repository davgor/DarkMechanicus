import { describe, expect, it } from 'vitest'
import type {
  ActivityEntry,
  AttemptTimelineView,
  RunActivityGroup,
  RunTimelineView
} from '../../../shared/domain/activity'
import {
  createActivityPoller,
  mergeAttemptTimeline,
  mergeEntries,
  mergeRunTimeline,
  type TimelinePage
} from './activityPoller'
import { MAX_PAGES_PER_TICK, PAGE_LIMIT } from './eventPoller'

function note(seq: number, text = `note ${seq}`): ActivityEntry {
  return {
    kind: 'note',
    id: `event:${seq}`,
    at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    sessionId: 'ss_worker',
    attemptId: 'at_1',
    ticketId: 'tk_1',
    text,
    step: null
  }
}

function alive(until: string, active = true): ActivityEntry {
  return {
    kind: 'alive',
    id: 'alive:at_1',
    at: '2026-01-01T00:00:01.000Z',
    sessionId: 'ss_worker',
    attemptId: 'at_1',
    ticketId: 'tk_1',
    until,
    leaseExpiresAt: null,
    active
  }
}

function attemptPage(entries: ActivityEntry[], cursor: number, isLive = true): AttemptTimelineView {
  return {
    attemptId: 'at_1',
    runId: 'rn_1',
    ticketId: 'tk_1',
    state: isLive ? 'running' : 'accepted',
    isLive,
    cursor,
    entries,
    sessions: [{ id: 'ss_worker', role: 'worker', label: 'impl' }]
  }
}

interface Rig {
  requests: Array<{ sinceSeq: number; limit: number }>
  pages: AttemptTimelineView[]
  errors: unknown[]
  poller: ReturnType<typeof createActivityPoller<AttemptTimelineView>>
  script(...next: Array<AttemptTimelineView | Error>): void
}

function rig(): Rig {
  const requests: Rig['requests'] = []
  const pages: AttemptTimelineView[] = []
  const errors: unknown[] = []
  const queue: Array<AttemptTimelineView | Error> = []
  const poller = createActivityPoller<AttemptTimelineView>({
    fetchPage: (request) => {
      requests.push(request)
      const next = queue.shift() ?? attemptPage([], requests.length)
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    size: (page) => page.entries.length,
    onPage: (page) => pages.push(page),
    onError: (error) => errors.push(error)
  })
  return { requests, pages, errors, poller, script: (...next) => queue.push(...next) }
}

describe('createActivityPoller', () => {
  it('starts from the beginning of the history, then follows the cursor of each page', async () => {
    const r = rig()
    r.script(attemptPage([note(1), note(2)], 7), attemptPage([note(8)], 9), attemptPage([], 9))
    await r.poller.tick()
    await r.poller.tick()
    await r.poller.tick()
    expect(r.requests).toEqual([
      { sinceSeq: 0, limit: PAGE_LIMIT },
      { sinceSeq: 7, limit: PAGE_LIMIT },
      { sinceSeq: 9, limit: PAGE_LIMIT }
    ])
    expect(r.pages.map((page) => page.entries.length)).toEqual([2, 1, 0])
  })

  it('keeps fetching within a tick while pages are full, up to the per-tick bound', async () => {
    const r = rig()
    const full = (cursor: number): AttemptTimelineView => attemptPage(Array.from({ length: PAGE_LIMIT }, (_, i) => note(i)), cursor)
    r.script(...Array.from({ length: MAX_PAGES_PER_TICK + 2 }, (_, i) => full(100 * (i + 1))))
    await r.poller.tick()
    expect(r.requests).toHaveLength(MAX_PAGES_PER_TICK)
    await r.poller.tick()
    expect(r.requests[MAX_PAGES_PER_TICK]).toEqual({ sinceSeq: 100 * MAX_PAGES_PER_TICK, limit: PAGE_LIMIT })
  })

  it('delivers a page with nothing new so the client learns that the timeline stopped being live', async () => {
    const r = rig()
    r.script(attemptPage([note(1)], 3), attemptPage([], 3, false))
    await r.poller.tick()
    expect(r.poller.done()).toBe(false)
    await r.poller.tick()
    expect(r.pages.at(-1)).toMatchObject({ entries: [], isLive: false })
    expect(r.poller.done()).toBe(true)
  })

})

describe('createActivityPoller — ending and failing', () => {
  it('is not done while a page that is no longer live still has a full page behind it', async () => {
    const r = rig()
    const full = Array.from({ length: PAGE_LIMIT }, (_, i) => note(i))
    r.script(...Array.from({ length: MAX_PAGES_PER_TICK }, () => attemptPage(full, 50, false)))
    await r.poller.tick()
    expect(r.poller.done()).toBe(false)
  })

  it('stops fetching once done', async () => {
    const r = rig()
    r.script(attemptPage([note(1)], 3, false))
    await r.poller.tick()
    expect(r.poller.done()).toBe(true)
    await r.poller.tick()
    await r.poller.tick()
    expect(r.requests).toHaveLength(1)
  })

})

describe('createActivityPoller — failures and slow requests', () => {
  it('reports the first failure of a run of failures once and recovers', async () => {
    const r = rig()
    r.script(new Error('first'), new Error('second'), attemptPage([note(1)], 2), new Error('third'))
    await r.poller.tick()
    await r.poller.tick()
    await r.poller.tick()
    await r.poller.tick()
    expect(r.errors.map((error) => (error as Error).message)).toEqual(['first', 'third'])
    expect(r.requests.map((request) => request.sinceSeq)).toEqual([0, 0, 0, 2])
  })

  it('skips a tick that overlaps a slow request', async () => {
    const requests: number[] = []
    let release: (page: TimelinePage) => void = () => undefined
    const poller = createActivityPoller<TimelinePage>({
      fetchPage: ({ sinceSeq }) => {
        requests.push(sinceSeq)
        return new Promise<TimelinePage>((resolve) => {
          release = resolve
        })
      },
      size: () => 0,
      onPage: () => undefined,
      onError: () => undefined
    })
    const first = poller.tick()
    await poller.tick()
    expect(requests).toEqual([0])
    release({ cursor: 1, isLive: true })
    await first
  })
})

describe('mergeEntries', () => {
  it('appends entries with a new id in the order they arrive', () => {
    expect(mergeEntries([note(1)], [note(2), note(3)]).map((entry) => entry.id)).toEqual(['event:1', 'event:2', 'event:3'])
  })

  it('replaces an entry that comes again by id, in place', () => {
    const merged = mergeEntries([note(1), alive('2026-01-01T00:00:10.000Z'), note(3)], [note(4), alive('2026-01-01T00:02:10.000Z')])
    expect(merged.map((entry) => entry.id)).toEqual(['event:1', 'alive:at_1', 'event:3', 'event:4'])
    expect(merged[1]).toMatchObject({ until: '2026-01-01T00:02:10.000Z' })
  })

  it('returns the same list when nothing is new or changed', () => {
    const held = [note(1), alive('2026-01-01T00:00:10.000Z')]
    expect(mergeEntries(held, [])).toBe(held)
    expect(mergeEntries(held, [alive('2026-01-01T00:00:10.000Z')])).toBe(held)
  })
})

describe('mergeAttemptTimeline', () => {
  it('takes the first page as it is', () => {
    const page = attemptPage([note(1)], 4)
    expect(mergeAttemptTimeline(null, page)).toBe(page)
  })

  it('adds new entries and sessions, replaces the span, and follows the cursor and liveness', () => {
    const first = attemptPage([alive('2026-01-01T00:00:10.000Z'), note(2)], 5)
    const next = {
      ...attemptPage([alive('2026-01-01T00:01:00.000Z', false), note(6)], 8, false),
      sessions: [
        { id: 'ss_worker', role: 'worker' as const, label: 'impl' },
        { id: 'ss_desktop', role: 'desktop' as const, label: 'Desktop' }
      ]
    }
    const merged = mergeAttemptTimeline(first, next)
    expect(merged.entries.map((entry) => entry.id)).toEqual(['alive:at_1', 'event:2', 'event:6'])
    expect(merged.entries[0]).toMatchObject({ until: '2026-01-01T00:01:00.000Z', active: false })
    expect(merged.sessions.map((session) => session.id)).toEqual(['ss_worker', 'ss_desktop'])
    expect([merged.cursor, merged.isLive, merged.state]).toEqual([8, false, 'accepted'])
  })

  it('keeps the same object when a poll changed nothing', () => {
    const first = attemptPage([alive('2026-01-01T00:00:10.000Z'), note(2)], 5)
    const same = attemptPage([alive('2026-01-01T00:00:10.000Z')], 5)
    expect(mergeAttemptTimeline(first, same)).toBe(first)
  })
})

function group(sessionId: string, label: string, entries: ActivityEntry[]): RunActivityGroup {
  return { session: { id: sessionId, role: 'orchestrator', label }, entries }
}

function runPage(groups: RunActivityGroup[], cursor: number, isLive = true): RunTimelineView {
  return { runId: 'rn_1', epicId: 'ep_1', state: isLive ? 'running' : 'completed', isLive, cursor, groups }
}

describe('mergeRunTimeline', () => {
  it('adds entries to the group of their session and new sessions after the ones already shown', () => {
    const first = runPage([group('ss_a', 'A', [note(1)])], 2)
    const next = runPage([group('ss_b', 'B', [note(3)]), group('ss_a', 'A', [note(4)])], 5)
    const merged = mergeRunTimeline(first, next)
    expect(merged.groups.map((item) => [item.session.id, item.entries.map((entry) => entry.id)])).toEqual([
      ['ss_a', ['event:1', 'event:4']],
      ['ss_b', ['event:3']]
    ])
    expect(merged.cursor).toBe(5)
  })

  it('keeps the same object when a poll brought nothing', () => {
    const first = runPage([group('ss_a', 'A', [note(1)])], 2)
    expect(mergeRunTimeline(first, runPage([], 2))).toBe(first)
  })

  it('follows liveness when the run ends', () => {
    const first = runPage([group('ss_a', 'A', [note(1)])], 2)
    expect(mergeRunTimeline(first, runPage([], 2, false))).toMatchObject({ isLive: false, state: 'completed' })
  })
})
