/**
 * Activity timelines: read models that merge what Dark Mechanicus knows about an attempt, or about a run,
 * into one time-ordered list a person can follow. Entries are small, typed and vendor-neutral: they carry
 * facts (who, what, when) and never a claim token. A new source (a chat stream, say) adds one member to
 * `ActivityEntry`; nothing else in these shapes changes. Narrow an entry with its `kind`, or name one member with
 * `Extract<ActivityEntry, { kind: 'note' }>`.
 */
import type { ReasoningEffort } from './bundle'
import type { AttemptState, RunState } from './status'
import type { SessionRole } from './views'

/** Who did something. `id` is null (and `role` too) for an entry no session wrote. */
export interface ActivitySession {
  id: string | null
  role: SessionRole | null
  label: string
}

interface EntryBase {
  /**
   * Stable within one timeline. A later page that carries an entry with the same id replaces the entry
   * the client holds (an alive span grows that way); an unknown id is appended.
   */
  id: string
  /** When it happened, ISO 8601 UTC; for an alive span, when its first heartbeat arrived. */
  at: string
  /** The session that did it; null when no session is on record. */
  sessionId: string | null
}

interface AttemptRef {
  attemptId: string
  ticketId: string
}

/** The worker named on a claim. */
interface ActivityWorker {
  label: string
  modelId: string | null
  hostId: string | null
  effort: ReasoningEffort | null
  rationale: string | null
}

/** A worker took the ticket. */
interface ClaimEntry extends EntryBase, AttemptRef {
  kind: 'claim'
  number: number
  worker: ActivityWorker
}

/** An earlier acceptance of the ticket was carried into this run without new work. */
interface CarriedForwardEntry extends EntryBase, AttemptRef {
  kind: 'carried_forward'
  note: string
}

/**
 * The attempt's heartbeats, collapsed: first heartbeat (`at`) to the latest (`until`). Heartbeats are not
 * stored one by one, so the span says the worker was alive in that window, not how many beats there were.
 * `active` is true while the attempt still holds a lease, i.e. while the span can grow.
 */
interface AliveEntry extends EntryBase, AttemptRef {
  kind: 'alive'
  until: string
  leaseExpiresAt: string | null
  active: boolean
}

/** A progress note the worker sent with a heartbeat. */
interface NoteEntry extends EntryBase, AttemptRef {
  kind: 'note'
  text: string
  step: string | null
}

/** A comment on the attempt's ticket, written while the attempt was open. */
interface CommentEntry extends EntryBase {
  kind: 'comment'
  ticketId: string | null
  commentId: string
  body: string
  author: { role: SessionRole; label: string }
}

interface SubmittedEntry extends EntryBase, AttemptRef {
  kind: 'submitted'
  summary: string
}

/** The reviewer's verdict on a submission. */
interface DecisionEntry extends EntryBase, AttemptRef {
  kind: 'decision'
  outcome: 'accepted' | 'rejected'
  reasons: string[]
  notes: string
  decidedBy: string
}

interface FailedEntry extends EntryBase, AttemptRef {
  kind: 'failed'
  reason: string
  retryable: boolean
}

/** The lease ran out (`timeout`) or the run moved to another machine (`takeover`); the attempt needs reconciling. */
interface LeaseExpiredEntry extends EntryBase, AttemptRef {
  kind: 'lease_expired'
  cause: 'timeout' | 'takeover'
  leaseExpiresAt: string | null
}

interface ReconciledEntry extends EntryBase, AttemptRef {
  kind: 'reconciled'
  resolution: 'abandon' | 'resubmit'
}

/** The run ended (canceled or failed) while the attempt was open. */
interface CanceledEntry extends EntryBase, AttemptRef {
  kind: 'canceled'
  reason: string | null
}

type RunChange =
  | 'queued'
  | 'started'
  | 'paused'
  | 'resumed'
  | 'leases_extended'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'taken_over'

/** A change to the run itself. */
interface RunChangeEntry extends EntryBase {
  kind: 'run'
  change: RunChange
  reason: string | null
}

interface ReportEntry extends EntryBase {
  kind: 'report'
  sprintId: string
  reportRevision: number
}

/** A person's (or the policy's) decision at a sprint checkpoint: the approval, then the advance. */
interface CheckpointEntry extends EntryBase {
  kind: 'checkpoint'
  step: 'approved' | 'advanced'
  sprintId: string
  /** The sprint the run moved to; null for an approval. */
  toSprintId: string | null
  policy: 'human' | 'auto' | null
}

export type ActivityEntry =
  | ClaimEntry
  | CarriedForwardEntry
  | AliveEntry
  | NoteEntry
  | CommentEntry
  | SubmittedEntry
  | DecisionEntry
  | FailedEntry
  | LeaseExpiredEntry
  | ReconciledEntry
  | CanceledEntry
  | RunChangeEntry
  | ReportEntry
  | CheckpointEntry

/** Paging of a timeline: entries after `sinceSeq` (0 or absent: the whole history), at most `limit` of them. */
export interface TimelineWindow {
  sinceSeq?: number
  limit?: number
}

export interface AttemptTimelineView {
  attemptId: string
  runId: string
  ticketId: string
  state: AttemptState
  /** True while the attempt is open (claimed, running or awaiting review): keep polling. */
  isLive: boolean
  /**
   * Pass back as `sinceSeq` to get only what is new. While the attempt holds a lease, every page also
   * carries its alive span again (same id, later `until`), because heartbeats grow it without a new entry.
   */
  cursor: number
  entries: ActivityEntry[]
  /** The sessions the entries name, once each. */
  sessions: ActivitySession[]
}

/** One session's entries in a run timeline, oldest first. */
export interface RunActivityGroup {
  session: ActivitySession
  entries: ActivityEntry[]
}

export interface RunTimelineView {
  runId: string
  epicId: string
  state: RunState
  /** True while the run is active (queued, running, awaiting its checkpoint or paused): keep polling. */
  isLive: boolean
  cursor: number
  /** Sessions in the order they first acted; a session with nothing new in this page is left out. */
  groups: RunActivityGroup[]
}
