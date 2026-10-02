/**
 * Display vocabulary for execution and editing states. Every state color (tone) is always shown
 * together with its text label, so color never carries meaning on its own.
 */
import type { AttemptState, RunState, TicketExecutionState, WorkStatus } from '../../../shared/domain/status'

export type Tone =
  | 'accepted'
  | 'review'
  | 'running'
  | 'ready'
  | 'waiting'
  | 'blocked'
  | 'failed'
  | 'attention'
  | 'neutral'
  | 'new'
  | 'edited'
  | 'rejected'

export const EXECUTION_LABELS: Record<TicketExecutionState, string> = {
  accepted: 'ACCEPTED',
  submitted: 'IN REVIEW',
  running: 'RUNNING',
  ready: 'READY',
  waiting: 'WAITING',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  needs_reconciliation: 'NEEDS RECONCILIATION',
  later_sprint: 'WAITING'
}

export const EXECUTION_TONES: Record<TicketExecutionState, Tone> = {
  accepted: 'accepted',
  submitted: 'review',
  running: 'running',
  ready: 'ready',
  waiting: 'waiting',
  blocked: 'blocked',
  failed: 'failed',
  needs_reconciliation: 'blocked',
  later_sprint: 'waiting'
}

/** Waiting tickets render with a dashed outline in addition to their label. */
export const DASHED_EXECUTION: Record<TicketExecutionState, boolean> = {
  accepted: false,
  submitted: false,
  running: false,
  ready: false,
  waiting: true,
  blocked: false,
  failed: false,
  needs_reconciliation: false,
  later_sprint: true
}

export const STATUS_LABELS: Record<WorkStatus, string> = {
  backlog: 'BACKLOG',
  in_progress: 'IN PROGRESS',
  completed: 'COMPLETED'
}

export const STATUS_TONES: Record<WorkStatus, Tone> = {
  backlog: 'neutral',
  in_progress: 'running',
  completed: 'accepted'
}

export const ATTEMPT_LABELS: Record<AttemptState, string> = {
  claimed: 'claimed',
  running: 'running',
  submitted: 'submitted',
  accepted: 'accepted',
  rejected: 'rejected',
  failed: 'failed',
  canceled: 'canceled',
  lease_expired: 'lease expired'
}

export const ATTEMPT_TONES: Record<AttemptState, Tone> = {
  claimed: 'running',
  running: 'running',
  submitted: 'review',
  accepted: 'accepted',
  rejected: 'failed',
  failed: 'failed',
  canceled: 'neutral',
  lease_expired: 'blocked'
}

export const RUN_STATE_LABELS: Record<RunState, string> = {
  queued: 'QUEUED',
  running: 'RUNNING',
  awaiting_checkpoint: 'AWAITING CHECKPOINT',
  paused: 'PAUSED',
  failed: 'FAILED',
  canceled: 'CANCELED',
  completed: 'COMPLETED'
}

export const RUN_STATE_TONES: Record<RunState, Tone> = {
  queued: 'ready',
  running: 'running',
  awaiting_checkpoint: 'attention',
  paused: 'blocked',
  failed: 'failed',
  canceled: 'neutral',
  completed: 'accepted'
}
