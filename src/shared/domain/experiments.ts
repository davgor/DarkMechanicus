/**
 * Improvement experiments: the structured corrective proposals a sprint retro can carry beside its prose `actions`.
 *
 * An experiment is written into a report's retro, so its definition is part of that report revision's content hash and
 * is as immutable as the report. It cites the frozen scorecard assessment it was drawn from (a grade of an earlier
 * report revision of the same epic, by report id and assessment id), states the observed issue and its evidence, a
 * hypothesis (labeled as one: nothing here claims the metrics prove a cause), where the corrective work goes, the work
 * proposed, the baseline it is measured against (read by the server from the frozen assessment), the change it
 * expects, the guardrails it must hold and the window over which it is measured.
 *
 * Its id is minted by the server the first time it is written (`xp_…`) and restated by id in a later revision of the
 * same sprint's report; the source assessment of a restated experiment never changes.
 *
 * What happens to an experiment later (a status, a measured result) is an `ExperimentEvent`: an append-only record of
 * its own, stored beside the report and never inside it, so recording one never changes an approved report or its
 * scorecard.
 */
import type { TicketSize } from './bundle'
import type { SessionRole } from './views'
import type { EvidenceRef, GradeSubject, SpaceComponent } from './space'
import type { ScorecardSnapshot } from './spaceGrades'
import type { CrossRepoResultsView } from './crossRepoCorrections'

/**
 * What kind of gap a corrective proposal addresses, as its author judges it (a hypothesis, never a proven cause):
 * - `code_defect`: the delivered code was wrong (failed checks, regressions, rework on the same change);
 * - `plan_context`: the plan or its context fell short (vague criteria, missing context, a budget or size that did not fit);
 * - `orchestration_tooling`: Dark Mechanicus, the host or the handoff tooling limited the work (coordination defects,
 *   runs that ended, reporting gaps of the tools);
 * - `unavailable_evidence`: the records do not say enough to judge (missing telemetry, unreviewed outcomes).
 * Valid exploration (planned tests, useful investigation) is productive effort and never one of these.
 */
export const IMPROVEMENT_CONCERNS = ['code_defect', 'plan_context', 'orchestration_tooling', 'unavailable_evidence'] as const
export type ImprovementConcern = (typeof IMPROVEMENT_CONCERNS)[number]

/** Units an experiment measure is stated in: grade points (0–100), counts, milliseconds or tokens. */
export const EXPERIMENT_UNITS = ['points', 'count', 'milliseconds', 'tokens'] as const
export type ExperimentUnit = (typeof EXPERIMENT_UNITS)[number]

/** An expected change is in the measure's own unit, or relative to the baseline in percent. */
export const EXPERIMENT_CHANGE_UNITS = [...EXPERIMENT_UNITS, 'percent'] as const
type ExperimentChangeUnit = (typeof EXPERIMENT_CHANGE_UNITS)[number]

/**
 * Every value of a frozen assessment an experiment can name as its baseline or guardrail, with the component it
 * belongs to (null: the whole grade) and its fixed unit. A reference states the unit too, so a serialized experiment is
 * self-describing and a unit that does not match the measure is refused.
 */
export const EXPERIMENT_MEASURES = {
  'grade.score': { component: null, unit: 'points' },
  'S.score': { component: 'S', unit: 'points' },
  'P.score': { component: 'P', unit: 'points' },
  'A.score': { component: 'A', unit: 'points' },
  'C.score': { component: 'C', unit: 'points' },
  'E.score': { component: 'E', unit: 'points' },
  'T.score': { component: 'T', unit: 'points' },
  'K.score': { component: 'K', unit: 'points' },
  'P.regressions': { component: 'P', unit: 'count' },
  'A.committed': { component: 'A', unit: 'count' },
  'A.delivered': { component: 'A', unit: 'count' },
  'A.added': { component: 'A', unit: 'count' },
  'C.failed_checks': { component: 'C', unit: 'count' },
  'C.rejected_submissions': { component: 'C', unit: 'count' },
  'C.coordination_defects': { component: 'C', unit: 'count' },
  'E.corrective_ms': { component: 'E', unit: 'milliseconds' },
  'E.productive_ms': { component: 'E', unit: 'milliseconds' },
  'E.unclassified_ms': { component: 'E', unit: 'milliseconds' },
  'T.actual_ms': { component: 'T', unit: 'milliseconds' },
  'K.actual_tokens': { component: 'K', unit: 'tokens' }
} as const satisfies Record<string, { component: SpaceComponent | null; unit: ExperimentUnit }>
export type ExperimentMeasure = keyof typeof EXPERIMENT_MEASURES
export const EXPERIMENT_MEASURE_NAMES = Object.keys(EXPERIMENT_MEASURES) as [ExperimentMeasure, ...ExperimentMeasure[]]

