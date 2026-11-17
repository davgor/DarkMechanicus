/**
 * E, T and K inputs from records: how much of the observed effort was corrective (E), and how the active time (T) and
 * tokens (K) a subject used compare with a frozen baseline. Built by `src/core/space/efficiency.ts` (pure) and
 * `src/core/services/efficiency.ts` (one run's records as of a cutoff); `gradeSpace` consumes `E`, `T` and `K`.
 *
 * E is the corrective share of classified effort, never a reward for little effort; T and K are resource economy
 * against a baseline. Unknown effort or usage makes a measure missing, never zero and never imputed.
 */
import type {
  BaselineMetric,
  CohortBaseline,
  CohortKey,
  EfficiencyInput,
  Measurement,
  ObservationMissingReason,
  ResourceInput,
  WorkflowCause
} from './space'
import type { AttemptTimingOutcome, TimingAnomaly, TimingCoverage, TimingState, WaitClass } from './timing'

/**
 * How a `corrective_effort_ms` observation classifies effort (attribute `classification`).
 * - `corrective`: repairing work that should not have needed it (a rejected or broken result, a misunderstood
 *   requirement, a broken tool). It names its `cause` when known.
 * - `productive`: work the ticket needed: planned implementation, planned tests and verification, useful
 *   investigation of a complex problem (attribute `work`, for example `research` or `planned_test`).
 */
export const EFFORT_CLASSIFICATIONS = ['corrective', 'productive'] as const
export type EffortClassification = (typeof EFFORT_CLASSIFICATIONS)[number]

/** A corrective record without a cause is still corrective; its cause is shown as `unstated`, never guessed. */
export type CorrectiveCause = WorkflowCause | 'unstated'

/** What an efficiency read covers: one ticket of the run, one sprint of the run, or the whole run. */
export type EfficiencyScope = { level: 'ticket'; ticketId: string; sprintId: string | null } | { level: 'sprint'; sprintId: string } | { level: 'run' }

/** E's denominator: the observed effort of the scope (every actor's activity, summed), with its coverage. */
export interface EffortDenominator {
  /** `resource_effort` total in milliseconds; null when nothing was measured. */
  effortMs: number | null
  state: TimingState
  /** Attempts whose worker reported activity, of the attempts that ran in scope. */
  coverage: TimingCoverage
  /** The non-worker part (orchestration, review, verification, other), already inside `effortMs`. */
  overheadMs: number | null
}

/** One executed attempt, shown beside E: retries are a diagnostic, never wasted time. */
interface RetriedAttemptView {
  attemptId: string
  ticketId: string
  number: number
  outcome: AttemptTimingOutcome
  superseded: boolean
  /** The attempt's own effort (all actors, inside its window); null when nothing was measured. */
  effortMs: number | null
}

export interface RetryDiagnostic {
  /** Attempts after each ticket's first; null when no attempt ran. */
  retries: number | null
  attempts: RetriedAttemptView[]
}

/** The corrective/productive split E is scored from, with the effort it is a share of. */
export interface EffortClassificationView {
  denominator: EffortDenominator
  /** Classified ms by class, as reported (null when a record of that class is missing its value). */
  correctiveMs: number | null
  productiveMs: number | null
  /** Effort no record classified: `effortMs − classified`; null when either side is unknown. */
  unclassifiedMs: number | null
  /** Classified ÷ effort, 0–1; null when either is unknown or the effort is zero. */
  classificationCoverage: number | null
  correctiveByCause: Partial<Record<CorrectiveCause, number>>
  /** Productive ms by the `work` attribute (`unspecified` when absent): research and planned tests stay productive. */
  productiveByWork: Record<string, number>
  /** The classification observations used. */
  observationIds: string[]
  retries: RetryDiagnostic
}

/**
 * Activity known to exist but not counted: an `active_ms` record without a value (`missing_span`), one the timing
 * projection refused or could not place in time (`refused_span`: inconsistent with its value, inverted, an unparseable
 * time, an amount with no start), or a usage stream whose latest report is a `partial_coverage` gap (a host thread
 * still working, its span still open).
 */
export interface ActivityGap {
  kind: 'missing_span' | 'refused_span' | 'unsettled_stream'
  observationId: string
  metric: string
  actor: string | null
  attemptId: string | null
  reason: ObservationMissingReason
}

