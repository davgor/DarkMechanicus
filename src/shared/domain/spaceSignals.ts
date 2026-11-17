/**
 * The S, A and C signals: what a person said (ratings and rescue time), delivery against the scope committed before
 * dispatch, and handoff quality. Each section carries the grader's input (`SatisfactionInput`, `DeliveryInput`,
 * `CollaborationInput` in `space.ts`) and the records it was built from, so every number and deduction can be traced.
 */
import type {
  CollaborationInput,
  DeliveryInput,
  EvidenceRef,
  GradeSubjectLevel,
  HumanIntervention,
  HumanReviewActivity,
  MetricScope,
  SatisfactionInput,
  WorkflowCause
} from './space'

// ---------------------------------------------------------------------------------------------------------------
// Human feedback (desktop only)

/** The lowest and highest satisfaction/confidence rating a person can give. */
export const HUMAN_RATING_RANGE = { min: 1, max: 5 } as const

/** The most minutes one rescue or planned review entry may record (a full working week). */
export const MAX_RESCUE_MINUTES = 2_400

/** The fewest minutes a rescue or planned review entry may record when it gives any: less reads as a typing slip. */
export const MIN_FEEDBACK_MINUTES = 1

/**
 * What a person's feedback is about. A rating names a ticket (optionally in one run) or a sprint (a run named beside a
 * sprint only places it: the rating is the sprint's, once, whichever run it was given in); rescue and planned review
 * time may also name a run, or one attempt of a run. The epic is always named; the server checks every id belongs to it.
 */
export interface HumanFeedbackTarget {
  epicId: string
  sprintId?: string
  runId?: string
  ticketId?: string
  attemptId?: string
}

/**
 * A person's satisfaction/confidence rating, 1 to 5. A sprint rating states whether the person shares it with the
 * sprint's tickets as inherited context (`sharedWithTickets`, required on a sprint rating and refused on a ticket
 * rating). A ticket rating overrides any inherited one for that ticket; nothing is asked per ticket.
 */
export interface HumanRatingFeedback {
  kind: 'rating'
  value: number
  sharedWithTickets?: boolean
}

/**
 * Minutes a person spent stepping in, with how they stepped in and why (`cause`, required of every new entry; older
 * imported entries without one stay readable). `minutes` is optional: without it the entry says a rescue happened and
 * that its time was not given (`missing`).
 */
export interface RescueFeedback {
  kind: 'rescue'
  minutes?: number
  intervention: HumanIntervention
  cause: WorkflowCause
}

/**
 * Planned review or playtesting a person did: separate from rescue, never an intervention, never scored. `activity` is
 * what it was for; `minutes` is optional (absent: the time was not given).
 */
export interface PlannedReviewFeedback {
  kind: 'planned_review'
  activity: HumanReviewActivity
  minutes?: number
}

export interface RecordHumanFeedbackInput {
  target: HumanFeedbackTarget
  feedback: HumanRatingFeedback | RescueFeedback | PlannedReviewFeedback
  /** The person as the desktop knows them (an account name); the desktop session's label when absent. */
  person?: string
  /** A retry with the same key and request returns the first answer instead of recording the feedback twice. */
  idempotencyKey?: string
}

// ---------------------------------------------------------------------------------------------------------------
// Signals read

/**
 * What to read signals for. A ticket or sprint is read within one run (`runId`); a run is its own id; an epic reads
 * every run of the epic. `cutoff` (server time) limits every record to those stored by then; absent means now.
 */
export interface GetSpaceSignalsInput {
  level: GradeSubjectLevel
  /** The ticket, sprint, run or epic id. */
  id: string
  runId?: string
  cutoff?: string
}

/** A person's stored rating, rescue or planned review entry with who gave it, when, and what it is about. */
export interface HumanFeedbackEntry {
  observationId: string
  /** The person (the observation's `source.actor`). */
  person: string
  /** When the desktop recorded it (server time). */
  recordedAt: string
  scope: MetricScope
  /** The rating, or the minutes; null when a rescue or planned review entry gave no minutes (never read as 0). */
  value: number | null
  /** Ratings: shared with the sprint's tickets. Rescue and planned review entries: null. */
  sharedWithTickets: boolean | null
  intervention: HumanIntervention | null
  cause: WorkflowCause | null
  /** Planned review entries: what the time was for. Ratings and rescue entries: null. */
  activity: HumanReviewActivity | null
  /** Where the entry was recorded, so an entry another machine (or a hand-written record file) brought in is visible. */
  recordedBy: FeedbackProvenance
}

/**
 * Where a person's entry came from. Portable records are not authenticated: a human-sourced observation file in
 * `.darkmechanicus` imports like any other record, so the read shows the desktop session and machine that recorded it.
 * - `this_machine`: recorded by this machine's desktop app: it names this machine and one of this machine's own desktop
 *   sessions (the local sessions table, which never leaves the machine; a label, not a signature: a writer who copies a
 *   local desktop session id from an exported entry is still not caught);
 * - `other_machine`: names another machine and its desktop session: imported, and not verifiable here;
 * - `unattested`: names no recording desktop session or machine (which `recordHumanFeedback` always stores), or claims
 *   this machine without one of its desktop sessions: written by hand, or by an agent writing record files.
 */
export interface FeedbackProvenance {
  origin: 'this_machine' | 'other_machine' | 'unattested'
  desktopSession: string | null
  machine: string | null
}

