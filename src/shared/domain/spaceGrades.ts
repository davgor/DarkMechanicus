/**
 * Balanced SPACE grades from Dark Mechanicus's records: a ticket's grade in one run, the run, sprint and epic grades
 * recomputed from the raw measures of their scope (never by averaging ticket letters or scores), the immutable
 * scorecard snapshot frozen into each sprint report revision, and dated reassessments that compare a snapshot with
 * the records as they stand later. Every grade is `gradeSpace`'s; only the input differs by level.
 */
import type { EffortDenominator, ScopeEfficiencyView, TicketEfficiencyView } from './efficiency'
import type { PerformanceAssessmentInput, VerificationReason } from './performance'
import type {
  RollupBaseline,
  ComponentMissingReason,
  GradeLetter,
  GradeOutcome,
  GradeStatus,
  GradeStatusReason,
  GradeSubject,
  Measurement,
  MeasurementState,
  SpaceComponent,
  SpaceGrade,
  SpaceGradeInput,
  VerificationState
} from './space'
import type { SpaceSignalsView } from './spaceSignals'
import type { TicketTiming, TimingAnomaly, TimingQuantity, WaitClass } from './timing'

/**
 * Where the read models disagree, listed rather than guessed at. `dispatch_mismatch`: the S/A/C read and the E/T/K
 * read name different first dispatches; the grade checks baselines against the earlier one, so a baseline frozen
 * between them is refused (fails closed).
 */
export interface GradeAssemblyAnomaly {
  kind: 'dispatch_mismatch'
  detail: string
}

export interface TicketGradeView {
  runId: string
  ticketId: string
  /** The one cutoff every source was read at (server time, never later than the read). */
  cutoff: string
  input: SpaceGradeInput
  grade: SpaceGrade
  sources: {
    signals: SpaceSignalsView
    performance: PerformanceAssessmentInput
    efficiency: TicketEfficiencyView
  }
  anomalies: GradeAssemblyAnomaly[]
}

// ---------------------------------------------------------------------------------------------------------------
// Run, sprint and epic grades

/**
 * A ticket's place in a run, sprint or epic grade, as the plan held it when the ticket was first dispatched in the
 * epic (a later adoption never changes it). `integrated` outcomes verify the combined work or are overhead (sprint
 * acceptance nodes, and tickets tagged `administrative`, `fireguard` or `overhead`); `work` outcomes are feature
 * tickets; `optional` tickets are shown and never required.
 */
export type OutcomeRole = 'integrated' | 'work' | 'optional'

/**
 * One ticket outcome as the aggregate P reads it. An integrated outcome always counts. A work ticket counts when it
 * was decided or is awaiting a decision, or was accepted without reviewed evidence; one never dispatched, left by a run
 * that ended, or carried forward is undelivered (A counts it) and does not decide verification. In an epic, a ticket
 * counts once, from the last run with an own outcome (`attemptId` set); a run that ended without an attempt of it never
 * supersedes an earlier failure. In a sprint, `movedOut` marks a ticket an adoption has since moved to another sprint
 * (or out of the plan): its outcome here is the one it had while this sprint held it.
 */
export interface RequiredOutcome {
  runId: string
  ticketId: string
  role: OutcomeRole
  state: VerificationState
  reason: VerificationReason
  /** The attempt the verification stands on; null when the ticket had none in this run (or sprint). */
  attemptId: string | null
  movedOut: boolean
  counted: boolean
}

/** The roll-up baseline T or K was offered, or why none was: executed tickets with and without a ticket baseline. */
export interface RollupView {
  metric: 'active_ms' | 'tokens'
  /** The roll-up offered to the grader; null when no executed ticket's grade accepted a baseline. */
  baseline: RollupBaseline | null
  /** Executed work tickets whose grade accepted no baseline: their own cost is left out and the roll-up is partial. */
  uncovered: { runId: string; ticketId: string }[]
  /** Executed overhead tickets without a baseline of their own: their cost is overhead in the actual. */
  overhead: { runId: string; ticketId: string }[]
  /** A baseline exists but some executed work ticket is uncovered: T or K is estimated and the grade provisional. */
  partial: boolean
}

