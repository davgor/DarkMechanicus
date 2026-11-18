/**
 * P (performance) inputs: what a ticket's verification and its escaped defects say, read from independent review
 * decisions, required-check evidence, criterion identities and the defect records in the SPACE observation ledger.
 *
 * Escaped defects are `escaped_defect` observations (`space.ts`) whose attribute `defectEvent` says what each record
 * is: a `report` of a defect, or a later record linked to one (`duplicate`, `reassessment`, `fix`, `withdrawal`).
 * Nothing is ever rewritten: a fix or a withdrawal is a new record that cites the report, so the evidence stays.
 * The pure read models are `src/core/space/defects.ts` and `src/core/space/verification.ts`; the service that feeds
 * them a run's records is `src/core/services/performance.ts`.
 */
import type { EvidenceRef, GradeSubject, MetricScope, MetricSourceKind, PerformanceInput, RegressionSeverity, VerificationState } from './space'
import type { AttemptKind, AttemptState } from './status'

// ---------------------------------------------------------------------------------------------------------------
// Escaped defect records

/**
 * What an `escaped_defect` observation records (attribute `defectEvent`):
 * - `report`: a defect found after its origin was accepted (value 1). It names its severity, attribution, discovery
 *   phase and the build it was found in.
 * - `duplicate`: two reports describe one defect (value 0); the defect counts once.
 * - `reassessment`: a later judgement of a defect's severity or attribution (value 0), e.g. a candidate confirmed.
 * - `fix`: the work or commit that fixed it (value 0). The defect still counts: it escaped.
 * - `withdrawal`: the report was not a defect after all (value 0). The defect stops counting; its records stay.
 */
export const DEFECT_EVENTS = ['report', 'duplicate', 'reassessment', 'fix', 'withdrawal'] as const
export type DefectEvent = (typeof DEFECT_EVENTS)[number]

/**
 * Who a defect is charged to.
 * - `attributed`: confirmed to come from one accepted outcome (an origin ticket and its accepted attempt); charged.
 * - `candidate`: suspected to come from an origin ticket, not confirmed; shown, never charged.
 * - `unassigned`: no origin named; shown, never charged.
 */
export const DEFECT_ATTRIBUTIONS = ['attributed', 'candidate', 'unassigned'] as const
export type DefectAttribution = (typeof DEFECT_ATTRIBUTIONS)[number]

/**
 * Where an escaped defect surfaced, after its origin's acceptance: the combined row checks (`integration`), the
 * sprint's acceptance node or Definition of Done (`sprint_acceptance`), the person's sprint review
 * (`sprint_review`), later work of the same epic (`later_sprint`) or after the epic (`after_epic`).
 */
export const DISCOVERY_PHASES = ['integration', 'sprint_acceptance', 'sprint_review', 'later_sprint', 'after_epic'] as const
export type DiscoveryPhase = (typeof DISCOVERY_PHASES)[number]

/** The evidence `detail` values that link a defect record to what it is about. */
export const DEFECT_LINKS = {
  /** A commit: the build the defect was found in (every report names exactly one). */
  sourceBuild: 'source build',
  /** A ticket (the origin ticket) and, when attributed, an attempt (its accepted outcome). */
  origin: 'origin',
  /** An observation: the report a follow-up is about. */
  defect: 'defect',
  /** An observation: on a `duplicate` record, the report that duplicates the `defect`. */
  duplicate: 'duplicate',
  /** A commit, ticket or attempt that fixed the defect. */
  fixedBy: 'fixed by'
} as const

/**
 * The server-stamped attribute (`authority: review`) that lets an agent-sourced defect record change charging: the
 * server sets it only for a session holding `attempt.review` (an orchestrator or reviewer) and refuses it from callers.
 * Records that change charging (an `attributed` report, a duplicate, a reassessment, a fix, a withdrawal) need a
 * human or server source, or this stamp; anything else is refused on record and on import and never read.
 */
export const DEFECT_AUTHORITY = { attribute: 'authority', review: 'review' } as const

// ---------------------------------------------------------------------------------------------------------------
// Escaped defect read model

type DefectStatus = 'open' | 'fixed' | 'withdrawn'

/** The origin a defect is attributed to: a ticket and, when confirmed, its accepted attempt. */
export interface DefectOrigin {
  ticketId: string
  attemptId: string | null
}

