/**
 * Lifecycle vocabulary shared by every entry point (desktop, MCP, core).
 * Epics and tickets have exactly three statuses; execution conditions live on runs and attempts.
 */

export const WORK_STATUSES = ['backlog', 'in_progress', 'completed'] as const
export type WorkStatus = (typeof WORK_STATUSES)[number]

export const RUN_STATES = [
  'queued',
  'running',
  'awaiting_checkpoint',
  'paused',
  'failed',
  'canceled',
  'completed'
] as const
export type RunState = (typeof RUN_STATES)[number]

/** Runs in these states hold the epic's single active-run slot. */
export const ACTIVE_RUN_STATES: readonly RunState[] = [
  'queued',
  'running',
  'awaiting_checkpoint',
  'paused'
]

/**
 * The pause reason of a run whose orchestrator chat lost its CLI login. Only the desktop app's own session may
 * pause with it (exact match); while a run is paused so, its open leases stay open and resume extends them.
 */
export const SIGNED_OUT_PAUSE_REASON = 'signed_out'

export const ATTEMPT_STATES = [
  'claimed',
  'running',
  'submitted',
  'accepted',
  'rejected',
  'failed',
  'canceled',
  'lease_expired'
] as const
export type AttemptState = (typeof ATTEMPT_STATES)[number]

/** Attempts in these states occupy the ticket: no second claim may exist beside them. */
export const OPEN_ATTEMPT_STATES: readonly AttemptState[] = ['claimed', 'running', 'submitted']

/** Attempts in these states hold a lease that can expire. */
export const LEASED_ATTEMPT_STATES: readonly AttemptState[] = ['claimed', 'running']

export type AttemptKind = 'work' | 'carry_forward'

/** The label of the worker recorded on an attempt the orchestrator collected because the model named for it could not take the ticket. */
export const ORCHESTRATOR_FALLBACK_LABEL = 'Orchestrator (fallback)'

/** Derived, per-run execution state of a ticket (never stored as a ticket status). */
export const TICKET_EXECUTION_STATES = [
  'accepted',
  'submitted',
  'running',
  'ready',
  'waiting',
  'blocked',
  'failed',
  'needs_reconciliation',
  'later_sprint'
] as const
export type TicketExecutionState = (typeof TICKET_EXECUTION_STATES)[number]

export function isActiveRunState(state: RunState): boolean {
  return ACTIVE_RUN_STATES.includes(state)
}

export function isOpenAttemptState(state: AttemptState): boolean {
  return OPEN_ATTEMPT_STATES.includes(state)
}

export function isLeasedAttemptState(state: AttemptState): boolean {
  return LEASED_ATTEMPT_STATES.includes(state)
}

export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  backlog: 'Backlog',
  in_progress: 'In progress',
  completed: 'Completed'
}
