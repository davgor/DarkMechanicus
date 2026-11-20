/**
 * Timing projection: how long work took, how much of it was measured activity, and what the rest was waiting on.
 *
 * Every number is a `TimingQuantity` that names what it counts (`quantity`), its unit, how it was aggregated and
 * how much of it the evidence covers, so a claim-to-submit elapsed time can never be read as active time, and a
 * sum of parallel effort can never be read as wall-clock time. The pure projection is `projectTiming`
 * (`src/core/space/timing.ts`); `projectRunTiming` (`src/core/services/timing.ts`) feeds it a run's records.
 */

/**
 * What a stretch of time was spent on.
 * - `active`: measured activity (host or agent activity spans) of the worker that held the attempt.
 * - `queue`: the ticket was ready (or awaiting a retry or reconciliation decision by the orchestrator, including the
 *   orchestrator's own retry of a ticket at its retry limit) and nobody held it.
 * - `build_test`: a host-reported wait on a build or test run.
 * - `blocked`: the run was paused, or a host reported the worker blocked.
 * - `review`: a submission waited for its review decision.
 * - `human_approval`: waiting for a person (a sprint checkpoint, a retry grant, or a host-reported approval prompt).
 * - `unknown`: no record says what happened. Never read as active, idle or waste.
 *
 * There is no "waste" class: planned verification and research spans are `active`, and a retried attempt's time
 * is classified like any other attempt's.
 */
const TIMING_CLASSES = ['active', 'queue', 'build_test', 'blocked', 'review', 'human_approval', 'unknown'] as const
export type TimingClass = (typeof TIMING_CLASSES)[number]

/** The classes that are waits: time that passed while no measured work happened. */
export const WAIT_CLASSES = ['queue', 'build_test', 'blocked', 'review', 'human_approval'] as const
export type WaitClass = (typeof WAIT_CLASSES)[number]

/** Why a segment has its class; `unknown` segments always say why nothing classified them. */
const SEGMENT_REASONS = [
  'activity_span',
  'host_wait',
  'run_paused',
  'ready_unclaimed',
  'awaiting_review',
  'awaiting_reconciliation',
  'awaiting_retry_grant',
  'awaiting_orchestrator_retry',
  'sprint_checkpoint',
  'no_activity_evidence',
  'after_last_signal',
  'no_lifecycle_evidence'
] as const
export type SegmentReason = (typeof SEGMENT_REASONS)[number]

/** Where a segment's class came from. */
export type SegmentEvidence = 'lifecycle' | 'host' | 'agent' | 'none'

export interface TimingSegment {
  class: TimingClass
  reason: SegmentReason
  evidence: SegmentEvidence
  start: string
  end: string
  ms: number
}

/**
 * What a timing number counts. Each kind is a distinct type, so code that wants active time cannot be handed an
 * elapsed time.
 * - `ticket_cycle_time`: a ticket's first claim to its acceptance (or the run's end, or the cutoff).
 * - `ticket_lead_time`: the ticket becoming ready to the same end; missing when readiness is not on record.
 * - `attempt_elapsed`: claim to submit (or failure, cancel, lease deadline, cutoff). Elapsed only, never active.
 * - `window_elapsed`: a sprint's or run's start to end.
 * - `measured_active`: the union of the attempt worker's own activity spans, inside the attempt.
 * - `classified_wait`: time in one wait class.
 * - `unclassified`: time no record classified (`unknown`).
 * - `resource_effort`: activity spans summed over every actor (parallel work adds up).
 * - `in_flight_wall_clock`: the union of attempt windows (claim to submit or end): when any attempt was open.
 * - `active_wall_clock`: the union of every activity span: when anyone was measurably working.
 */
export const TIMING_QUANTITIES = [
  'ticket_cycle_time',
  'ticket_lead_time',
  'attempt_elapsed',
  'window_elapsed',
  'measured_active',
  'classified_wait',
  'unclassified',
  'resource_effort',
  'in_flight_wall_clock',
  'active_wall_clock'
] as const
export type TimingQuantityKind = (typeof TIMING_QUANTITIES)[number]

/**
 * - `observed`: every input it needs is on record.
 * - `estimated`: some input was an estimated value.
 * - `partial`: a number, but some attempts or streams it should cover reported nothing (`coverage` says how many).
 * - `missing`: no number (`ms` is null); never zero.
 */
export type TimingState = 'observed' | 'estimated' | 'partial' | 'missing'

