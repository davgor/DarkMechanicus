/**
 * The SPACE grading and measurement contract: the shapes every scorecard producer and reader shares.
 *
 * Dark Mechanicus grades a ticket, run, sprint or epic on seven equally weighted components. Five follow the
 * SPACE framework (Satisfaction, Performance, Activity, Collaboration, Efficiency) and two measure resource
 * economy (execution time and tokens). The normalization, weights and letter bands are Dark Mechanicus's own
 * versioned policy, informed by SPACE; they are not an official SPACE formula or a validated benchmark.
 * docs/space-grading.md is the human-readable rubric; `src/core/space/rubric.ts` is its reference grader and
 * `src/core/space/contract.ts` validates serialized records against these types.
 *
 * Three rules run through every type here:
 * - Every value is observed, estimated or missing. Missing is never read as zero or as perfect.
 * - Every record names its unit, its scope (what it is about) and its source (who measured it).
 * - Every record that can be cited has a stable id, so a grade lists the evidence it was built from.
 */
import type { ReasoningLevel, TicketSize, WorkType } from './bundle'

// ---------------------------------------------------------------------------------------------------------------
// Components

/**
 * The seven graded components, in display order. S, P, A, C and E are the SPACE dimensions; T and K are
 * execution-time and token efficiency. E measures corrective work and flow, never raw time or token economy, so
 * a slow or expensive ticket is charged once (in T or K), not twice.
 */
export const SPACE_COMPONENTS = ['S', 'P', 'A', 'C', 'E', 'T', 'K'] as const
export type SpaceComponent = (typeof SPACE_COMPONENTS)[number]

export const SPACE_COMPONENT_LABELS: Readonly<Record<SpaceComponent, string>> = {
  S: 'Satisfaction',
  P: 'Performance',
  A: 'Activity (delivery against committed scope)',
  C: 'Collaboration',
  E: 'Efficiency and flow',
  T: 'Execution-time efficiency',
  K: 'Token efficiency'
}

/**
 * Whether a signal measures the thing itself (a person's stated rating, tokens a host counted) or stands in for
 * it (a handoff check passing stands in for collaboration quality).
 */
