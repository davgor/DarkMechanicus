import type { EventView } from '../../../shared/domain/views'
import type { Runner } from '../epic/runner'

const PAGE_SIZE = 500
const MAX_PAGES = 10

/** Reads the epic's event log page by page (bounded), for the ticket History tab. */
export async function loadHistory(runner: Runner, epicId: string, pageSize = PAGE_SIZE): Promise<EventView[]> {
  const events: EventView[] = []
  let since = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await runner('listEvents', { epicId, sinceSeq: since, limit: pageSize })
    events.push(...result.events)
    if (result.events.length < pageSize || result.cursor <= since) {
      break
    }
    since = result.cursor
  }
  return events
}
