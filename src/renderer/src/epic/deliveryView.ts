/** Pure view model for a sprint's structured delivery: the run bar's pending line and the declaration's summary. */
import { deliverySatisfied } from '../../../core/plan/delivery'
import type { PlanBundle, SprintDelivery } from '../../../shared/domain/bundle'
import type { CheckResult, CheckStatus, DeliveryCheckView, RunView } from '../../../shared/domain/views'

const CHECK_ICONS: Record<CheckStatus, string> = { passed: '✓', failed: '✗', skipped: '–' }

/** An earlier sprint whose declared delivery holds the run's next claims: no check yet (`pending`) or a failed latest one. */
export interface DeliveryLine {
  sprintId: string
  ordinal: number
  target: string
  state: 'pending' | 'failed'
  /** The latest check's named server checks, each with its icon; empty while no check is recorded. */
  checks: (CheckResult & { icon: string })[]
}

/** The declaration in a few words, for example `main · release · verify installed`. */
export function deliverySummary(declared: SprintDelivery): string {
  return [declared.target, declared.release ? 'release' : null, declared.verifyInstalled ? 'verify installed' : null]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

/** The sprint's highest-numbered check; waivers are not checks. */
function latestCheck(sprintId: string, deliveries: DeliveryCheckView[]): DeliveryCheckView | null {
  let latest: DeliveryCheckView | null = null
  for (const delivery of deliveries) {
    if (delivery.sprintId === sprintId && delivery.kind === 'check' && delivery.number > (latest?.number ?? 0)) {
      latest = delivery
    }
  }
  return latest
}

/**
 * The earliest sprint before the active one that declares a delivery the server does not count as satisfied (no
 * waiver, and no passing latest check); null when nothing holds the run, or without the pinned plan.
 */
export function deliveryLine(run: RunView, bundle: PlanBundle | null): DeliveryLine | null {
  const active = run.activeSprintOrdinal
  if (bundle === null || active === null) {
    return null
  }
  const held = [...bundle.sprints]
    .sort((a, b) => a.ordinal - b.ordinal)
    .find((sprint) => sprint.ordinal < active && sprint.delivery !== undefined && !deliverySatisfied(sprint.id, run.deliveries))
  if (held?.delivery === undefined) {
    return null
  }
  const latest = latestCheck(held.id, run.deliveries)
  return {
    sprintId: held.id,
    ordinal: held.ordinal,
    target: held.delivery.target,
    state: latest === null ? 'pending' : 'failed',
    checks: latest === null ? [] : latest.checks.map(({ name, status, detail }) => ({ name, status, detail, icon: CHECK_ICONS[status] }))
  }
}