/**
 * Where the corrective work goes: the repository this project plans (the source of the measured work), or the Dark
 * Mechanicus source itself (a tooling or orchestration limit). Only the kind and, in a folder of repositories, the
 * repository's name travel with the record; which local checkout serves a destination is machine-local.
 */
const EXPERIMENT_DESTINATION_KINDS = ['source_repository', 'darkmechanicus_source'] as const
export type ExperimentDestinationKind = (typeof EXPERIMENT_DESTINATION_KINDS)[number]

export type ExperimentDestination =
  /** `repository` names one repository of a folder of repositories; null in a single repository. */
  | { kind: 'source_repository'; repository: string | null }
  | { kind: 'darkmechanicus_source' }

/** What the measurement window counts: the next n sprints, runs or delivered tickets after the work lands. */
export const EXPERIMENT_WINDOW_BASES = ['sprints', 'runs', 'tickets'] as const
type ExperimentWindowBasis = (typeof EXPERIMENT_WINDOW_BASES)[number]

export const EXPERIMENT_DIRECTIONS = ['increase', 'decrease'] as const
export type ExperimentDirection = (typeof EXPERIMENT_DIRECTIONS)[number]

export const GUARDRAIL_COMPARATORS = ['at_least', 'at_most'] as const
export type GuardrailComparator = (typeof GUARDRAIL_COMPARATORS)[number]

/** What identifies a frozen grade wherever it is cited: identities and hashes only, never a machine path. */
interface AssessmentIdentity {
  epicId: string
  runId: string
  sprintId: string
  reportId: string
  reportRevision: number
  snapshotId: string
  /** The hash of the policy the assessment was graded under. */
  policyHash: string
  assessmentId: string
  subject: GradeSubject
  /** The content hash of the grade's input, which the frozen result follows from under the policy. */
  inputHash: string
}

/** A grade of an earlier report revision's sealed scorecard, with the seals it was cited under. */
export interface SealedAssessmentRef extends AssessmentIdentity {
  revision: 'earlier'
  /** The content hash of the report revision the scorecard was frozen with. */
  reportContentHash: string
  snapshotHash: string
}

/**
 * A grade of the scorecard frozen with the very report revision that holds the experiment. That scorecard seals the
 * revision's content hash (experiment included), so the reference leaves both seals out: the holding report row binds
 * it (`reportId` and `reportRevision` are the holding revision's), and `inputHash` pins the grade.
 */
export interface OwnAssessmentRef extends AssessmentIdentity {
  revision: 'own'
}

/** The frozen assessment an experiment was drawn from. */
export type ExperimentAssessmentRef = SealedAssessmentRef | OwnAssessmentRef

/** The baseline as read from the source assessment: an estimated value stays labeled as estimated. */
export interface ExperimentBaseline {
  measure: ExperimentMeasure
  unit: ExperimentUnit
  value: number
  state: 'observed' | 'estimated'
}

export interface ExperimentChange {
  direction: ExperimentDirection
  /** Greater than zero, in `unit`. */
  amount: number
  unit: ExperimentChangeUnit
}

/** A value the experiment must not worsen past while it pursues its change (quality, delivery, ...). */
export interface ExperimentGuardrail {
  measure: ExperimentMeasure
  unit: ExperimentUnit
  comparator: GuardrailComparator
  threshold: number
}

export interface ExperimentWindow {
  basis: ExperimentWindowBasis
  count: number
}

interface ExperimentIssue {
  summary: string
  evidence: EvidenceRef[]
}

/**
 * One piece of corrective work. It is a proposal until it is specific (a body that says what changes) and sized: only
 * then can its experiment be scheduled (`executionProblems`). The planner authors the corrective tickets from it.
 */
interface ExperimentWork {
  title: string
  body: string
  /** The planned size of the work; absent when the reporter did not size it (it cannot be scheduled then). */
  size?: TicketSize
}

