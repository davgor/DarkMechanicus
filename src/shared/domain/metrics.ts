/**
 * Metric ingestion and the reads over it: what an agent session or an external MCP host reports into the SPACE
 * observation ledger (`space.ts`), the run's usage with its coverage, and a ticket's planned budget versions.
 */
import type { BudgetBasis } from './bundle'
import type {
  Accumulation,
  BaselineMetric,
  BudgetBaseline,
  EvidenceRef,
  Measurement,
  MetricAttributes,
  MetricKind,
  MetricObservation,
  MetricSourceKind,
  MetricUnit,
  UsageScope,
  WorkflowCause
} from './space'
import type { AttemptState } from './status'

/**
 * The sources an agent session may report as: `agent` (its own account) or `host` (telemetry its host read from the
 * provider). `human` is the desktop's and `server` is derived by Dark Mechanicus; neither is ever accepted over MCP.
 */
export const AGENT_METRIC_SOURCES: readonly MetricSourceKind[] = ['agent', 'host']

/**
 * One reported measurement. Its delivery identity is the stream (`source.actor`), the metric and, for a cumulative
 * report, its `sequence`, or, for a delta or event, the source's own `eventId`. The same identity always lands on the
 * same observation, so a retried delivery is never counted twice, and the same identity with another payload is a
 * `conflict`. `unit` must be the metric's fixed unit.
 */
export interface MetricReport {
  metric: MetricKind
  unit: MetricUnit
  /** Only `agent` and `host` are accepted (see `AGENT_METRIC_SOURCES`); any other kind is refused as `unauthorized`. */
  source: { kind: MetricSourceKind; actor: string }
  measurement: Measurement
  accumulation: Accumulation
  /** Cumulative reports only: the position in the stream. A later sequence never reports less than an earlier one. */
  sequence?: number
  /** Delta and event reports only: the source's id for the event, unique within its stream and metric. */
  eventId?: string
  observedAt: string
  attributes?: MetricAttributes
  evidence?: EvidenceRef[]
  cause?: WorkflowCause
  usage?: UsageScope
}

/**
 * Usage of one attempt. A worker proves its live claim with the claim token and may report only that attempt; an
 * orchestrator of the run may report any of the run's attempts without one (an external host relaying usage).
 */
export interface RecordAttemptMetricsInput {
  attemptId: string
  claimToken?: string
  reports: MetricReport[]
}

/**
 * What run-level overhead is: orchestrating the run, reviewing submissions, verifying increments, or `unattributed`
 * usage a host read but could not tie to one attempt through a session link (a reviewer or helper thread without a
 * claim). Unattributed usage counts once in the run totals and is shown as its own bucket, never dropped or guessed.
 */
export const OVERHEAD_KINDS = ['orchestration', 'review', 'verification', 'unattributed'] as const
export type OverheadKind = (typeof OVERHEAD_KINDS)[number]

/** Overhead no single attempt owns, in the run's bucket (optionally the bucket of one of its sprints). */
export interface RecordRunMetricsInput {
  runId: string
  sprintId?: string
  overhead: OverheadKind
  reports: MetricReport[]
}

export interface RecordMetricsResultView {
  /** The stored observations, in report order. */
  observations: MetricObservation[]
  /** Ids stored by this call. */
  created: string[]
  /** Ids already stored with the same payload (a repeated delivery): nothing was written for them. */
  unchanged: string[]
}

/** The token and active-time metrics whose coverage the run read reports. */
export const USAGE_METRICS = [
  'tokens_input',
  'tokens_cached_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_total',
  'active_ms'
] as const satisfies readonly MetricKind[]
export type UsageMetric = (typeof USAGE_METRICS)[number]

/**
 * How much of one metric a bucket reported: `observed` numbers only, numbers some of which are `estimated`, numbers
 * with a known gap beside them (`partial`: a stream reported missing, so the value is only a lower bound, or reported
 * `partial_coverage` while still growing, with no number yet: value null), only `unavailable` (the host said it
 * cannot report it), or nothing usable (`unreported`). Unknown is never zero.
 */
const USAGE_COVERAGE_STATES = ['observed', 'estimated', 'partial', 'unavailable', 'unreported'] as const
export type UsageCoverageState = (typeof USAGE_COVERAGE_STATES)[number]

/**
 * One bucket's total of one metric: cumulative streams count their latest report, deltas add up, nested usage once,
 * and one delivery reported by both an agent and its host counts once (the host's).
 */
export interface UsageCellView {
  metric: UsageMetric
  unit: MetricUnit
  coverage: UsageCoverageState
  /** Null exactly when nothing numeric was reported. */
  value: number | null
}

export interface AttemptUsageView {
  attemptId: string
  ticketId: string
  number: number
  state: AttemptState
  usage: UsageCellView[]
}

