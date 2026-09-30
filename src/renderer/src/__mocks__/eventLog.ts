import type { EventView, EventsPage } from '../../../shared/domain/views'
import { eventView } from './fixtures'

interface PageInput {
  sinceSeq?: number
  limit?: number
  epicId?: string
  runId?: string
}

/** In-memory event log with the same paging semantics as the core `listEvents` service. */
export class EventLog {
  readonly events: EventView[] = []
  requests: PageInput[] = []

  append(patch: Partial<EventView> = {}): EventView {
    const event = eventView({ ...patch, seq: this.head() + 1 })
    this.events.push(event)
    return event
  }

  head(): number {
    return this.events.length === 0 ? 0 : (this.events[this.events.length - 1]?.seq ?? 0)
  }

  page(input: PageInput): EventsPage {
    this.requests.push(input)
    const since = Math.max(0, Math.floor(input.sinceSeq ?? 0))
    const limit = Math.min(500, Math.max(1, Math.floor(input.limit ?? 200)))
    const events = this.events
      .filter((event) => event.seq > since)
      .filter((event) => input.epicId === undefined || event.epicId === input.epicId)
      .filter((event) => input.runId === undefined || event.runId === input.runId)
      .slice(0, limit)
    const last = events[events.length - 1]
    return { events, cursor: last ? last.seq : Math.max(since, this.head()) }
  }
}