/**
 * How much of what a quantity should cover was covered by evidence: `covered` of `of`, counted in `unit`.
 * - `milliseconds` (elapsed, wait and unclassified quantities): classified milliseconds of the window.
 * - `attempts` (activity and effort quantities, and the in-flight wall clock): attempts whose worker reported
 *   activity (in flight: whose claim is on record), of the attempts counted; for overhead, reviewed attempts with an
 *   overhead span, of the reviewed attempts. In run totals an attempt with events but no claim on record is counted
 *   and never covered, so those totals read `partial`.
 * A quantity with nothing to cover (no window, no attempt, no span) is `missing`, never a covered zero; a missing
 * quantity always has `covered` 0, so it never reads as complete.
 */
export interface TimingCoverage {
  covered: number
  of: number
  unit: 'milliseconds' | 'attempts'
}

/**
 * - `single`: one interval or one classification of one subject.
 * - `union`: overlapping intervals counted once (wall clock).
 * - `sum`: summed over parallel actors, attempts or tickets, so it can exceed wall-clock time.
 */
export type TimingAggregation = 'single' | 'union' | 'sum'

export interface TimingQuantity<K extends TimingQuantityKind = TimingQuantityKind> {
  quantity: K
  unit: 'milliseconds'
  aggregation: TimingAggregation
  /** Null exactly when `state` is `missing`. */
  ms: number | null
  state: TimingState
  coverage: TimingCoverage
  /** True when the interval was still running at the cutoff, so the number is a lower bound. */
  open: boolean
}

/** Who an activity span belongs to. Spans of the attempt's worker are its `measured_active`; the rest is overhead. */
export const ACTIVITY_ROLES = ['worker', 'orchestrator', 'reviewer', 'other'] as const
export type ActivityRole = (typeof ACTIVITY_ROLES)[number]

/** How an attempt ended (or that it had not by the cutoff). */
const ATTEMPT_TIMING_OUTCOMES = [
  'accepted',
  'rejected',
  'awaiting_review',
  'failed',
  'canceled',
  'lease_expired',
  'open'
] as const
export type AttemptTimingOutcome = (typeof ATTEMPT_TIMING_OUTCOMES)[number]

/** What closed an elapsed window. `cutoff`: nothing had closed it by the cutoff, so it is still open there. */
export type WindowEnd = 'submitted' | 'failed' | 'canceled' | 'lease_expired' | 'accepted' | 'next_sprint' | 'run_ended' | 'cutoff'

export interface EffortTotals {
  /** Every actor's activity summed (`resource_effort`, aggregation `sum`). */
  total: TimingQuantity<'resource_effort'>
  /** The same split by actor role; overhead is everything but `worker`. */
  byRole: Record<ActivityRole, number>
  /**
   * Overhead (orchestrator, reviewer and other spans), kept visible beside the worker effort. Its coverage counts
   * the reviewed (submitted) attempts in scope that have any overhead span scoped to them; its state is estimated
   * only when an overhead span is.
   */
  overhead: TimingQuantity<'resource_effort'>
  /** Span time outside the window the span was scoped to (before the claim, after the run): not counted above. */
  outsideWindowMs: number
}

export type WaitTotals = Record<WaitClass, TimingQuantity<'classified_wait'>>

export interface AttemptTiming {
  attemptId: string
  ticketId: string
  /** The sprint its ticket is assigned to (see `SprintTiming.membership`). */
  sprintId: string | null
  number: number
  outcome: AttemptTimingOutcome
  /** Superseded by a plan adoption; its effort still counts. */
  superseded: boolean
  claimedAt: string
  endedAt: string | null
  endedBy: WindowEnd
  submittedAt: string | null
  decidedAt: string | null
  /** The last sign of life on record inside the attempt (claim, heartbeat, progress note, submit, activity span end). */
  lastSignalAt: string
  elapsed: TimingQuantity<'attempt_elapsed'>
  active: TimingQuantity<'measured_active'>
  waits: WaitTotals
  unknown: TimingQuantity<'unclassified'>
  effort: EffortTotals
  /** The attempt window from claim to end, classified; together the segments cover it exactly once. */
  segments: TimingSegment[]
}

/**
 * Effort buckets: an attempt's outcome (`superseded` whatever the outcome, once a plan adoption superseded it), or
 * `unscoped` for spans scoped to no attempt (run, sprint or ticket overhead). A span shared by several attempts is
 * counted in one bucket only, so the buckets add up to `effort.total`.
 */
export type OutcomeBucket = AttemptTimingOutcome | 'superseded' | 'unscoped'

/** A total for an outcome bucket: retried, failed and superseded attempts keep their effort. */
export interface OutcomeEffort {
  attempts: number
  elapsedMs: number
  /** The bucket's share of `effort.total`. */
  effortMs: number
  /** Attempts whose worker reported no activity: their effort is missing (or overhead only), never a measured 0. */
  unreported: number
  unknownMs: number
}

