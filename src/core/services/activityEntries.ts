/**
 * How one logged event becomes one timeline entry. Each table maps an event kind to a function that builds
 * the entry's own fields; `entryOf` adds the id, time and session every entry shares. Attempt facts that the
 * event does not carry (the worker, the summary, the verdict) come from the attempt as it is now.
 */
import type { ActivityEntry } from '../../shared/domain/activity'
import type { AttemptView, EventView, WorkerInfo } from '../../shared/domain/views'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type EntryOf<K extends ActivityEntry['kind']> = Extract<ActivityEntry, { kind: K }>

/** An entry without the fields every entry shares. */
type EntryBody = DistributiveOmit<ActivityEntry, 'id' | 'at' | 'sessionId'>

/** An entry and the event it came from; the event's `seq` orders entries and drives the cursor. */
export interface Draft {
  seq: number
  entry: ActivityEntry
}

type AttemptBody = (event: EventView, attempt: AttemptView) => EntryBody | null
type RunBody = (event: EventView) => EntryBody | null

export function entryOf(event: EventView, body: EntryBody): ActivityEntry {
  return { id: `event:${event.seq}`, at: event.at, sessionId: event.sessionId, ...body }
}

export function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function ref(attempt: AttemptView): { attemptId: string; ticketId: string } {
  return { attemptId: attempt.id, ticketId: attempt.ticketId }
}

function workerOf(worker: WorkerInfo): EntryOf<'claim'>['worker'] {
  return {
    label: worker.label,
    modelId: worker.modelId,
    hostId: worker.hostId,
    effort: worker.effort ?? null,
    rationale: worker.rationale
  }
}

const claimed: AttemptBody = (_event, attempt) => ({
  kind: 'claim',
  ...ref(attempt),
  number: attempt.number,
  worker: workerOf(attempt.worker)
})

const carriedForward: AttemptBody = (event, attempt) => ({
  kind: 'carried_forward',
  ...ref(attempt),
  note: text(event.payload.note) ?? ''
})

const submitted: AttemptBody = (_event, attempt) => ({
  kind: 'submitted',
  ...ref(attempt),
  summary: attempt.outputs?.summary ?? ''
})

const decided: AttemptBody = (event, attempt) => ({
  kind: 'decision',
  ...ref(attempt),
  outcome: event.kind === 'attempt.accepted' ? 'accepted' : 'rejected',
  reasons: attempt.decision?.reasons ?? texts(event.payload.reasons),
  notes: attempt.decision?.notes ?? '',
  decidedBy: attempt.decision?.decidedBy ?? ''
})

const failed: AttemptBody = (event, attempt) => ({
  kind: 'failed',
  ...ref(attempt),
  reason: text(event.payload.reason) ?? attempt.failure?.reason ?? '',
  retryable: attempt.failure?.retryable ?? true
})

const leaseExpired: AttemptBody = (event, attempt) => ({
  kind: 'lease_expired',
  ...ref(attempt),
  cause: 'timeout',
  leaseExpiresAt: text(event.payload.leaseExpiresAt)
})

const reconciled: AttemptBody = (event, attempt) => ({
  kind: 'reconciled',
  ...ref(attempt),
  resolution: event.payload.resolution === 'resubmit' ? 'resubmit' : 'abandon'
})

/** The events of one attempt that both timelines list, keyed by event kind. */
export const LIFECYCLE_BODIES: Readonly<Record<string, AttemptBody>> = {
  'attempt.claimed': claimed,
  'attempt.carried_forward': carriedForward,
  'attempt.submitted': submitted,
  'attempt.accepted': decided,
  'attempt.rejected': decided,
  'attempt.failed': failed,
  'attempt.lease_expired': leaseExpired,
  'attempt.reconciled': reconciled
}

const note: AttemptBody = (event, attempt) => ({
  kind: 'note',
  ...ref(attempt),
  text: text(event.payload.note) ?? '',
  step: text(event.payload.step)
})

const runEnded: AttemptBody = (event, attempt) =>
  texts(event.payload.canceledAttempts).includes(attempt.id)
    ? { kind: 'canceled', ...ref(attempt), reason: text(event.payload.reason) }
    : null

const takenOver: AttemptBody = (event, attempt) =>
  texts(event.payload.expiredAttempts).includes(attempt.id)
    ? { kind: 'lease_expired', ...ref(attempt), cause: 'takeover', leaseExpiresAt: null }
    : null

/** What an attempt timeline lists besides the lifecycle: its notes, and the run events that closed it. */
export const ATTEMPT_ONLY_BODIES: Readonly<Record<string, AttemptBody>> = {
  'attempt.progress': note,
  'run.canceled': runEnded,
  'run.failed': runEnded,
  'run.taken_over': takenOver
}

function runChange(change: EntryOf<'run'>['change'], reason: (event: EventView) => string | null = () => null): RunBody {
  return (event) => ({ kind: 'run', change, reason: reason(event) })
}

const reasonOf = (event: EventView): string | null => text(event.payload.reason)

const reported: RunBody = (event) => ({
  kind: 'report',
  sprintId: text(event.payload.sprintId) ?? '',
  reportRevision: count(event.payload.reportRevision)
})

const approved: RunBody = (event) => ({
  kind: 'checkpoint',
  step: 'approved',
  sprintId: text(event.payload.sprintId) ?? '',
  toSprintId: null,
  policy: null
})

const advanced: RunBody = (event) => ({
  kind: 'checkpoint',
  step: 'advanced',
  sprintId: text(event.payload.fromSprintId) ?? '',
  toSprintId: text(event.payload.toSprintId),
  policy: event.payload.policy === 'auto' || event.payload.policy === 'human' ? event.payload.policy : null
})

/** The events of the run itself that a run timeline lists, keyed by event kind. */
export const RUN_BODIES: Readonly<Record<string, RunBody>> = {
  'run.queued': runChange('queued'),
  'run.started': runChange('started'),
  'run.paused': runChange('paused', reasonOf),
  'run.resumed': runChange('resumed'),
  'run.leases_extended': runChange('leases_extended'),
  'run.completed': runChange('completed'),
  'run.canceled': runChange('canceled', reasonOf),
  'run.failed': runChange('failed', reasonOf),
  'run.taken_over': runChange('taken_over'),
  'report.submitted': reported,
  'checkpoint.approved': approved,
  'checkpoint.advanced': advanced
}