/**
 * A run's, sprint's or epic's grade as of `cutoff`, recomputed from the scope's own measures:
 * - S, A and C from `getSpaceSignals` at the level (A commits feature tickets only);
 * - P from the ticket outcomes in scope: any confirmed failure of a required or integrated outcome fails P and caps
 *   the grade at F, whatever the component tickets scored; otherwise a pending outcome leaves it pending, an outcome
 *   accepted without reviewed evidence leaves it missing, and regressions of every ticket in scope are charged once;
 * - E, T and K from the scope's efficiency (overhead included) in the runs that executed work, with T and K compared
 *   against the roll-up of the ticket baselines the scope's own ticket grades accepted, each ticket once (budgets and
 *   cohorts are ticket-level only).
 */
export interface AggregateGradeView {
  subject: GradeSubject
  /** The runs read: the subject's own, or every run of the epic created by the cutoff. */
  runIds: string[]
  /** The runs whose E, T and K measures were summed: those that executed work (the last run when none did). */
  measuredRunIds: string[]
  cutoff: string
  input: SpaceGradeInput
  grade: SpaceGrade
  outcomes: RequiredOutcome[]
  rollups: { T: RollupView; K: RollupView }
  /** Each ticket grade the roll-ups and outcomes were read from (the scope's tickets in each run). */
  tickets: TicketGradeView[]
  sources: { signals: SpaceSignalsView; efficiency: ScopeEfficiencyView[] }
  anomalies: GradeAssemblyAnomaly[]
}

// ---------------------------------------------------------------------------------------------------------------
// Frozen scorecard snapshots

/** One timing quantity as frozen: the projection's own record, so kind, aggregation, state and coverage stay with it. */
type FrozenQuantity = TimingQuantity

/** A ticket's timing at the cutoff. */
interface FrozenTicketTiming {
  ticketId: string
  sprintId: string | null
  readyAt: string | null
  firstClaimAt: string | null
  acceptedAt: string | null
  endedBy: TicketTiming['endedBy']
  cycleTime: FrozenQuantity
  leadTime: FrozenQuantity
  active: FrozenQuantity
  effort: FrozenQuantity
  overhead: FrozenQuantity
}

/** A sprint's or run's timing at the cutoff. */
interface FrozenWindowTiming {
  /** The window from activation (a sprint) or start (the run) to the next sprint, the run's end or the cutoff. */
  elapsed: FrozenQuantity
  startedAt: string | null
  endedAt: string | null
  inFlight: FrozenQuantity
  activeWallClock: FrozenQuantity
  effort: FrozenQuantity
  overhead: FrozenQuantity
}

/**
 * The run's timing projection (`projectRunTiming`) as it stood at the cutoff, kept so a later adoption that moves a
 * ticket to another sprint, a late usage read or a settled lease never changes what the report showed. `basis` says
 * how each number assigns work to the sprint: the sprint's window runs from its activation, while its ticket and
 * effort totals follow the plan the run held at the cutoff (`current_plan`).
 */
export interface FrozenTiming {
  runId: string
  asOf: string
  basis: { window: 'activation'; totals: 'current_plan' }
  run: FrozenWindowTiming & { unattributedEffort: FrozenQuantity }
  sprint: (FrozenWindowTiming & { sprintId: string; ticketIds: string[]; checkpointWait: FrozenQuantity; unattributedOverhead: FrozenQuantity }) | null
  tickets: FrozenTicketTiming[]
  anomalies: TimingAnomaly[]
}

/** A scope's efficiency inputs at the cutoff beyond what the grade's components hold: overhead, waits and gaps. */
export interface FrozenEfficiency {
  runId: string
  effort: EffortDenominator
  /** The active time (T) actual, its overhead part and the waits shown beside it, never counted. */
  time: { actual: Measurement; overheadMs: number | null; excludedWaitsMs: Partial<Record<WaitClass, number>> | null; unreportedAttemptIds: string[]; openAttemptIds: string[] }
  tokens: { actual: Measurement; unreportedAttemptIds: string[]; openAttemptIds: string[] }
  retries: number | null
}

/** One component input of a grade, as the snapshot pools it. */
export type FrozenComponentInput = SpaceGradeInput['components'][SpaceComponent]

/** A component's result as frozen: the explanation is re-derived on read. */
interface FrozenComponentResult {
  component: SpaceComponent
  state: MeasurementState
  score: number | null
  missingReason: ComponentMissingReason | null
}

