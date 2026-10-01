import type { RunState, TicketExecutionState, WorkStatus } from '../../../shared/domain/status'

/** Anything the product shows as a colored state: ticket execution, work status, or run state. */
export type PillState = TicketExecutionState | WorkStatus | RunState

const PILL_LABELS: Record<PillState, string> = {
  accepted: 'Accepted',
  submitted: 'In review',
  running: 'Running',
  ready: 'Ready',
  waiting: 'Waiting',
  blocked: 'Blocked',
  failed: 'Failed',
  needs_reconciliation: 'Needs reconciliation',
  later_sprint: 'Later sprint',
  backlog: 'Backlog',
  in_progress: 'In progress',
  completed: 'Completed',
  queued: 'Queued',
  awaiting_checkpoint: 'Awaiting checkpoint',
  paused: 'Paused',
  canceled: 'Canceled'
}

export function pillLabel(state: PillState): string {
  return PILL_LABELS[state]
}

interface StatePillProps {
  state: PillState
  /** Overrides the default label; the color still follows `state`. */
  label?: string
}

/** Color is always paired with the state's name in text. */
export function StatePill({ state, label }: StatePillProps): JSX.Element {
  return (
    <span className={`pill pill-${state}`} data-state={state}>
      <span className="pill-dot" aria-hidden="true" />
      {label ?? PILL_LABELS[state]}
    </span>
  )
}