/**
 * One defect as its records say at a cutoff. Its id is its first report's observation id, so it is stable however
 * many reports, duplicates or reassessments follow; duplicate reports fold into it and never count again. It reads
 * what its base report says (its first, or the `defect` a duplicate record named) while that is not withdrawn, else
 * its earliest report that is not, adjusted by its reassessments.
 */
export interface EscapedDefect {
  defectId: string
  /** Every report folded into this defect, first report first. */
  reportIds: string[]
  /** The external key reports share (an issue number); agreeing reports with the same key in an epic are one defect. */
  defectKey: string | null
  /** Where the report it reads was recorded. */
  scope: MetricScope
  reportedBy: { kind: MetricSourceKind; actor: string | null }
  severity: RegressionSeverity
  attribution: DefectAttribution
  origin: DefectOrigin | null
  discoveryPhase: DiscoveryPhase
  /** The commit the defect was found in. */
  sourceBuild: string
  /** When the report says it was found (the source's clock; provenance only, never used to charge). */
  discoveredAt: string
  /** When the server stored the report it reads: what "found after acceptance" is judged by. */
  recordedAt: string
  status: DefectStatus
  /** Whether it counts as a defect at all (false once every report is withdrawn). Counting is not charging. */
  counted: boolean
  /** The reassessments applied, in ledger order. */
  reassessmentIds: string[]
  fixes: { observationId: string; recordedAt: string; fixedBy: EvidenceRef[] }[]
  /** Each withdrawn report and the withdrawal that withdrew it. */
  withdrawals: { observationId: string; reportId: string; recordedAt: string }[]
  /** The latest server time among the records that shaped it. */
  updatedAt: string
}

/**
 * A defect record the read model could not apply, or reports it would not merge; listed, never guessed at.
 * - `unknown_defect`: it cites no report known at the cutoff.
 * - `withdrawn_twice`: the report it withdraws was already withdrawn.
 * - `conflicting_reports`: a report shares an earlier report's defect key (`relatedId`) but disagrees on severity,
 *   attribution or origin, so it stays its own defect until a person reassesses or joins them.
 */
export interface DefectAnomaly {
  observationId: string
  reason: 'unknown_defect' | 'withdrawn_twice' | 'conflicting_reports'
  relatedId: string | null
}

export interface EscapedDefectsView {
  cutoff: string
  defects: EscapedDefect[]
  anomalies: DefectAnomaly[]
}

// ---------------------------------------------------------------------------------------------------------------
// Verification

/**
 * What one criterion or check of a verification rests on:
 * - `reviewer_checked`: an independent reviewer stated it (a criterion result passed to `accept_attempt`), or, for a
 *   reported check, the accepted decision covers it (a check has no per-check review channel).
 * - `worker_claim`: only the worker said so. Never verification, met or not.
 * - `review_unknown`: a criterion result on an acceptance recorded before reviewers' results were kept apart, so
 *   nothing shows whether the worker or the reviewer stated it. Never read as reviewed.
 * - `skipped`: the check was reported as skipped.
 * - `missing`: nothing reports it.
 */
const VERIFICATION_BASES = ['reviewer_checked', 'worker_claim', 'review_unknown', 'skipped', 'missing'] as const
type VerificationBasis = (typeof VERIFICATION_BASES)[number]

export interface VerificationItem {
  kind: 'criterion' | 'check'
  /** The criterion id (`c1`) or the check name. */
  id: string
  /**
   * Every criterion is required; a check only when it is in the Definition of Done the acceptance node was accepted
   * against. Any other check is a diagnostic: shown, and never a confirmed failure (a worker may report a failing
   * suite it did not touch).
   */
  required: boolean
  basis: VerificationBasis
  /** What the basis says: null when skipped or missing. A required `reviewer_checked` failure is a confirmed failure. */
  result: 'passed' | 'failed' | null
  note: string
  evidence: EvidenceRef[]
}

