import type { EventView, EventsPage } from '../../../shared/domain/views'

export const PAGE_LIMIT = 200
export const MAX_PAGES_PER_TICK = 5
/** 2^40 events is far beyond any real log; the bound also guarantees the search terminates. */
const MAX_SEARCH_STEPS = 40

export interface PageRequest {
  sinceSeq: number
  limit: number
}

type HasEventAfter = (sinceSeq: number) => Promise<boolean>

/**
 * Finds the newest event seq without downloading the log: an exponential probe brackets it, then
 * a binary search narrows it. `hasEventAfter(n)` is true while any event has seq > n.
 */
export async function findHeadSeq(hasEventAfter: HasEventAfter): Promise<number> {
  if (!(await hasEventAfter(0))) {
    return 0
  }
  let low = 0
  let high = 1
  for (let step = 0; await hasEventAfter(high); step += 1) {
    if (step === MAX_SEARCH_STEPS) {
      throw new Error('Could not find the end of the event log')
    }
    low = high
    high *= 2
  }
  for (let step = 0; high - low > 1 && step < MAX_SEARCH_STEPS; step += 1) {
    const middle = low + Math.floor((high - low) / 2)
    if (await hasEventAfter(middle)) {
      low = middle
    } else {
      high = middle
    }
  }
  return high
}

export interface EventPollerOptions {
  fetchPage(request: PageRequest): Promise<EventsPage>
  /** Called with each page of events that arrived after the baseline. */
  onEvents(events: EventView[]): void
  /** Called once the baseline (the log's current end) is known. */
  onReady(): void
  /** Called on the first failure of a run of failures; recovery re-arms it. */
  onError(error: unknown): void
}

export interface EventPoller {
  tick(): Promise<void>
}

/**
 * One polling loop per folder. The first tick only finds where the log ends (history is not
 * replayed); later ticks deliver what was appended since, a bounded number of pages at a time.
 * Overlapping ticks are skipped so a slow reply never stacks requests.
 */
export function createEventPoller(options: EventPollerOptions): EventPoller {
  let cursor: number | null = null
  let busy = false
  let failing = false

  async function drain(from: number): Promise<number> {
    let position = from
    for (let pages = 0; pages < MAX_PAGES_PER_TICK; pages += 1) {
      const page = await options.fetchPage({ sinceSeq: position, limit: PAGE_LIMIT })
      if (page.events.length === 0) {
        break
      }
      position = page.cursor
      options.onEvents(page.events)
      if (page.events.length < PAGE_LIMIT) {
        break
      }
    }
    return position
  }

  async function poll(): Promise<void> {
    if (cursor === null) {
      cursor = await findHeadSeq(
        async (since) => (await options.fetchPage({ sinceSeq: since, limit: 1 })).events.length > 0
      )
      options.onReady()
      return
    }
    cursor = await drain(cursor)
  }

  return {
    async tick() {
      if (busy) {
        return
      }
      busy = true
      try {
        await poll()
        failing = false
      } catch (error) {
        if (!failing) {
          failing = true
          options.onError(error)
        }
      } finally {
        busy = false
      }
    }
  }
}
