/**
 * Retro findings: the measured gaps of a sprint, read from the scorecard frozen with a sprint report revision, so a
 * retro starts from what the records show rather than from impression.
 *
 * A finding states an observed fact (a gap, its magnitude and how much of the scope it covers) and cites the records it
 * comes from: the frozen assessment, the attempts, criteria, checks and observations in the grade's evidence. It never
 * claims a cause. What might explain it is listed as hypotheses, each labeled as one and tagged with the kind of gap it
 * would be (`ImprovementConcern`). Only a finding with exactly one candidate concern, consistent signals and enough data
 * carries a proposal outline, and an outline names what to measure and where the work would go but never the work: the
 * planner authors specific, sized corrective work from it (an experiment in a later report revision). Nothing here picks
 * a model or a larger tier.
 *
 * Findings are derived on read from the frozen snapshot alone (no clock, no later records), so the same scorecard
 * gives the same findings in the same order, byte for byte.
 */
import type {
  ExperimentDestinationKind,
  ExperimentDirection,
  ExperimentMeasure,
  ExperimentUnit,
  GuardrailComparator,
  ImprovementConcern,
  SealedAssessmentInput
} from './experiments'
import type { EvidenceRef, GradeSubject, MeasurementState, SpaceComponent } from './space'

/** The kinds of measured gap, in the order they rank when equally large. */
export const FINDING_KINDS = [
  'failed_verification',
  'delivery_gap',
  'coordination_problem',
  'corrective_concentration',
  'budget_overrun',
  'missing_instrumentation'
] as const
export type FindingKind = (typeof FINDING_KINDS)[number]

/** How large the gap is: the observed value, against what (a commitment, a baseline, a total), and their ratio. */
export interface FindingMagnitude {
  /** The measure an experiment would name for it; null when no experiment measure reads it (missing data). */
  measure: ExperimentMeasure | null
  value: number
  unit: ExperimentUnit | 'ratio'
  /** What the value is compared with (committed items, the baseline, the scope's total); null when nothing. */
  reference: number | null
  /** value ÷ reference, or the share it stands for (0–1); null without a reference. */
  ratio: number | null
  /** How the value was measured: an estimate stays labeled as one. */
  state: Exclude<MeasurementState, 'missing'>
  /** The magnitude in words, with its numbers. */
  text: string
}

/** How much of the subject the finding's data covers. */
export interface FindingCoverage {
  /** The grade's coverage (components scored ÷ required), 0–1. */
  grade: number
  /**
   * Items the finding counted and how many of them had data, when it counts items; null otherwise (a ticket's own
   * verification, handoffs or budget). Corrective concentration: the sprint's tickets and those with corrective effort
   * measured. Missing instrumentation: the dispatched tickets and those with a value. Delivery gap: the committed items
   * and those whose delivery state rests on reviewed evidence.
   */
  items: { measured: number; total: number } | null
}

/** Where a finding comes from, by record. */
export interface FindingOrigins {
  attemptIds: string[]
  /** Ticket criteria (`criterion` evidence: the ticket id and the criterion id). */
  criteria: { ticketId: string; criterionId: string }[]
  observationIds: string[]
  /** Checks as `check` evidence names them: the attempt and the check name. */
  checks: { attemptId: string; name: string }[]
  ticketIds: string[]
}

/** A possible explanation, labeled as a hypothesis: the measured gap does not prove it. */
export interface FindingHypothesis {
  concern: ImprovementConcern
  hypothesis: string
}

/** Why a finding carries no proposal outline. */
const PROPOSAL_WITHHELD_REASONS = [
  /** More than one concern could explain it: the planner chooses after looking, nothing is proposed for them. */
  'multiple_candidate_causes',
  /** Another measure of the same subject points the other way. */
  'contradictory_signals',
  /** The scorecard has too little data to size a change. */
  'sparse_data',
  /** The measure the change would be read from has no value in the frozen grade. */
  'no_baseline'
] as const
export type ProposalWithheldReason = (typeof PROPOSAL_WITHHELD_REASONS)[number]