/** An experiment as stored in a retro: every reference resolved and frozen. */
export interface RetroExperiment {
  id: string
  source: ExperimentAssessmentRef
  /**
   * The kind of gap the experiment addresses, as its author judges it. Absent only on an experiment written before
   * concerns were recorded (its stored bytes are kept); every new one states it.
   */
  concern?: ImprovementConcern
  issue: ExperimentIssue
  /** A hypothesis, labeled as one: the measured gap does not prove its cause. */
  hypothesis: string
  destination: ExperimentDestination
  proposedWork: ExperimentWork[]
  baseline: ExperimentBaseline
  expectedChange: ExperimentChange
  guardrails: ExperimentGuardrail[]
  window: ExperimentWindow
}

/** A grade of an earlier report revision's frozen scorecard: that revision's id and the grade's assessment id. */
export interface SealedAssessmentInput {
  reportId: string
  assessmentId: string
}

/**
 * The assessment an experiment is drawn from as a reporter names it: a grade of the scorecard frozen with the report
 * being submitted, by its subject (one submission carries the experiment and its scorecard), or a grade of an earlier
 * revision's scorecard.
 */
export type ExperimentAssessmentInput = { subject: GradeSubject } | SealedAssessmentInput

/** An experiment as a reporter writes it. `id` is given only to restate an experiment of an earlier revision. */
export interface RetroExperimentInput {
  id?: string
  source: ExperimentAssessmentInput
  concern: ImprovementConcern
  issue: { summary: string; evidence: { kind: EvidenceRef['kind']; id: string; detail?: string | null }[] }
  hypothesis: string
  destination: { kind: 'source_repository'; repository?: string | null } | { kind: 'darkmechanicus_source' }
  proposedWork: { title: string; body?: string; size?: TicketSize }[]
  baseline: { measure: ExperimentMeasure; unit: ExperimentUnit }
  expectedChange: ExperimentChange
  guardrails: ExperimentGuardrail[]
  window: ExperimentWindow
}

// ---------------------------------------------------------------------------------------------------------------
// Later events

/** Where an experiment stands; `proposed` until a status event says otherwise. Completed and abandoned are final. */
export const EXPERIMENT_STATUSES = ['proposed', 'selected', 'scheduled', 'in_progress', 'completed', 'abandoned'] as const
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number]
export const FINAL_EXPERIMENT_STATUSES: readonly ExperimentStatus[] = ['completed', 'abandoned']

/** A measured after-value in the baseline's unit; `assessment` is the frozen scorecard it was read from, when any. */
export interface ExperimentResult {
  value: number | null
  unit: ExperimentUnit
  state: 'observed' | 'estimated' | 'missing'
  assessment: SealedAssessmentRef | null
  evidence: EvidenceRef[]
  /**
   * Present when `assessment` is a grade of the epic a cross-repository correction created in another project (the
   * Dark Mechanicus source): that project's records are not here, so the result carries what its comparison needs.
   */
  crossRepo?: CrossRepoResultEvidence
}

/** Where the scopes of one frozen scorecard start (their first dispatch): what window positions are counted from. */
export interface ExperimentScopeStarts {
  epicId: string
  runId: string
  sprintId: string
  sprint: string | null
  run: string | null
  tickets: { ticketId: string; dispatchedAt: string | null }[]
}

/**
 * A result read from a frozen grade of the epic a cross-repository correction created in the Dark Mechanicus source,
 * as the source project's receipt brought it back (`src/shared/domain/crossRepoCorrections.ts`). It travels inside the
 * result event: the cited scorecard whole (checked against its seal and regraded wherever the event is recorded or
 * imported), where that epic's scopes start, its corrective tickets with their accepted attempts (when the work
 * landed) and the planned sizes of the cited plan revision's tickets, so the comparison follows the same rules as for
 * a grade of this project. Identities and hashes only, never a path.
 */
export interface CrossRepoResultEvidence {
  /** The target project, and the receipt key its epic carries. */
  projectId: string
  key: string
  epicId: string
  epicTitle: string
  scorecard: ScorecardSnapshot
  /** Every frozen scorecard of that epic, as scope starts. */
  starts: ExperimentScopeStarts[]
  corrections: ExperimentCorrectionTicket[]
  /** Planned sizes of the tickets of the cited scorecard's plan revision (null: unsized). */
  sizes: Record<string, TicketSize | null>
  /** When the receipt read it from the target. */
  readAt: string
  /**
   * `sha256:` over the canonical JSON of every other field (`crossRepoSealOf`). Tamper-evident only: an edit that is
   * not resealed is refused, one that is resealed is not caught (only the scorecard is regraded; the accepted times,
   * scope starts and planned sizes are the target's word, which this project cannot verify).
   */
  seal: string
}