/** The actual T or K compares, and why it is (or is not) complete. */
export interface ResourceActualView {
  metric: BaselineMetric
  actual: Measurement
  /** As far as reported (a lower bound when `actual` is missing); null when nothing numeric was. */
  reportedValue: number | null
  /** Executed attempts in scope (carried-forward ones ran nothing here and are not counted). */
  attempts: number
  /** Attempts that ran but reported nothing: any makes the component `partial_telemetry`. */
  unreportedAttemptIds: string[]
  /** Attempts still open at the cutoff: the actual is only a lower bound. */
  openAttemptIds: string[]
  gaps: ActivityGap[]
  /** Active time only: the part spent by actors other than the workers (review, orchestration, verification). */
  overheadValue: number | null
  /** Active time only: waits in scope, shown and never counted as active (human approval, queue, review, …). */
  excludedWaitsMs: Partial<Record<WaitClass, number>> | null
}

/** One prior ticket in a cohort, with the value it used. */
export interface CohortMemberView {
  ticketId: string
  runId: string
  value: number
  /** The latest server time of the records the value was built from, always before the subject's dispatch. */
  basisAt: string
  /** Outside the Tukey fences (1.5 × the interquartile range beyond p25/p75); shown, still in the median. */
  outlier: boolean
}

/** Why a prior accepted ticket was not a cohort member. */
const COHORT_EXCLUSIONS = ['cohort_mismatch', 'no_cohort_key', 'subject', 'not_observed', 'zero_value'] as const
export type CohortExclusion = (typeof COHORT_EXCLUSIONS)[number]

/**
 * The cohort baseline for one subject and metric. Its candidates are the tickets accepted (and still standing) before
 * the subject's dispatch, each measured only from records stored strictly before that dispatch; later records are
 * ignored, so the member set, values and baseline id are the same at every cutoff from the dispatch on. Null
 * `baseline` with a reason when no cohort can be formed; a cohort below the policy's minimum sample is still built and
 * refused by selection (`sample_too_small`), so its size stays visible.
 */
export interface CohortView {
  metric: BaselineMetric
  key: CohortKey | null
  baseline: CohortBaseline | null
  missingReason: 'no_cohort_key' | 'no_members' | 'not_dispatched' | null
  members: CohortMemberView[]
  outlierTicketIds: string[]
  excluded: { ticketId: string; runId: string; reason: CohortExclusion }[]
}

/**
 * Input the efficiency read could not use, kept visible instead of silently dropped: the timing projection's own
 * anomalies (refused spans, re-deliveries, host-over-agent drops, unattributed records) and the read's.
 */
export interface EfficiencyAnomaly {
  kind: TimingAnomaly['kind'] | 'unknown_classification' | 'not_an_event' | 'over_classified'
  subject: string
  detail: string
}

/** E, T and K inputs of one scope, with what they were built from. */
export interface ScopeEfficiencyView {
  scope: EfficiencyScope
  /** What `gradeSpace` consumes as `components.E`, `components.T` and `components.K`. */
  E: EfficiencyInput
  T: ResourceInput
  K: ResourceInput
  classification: EffortClassificationView
  time: ResourceActualView
  tokens: ResourceActualView
}

export interface TicketEfficiencyView extends ScopeEfficiencyView {
  /** The ticket's first claim in the run (server time); null when it was never dispatched. */
  dispatchedAt: string | null
  /** The cohort key from the plan revision the ticket was first dispatched under; null when it has no size. */
  cohortKey: CohortKey | null
  cohorts: { T: CohortView; K: CohortView }
}

/**
 * A run's E, T and K inputs as of `cutoff`: per ticket (with baselines: budgets apply only to ticket grades), and per
 * sprint and for the whole run (actuals only; their baseline is left `no_eligible_baseline` here, so aggregate grades
 * roll up from the ticket measures).
 */
export interface RunEfficiencyView {
  runId: string
  cutoff: string
  tickets: TicketEfficiencyView[]
  sprints: ScopeEfficiencyView[]
  run: ScopeEfficiencyView
  anomalies: EfficiencyAnomaly[]
}
