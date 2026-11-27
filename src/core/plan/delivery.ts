/** The sprint delivery rule the server's claim hold, adoption guard and the desktop's run bar share. Pure. */
import type { DeliveryCheckView } from '../../shared/domain/views'

/**
 * A sprint's delivery is satisfied when any waiver exists for it, or when its highest-numbered check passed.
 * A later failed check overrides an earlier pass; a waiver is never overridden.
 */
export function deliverySatisfied(sprintId: string, deliveries: DeliveryCheckView[]): boolean {
  let latest: DeliveryCheckView | null = null
  for (const delivery of deliveries) {
    if (delivery.sprintId !== sprintId) {
      continue
    }
    if (delivery.kind === 'waiver') {
      return true
    }
    if (delivery.number > (latest?.number ?? 0)) {
      latest = delivery
    }
  }
  return latest?.passed ?? false
}