/**
 * Why verification is in its state.
 * - `reviewed`: accepted by an independent review, every required item reviewer-checked and passed (verified).
 * - `confirmed_failure`: a Definition of Done check failed or the reviewer found a criterion unmet on the accepted
 *   attempt, or the ticket used every try where the run's retry grants are known (failed).
 * - `awaiting_review`, `in_progress`, `awaiting_retry`: no outcome yet (pending).
 * - `legacy_review_basis_unknown`: accepted before reviewers' criterion results were kept apart from the worker's,
 *   so the review basis is unknown (missing).
 * - `worker_claims_only`: accepted, but some criterion rests only on the worker's word or is not reported (missing).
 * - `required_evidence_missing`: accepted, but a Definition of Done check is skipped or not reported (missing).
 * - `retry_grants_unknown`: the ticket used every try its tracked records show, but the machine-local retry grants are
 *   not known where it is read (a machine that does not own the run, and the run did not end failed by `fail_run` on
 *   this ticket): the failure is not confirmed (missing).
 * - `run_ended`: the run ended (canceled, failed or completed) without an outcome for the ticket (missing).
 * - `carried_forward`: accepted in an earlier run; this run holds no review of it (missing).
 * - `no_attempt`: nothing was dispatched (missing).
 */
export const VERIFICATION_REASONS = [
  'reviewed',
  'confirmed_failure',
  'awaiting_review',
  'in_progress',
  'awaiting_retry',
  'legacy_review_basis_unknown',
  'worker_claims_only',
  'required_evidence_missing',
  'retry_grants_unknown',
  'run_ended',
  'carried_forward',
  'no_attempt'
] as const
export type VerificationReason = (typeof VERIFICATION_REASONS)[number]

/** A ticket's verification in one run, as of a cutoff. */
export interface VerificationRecord {
  runId: string
  ticketId: string
  state: VerificationState
  reason: VerificationReason
  /** The attempt the state is read from (standing accepted, awaiting review, or latest), or null with none. */
  attemptId: string | null
  /** That attempt's kind and state as of the cutoff. */
  attemptKind: AttemptKind | null
  attemptState: AttemptState | null
  /** The decision's server time and decider, when the attempt was decided by the cutoff. */
  decidedAt: string | null
  decidedBy: string | null
  items: VerificationItem[]
  /** The attempt, its decision's criteria and checks: what `PerformanceInput.verification.evidence` cites. */
  evidence: EvidenceRef[]
}

// ---------------------------------------------------------------------------------------------------------------
// Assessment input

/**
 * Why a defect linked to the subject is or is not charged:
 * - `charged`: attributed to the subject's accepted outcome and found after it.
 * - `candidate`, `unassigned`: not confirmed; shown only.
 * - `other_outcome`: attributed to another accepted attempt of the ticket (another run's).
 * - `before_acceptance`: stored (server time) before the outcome it names was accepted, so it did not escape it.
 */
export type RegressionCharge = 'charged' | 'candidate' | 'unassigned' | 'other_outcome' | 'before_acceptance'

export interface RegressionView {
  defectId: string
  severity: RegressionSeverity
  attribution: DefectAttribution
  status: DefectStatus
  charge: RegressionCharge
}

/**
 * The P input of one ticket in one run as of `cutoff`, with what it was built from. Rebuilding it for the same cutoff
 * gives the same input: it reads only times the server writes once (submission, decision, supersede, reconcile and
 * run-end columns; failure, cancel, lease-expiry and retry-grant times from the event log; ledger `recordedAt`) and the
 * Definition of Done frozen on an acceptance node's decision, never the current configuration or execution state.
 * (Limits: a failure recorded on another machine, whose event log does not travel, is timed by its row's last update;
 * records imported later from another machine keep their own server times and so can join an earlier cutoff; and a
 * ticket out of tries reads `confirmed_failure` or `retry_grants_unknown` by whether the reading machine owns the run,
 * since retry grants never travel.) A defect or decision recorded later only changes an input for a later cutoff, so a
 * later confirmed regression is a new dated input and never rewrites an earlier one or any accepted record.
 */
export interface PerformanceAssessmentInput {
  subject: GradeSubject
  runId: string
  cutoff: string
  /** The latest server time among the records it used (decision, defect records); null when none. */
  basisAt: string | null
  /** What `gradeSpace` consumes as `components.P`. */
  performance: PerformanceInput
  verification: VerificationRecord
  /** Every counted defect whose origin is the ticket, charged or not. Withdrawn defects are left out. */
  regressions: RegressionView[]
}