export const SIGNAL_KINDS = ['direct', 'proxy'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

// ---------------------------------------------------------------------------------------------------------------
// Units, scope, source and measurement state

export const METRIC_UNITS = ['tokens', 'milliseconds', 'minutes', 'count', 'rating_1_5', 'pass_fail'] as const
export type MetricUnit = (typeof METRIC_UNITS)[number]

/** The level a record is about. Each level carries the ids above it (an attempt names its ticket and run). */
export const METRIC_SCOPE_LEVELS = ['project', 'epic', 'sprint', 'run', 'ticket', 'attempt'] as const
type MetricScopeLevel = (typeof METRIC_SCOPE_LEVELS)[number]

/**
 * What a record is about. `level` names the most specific id that is set; every id the level requires is set
 * (see `SCOPE_REQUIRED_IDS`), and ids the record cannot know are null.
 */
export interface MetricScope {
  level: MetricScopeLevel
  epicId: string | null
  sprintId: string | null
  runId: string | null
  ticketId: string | null
  attemptId: string | null
}

/** The ids each scope level must set. A project-level record (overhead not owned by any epic) sets none. */
export const SCOPE_REQUIRED_IDS: Readonly<Record<MetricScopeLevel, readonly (keyof Omit<MetricScope, 'level'>)[]>> = {
  project: [],
  epic: ['epicId'],
  sprint: ['epicId', 'sprintId'],
  run: ['epicId', 'runId'],
  ticket: ['epicId', 'ticketId'],
  attempt: ['epicId', 'runId', 'ticketId', 'attemptId']
}

/**
 * Who measured a value.
 * - `human`: a person, entered in the desktop app. The only source of satisfaction ratings and rescue time.
 * - `server`: derived by Dark Mechanicus from its own lifecycle records (claims, submissions, reviews, plan
 *   revisions). Authoritative times such as dispatch and baseline freezing come only from here.
 * - `host`: telemetry an agent host adapter read from the provider (token usage, activity spans).
 * - `agent`: self-reported by a session over MCP, scoped to what that session owns.
 */
export const METRIC_SOURCES = ['human', 'server', 'host', 'agent'] as const
export type MetricSourceKind = (typeof METRIC_SOURCES)[number]

interface MetricSource {
  kind: MetricSourceKind
  /** The session id, adapter name or desktop user that produced the value; null when the server derived it. */
  actor: string | null
}

export const MEASUREMENT_STATES = ['observed', 'estimated', 'missing'] as const
export type MeasurementState = (typeof MEASUREMENT_STATES)[number]

/** Why a value is missing at the observation level. */
export const OBSERVATION_MISSING_REASONS = [
  /** Nothing reported it, though the source could have. */
  'not_reported',
  /** The host or adapter cannot report this measure at all. */
  'host_unavailable',
  /** Some of the work it covers reported and some did not, so no total can be claimed. */
  'partial_coverage'
] as const
export type ObservationMissingReason = (typeof OBSERVATION_MISSING_REASONS)[number]

/**
 * One value and how much to trust it. `estimated` values are labeled with their method and never make a grade
 * final; `missing` values carry no number at all.
 */
export type Measurement =
  | { state: 'observed'; value: number }
  | { state: 'estimated'; value: number; method: string }
  | { state: 'missing'; reason: ObservationMissingReason }

// ---------------------------------------------------------------------------------------------------------------
// Evidence

export const EVIDENCE_KINDS = [
  'observation',
  'baseline',
  'attempt',
  'run',
  'ticket',
  'sprint',
  'report',
  'comment',
  /** `id` is the ticket id; `detail` is the criterion id (`c1`). */
  'criterion',
  /** `id` is the attempt id the check was reported on; `detail` is the check name. */
  'check',
  /** `id` is a commit hash. */
  'commit'
] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** A citation of a record a value or grade was built from. */
export interface EvidenceRef {
  kind: EvidenceKind
  id: string
  detail: string | null
}

// ---------------------------------------------------------------------------------------------------------------
// Observations

/** How a reported number combines with earlier reports from the same source stream. */
export const ACCUMULATIONS = ['delta', 'cumulative', 'event'] as const
export type Accumulation = (typeof ACCUMULATIONS)[number]

export const METRIC_KINDS = [
  'tokens_input',
  'tokens_cached_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_total',
  'active_ms',
  'elapsed_ms',
  'wait_ms',
  'human_rating',
  'rescue_minutes',
  'human_review_minutes',
  'verification',
  'escaped_defect',
  'scope_committed',
  'scope_delivered',
  'scope_added',
  'handoff_check',
  'coordination_defect',
  'corrective_effort_ms',
  'activity_volume'
] as const
export type MetricKind = (typeof METRIC_KINDS)[number]

interface MetricDefinition {
  unit: MetricUnit
  signal: SignalKind
  /** The sources allowed to record it; any other source is refused. */
  sources: readonly MetricSourceKind[]
  accumulations: readonly Accumulation[]
  /** The component it feeds, or null when it is a diagnostic that is shown but never scored. */
  component: SpaceComponent | null
  description: string
}

/**
 * Every metric the ledger accepts, with its fixed unit, signal kind, allowed sources and the component it feeds.
 * Activity volume, elapsed time, waits and rescue time are diagnostics: they explain a grade but never raise it.
 */
export const METRIC_DEFINITIONS: Readonly<Record<MetricKind, MetricDefinition>> = {
  tokens_input: {
    unit: 'tokens',
    signal: 'direct',
    sources: ['host', 'agent'],
    accumulations: ['delta', 'cumulative'],
    component: 'K',
    description: 'Input tokens as the provider defines them (may include cached input; see tokens_cached_input).'
  },
  tokens_cached_input: {
    unit: 'tokens',
    signal: 'direct',
    sources: ['host', 'agent'],
    accumulations: ['delta', 'cumulative'],
    component: 'K',
    description: 'Cached input tokens, a subset of input for providers that report it that way.'
  },
  tokens_output: {
    unit: 'tokens',
    signal: 'direct',
    sources: ['host', 'agent'],
    accumulations: ['delta', 'cumulative'],
    component: 'K',
    description: 'Output tokens (may include reasoning tokens; see tokens_reasoning).'
  },
  tokens_reasoning: {
    unit: 'tokens',
    signal: 'direct',
    sources: ['host', 'agent'],
    accumulations: ['delta', 'cumulative'],
    component: 'K',
    description: 'Reasoning tokens, a subset of output for providers that report it that way.'
  },
  tokens_total: {
    unit: 'tokens',
    signal: 'direct',
    sources: ['host', 'agent'],
    accumulations: ['delta', 'cumulative'],
    component: 'K',
    description: 'The non-duplicated total, recorded only when the provider semantics allow deriving it.'
  },
  active_ms: {
    unit: 'milliseconds',
    signal: 'direct',
    sources: ['host', 'agent'],
    accumulations: ['delta', 'event'],
    component: 'T',
    description: 'Active execution time from host activity spans, including review, orchestration and verification.'
  },
  elapsed_ms: {
    unit: 'milliseconds',
    signal: 'direct',
    sources: ['server'],
    accumulations: ['event'],
    component: null,
    description: 'Claim-to-submit or cycle time from lifecycle records. Elapsed only: never read as active time.'
  },
  wait_ms: {
    unit: 'milliseconds',
    signal: 'direct',
    sources: ['server', 'host'],
    accumulations: ['event'],
    component: null,
    description: 'Queue, human-approval, blocked, build/test or review wait (attribute waitKind). Never active compute.'
  },
  human_rating: {
    unit: 'rating_1_5',
    signal: 'direct',
    sources: ['human'],
    accumulations: ['event'],
    component: 'S',
    description: 'A person’s satisfaction/confidence rating from the desktop. Never inferred from agent prose.'
  },
  rescue_minutes: {
    unit: 'minutes',
    signal: 'direct',
    sources: ['human'],
    accumulations: ['event'],
    component: null,
    description: 'Time a person spent rescuing the work (names its intervention). Shown beside E; not scored in policy v1.'
  },
  human_review_minutes: {
    unit: 'minutes',
    signal: 'direct',
    sources: ['human'],
    accumulations: ['event'],
    component: null,
    description: 'Planned review or playtesting by a person (attribute activity). Never a rescue; shown beside E, never scored.'
  },
  verification: {
    unit: 'pass_fail',
    signal: 'direct',
    sources: ['server'],
    accumulations: ['event'],
    component: 'P',
    description: 'A reviewer-checked required check or criterion result (1 pass, 0 fail). Worker claims are not verification.'
  },
  escaped_defect: {
    unit: 'count',
    signal: 'direct',
    sources: ['human', 'server', 'agent'],
    accumulations: ['event'],
    component: 'P',
    description:
      'A regression found after acceptance, as defect records (attribute defectEvent: report, duplicate, reassessment, fix, withdrawal; a report names severity, attribution and discoveryPhase). See performance.ts.'
  },
  scope_committed: {
    unit: 'count',
    signal: 'direct',
    sources: ['server'],
    accumulations: ['event'],
    component: 'A',
    description: 'Deliverables committed before dispatch, frozen from the saved revision the run pinned.'
  },
  scope_delivered: {
    unit: 'count',
    signal: 'direct',
    sources: ['server'],
    accumulations: ['event'],
    component: 'A',
    description: 'Committed deliverables accepted by review.'
  },
  scope_added: {
    unit: 'count',
    signal: 'direct',
    sources: ['server'],
    accumulations: ['event'],
    component: null,
    description: 'Scope authorized after dispatch. Shown separately; it neither raises nor lowers A.'
  },
  handoff_check: {
    unit: 'pass_fail',
    signal: 'proxy',
    sources: ['server'],
    accumulations: ['event'],
    component: 'C',
    description: 'A server-derived check that a handoff carried its required evidence and interface contract.'
  },
  coordination_defect: {
    unit: 'count',
    signal: 'proxy',
    sources: ['server', 'human', 'agent'],
    accumulations: ['event'],
    component: 'C',
    description: 'A recorded coordination failure citing a run record. Purposeful clarification is not a defect.'
  },
  corrective_effort_ms: {
    unit: 'milliseconds',
    signal: 'proxy',
    sources: ['server', 'host', 'agent'],
    accumulations: ['event'],
    component: 'E',
    description: 'Effort classified as corrective (with its cause) or productive (planned tests, research).'
  },
  activity_volume: {
    unit: 'count',
    signal: 'proxy',
    sources: ['server', 'host', 'agent'],
    accumulations: ['event'],
    component: null,
    description: 'Commits, attempts, changed lines or tool calls (attribute kind). Diagnostic only: never rewarded.'
  }
}

/** A small set of named qualifiers (severity, waitKind, kind…); values are primitives only. */
export type MetricAttributes = Record<string, string | number | boolean | null>

/**
 * Why corrective or added work happened, for E and the retrospective. An observation names a cause only when it is
 * known; nothing is inferred from its absence.
 */
export const WORKFLOW_CAUSES = ['requirement', 'context', 'implementation', 'integration', 'tooling', 'verification'] as const
export type WorkflowCause = (typeof WORKFLOW_CAUSES)[number]

/**
 * How a person stepped into the work: took it over or repaired it (`rescue`), answered a question
 * (`clarification`), overrode a decision (`override`), granted an extra attempt (`retry_grant`) or changed its
 * direction (`redirect`). Only a person, or the server deriving it from a person's recorded action, can record one.
 */
export const HUMAN_INTERVENTIONS = ['rescue', 'clarification', 'override', 'retry_grant', 'redirect'] as const
export type HumanIntervention = (typeof HUMAN_INTERVENTIONS)[number]

/**
 * Planned work a person does on a ticket or sprint that is not a rescue: reviewing the result (`review`) or trying it
 * out by hand (`playtest`). Recorded as `human_review_minutes` with attribute `activity`, never as rescue time.
 */
export const HUMAN_REVIEW_ACTIVITIES = ['review', 'playtest'] as const
export type HumanReviewActivity = (typeof HUMAN_REVIEW_ACTIVITIES)[number]

/**
 * Whose usage a token or active-time value counts. `self`: only the reporting session's own usage. `inclusive`: it
 * and every child session it started, so the children's own reports are already inside it and are never added again.
 */
export const USAGE_COVERAGES = ['self', 'inclusive'] as const
export type UsageCoverage = (typeof USAGE_COVERAGES)[number]

export interface UsageScope {
  coverage: UsageCoverage
  /** The parent session or stream (as its `source.actor` names it) this usage is nested in; null at the top level. */
  parentActor: string | null
}

/**
 * One measurement in the append-only ledger. `observationId` is a stable id (`mo_…`); recording the same id again
 * with the same payload is a no-op and with a different payload is a conflict.
 *
 * `cause`, `intervention` and `usage` are absent, never null, when they do not apply, so a record written without
 * them keeps its serialized form and content hash.
 */
export interface MetricObservation {
  observationId: string
  metric: MetricKind
  /** Always `METRIC_DEFINITIONS[metric].unit`, stated so a serialized record is self-describing. */
  unit: MetricUnit
  scope: MetricScope
  source: MetricSource
  measurement: Measurement
  accumulation: Accumulation
  /** Order within one source stream, for cumulative reports; null for events and plain deltas. */
  sequence: number | null
  /** When it happened, by the source's clock. */
  observedAt: string
  /** When the server stored it, by the server's clock. Grades include only records stored by their cutoff. */
  recordedAt: string
  attributes: MetricAttributes
  evidence: EvidenceRef[]
  /** The known cause of the work measured. */
  cause?: WorkflowCause
  /** The person's intervention this records. `rescue_minutes` always names one. */
  intervention?: HumanIntervention
  /** Token and active-time metrics only: whose usage the value counts. */
  usage?: UsageScope
}

// ---------------------------------------------------------------------------------------------------------------
// Baselines

/** The resources T and K compare against a baseline. */
export const BASELINE_METRICS = ['active_ms', 'tokens'] as const
export type BaselineMetric = (typeof BASELINE_METRICS)[number]

export const BASELINE_UNITS: Readonly<Record<BaselineMetric, MetricUnit>> = { active_ms: 'milliseconds', tokens: 'tokens' }

/**
 * What makes prior tickets comparable: the planned work type, size and risk. Dark Mechanicus records no separate
 * risk field, so the planned reasoning level (routine, multi_step, deep) stands for risk.
 */
export interface CohortKey {
  workType: WorkType
  size: TicketSize
  risk: ReasoningLevel
}

/**
 * A pre-dispatch budget planned for one ticket. Each edit appends a new version; `frozenAt` is the server time
 * the version was saved, never a caller-supplied time.
 */
export interface BudgetBaseline {
  baselineId: string
  kind: 'budget'
  metric: BaselineMetric
  unit: MetricUnit
  ticketId: string
  /** The saved plan revision that carried this budget. */
  revisionId: string
  version: number
  value: number
  frozenAt: string
}

/**
 * The median of a frozen cohort of comparable accepted tickets, with its sample size and spread so outliers are
 * visible. `memberTicketIds` lets a subject be kept out of its own cohort.
 */
export interface CohortBaseline {
  baselineId: string
  kind: 'cohort'
  metric: BaselineMetric
  unit: MetricUnit
  cohort: CohortKey
  statistic: 'median'
  value: number
  sampleSize: number
  spread: { p25: number; p75: number } | null
  memberTicketIds: string[]
  version: number
  frozenAt: string
}

/**
 * One ticket baseline inside a roll-up: the baseline its own ticket grade accepted in the first run that executed it,
 * with that ticket's dispatch time there. A ticket counts once per scope, so restarting a run never buys it a fresh
 * allowance.
 */
export interface RollupMember {
  runId: string
  ticketId: string
  baselineId: string
  kind: 'budget' | 'cohort'
  value: number
  frozenAt: string
  /** The ticket's first claim in that run: the member was frozen strictly before it. */
  dispatchedAt: string
}

/**
 * The baseline of a run, sprint or epic grade: the sum of the ticket baselines its executed tickets' own grades accepted
 * (policies v1 and v2 apply a budget or cohort only to a ticket grade), each ticket once. The scope's actual includes
 * its overhead (review, orchestration, acceptance nodes, Fireguard and other overhead tickets) while the baseline holds
 * only ticket baselines, so overhead is charged at the level it was spent. `uncovered` lists executed work tickets in
 * scope whose grade accepted no baseline: the roll-up is then partial, compared only with an estimated actual that
 * leaves those tickets' own cost out, so the grade reads provisional (against an observed actual the grader refuses it,
 * `incomplete_rollup`). `value` is the members' sum and `frozenAt` their latest freeze.
 */
export interface RollupBaseline {
  baselineId: string
  kind: 'rollup'
  metric: BaselineMetric
  unit: MetricUnit
  value: number
  version: number
  frozenAt: string
  members: RollupMember[]
  uncovered: { runId: string; ticketId: string }[]
}

export type Baseline = BudgetBaseline | CohortBaseline | RollupBaseline

/**
 * What a baseline is chosen for. `dispatchedAt` is the server time of the ticket's first claim in the run: a
 * baseline frozen after it can never apply, so editing a budget mid-run cannot improve that assessment.
 */
export interface BaselineSubject {
  ticketId: string
  metric: BaselineMetric
  cohort: CohortKey
  dispatchedAt: string
}

export const BASELINE_REJECTIONS = [
  'metric_mismatch',
  'other_ticket',
  'invalid_time',
  'frozen_after_dispatch',
  'zero_value',
  'cohort_mismatch',
  'sample_too_small',
  'contains_subject',
  /** A budget or cohort offered to a run, sprint or epic grade, or a roll-up offered to a ticket grade. */
  'level_mismatch',
  /** A roll-up that leaves an executed work ticket in scope without a baseline, or whose member was frozen too late. */
  'incomplete_rollup',
  'superseded'
] as const
export type BaselineRejection = (typeof BASELINE_REJECTIONS)[number]

export type BaselineSelection =
  | { state: 'selected'; baseline: Baseline; rejected: { baselineId: string; reason: BaselineRejection }[] }
  | { state: 'missing'; reason: 'no_eligible_baseline'; rejected: { baselineId: string; reason: BaselineRejection }[] }

// ---------------------------------------------------------------------------------------------------------------
// Policy

export const GRADE_LETTERS = ['A', 'B', 'C', 'D', 'F'] as const
export type GradeLetter = (typeof GRADE_LETTERS)[number]

export const REGRESSION_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export type RegressionSeverity = (typeof REGRESSION_SEVERITIES)[number]

interface SpaceComponentPolicy {
  component: SpaceComponent
  /** Integer base weight. Policy v1 gives every component 1, so each starts at 1/7. */
  weight: number
  /** A missing required component keeps a grade from being final; a missing optional one does not. */
  required: boolean
  signal: SignalKind
  /** The normalization rule id, as named in docs/space-grading.md. */
  rule: string
}

/** A versioned grading policy. Grades name the policy they used, so a new version reassesses rather than rewrites. */
export interface SpacePolicy {
  policyId: string
  version: number
  components: SpaceComponentPolicy[]
  /** Highest band first; a score at or above `min` earns the letter. The last band's min is 0. */
  bands: { letter: GradeLetter; min: number }[]
  precision: {
    /** Scores are kept as integer multiples of 10^-canonicalDecimals; bands compare that canonical value. */
    canonicalDecimals: number
    displayDecimals: number
    /** Display rounds down, so a displayed score never reads as a higher band than its letter. */
    displayRounding: 'floor'
  }
  /** Below this many scored components a grade is ungraded rather than provisional. */
  minScoredComponents: number
  /** A confirmed mandatory failure caps the score here (inside F) and the letter at F. */
  mandatoryFailureCeiling: number
  /** Points P loses per attributed regression, by severity. */
  regressionPenalty: Record<RegressionSeverity, number>
  /** Points C loses per recorded coordination defect. */
  coordinationDefectPenalty: number
  /** E = 100 − slope × corrective share. */
  correctiveShareSlope: number
  /** The share of effort that must be classified before E is scored. */
  minClassificationCoverage: number
  /** T and K = clamp(intercept − slope × actual/baseline, 0, 100). */
  resourceCurve: { intercept: number; slope: number }
  /** The smallest prior cohort that may serve as a baseline. */
  minCohortSampleSize: number
}

// ---------------------------------------------------------------------------------------------------------------
// Grade inputs

export const GRADE_SUBJECT_LEVELS = ['ticket', 'run', 'sprint', 'epic'] as const
export type GradeSubjectLevel = (typeof GRADE_SUBJECT_LEVELS)[number]

export interface GradeSubject {
  level: GradeSubjectLevel
  id: string
}

/** A person's rating from the desktop. The source is always human: an agent's opinion is never a rating. */
export interface HumanRatingInput {
  observationId: string
  source: 'human'
  /** 1 (not satisfied/confident) to 5 (fully satisfied/confident). */
  value: number
}

interface SprintRatingInput extends HumanRatingInput {
  /** The person chose to share this sprint rating with the sprint's tickets as inherited context. */
  sharedWithTickets: boolean
}

/**
 * S. At ticket level the ticket's own rating wins; without one, a sprint rating counts only when the person shared
 * it with the sprint's tickets, and it is marked inherited. At sprint level the sprint rating is the sprint's own.
 * Run and epic grades have no rating of their own in policy v1: a shared sprint rating counts there only as
 * inherited context. With nothing usable, S is missing. A ticket rating belongs only to a ticket-level input.
 */
export interface SatisfactionInput {
  ticketRating: HumanRatingInput | null
  sprintRating: SprintRatingInput | null
}

/**
 * The state of required verification (built by `src/core/space/verification.ts`).
 * - `verified`: an independent review accepted every criterion and Definition of Done check.
 * - `failed`: a Definition of Done check or a criterion is confirmed failed, or the ticket used every try; the grade
 *   is capped at F.
 * - `pending`: no outcome yet (in progress, awaiting review, or awaiting a retry). `missing`: no reviewed evidence
 *   (worker claims alone count here, as does an acceptance whose review basis is unknown), a Definition of Done
 *   check skipped or unreported, or a run that ended without an outcome.
 */
export const VERIFICATION_STATES = ['verified', 'failed', 'pending', 'missing'] as const
export type VerificationState = (typeof VERIFICATION_STATES)[number]

export interface RegressionInput {
  observationId: string
  severity: RegressionSeverity
  /** Unassigned regressions are shown but never charged to the subject. */
  attribution: 'attributed' | 'unassigned'
}

/** P. */
export interface PerformanceInput {
  verification: { state: VerificationState; evidence: EvidenceRef[] }
  /** Regressions known at the cutoff. Later ones produce a dated reassessment. */
  regressions: RegressionInput[]
}

/** Raw activity counts: shown beside A as context, never scored. */
interface ActivityVolume {
  attempts: number | null
  commits: number | null
  changedLines: number | null
}

/** A. `committed` is frozen before dispatch; null when no frozen scope exists. */
export interface DeliveryInput {
  committed: number | null
  delivered: number
  /** Scope authorized after dispatch, shown separately. */
  added: number
  /** Committed items later removed; they stay in the denominator. */
  removed: number
  activity: ActivityVolume
  evidence: EvidenceRef[]
}

/**
 * C. `handoffChecks` is null when no checks were derived; it counts each check as it found. Coordination defects are
 * events: none recorded is 0. `rejected` (absent: none) names the submissions the review rejected by the cutoff and
 * how many checks they passed on their own; the policy's C rule decides what that means (`C.handoff-pass-rate.v2`
 * counts those checks failed, v1 ignores it), so the same input grades the same way under the same policy hash.
 */
export interface CollaborationInput {
  handoffChecks: { passed: number; failed: number } | null
  rejected?: { submissions: number; passedChecks: number }
  coordinationDefects: number
  evidence: EvidenceRef[]
}

/** E, in effort milliseconds. Productive effort includes planned tests and useful investigation. */
export interface EfficiencyInput {
  correctiveMs: Measurement
  productiveMs: Measurement
  unclassifiedMs: Measurement
  /** Shown as a diagnostic; never read as wasted time. */
  retries: number | null
  evidence: EvidenceRef[]
}

/** T or K: the actual total (with overhead, excluding human waits) and the baseline chosen for it. */
export interface ResourceInput {
  actual: Measurement
  /** Attempts that ran but reported nothing. Any makes the total partial, so the component is missing. */
  unreportedAttempts: number
  baseline: BaselineSelection
  evidence: EvidenceRef[]
}

export interface SpaceGradeInput {
  subject: GradeSubject
  /** Only records stored at or before this server time were used. */
  cutoff: string
  /**
   * The server time the subject's work was first dispatched (a ticket's first claim in the run), or null before
   * any dispatch. A baseline must be frozen strictly before it; with null, no baseline applies.
   */
  dispatchedAt: string | null
  components: {
    S: SatisfactionInput
    P: PerformanceInput
    A: DeliveryInput
    C: CollaborationInput
    E: EfficiencyInput
    T: ResourceInput
    K: ResourceInput
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Grades

/** Why a component has no score. */
export const COMPONENT_MISSING_REASONS = [
  'no_rating',
  'verification_pending',
  'verification_missing',
  'scope_not_frozen',
  'zero_scope',
  'not_reported',
  'host_unavailable',
  'partial_coverage',
  'no_handoffs',
  'zero_observation',
  'insufficient_classification',
  'partial_telemetry',
  'no_eligible_baseline'
] as const
export type ComponentMissingReason = (typeof COMPONENT_MISSING_REASONS)[number]

/**
 * - `final`: verified outcome, every required component observed (none estimated or missing).
 * - `provisional`: a score and letter exist but a required component is missing or estimated.
 * - `ungraded`: no score or letter, because verification is missing/pending or too few components scored.
 */
export const GRADE_STATUSES = ['final', 'provisional', 'ungraded'] as const
export type GradeStatus = (typeof GRADE_STATUSES)[number]

export const GRADE_OUTCOMES = ['verified', 'failed', 'unverified'] as const
export type GradeOutcome = (typeof GRADE_OUTCOMES)[number]

export const GRADE_STATUS_REASONS = [
  'mandatory_failure',
  'verification_missing',
  'verification_pending',
  'insufficient_coverage',
  'required_component_missing',
  'estimated_input'
] as const
export type GradeStatusReason = (typeof GRADE_STATUS_REASONS)[number]

export type ComponentValues = Record<string, number | string | boolean | null>

export interface SpaceComponentResult {
  component: SpaceComponent
  state: MeasurementState
  required: boolean
  /** Canonical precision (see `SpacePolicy.precision`); null when missing. */
  score: number | null
  /** The policy weight over the sum of all weights (1/7 in policy v1). */
  baseWeight: number
  /** The weight over the sum of the scored components' weights; 0 when missing. */
  effectiveWeight: number
  rule: string
  missingReason: ComponentMissingReason | null
  /** True when S came from a sprint rating the person shared with the ticket. */
  inherited: boolean
  /** The values the rule used. */
  inputs: ComponentValues
  /** Shown beside the score, never used by it (activity volume, retries, unassigned regressions). */
  diagnostics: ComponentValues
  evidence: EvidenceRef[]
  explanation: ComponentExplanation
}

/** The baseline T or K was offered, as the grader judged it: compared against, or refused with its reason. */
export interface BaselineComparison {
  baselineId: string
  kind: Baseline['kind']
  value: number
  version: number
  /**
   * Server time the baseline was frozen; it must precede the grade's `dispatchedAt` (a roll-up's members each precede
   * their own ticket's dispatch).
   */
  frozenAt: string
  /** Cohorts: how many prior tickets the median was taken over. Roll-ups: how many ticket baselines were summed. */
  sampleSize: number | null
  /** Why the grader refused it on re-checking; null when it passed every check (and was compared, if T or K was scored). */
  refusedReason: BaselineRejection | null
}

/** How one component's score, or its absence, follows from its inputs: enough to recompute it by hand. */
interface ComponentExplanation {
  /** The rule's formula with this grade's numbers and its result, or why the rule gave no score. */
  normalization: string
  /** Only records stored at or before this server time were read (the grade's cutoff). */
  cutoff: string
  /** T and K: the baseline offered (used or refused). Null for other components and when none was offered. */
  baseline: BaselineComparison | null
  /** Caps this component triggers on the final result (P: the mandatory-failure cap). */
  caps: GradeCap['kind'][]
}

export interface GradeCap {
  kind: 'mandatory_failure'
  ceiling: number
  letter: 'F'
  evidence: EvidenceRef[]
}

/** The precision rules a grade was computed under, shown with every score. */
interface GradeRounding {
  /** Scores are integers in units of 10^-canonicalDecimals, rounded half up; bands compare that value. */
  canonicalDecimals: number
  canonical: 'half_up'
  displayDecimals: number
  display: SpacePolicy['precision']['displayRounding']
}

/** How the final result follows from the components: composite, cap, band and status, with what is missing. */
export interface GradeExplanation {
  /** The weighted mean over the scored components with their numbers (`Σ wᵢ·scoreᵢ ÷ Σ wᵢ = …`); null when ungraded. */
  composite: string | null
  /** The cap applied to the composite (`min(79.166667, 59) = 59`); null when no cap applies. */
  cap: string | null
  /** How the letter was reached (`85.357143 ≥ 80 → B`, or the cap's F); null when ungraded. */
  letter: string | null
  /** What the status means, then one line per status reason. */
  status: string[]
  /** The components with no score and why: they carry no weight and are never read as zero or perfect. */
  missing: { component: SpaceComponent; reason: ComponentMissingReason }[]
  rounding: GradeRounding
  /** Every record the components and caps cite, without repeats, in component order. */
  evidence: EvidenceRef[]
}

/**
 * A computed grade. A live preview has a null `assessmentId`; a frozen snapshot gets a stable id (`as_…`).
 * `score`, `uncappedScore`, `displayScore` and `letter` are null exactly when `status` is ungraded.
 */
export interface SpaceGrade {
  assessmentId: string | null
  /** The policy, with the content hash of the exact policy record used, so a reused version number cannot hide a change. */
  policy: { policyId: string; version: number; hash: string }
  subject: GradeSubject
  cutoff: string
  /** The dispatch time the baselines were checked against, kept so the pre-dispatch rule can be audited. */
  dispatchedAt: string | null
  /**
   * Content hash (`sha256:` over canonical JSON) of the validated input. The same input hash and policy hash always
   * give the same grade, byte for byte; a different hash means the sources changed.
   */
  inputHash: string
  status: GradeStatus
  outcome: GradeOutcome
  statusReasons: GradeStatusReason[]
  /** The capped canonical score. */
  score: number | null
  /** The weighted score before any cap. */
  uncappedScore: number | null
  /** `score` rounded down to the display precision, as text (for example "89.9"). */
  displayScore: string | null
  letter: GradeLetter | null
  /** The share of base weight that was scored, 0–1. */
  coverage: number
  scoredComponents: number
  caps: GradeCap[]
  components: SpaceComponentResult[]
  baselineIds: string[]
  explanation: GradeExplanation
}