/**
 * A grade's result as frozen, without its explanations: those follow deterministically from the input and the policy,
 * so a read regrades the stored input under the stored policy and must get exactly this result back.
 */
export interface FrozenResult {
  inputHash: string
  status: GradeStatus
  outcome: GradeOutcome
  statusReasons: GradeStatusReason[]
  score: number | null
  uncappedScore: number | null
  displayScore: string | null
  letter: GradeLetter | null
  coverage: number
  components: FrozenComponentResult[]
}

/**
 * One frozen grade: its subject, its own assessment id, the dispatch time and the seven component inputs it was graded
 * from (each by content hash in `ScorecardSnapshot.inputs`, so a component two subjects share is stored once), and the
 * result it gave. Its cutoff is the snapshot's.
 */
export interface FrozenGrade {
  subject: GradeSubject
  assessmentId: string
  dispatchedAt: string | null
  inputs: Record<SpaceComponent, string>
  result: FrozenResult
}

/** A roll-up beyond its baseline (which the T or K input holds): the overhead tickets and whether it is partial. */
interface FrozenRollup {
  overhead: { runId: string; ticketId: string }[]
  partial: boolean
}

/** What a run, sprint or epic grade was assembled from beyond its input: the outcomes, roll-ups and efficiency. */
export interface AggregateDetail {
  runIds: string[]
  measuredRunIds: string[]
  outcomes: RequiredOutcome[]
  rollups: { T: FrozenRollup; K: FrozenRollup }
  efficiency: FrozenEfficiency[]
}

/** A frozen run, sprint or epic grade; `detail` is the content hash of its `AggregateDetail` in `ScorecardSnapshot.details`. */
export interface FrozenAggregate extends FrozenGrade {
  detail: string
}

/**
 * The scorecard frozen with a sprint report revision when it is submitted: the sprint's, run's and (in the final
 * sprint's report) epic's grades and every ticket grade of the sprint, as computed at the report's cutoff under the
 * named policy, with the plan revision, the report content it belongs to, every grade's inputs (baselines included),
 * the frozen timing and efficiency inputs, and the source ids. It is its own portable record
 * (`history/<runId>/scorecards/<reportId>.json`), which the run history names by hash. Stored once and never
 * recomputed: restarts, export, import, adoption and later records or policy changes leave it byte for byte as
 * written (`snapshotHash` covers every other field). Inputs and details are pooled by content hash, so identical
 * aggregates (the run and the epic of a single-run epic) and shared components are stored once. A later reading of
 * the same scope is a dated reassessment, never a rewrite.
 */
export interface ScorecardSnapshot {
  format: 'darkmechanicus.scorecard'
  formatVersion: 1
  /** `as_…`, derived from the report id: one snapshot per report revision. */
  snapshotId: string
  epicId: string
  runId: string
  sprintId: string
  report: { reportId: string; reportRevision: number; contentHash: string }
  /** The plan revision the run executed when the report was submitted. */
  planRevisionId: string
  /** The server time every grade was read at (the report's submission). */
  cutoff: string
  /** The policy every grade was computed under; a later read regrades under this very policy (by hash). */
  policy: { policyId: string; version: number; hash: string }
  sprint: FrozenAggregate
  run: FrozenAggregate
  /** Only in the final sprint's report: the epic so far, across its runs. */
  epic: FrozenAggregate | null
  /** Every ticket grade of the sprint (current-plan membership at the cutoff). */
  tickets: FrozenGrade[]
  /** Component inputs by content hash. */
  inputs: Record<string, FrozenComponentInput>
  /** Aggregate details by content hash. */
  details: Record<string, AggregateDetail>
  timing: FrozenTiming
  /** The records the grades rest on, by id. */
  sources: { runIds: string[]; ticketIds: string[]; attemptIds: string[] }
  anomalies: GradeAssemblyAnomaly[]
  /** `sha256:` over the canonical JSON of every other field. */
  snapshotHash: string
}

/**
 * A report revision's scorecard graded but not yet sealed: every grade is final, only the report's content hash (and so
 * the seal) is still to come. Grades never read the report's text, so a retro written in the same submission can cite
 * them (`OwnAssessmentRef`) before the content is hashed and the snapshot sealed.
 */