export type OutcomeEffortTotals = Partial<Record<OutcomeBucket, OutcomeEffort>>

export interface TicketTiming {
  ticketId: string
  sprintId: string | null
  /**
   * Accepted in an earlier run and carried forward: no time of this run is classified for it (no queue, no cycle),
   * so its cycle, lead and wait quantities are missing.
   */
  carriedForward: boolean
  readyAt: string | null
  firstClaimAt: string | null
  acceptedAt: string | null
  /** `accepted`, `run_ended`, or `cutoff` (still open). */
  endedBy: WindowEnd
  cycleTime: TimingQuantity<'ticket_cycle_time'>
  leadTime: TimingQuantity<'ticket_lead_time'>
  /** Waits and unknown time inside the cycle (first claim to end); missing without a claim. */
  waits: WaitTotals
  unknown: TimingQuantity<'unclassified'>
  /** The union of the attempts' measured active time inside the cycle. */
  active: TimingQuantity<'measured_active'>
  /** Ready to first claim: queue (or blocked while the run was paused). Missing when readiness is unknown. */
  waitBeforeDispatch: TimingQuantity<'classified_wait'>
  effort: EffortTotals
  /** Every attempt, including rejected, failed, canceled, expired and superseded ones. */
  effortByOutcome: OutcomeEffortTotals
  attempts: AttemptTiming[]
  /** The ticket's lead window (or cycle window when readiness is unknown), classified without overlap. */
  segments: TimingSegment[]
}

/** Sprint and run totals. Waits and unknown time are summed over tickets (ticket-milliseconds). */
export interface WindowTiming {
  elapsed: TimingQuantity<'window_elapsed'>
  startedAt: string | null
  endedAt: string | null
  endedBy: WindowEnd
  inFlight: TimingQuantity<'in_flight_wall_clock'>
  activeWallClock: TimingQuantity<'active_wall_clock'>
  effort: EffortTotals
  attemptElapsedSum: TimingQuantity<'attempt_elapsed'>
  waits: WaitTotals
  unknown: TimingQuantity<'unclassified'>
  effortByOutcome: OutcomeEffortTotals
}

export interface SprintTiming extends WindowTiming {
  sprintId: string
  /**
   * How tickets, attempts and spans are assigned to sprints, one rule for every total: a ticket (with all its
   * attempts, segments and spans) belongs to the sprint that holds it in the run's current plan revision; a ticket
   * the current plan no longer holds keeps its last attempt's sprint. Sprint ids of older revisions are mapped to
   * the current plan's the way plan adoption maps the active sprint (same id, else same ordinal). A span scoped to
   * no ticket belongs to the sprint its scope names. Anything that cannot be mapped is listed as `unattributed`.
   */
  membership: 'current_plan'
  ticketIds: string[]
  /** Report submitted to checkpoint approved: waiting on a person (part of `waits.human_approval`). */
  checkpointWait: TimingQuantity<'classified_wait'>
  /**
   * Run-scoped overhead (spans in no sprint) that fell inside this sprint's window. Shown as unattributed overhead
   * beside the sprint; never part of its `effort`.
   */
  unattributedOverhead: TimingQuantity<'resource_effort'>
}

export const TIMING_ANOMALY_KINDS = [
  'invalid_time',
  'duplicate_event',
  'event_out_of_place',
  'attempt_without_claim',
  'inconsistent_span',
  'negative_span',
  'not_an_interval',
  'unknown_wait_kind',
  'conflicting_delivery',
  'duplicate_source',
  'unattributed',
  'estimated_time'
] as const

/**
 * Input the projection could not use or attribute, kept visible instead of silently dropped. `estimated_time`: the
 * records did not hold an end the projection needed, so the feed placed it at the latest time they show (an imported
 * resubmitted attempt's lease expiry at its last heartbeat); the times built on it are estimates.
 */
export interface TimingAnomaly {
  kind: (typeof TIMING_ANOMALY_KINDS)[number]
  subject: string
  detail: string
}

export interface RunTiming extends WindowTiming {
  runId: string
  /** Records after this instant are ignored; open intervals end here. */
  asOf: string
  sprints: SprintTiming[]
  tickets: TicketTiming[]
  /** Effort of spans in no sprint (run-scoped orchestration): part of the run's effort, of no sprint's. */
  unattributedEffort: EffortTotals
  /** Carried-forward attempts: work done in an earlier run, never counted again here. */
  carriedForwardAttemptIds: string[]
  anomalies: TimingAnomaly[]
}
