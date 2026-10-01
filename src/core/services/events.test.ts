import { describe, expect, it } from 'vitest'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import type { Db, SqlValue } from '../db/database'
import { appendEvent, listEvents, MAX_EVENT_PAGE } from './events'

/** Delegates to `db`, running `afterAll` once each `all` query has returned its rows. */
function withHookAfterAll(db: Db, afterAll: () => void): Db {
  return {
    path: db.path,
    get: <T>(sql: string, ...params: SqlValue[]): T | undefined => db.get<T>(sql, ...params),
    all: <T>(sql: string, ...params: SqlValue[]): T[] => {
      const rows = db.all<T>(sql, ...params)
      afterAll()
      return rows
    },
    run: (sql, ...params) => db.run(sql, ...params),
    exec: (sql) => db.exec(sql),
    tx: <T>(fn: () => T): T => db.tx(fn),
    inTransaction: () => db.inTransaction(),
    close: () => db.close()
  }
}

function appendMany(ctx: TestCtx, count: number, epicId?: string): void {
  ctx.db.tx(() => {
    for (let index = 0; index < count; index += 1) {
      appendEvent(ctx, { kind: 'bulk', epicId })
    }
  })
}

function seqs(ctx: TestCtx, input: Parameters<typeof listEvents>[1]): number[] {
  return listEvents(ctx, input).events.map((event) => event.seq)
}

describe('appendEvent', () => {
  it('returns increasing sequence numbers starting at 1', () => {
    const ctx = createTestCtx()
    const first = appendEvent(ctx, { kind: 'a' })
    const second = appendEvent(ctx, { kind: 'b' })
    const third = appendEvent(ctx, { kind: 'c' })
    expect([first, second, third]).toEqual([1, 2, 3])
    expect(typeof first).toBe('number')
  })

  it('stores time, kind, references, session and payload', () => {
    const ctx = createTestCtx()
    ctx.clock.set('2026-02-03T04:05:06.007Z')
    appendEvent(ctx, {
      kind: 'ticket.claimed',
      epicId: 'ep_1',
      runId: 'rn_1',
      ticketId: 'tk_1',
      payload: { attempt: 2, nested: { ok: true } }
    })
    expect(listEvents(ctx, {}).events).toEqual([
      {
        seq: 1,
        at: '2026-02-03T04:05:06.007Z',
        kind: 'ticket.claimed',
        epicId: 'ep_1',
        runId: 'rn_1',
        ticketId: 'tk_1',
        sessionId: ctx.session.id,
        payload: { attempt: 2, nested: { ok: true } }
      }
    ])
  })
})

describe('appendEvent defaults and provenance', () => {
  it('defaults absent references to null and the payload to an empty object', () => {
    const ctx = createTestCtx()
    appendEvent(ctx, { kind: 'bare' })
    const [event] = listEvents(ctx, {}).events
    expect(event).toMatchObject({ epicId: null, runId: null, ticketId: null, payload: {} })
  })

  it('stores hostile kinds, references and payloads verbatim', () => {
    const ctx = createTestCtx()
    const kind = `x'); DELETE FROM events; --`
    appendEvent(ctx, { kind, epicId: `ep_'"`, payload: { text: `"quoted" 'text' \\ \u0000 ünï` } })
    const [event] = listEvents(ctx, {}).events
    expect(event).toMatchObject({ kind, epicId: `ep_'"`, payload: { text: `"quoted" 'text' \\ \u0000 ünï` } })
  })

  it('keeps explicit null references as null', () => {
    const ctx = createTestCtx()
    appendEvent(ctx, { kind: 'nulls', epicId: null, runId: null, ticketId: null })
    expect(listEvents(ctx, {}).events[0]).toMatchObject({ epicId: null, runId: null, ticketId: null })
  })

  it('records the acting session and the time of each append', () => {
    const ctx = createTestCtx()
    const desktop = withRole(ctx, 'desktop')
    appendEvent(ctx, { kind: 'first' })
    ctx.clock.advanceSeconds(30)
    appendEvent(desktop, { kind: 'second' })
    const [first, second] = listEvents(ctx, {}).events
    expect(first?.sessionId).toBe(ctx.session.id)
    expect(second?.sessionId).toBe(desktop.session.id)
    expect(second?.sessionId).not.toBe(first?.sessionId)
    expect(first?.at).toBe('2026-01-01T00:00:00.000Z')
    expect(second?.at).toBe('2026-01-01T00:00:30.000Z')
  })
})

describe('listEvents ordering and paging window', () => {
  it('returns events in append order', () => {
    const ctx = createTestCtx()
    for (const kind of ['a', 'b', 'c']) {
      appendEvent(ctx, { kind })
    }
    expect(listEvents(ctx, {}).events.map((event) => event.kind)).toEqual(['a', 'b', 'c'])
  })

  it('returns only events after sinceSeq', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 5)
    expect(seqs(ctx, { sinceSeq: 2 })).toEqual([3, 4, 5])
    expect(seqs(ctx, { sinceSeq: 5 })).toEqual([])
    expect(seqs(ctx, { sinceSeq: 0 })).toEqual([1, 2, 3, 4, 5])
  })

  it('treats a negative sinceSeq as zero and floors fractions', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 4)
    expect(seqs(ctx, { sinceSeq: -10 })).toEqual([1, 2, 3, 4])
    expect(seqs(ctx, { sinceSeq: 1.9 })).toEqual([2, 3, 4])
  })

  it('defaults to a page of 200 events', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 201)
    const page = listEvents(ctx, {})
    expect(page.events).toHaveLength(200)
    expect(page.cursor).toBe(200)
  })
})