export interface SatisfactionSignal {
  input: SatisfactionInput
  /** Where the sprint rating came from: the subject's own sprint, inherited by a ticket, or none usable. */
  sprintRatingUse: 'own' | 'inherited' | 'not_shared' | 'none'
  /** Every rating stored for the subject (and its sprints) by the cutoff, latest last; only the latest per scope counts. */
  ratings: HumanFeedbackEntry[]
  /** Rescue entries for the subject: a diagnostic beside E, never scored. */
  rescue: HumanFeedbackEntry[]
  /** The minutes the rescue entries gave; entries without minutes add nothing and are counted apart. */
  rescueMinutes: number
  /** Planned review and playtesting entries for the subject: never a rescue, never scored. */
  plannedReview: HumanFeedbackEntry[]
  plannedReviewMinutes: number
  /** Rescue and planned review entries that gave no minutes. */
  entriesWithoutMinutes: number
}

/**
 * Why a committed item reads undelivered:
 * - `not_accepted`: no accepted work attempt stands for the ticket at the cutoff.
 * - `criteria_unverified`: the ticket was accepted, but its acceptance did not verify every criterion it committed.
 *   Each such criterion is listed: `not_met` when the acceptance held it (same id and text, ignoring case and spacing)
 *   without verifying it met, `changed` when the accepted revision holds no such criterion (reworded or removed).
 */
export interface UndeliveredReason {
  reason: 'not_accepted' | 'criteria_unverified'
  criteria: { criterionId: string; cause: 'not_met' | 'changed' }[]
}

/** A committed deliverable: a ticket (sprint, run and epic levels) or an acceptance criterion (ticket level). */
export interface ScopeItem {
  /** A ticket id, or `<ticket id>#<criterion id>`. */
  id: string
  label: string
  delivered: boolean
  /** Why it is not delivered; null exactly when it is. */
  undelivered: UndeliveredReason | null
}

export interface DeliverySignal {
  input: DeliveryInput
  /**
   * The saved plan revision the scope was frozen from, or null before any dispatch: the revision the subject's first
   * work claim ran under; a ticket's is its sprint's first claim's when that plan already held the ticket there.
   */
  frozenRevisionId: string | null
  /** The server time of the claim that froze the scope, or null. */
  frozenAt: string | null
  /** The server time of the subject's own first work claim (its dispatch), or null. */
  dispatchedAt: string | null
  /** The revision compared with it for additions and removals (the run's plan at the cutoff). */
  currentRevisionId: string | null
  committed: ScopeItem[]
  /** Committed items the current plan no longer holds; they stay in the denominator. */
  removed: ScopeItem[]
  /** Scope authorized after dispatch: shown separately, never in A. */
  added: ScopeItem[]
  /** Tickets an earlier run completed (carry-forward): neither committed nor delivered here. */
  carriedForward: string[]
}

export const HANDOFF_CHECKS = ['criteria_evidence', 'verification_checks', 'outputs_contract'] as const
export type HandoffCheckName = (typeof HANDOFF_CHECKS)[number]

/** One deduction from C, linked to the record that caused it. */
export type CollaborationDeduction =
  | {
      kind: 'failed_handoff_check'
      observationId: string
      attemptId: string
      check: string
      /** What the handoff lacked (criterion ids, check names or output fields), as many whole items as were stored. */
      missing: string[]
      /** How many items were missing in all; more than `missing` lists when the list was too long to store whole. */
      missingCount: number
      /** The review decision on that submission by the cutoff, or null when undecided. */
      review: { outcome: 'accepted' | 'rejected'; decidedBy: string; decidedAt: string } | null
      evidence: EvidenceRef[]
    }
  | {
      kind: 'coordination_defect'
      observationId: string
      count: number
      reportedBy: string | null
      /** The run records the defect cites. */
      evidence: EvidenceRef[]
    }
  | {
      /**
       * The review rejected this submission by the cutoff; under `C.handoff-pass-rate.v2` its handoff failed and the
       * `checks` it passed on their own count failed too (any it failed are listed as `failed_handoff_check`).
       */
      kind: 'rejected_submission'
      attemptId: string
      checks: number
      decidedBy: string
      decidedAt: string
      evidence: EvidenceRef[]
    }

/**
 * A submission C reads no derived handoff checks for, and why:
 * - `checks_refused`: the ledger refused its checks when it arrived; `code` and `detail` are the refusal as this
 *   machine logged it (`attempt.handoff_checks_refused`);
 * - `not_recorded`: no checks and no logged refusal here: submitted before checks were derived, or brought in from
 *   another machine without them.
 */
export interface UncheckedSubmission {
  attemptId: string
  reason: 'checks_refused' | 'not_recorded'
  code: string | null
  detail: string
}

export interface CollaborationSignal {
  input: CollaborationInput
  /** Submissions in scope by the cutoff, and those of them with no derived checks (unavailable observations). */
  submissions: number
  uncheckedSubmissions: string[]
  /** Why each unchecked submission has no checks, in `uncheckedSubmissions` order. */
  unchecked: UncheckedSubmission[]
  deductions: CollaborationDeduction[]
  /** Clarifications a person recorded (intervention `clarification`): shown, never a deduction. */
  clarifications: number
}

export interface SpaceSignalsView {
  subject: { level: GradeSubjectLevel; id: string }
  runId: string | null
  epicId: string
  cutoff: string
  S: SatisfactionSignal
  A: DeliverySignal
  C: CollaborationSignal
}
