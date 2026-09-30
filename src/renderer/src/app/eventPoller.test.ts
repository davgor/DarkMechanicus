import { describe, expect, it } from 'vitest'
import { EventLog } from '../__mocks__/eventLog'
import { EPIC_A } from '../__mocks__/fixtures'
import type { EventView } from '../../../shared/domain/views'
import { MAX_PAGES_PER_TICK, PAGE_LIMIT, createEventPoller, findHeadSeq } from './eventPoller'

function logWith(count: number): EventLog {
  const log = new EventLog()
  for (let index = 0; index < count; index += 1) log.append({ epicId: EPIC_A })
  return log
}

const probeOf = (log: EventLog) => async (since: number) =>
  log.page({ sinceSeq: since, limit: 1 }).events.length > 0

describe('findHeadSeq', () => {
  it.each([0, 1, 2, 3, 7, 8, 100, 1023, 1024, 1025])('finds the newest seq of %i events', async (count) => {
    expect(await findHeadSeq(probeOf(logWith(count)))).toBe(count)
  })

  it('needs only a logarithmic number of probes', async () => {
    const log = logWith(1000)
    await findHeadSeq(probeOf(log))
    expect(log.requests.length).toBeLessThanOrEqual(24)
  })

  it('gives up on a log that never ends', async () => {
    await expect(findHeadSeq(async () => true)).rejects.toThrow('end of the event log')
  })
})

interface Harness {
  log: EventLog
  batches: EventView[][]
  errors: unknown[]
  ready: () => number
  poller: ReturnType<typeof createEventPoller>
  failNext: (message: string) => void
}

function harness(initial: number): Harness {
  const log = logWith(initial)
  const batches: EventView[][] = []
  const errors: unknown[] = []
  let ready = 0
  let failure: string | null = null
  const poller = createEventPoller({
    fetchPage: (input) => {
      if (failure !== null) {
        const message = failure
        failure = null
        return Promise.reject(new Error(message))
      }
      return Promise.resolve(log.page(input))
    },
    onEvents: (events) => batches.push(events),
    onReady: () => {
      ready += 1
    },
    onError: (error) => errors.push(error)
  })
  const failNext = (message: string): void => {
    failure = message
  }
  return { log, batches, errors, ready: () => ready, poller, failNext }
}

describe('createEventPoller baseline', () => {
  it('starts at the newest event without replaying history', async () => {
    const h = harness(5)
    await h.poller.tick()
    expect(h.batches).toEqual([])
    expect(h.ready()).toBe(1)
  })

  it('reports readiness once per baseline', async () => {
    const h = harness(2)
    await h.poller.tick()
    await h.poller.tick()
    expect(h.ready()).toBe(1)
  })

  it('delivers events appended after the baseline, in order', async () => {
    const h = harness(3)
    await h.poller.tick()
    h.log.append({ epicId: 'first' })
    h.log.append({ epicId: 'second' })
    await h.poller.tick()
    expect(h.batches.map((batch) => batch.map((event) => event.epicId))).toEqual([['first', 'second']])
  })

  it('stops after a short page instead of asking for another', async () => {
    const h = harness(0)
    await h.poller.tick()
    h.log.append()
    const before = h.log.requests.length
    await h.poller.tick()
    expect(h.log.requests.length - before).toBe(1)
  })

  it('does not redeliver events on the next tick', async () => {
    const h = harness(0)
    await h.poller.tick()
    h.log.append()
    await h.poller.tick()
    await h.poller.tick()
    expect(h.batches).toHaveLength(1)
  })
})

describe('createEventPoller paging', () => {
  it('drains a burst larger than one page within a tick', async () => {
    const h = harness(0)
    await h.poller.tick()
    for (let index = 0; index < PAGE_LIMIT + 50; index += 1) h.log.append()
    await h.poller.tick()
    expect(h.batches.map((batch) => batch.length)).toEqual([PAGE_LIMIT, 50])
  })

  it('caps the pages per tick and continues on the next one', async () => {
    const h = harness(0)
    await h.poller.tick()
    const total = PAGE_LIMIT * MAX_PAGES_PER_TICK + 10
    for (let index = 0; index < total; index += 1) h.log.append()
    await h.poller.tick()
    expect(h.batches).toHaveLength(MAX_PAGES_PER_TICK)
    await h.poller.tick()
    expect(h.batches.flat()).toHaveLength(total)
  })

  it('skips a tick while the previous one is still running', async () => {
    const h = harness(0)
    const first = h.poller.tick()
    const second = h.poller.tick()
    await Promise.all([first, second])
    expect(h.ready()).toBe(1)
  })
})

describe('createEventPoller failures', () => {
  it('reports a failure once until a poll succeeds again', async () => {
    const h = harness(0)
    await h.poller.tick()
    h.failNext('offline')
    await h.poller.tick()
    h.failNext('still offline')
    await h.poller.tick()
    expect(h.errors).toHaveLength(1)
  })

  it('reports again after recovering', async () => {
    const h = harness(0)
    await h.poller.tick()
    h.failNext('one')
    await h.poller.tick()
    await h.poller.tick()
    h.failNext('two')
    await h.poller.tick()
    expect(h.errors.map((error) => (error as Error).message)).toEqual(['one', 'two'])
  })

  it('retries the baseline after a failure and keeps its cursor once found', async () => {
    const h = harness(4)
    h.failNext('boot')
    await h.poller.tick()
    expect(h.ready()).toBe(0)
    await h.poller.tick()
    expect(h.ready()).toBe(1)
    h.log.append({ epicId: 'later' })
    await h.poller.tick()
    expect(h.batches).toHaveLength(1)
  })
})