/**
 * One later event of an experiment, append-only and stored beside the run's reports (never inside one). `source` pins
 * the exact experiment definition it is about: the report revision holding it and the content hash of the experiment.
 * `number` counts the experiment's events 1, 2, 3, … in the order they were recorded.
 */
export type ExperimentEvent = {
  id: string
  experimentId: string
  runId: string
  number: number
  source: { reportId: string; experimentHash: string }
  note: string
  recordedBy: { role: SessionRole; label: string }
  recordedAt: string
} & ({ kind: 'status'; status: Exclude<ExperimentStatus, 'proposed'> } | { kind: 'result'; result: ExperimentResult })

/** A later event as written: a status, or a result read from a frozen assessment or stated with its unit. */
export type ExperimentEventInput =
  | { kind: 'status'; status: Exclude<ExperimentStatus, 'proposed'>; note?: string }
  | {
      kind: 'result'
      result: {
        assessment?: SealedAssessmentInput | null
        value?: number | null
        unit: ExperimentUnit
        evidence?: { kind: EvidenceRef['kind']; id: string; detail?: string | null }[]
      }
      note?: string
    }

/**
 * An experiment as read: its latest definition and where it was written, its status, and every later event. It is
 * `withdrawn` when a later revision of its sprint's report left it out: it takes no new events.
 */
export interface ExperimentView {
  experiment: RetroExperiment
  /** The report revision holding the definition read here (the latest that states it). */
  definedIn: { runId: string; sprintId: string; reportId: string; reportRevision: number; experimentHash: string }
  status: ExperimentStatus
  withdrawn: boolean
  /** Why its proposed work cannot be scheduled or started yet (unsized or vague work); empty when it can. */
  executionProblems: string[]
  events: ExperimentEvent[]
  /** Its corrective work and measured results set against the original baseline, target and guardrails. */
  outcome: ExperimentOutcome
  /**
   * For an experiment aimed at the Dark Mechanicus source: what each linked cross-repository correction last brought
   * back from the epic it links (its corrective tickets and frozen grades, each citable as { reportId, assessmentId } in
   * a result). Empty until the person brings them back in the desktop app.
   */
  crossRepoResults: { key: string; targetProjectId: string; results: CrossRepoResultsView }[]
}

// ---------------------------------------------------------------------------------------------------------------
// Outcome: the corrective work assessed against the original experiment

/**
 * How a measured result compares with the experiment's frozen baseline:
 * - `improved`: it moved at least the expected change in the expected direction and every guardrail held;
 * - `unchanged`: it moved less than the expected change either way, and no guardrail was breached;
 * - `regressed`: it moved at least the expected change the other way, or a guardrail was breached on a result in the
 *   experiment's window (that decides, even when the value itself is missing or estimated, and even when a later
 *   result looks clean: a lower token or time total with a failed quality guardrail is never an improvement);
 * - `insufficient_evidence`: nothing comparable was measured: no result, a missing or estimated value, another unit,
 *   policy (for scores) or task scope (ticket size, or the size mix of a run, sprint or epic), an observation window
 *   outside the experiment's, corrective work that has not landed, or (for an apparent improvement) a guardrail that
 *   could not be read.
 */
const EXPERIMENT_OUTCOME_CLASSES = ['improved', 'unchanged', 'regressed', 'insufficient_evidence'] as const
export type ExperimentOutcomeClass = (typeof EXPERIMENT_OUTCOME_CLASSES)[number]

/** A ticket created as the experiment's corrective work (found by its correction marker), and where it was accepted. */
export interface ExperimentCorrectionTicket {
  /** The epic holding it: the experiment's own, a follow-up epic whose provenance names it, or another project's correction epic. */
  epicId: string
  epicTitle: string
  /** Set for a ticket of the correction epic of another project (the Dark Mechanicus source), as a result carried it. */
  projectId?: string
  ticketId: string
  key: string
  title: string
  role: 'work' | 'fireguard'
  /** The proposed-work index for `work`; null for `fireguard`. */
  workIndex: number | null
  /** The latest saved revision holding it; null while only the epic's draft does. */
  revisionNumber: number | null
  /** Its accepted attempt (not superseded by an adoption); null until one is accepted. */
  accepted: { runId: string; attemptId: string; at: string } | null
}