describe('listEvents limit clamping', () => {
  it('pins the maximum page size', () => {
    expect(MAX_EVENT_PAGE).toBe(500)
  })

  it('honours limits within range', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 6)
    expect(seqs(ctx, { limit: 1 })).toEqual([1])
    expect(seqs(ctx, { limit: 4 })).toEqual([1, 2, 3, 4])
    expect(seqs(ctx, { limit: 6 })).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('raises zero and negative limits to one', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 3)
    expect(seqs(ctx, { limit: 0 })).toEqual([1])
    expect(seqs(ctx, { limit: -5 })).toEqual([1])
  })

  it('floors fractional limits', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 5)
    expect(seqs(ctx, { limit: 2.9 })).toEqual([1, 2])
  })

  it('caps the page at the maximum', () => {
    const ctx = createTestCtx()
    appendMany(ctx, MAX_EVENT_PAGE + 1)
    expect(listEvents(ctx, { limit: 100_000 }).events).toHaveLength(MAX_EVENT_PAGE)
    expect(listEvents(ctx, { limit: MAX_EVENT_PAGE }).events).toHaveLength(MAX_EVENT_PAGE)
    expect(listEvents(ctx, { limit: MAX_EVENT_PAGE - 1 }).events).toHaveLength(MAX_EVENT_PAGE - 1)
  })
})

describe('listEvents filters', () => {
  function mixedEvents(): TestCtx {
    const ctx = createTestCtx()
    appendEvent(ctx, { kind: 'a', epicId: 'ep_1', runId: 'rn_1' })
    appendEvent(ctx, { kind: 'b', epicId: 'ep_2', runId: 'rn_2' })
    appendEvent(ctx, { kind: 'c', epicId: 'ep_1', runId: 'rn_3' })
    appendEvent(ctx, { kind: 'd' })
    return ctx
  }

  it('filters by epic', () => {
    expect(seqs(mixedEvents(), { epicId: 'ep_1' })).toEqual([1, 3])
    expect(seqs(mixedEvents(), { epicId: 'ep_2' })).toEqual([2])
  })

  it('filters by run', () => {
    expect(seqs(mixedEvents(), { runId: 'rn_3' })).toEqual([3])
    expect(seqs(mixedEvents(), { runId: 'rn_1' })).toEqual([1])
  })

  it('combines epic, run and sinceSeq filters', () => {
    const ctx = mixedEvents()
    expect(seqs(ctx, { epicId: 'ep_1', runId: 'rn_3' })).toEqual([3])
    expect(seqs(ctx, { epicId: 'ep_2', runId: 'rn_1' })).toEqual([])
    expect(seqs(ctx, { epicId: 'ep_1', sinceSeq: 1 })).toEqual([3])
  })

  it('returns everything when no filter is given, including events without references', () => {
    expect(seqs(mixedEvents(), {})).toEqual([1, 2, 3, 4])
  })
})

describe('listEvents cursor', () => {
  it('is the sequence of the last returned event', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 5)
    expect(listEvents(ctx, { limit: 2 }).cursor).toBe(2)
    expect(listEvents(ctx, { sinceSeq: 2, limit: 2 }).cursor).toBe(4)
    expect(listEvents(ctx, { sinceSeq: 4 }).cursor).toBe(5)
  })

  it('is zero for an empty log and echoes sinceSeq when nothing is newer', () => {
    const ctx = createTestCtx()
    expect(listEvents(ctx, {})).toEqual({ events: [], cursor: 0 })
    expect(listEvents(ctx, { sinceSeq: 5 }).cursor).toBe(5)
  })

  it('never moves backwards past the latest event when the page is empty', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 3)
    expect(listEvents(ctx, { sinceSeq: 3 })).toEqual({ events: [], cursor: 3 })
    expect(listEvents(ctx, { sinceSeq: 100 })).toEqual({ events: [], cursor: 100 })
  })

  it('jumps to the latest event when a filter matches nothing', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 3, 'ep_1')
    expect(listEvents(ctx, { epicId: 'ep_other' })).toEqual({ events: [], cursor: 3 })
    expect(listEvents(ctx, { runId: 'rn_other', sinceSeq: 1 })).toEqual({ events: [], cursor: 3 })
  })

  it('lets a poller page through every event exactly once', () => {
    const ctx = createTestCtx()
    appendMany(ctx, 5)
    const seen: number[] = []
    let cursor = 0
    for (let poll = 0; poll < 4; poll += 1) {
      const page = listEvents(ctx, { sinceSeq: cursor, limit: 2 })
      seen.push(...page.events.map((event) => event.seq))
      cursor = page.cursor
    }
    expect(seen).toEqual([1, 2, 3, 4, 5])
    expect(cursor).toBe(5)
  })
})

describe('listEvents while another process appends', () => {
  it('does not skip an event committed right after the page was read', () => {
    const ctx = createTestCtx()
    appendEvent(ctx, { kind: 'first' })
    let appended = false
    const racing: TestCtx = {
      ...ctx,
      db: withHookAfterAll(ctx.db, () => {
        if (!appended) {
          appended = true
          appendEvent(ctx, { kind: 'late' })
        }
      })
    }
    const page = listEvents(racing, { sinceSeq: 1 })
    expect(page.events).toEqual([])
    expect(page.cursor).toBe(1)
    expect(listEvents(ctx, { sinceSeq: page.cursor }).events.map((event) => event.kind)).toEqual(['late'])
  })
})
