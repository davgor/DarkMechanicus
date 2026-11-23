import type { EventView, EventsPage } from '../../../shared/domain/views'

export const PAGE_LIMIT = 200
export const MAX_PAGES_PER_TICK = 5

interface PageRequest {
  sinceSeq: number
  limit: number
}

interface EventPollerOptions {
  fetchHead(): Promise<number>
  fetchPage(request: PageRequest): Promise<EventsPage>
  onEvents(events: EventView[]): void
  onReady(): void
  /** Called on the first failure of a run of failures; recovery re-arms it. */
  onError(error: unknown): void
}

export interface EventPoller {
  tick(): Promise<void>
  stop(): void
}

/**
 * Establish a baseline without replaying history, then deliver new events in bounded bursts.
 * Repeated ticks join the in-flight request. Deactivated pollers neither publish nor page again.
 */
export function createEventPoller(options: EventPollerOptions): EventPoller {
  let cursor: number | null = null
  let pending: Promise<void> | null = null
  let active = true
  let failing = false

  async function poll(): Promise<void> {
    if (cursor === null) {
      cursor = await options.fetchHead()
      if (active) options.onReady()
      return
    }
    const events: EventView[] = []
    try {
      for (let pages = 0; active && pages < MAX_PAGES_PER_TICK; pages += 1) {
        const page = await options.fetchPage({ sinceSeq: cursor, limit: PAGE_LIMIT })
        cursor = page.cursor
        events.push(...page.events)
        if (page.events.length < PAGE_LIMIT) break
      }
    } finally {
      if (active && events.length > 0) options.onEvents(events)
    }
  }

  return {
    tick() {
      if (!active) return Promise.resolve()
      pending ??= poll().then(() => { failing = false }, (error: unknown) => {
        if (active && !failing) {
          failing = true
          options.onError(error)
        }
      }).finally(() => { pending = null })
      return pending
    },
    stop() { active = false }
  }
}