/** An observation window: from the scope's first dispatch to the scorecard's cutoff. */
interface ExperimentObservationWindow {
  from: string | null
  to: string
}

/** One side of a comparison: the frozen baseline, or a measured after-result. */
export interface ExperimentReading {
  value: number | null
  unit: ExperimentUnit
  state: 'observed' | 'estimated' | 'missing'
  /** The frozen grade it was read from; null for a stated value. */
  assessment: ExperimentAssessmentRef | null
  /** Tickets the scope counted (1 for a ticket grade); null when unknown (a stated value, or a scorecard not here). */
  sampleSize: number | null
  /** `value / sampleSize`, the figure an additive measure of a run, sprint or epic is compared by; null otherwise. */
  perTicket: number | null
  /** The ticket's planned size, for a ticket grade whose plan this machine holds; null otherwise. */
  size: TicketSize | null
  /**
   * How many tickets of each planned size a run, sprint or epic scope counted (`unsized` for none); null for a ticket
   * grade or a scope this machine cannot read. A per-ticket comparison needs the same mix on both sides.
   */
  sizeMix: Partial<Record<TicketSize | 'unsized', number>> | null
  window: ExperimentObservationWindow | null
}

export interface ExperimentGuardrailCheck extends ExperimentGuardrail {
  /** The guardrail measure in the after-assessment; null when it could not be read. */
  after: number | null
  verdict: 'held' | 'breached' | 'unknown'
  detail: string
}

/** One result event set against the baseline. */
export interface ExperimentComparison {
  eventId: string
  eventNumber: number
  recordedAt: string
  note: string
  after: ExperimentReading
  /** The result's evidence references, as recorded. */
  evidence: EvidenceRef[]
  /** `value`: the measures themselves; `per_ticket`: an additive measure of a run, sprint or epic, per ticket in scope. */
  basis: 'value' | 'per_ticket'
  /** The baseline and the result in `basis` terms; null when either has no such figure. */
  before: number | null
  measured: number | null
  /** The target in `basis` terms (the baseline moved by the expected change); null when the baseline has no such figure. */
  target: number | null
  /** `measured - before`; null when either is null. */
  difference: number | null
  /** The difference relative to the baseline in percent; null when it is null or the baseline is 0. */
  percentChange: number | null
  guardrails: ExperimentGuardrailCheck[]
  classification: ExperimentOutcomeClass
  /** Why it is classified so: the incompatibilities, the guardrail verdicts or the change against the target. */
  reasons: string[]
  /** Set when the result was read from the correction epic of another project (the Dark Mechanicus source). */
  crossRepo?: { projectId: string; key: string; epicId: string; epicTitle: string }
}

/** When the corrective work counts as landed: the after-window starts there. */
export interface ExperimentLanding {
  /** Null while it has not landed. */
  at: string | null
  /** `corrective_tickets`: the last of its work tickets was accepted; `completed_status`: no tickets, a `completed` status. */
  by: 'corrective_tickets' | 'completed_status' | null
  detail: string
}

/**
 * An experiment's outcome, derived when read from its frozen definition, its events, its corrective tickets and the
 * frozen scorecards its results cite: nothing is regraded and nothing approved is rewritten. It is observational: a
 * before/after difference over different work, never proof that the corrective work caused it.
 */
export interface ExperimentOutcome {
  experimentId: string
  status: ExperimentStatus
  classification: ExperimentOutcomeClass
  /**
   * The result event the classification comes from: the latest result whose in-window guardrail was breached (any
   * breach decides), else the latest one that could be compared; null when none could.
   */
  decidedBy: string | null
  reasons: string[]
  baseline: ExperimentReading
  /** The expected change and the value it aims at (the baseline moved by it), in the baseline's unit. */
  target: ExperimentChange & { value: number }
  guardrails: ExperimentGuardrail[]
  window: ExperimentWindow
  landing: ExperimentLanding
  corrections: { tickets: ExperimentCorrectionTicket[]; runIds: string[] }
  comparisons: ExperimentComparison[]
  evidence: 'observational'
  caveat: string
}