/**
 * A run total of one metric. `measurement` is `observed` (or `estimated`) only when every executing attempt reported
 * fully and the overhead bucket holds no known gap; otherwise it is `missing` (`partial_coverage` when anything was
 * reported, `host_unavailable` when every gap is a host that cannot report it, else `not_reported`), and
 * `reportedValue` is only a lower bound. Nesting is resolved across the whole run, so usage inside an inclusive report
 * in another bucket counts once.
 */
export interface UsageTotalView {
  metric: UsageMetric
  unit: MetricUnit
  measurement: Measurement
  /** Executing attempts plus run overhead, as far as reported; null when nothing numeric was. */
  reportedValue: number | null
  /** Executing attempts by coverage state. */
  attempts: Record<UsageCoverageState, number>
  /** Run-level overhead as far as reported; null when none was. */
  overhead: number | null
  /**
   * The overhead bucket's coverage. A complete total with `unreported` overhead counts no overhead: nobody reported
   * any, which is not a statement that none was spent.
   */
  overheadCoverage: UsageCoverageState
}

export interface GetRunMetricsInput {
  runId: string
  /** Lists only this attempt's observations (the usage tables always cover the whole run). */
  attemptId?: string
  /** Includes the stored observations with their provenance (source, actor, delivery identity, times, evidence). */
  includeObservations?: boolean
}

/** One overhead kind's share of the run bucket. */
interface OverheadUsageView {
  overhead: OverheadKind
  usage: UsageCellView[]
}

export interface RunMetricsView {
  runId: string
  epicId: string
  /** Attempts that executed (every claimed work attempt, in any state), in claim order. */
  attempts: AttemptUsageView[]
  /** Carry-forward attempts: they ran nothing, so they carry no usage and are not counted as gaps. */
  carriedForward: string[]
  /** Run-level overhead (orchestration, review, verification and unattributed together) for each metric. */
  overhead: UsageCellView[]
  /** The same overhead per kind, for every kind that holds an observation, so unattributed usage stays visible. */
  overheadByKind: OverheadUsageView[]
  totals: UsageTotalView[]
  /** How many observations the run (or the chosen attempt) holds. */
  observationCount: number
  /** The observations themselves when asked for, oldest first, at most `RUN_METRICS_OBSERVATION_LIMIT`. */
  observations: MetricObservation[] | null
}

export const RUN_METRICS_OBSERVATION_LIMIT = 2_000

/** Where a budget version stands for the ticket's run: the one it uses, an earlier one, or a later (prospective) one. */
const BUDGET_VERSION_STATUSES = ['pinned', 'superseded', 'prospective'] as const
export type BudgetVersionStatus = (typeof BUDGET_VERSION_STATUSES)[number]

/**
 * One saved budget version: a saved revision that changed the ticket's budget for this metric. `value` null means that
 * revision cleared the budget. `frozenAt` is the server time the revision was saved; `basis` is where the revision's
 * budget said its numbers came from (null when it did not say).
 */
export interface BudgetVersionView {
  /** The budget baseline's id (`bl_…`), derived from the revision, ticket and metric; null for a clearing version. */
  baselineId: string | null
  metric: BaselineMetric
  unit: MetricUnit
  version: number
  value: number | null
  basis: BudgetBasis | null
  revisionId: string
  revisionNumber: number
  frozenAt: string
  status: BudgetVersionStatus
}

/**
 * `frozen`: the ticket was dispatched and this budget, saved before dispatch in the revision it ran under, applies.
 * `planned`: not dispatched yet; the pinned revision's budget would apply. `none`: no budget applies.
 */
const PLANNED_BUDGET_STATES = ['frozen', 'planned', 'none'] as const
type PlannedBudgetState = (typeof PLANNED_BUDGET_STATES)[number]

export interface PlannedBudgetView {
  metric: BaselineMetric
  unit: MetricUnit
  state: PlannedBudgetState
  /** The budget baseline that applies (or would on dispatch); null when none does. */
  applied: BudgetBaseline | null
  versions: BudgetVersionView[]
  /** An unsaved draft change to this budget against the epic's current saved revision; null when there is none. */
  draft: { value: number | null; basis: BudgetBasis | null } | null
}

export interface TicketPlannedBaselinesView {
  ticketId: string
  key: string
  title: string
  /** The server time of the ticket's first claim in the run; null when not dispatched (or without a run). */
  dispatchedAt: string | null
  /** The revision whose budget applies: the one the ticket was first dispatched under, else the run's (or the epic's). */
  pinnedRevisionId: string
  budgets: PlannedBudgetView[]
}

export interface GetPlannedBaselinesInput {
  epicId: string
  /** Pins budgets to this run's dispatches and revision; without it, to the epic's current saved revision. */
  runId?: string
}

export interface PlannedBaselinesView {
  epicId: string
  runId: string | null
  currentRevisionId: string
  /** The revision the run is on now; null without a run. */
  runRevisionId: string | null
  tickets: TicketPlannedBaselinesView[]
}