export type ScorecardDraft = Omit<ScorecardSnapshot, 'snapshotHash' | 'report'> & { report: Omit<ScorecardSnapshot['report'], 'contentHash'> }

/** A frozen aggregate as read: the full grade (explanations re-derived) and what it was assembled from. */
export interface ScorecardAggregateView {
  grade: SpaceGrade
  detail: AggregateDetail
}

/**
 * A report revision's scorecard as read: the stored snapshot exactly as written, and every frozen grade regraded from
 * its stored input under its stored policy, which must give back exactly the frozen result.
 */
export interface ScorecardView {
  snapshot: ScorecardSnapshot
  sprint: ScorecardAggregateView
  run: ScorecardAggregateView
  epic: ScorecardAggregateView | null
  tickets: SpaceGrade[]
}

/** A grade at a glance: what a report view lists without carrying the whole snapshot. */
export interface GradeSummary {
  subject: GradeSubject
  assessmentId: string | null
  status: GradeStatus
  score: number | null
  displayScore: string | null
  letter: GradeLetter | null
  coverage: number
  inputHash: string
  policyHash: string
}

/** What a report view says about its snapshot; the snapshot itself is read with `getReportScorecard`. */
export interface ScorecardSummary {
  snapshotId: string
  snapshotHash: string
  cutoff: string
  policy: { policyId: string; version: number; hash: string }
  grades: GradeSummary[]
  ticketCount: number
}

// ---------------------------------------------------------------------------------------------------------------
// Dated reassessments

/** A component's score in each reading, or null when it was missing. */
export interface ComponentReading {
  state: MeasurementState
  score: number | null
  missingReason: ComponentMissingReason | null
}

/**
 * Why a component differs between readings:
 * - `policy_changed`: the approved input regraded under the current policy differs from the approved grade;
 * - `records_at_cutoff_changed`: the same window read now differs from the approved input (records imported later
 *   with earlier server times, or a state the read cannot rewind);
 * - `later_records`: records stored after the snapshot's cutoff (a later regression, rating, usage read or decision);
 * - `window_start_moved`: the reassessed window starts at another dispatch than the snapshot's.
 */
export type DifferenceCause = 'policy_changed' | 'records_at_cutoff_changed' | 'later_records' | 'window_start_moved'

export interface ComponentDifference {
  component: SpaceComponent
  approved: ComponentReading | null
  sameWindow: ComponentReading | null
  current: ComponentReading | null
  causes: DifferenceCause[]
  detail: string
}

/** An observation window: from the subject's first dispatch to a cutoff. */
export interface ObservationWindow {
  from: string | null
  to: string
}

/**
 * How a subject relates to the frozen scorecard: `kept` (frozen and still in the sprint), `left` (frozen, but an
 * adoption has since moved it out of the sprint or the plan: shown, never dropped), `joined` (in the sprint now, not
 * in the snapshot), `legacy` (the report predates scorecards, so nothing was frozen).
 */
export type ReassessedMembership = 'kept' | 'left' | 'joined' | 'legacy'

export interface SubjectReassessment {
  subject: GradeSubject
  membership: ReassessedMembership
  /** The frozen grade, exactly as approved; null when nothing was frozen for it. */
  approved: GradeSummary | null
  /** The same scope regraded now over the approved window (the snapshot's cutoff) under the current policy; null when the run no longer grades it. */
  sameWindow: GradeSummary | null
  /** The scope graded at the reassessment's own cutoff; null when the run no longer grades it. */
  current: GradeSummary | null
  windows: { approved: ObservationWindow; current: ObservationWindow; comparable: boolean; note: string }
  differences: ComponentDifference[]
}

/**
 * A dated reassessment of a sprint report's scorecard: the approved snapshot is returned untouched, and each subject
 * is regraded twice, over the approved window and up to `assessedAt`, so every difference is attributed to the policy,
 * to records at the approved cutoff, or to later records.
 */
export interface ScorecardReassessment {
  reportId: string
  reportRevision: number
  /** The report predates scorecards: it has no approved grade and stays ungraded. */
  legacy: boolean
  approved: ScorecardSnapshot | null
  /** The reassessment's own cutoff (server time). */
  assessedAt: string
  policy: { policyId: string; version: number; hash: string }
  subjects: SubjectReassessment[]
}
