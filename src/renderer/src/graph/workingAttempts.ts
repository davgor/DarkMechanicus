/** Which tickets are being worked on: the ones whose latest attempt is claimed or running. */
import { isLeasedAttemptState } from '../../../shared/domain/status'
import type { AttemptView, RunView } from '../../../shared/domain/views'

/** Each ticket's latest attempt that still holds a lease (claimed or running), by ticket id. */
export function workingAttempts(run: RunView | null): ReadonlyMap<string, string> {
  const latest = new Map<string, AttemptView>()
  for (const item of run?.attempts ?? []) {
    const held = latest.get(item.ticketId)
    if (!item.superseded && (held === undefined || item.number > held.number)) {
      latest.set(item.ticketId, item)
    }
  }
  const working = [...latest.values()].filter((item) => isLeasedAttemptState(item.state))
  return new Map(working.map((item) => [item.ticketId, item.id]))
}