/**
 * What a proposal for a finding would measure and where its work would go, ready to fill in as an experiment of a later
 * report revision (`source` cites the frozen grade). It holds no work: `needs` lists what the planner still writes
 * (specific, sized proposed work, the size of the change and its window), so nothing can be scheduled from it as is.
 */
export interface ProposalOutline {
  concern: ImprovementConcern
  destination: ExperimentDestinationKind
  source: SealedAssessmentInput
  /**
   * The measured value a change would be read against; null for missing instrumentation, where nothing is measured
   * yet (the work is a discovery: an experiment needs a measured baseline).
   */
  baseline: { measure: ExperimentMeasure; unit: ExperimentUnit; value: number; state: 'observed' | 'estimated' } | null
  direction: ExperimentDirection
  guardrails: { measure: ExperimentMeasure; unit: ExperimentUnit; comparator: GuardrailComparator; threshold: number }[]
  needs: string[]
}

export interface RetroFinding {
  /** Stable within the scorecard: `<kind>:<level>:<subject id>[:<component>]`. */
  id: string
  /** 1 for the largest gap. */
  rank: number
  kind: FindingKind
  subject: GradeSubject
  /** The frozen grade the finding was read from. */
  assessmentId: string
  /** The SPACE component the gap shows in. */
  component: SpaceComponent
  /** The observed fact, with its numbers; never a cause. */
  statement: string
  magnitude: FindingMagnitude
  /** 0–1: how large the gap is relative to its reference, the value findings rank by (ties: kind order, then id). */
  severity: number
  coverage: FindingCoverage
  origins: FindingOrigins
  /** Every record cited, as the grade's evidence names it. */
  evidence: EvidenceRef[]
  /** Explanations to check, each a hypothesis; one, several or none. */
  hypotheses: FindingHypothesis[]
  /** The single candidate concern; null when several (or none) remain. */
  concern: ImprovementConcern | null
  /** Other findings of the same subject whose signals disagree with this one. */
  contradictedBy: string[]
  proposal: ProposalOutline | null
  /** Why `proposal` is null. */
  withheld: ProposalWithheldReason | null
}

/**
 * - `findings`: at least one measured gap.
 * - `no_meaningful_issue`: the scorecard shows no gap past the thresholds: nothing to correct, and nothing is proposed.
 * - `insufficient_data`: too little was measured to size a change: findings are still listed, but only missing
 *   instrumentation carries a proposal outline (every other one is withheld as `sparse_data`).
 */
const FINDINGS_STATUSES = ['findings', 'no_meaningful_issue', 'insufficient_data'] as const
export type FindingsStatus = (typeof FINDINGS_STATUSES)[number]

/** A disagreement between two measures of one subject, shown rather than resolved. */
export interface FindingContradiction {
  subject: GradeSubject
  findingIds: string[]
  detail: string
}

export interface RetroFindingsView {
  runId: string
  sprintId: string
  reportId: string
  reportRevision: number
  snapshotId: string
  /** The scorecard's cutoff: nothing recorded later is read. */
  cutoff: string
  policyHash: string
  status: FindingsStatus
  findings: RetroFinding[]
  contradictions: FindingContradiction[]
  /** The thresholds a gap must pass to be a finding, as applied. */
  thresholds: RetroFindingThresholds
  /** Plain statements about how to read the findings (what was left out and why). */
  notes: string[]
}

export interface RetroFindingThresholds {
  /** A resource actual this much over its baseline (ratio − 1) is an overrun. */
  overrun: number
  /** A ticket holding more than this share of the sprint's corrective effort (at 0.5: a strict majority) concentrates it… */
  correctiveShare: number
  /** …when corrective effort is also at least this share of its own classified effort. */
  correctiveOfOwn: number
  /**
   * A ticket counts as measured when its grade covers at least this share of its components; with fewer than this
   * share of the sprint's tickets measured (or a grade the grader found too sparse), no change is sized.
   */
  sparseCoverage: number
}
