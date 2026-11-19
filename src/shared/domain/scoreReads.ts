/**
 * The command contracts the desktop (and MCP, through `src/mcp/tools/metrics.ts`) reads SPACE scorecards with, and the desktop's measurement
 * controls. Every read returns a core read model unchanged (`getTicketGrade`, `getSprintGrade`, `getRunGrade`,
 * `getEpicGrade`, `getReportScorecard`, `reassessReportScorecard`, `getSpaceSignals`, `getTicketPerformance`,
 * `getEscapedDefects`, `getRunEfficiency`): nothing is regraded outside the core. A sprint-report read is pinned to the
 * report revision it names and returns the snapshot frozen with it, never the live grade; a report submitted before
 * scorecards existed reads as `legacy`, never as an empty grade.
 *
 * The measurement controls are the person's: a rating, rescue time or planned review time (`recordHumanFeedback`) and
 * escaped defect records (`recordEscapedDefects`) are recorded only by the desktop session, as source `human`. A
 * ticket's prospective budget (`setTicketBudget`) is a draft edit like any other, saved (and frozen as a new budget
 * version) only by `savePlan`. `getGradingPolicy` shows the one balanced policy new grades use and how it calculates;
 * there is no policy editor.
 */
import type { TicketBudget } from './bundle'
import type { TicketPlannedBaselinesView } from './metrics'
import type { DefectAttribution, DefectEvent, DiscoveryPhase } from './performance'
import type { EvidenceRef, GradeLetter, MetricObservation, RegressionSeverity, SignalKind, SpaceComponent } from './space'
import type { ScorecardView } from './spaceGrades'

// ---------------------------------------------------------------------------------------------------------------
// The grading policy

/** One component as the policy grades it: its base weight and share, whether it is required, and its rule in words. */
export interface GradingPolicyComponentView {
  component: SpaceComponent
  weight: number
  /** The component's share of the summed base weight when every component is scored (1/7 under the balanced policy). */
  baseShare: number
  required: boolean
  signal: SignalKind
  rule: string
  /** The rule's formula with this policy's numbers, as docs/space-grading.md states it. */
  formula: string
  /** What happens when the component cannot be scored. */
  whenMissing: string
}

/**
 * The policy new grades are computed under (the default balanced policy; frozen grades keep the policy they name), with
 * its calculation spelled out: each component's rule, how the composite, the cap and the letter follow, and the bands.
 * Read-only: no command edits a policy.
 */
export interface GradingPolicyView {
  policy: { policyId: string; version: number; hash: string }
  components: GradingPolicyComponentView[]
  /** How the scored components combine: the weighted mean over scored components only, missing ones dropping out. */
  composite: string
  bands: { letter: GradeLetter; min: number }[]
  /** Below this many scored components a grade is ungraded rather than provisional. */
  minScoredComponents: number
  /** A confirmed mandatory failure caps the score here and the letter at F. */
  mandatoryFailureCeiling: number
  /** How scores are kept and shown. */
  precision: string
}

// ---------------------------------------------------------------------------------------------------------------
// Pinned report reads

/** The sprint report revision a scorecard read is pinned to. */
export interface ReportIdentity {
  reportId: string
  runId: string
  sprintId: string
  reportRevision: number
  /** The revision's submission (server time): the cutoff its scorecard was frozen at. */
  submittedAt: string
}

/**
 * A sprint report revision's scorecard. `reportRevision`, when given, must be the revision `reportId` names, so a view
 * that asked for revision 2 never shows revision 3 (`not_found` otherwise).
 */
export interface GetReportScorecardInput {
  reportId: string
  reportRevision?: number
}

/**
 * What a report revision's scorecard read returns: the snapshot frozen with it (every grade regraded from its stored
 * input under its stored policy), or `legacy` for a report submitted before scorecards were frozen. A legacy report
 * stays ungraded: it has no score, and no live grade stands in for one.
 */
export type ReportScorecardView =
  | { state: 'frozen'; report: ReportIdentity; scorecard: ScorecardView }
  | { state: 'legacy'; report: ReportIdentity; reason: string }

// ---------------------------------------------------------------------------------------------------------------
// Escaped defects a person records

/**
 * One escaped defect record (see `performance.ts`): a `report` names its severity, attribution and discovery phase and
 * cites the build it was found in (evidence `commit`, detail `source build`) and, when attributed, its origin ticket
 * and accepted attempt (detail `origin`); a `duplicate`, `reassessment`, `fix` or `withdrawal` cites a stored report
 * (evidence `observation`, detail `defect`). Records cite stored reports only: ids are assigned by the server.
 */
export interface EscapedDefectRecordInput {
  defectEvent: DefectEvent
  severity?: RegressionSeverity
  attribution?: DefectAttribution
  discoveryPhase?: DiscoveryPhase
  /** An external key reports share (an issue number). */
  defectKey?: string
  evidence: EvidenceRef[]
}

export interface RecordEscapedDefectsInput {
  /** The epic the defects belong to, and optionally the run or sprint they were found in. */
  target: { epicId: string; runId?: string; sprintId?: string }
  /** Stored in call order (server-assigned, monotonically ordered ids), all or none. */
  records: EscapedDefectRecordInput[]
  /** The person as the desktop knows them; the desktop session's label when absent. */
  person?: string
  /** A retry with the same key and request returns the first answer instead of recording the records twice. */
  idempotencyKey?: string
}

export interface RecordEscapedDefectsResultView {
  /** The stored records, in call order. */
  observations: MetricObservation[]
}

// ---------------------------------------------------------------------------------------------------------------
// Prospective budgets

/**
 * Sets (or, with `null`, clears) a ticket's planned budget in the epic's draft. `expectedDraftRevision` is the draft
 * revision the person edited: a draft changed since is refused (`conflict`) and nothing is written, so a stale form
 * never overwrites another edit. `runId` places the result relative to that run's dispatches.
 */
export interface SetTicketBudgetInput {
  epicId: string
  ticketId: string
  budget: TicketBudget | null
  expectedDraftRevision: number
  runId?: string
}

export interface SetTicketBudgetResultView {
  epicId: string
  /** The draft revision after the edit: what the next edit or `savePlan` names. */
  draftRevision: number
  /**
   * The ticket's budget versions with the unsaved draft edit (`budgets[].draft`); null for a ticket only the draft holds
   * or any ticket of a never-saved epic, whose budget becomes its first version when the plan is saved.
   */
  ticket: TicketPlannedBaselinesView | null
  /**
   * `later_dispatches`: the ticket was already dispatched in the run, which keeps the budget pinned at its first claim;
   * the edit, once saved, applies only to later dispatches. `next_dispatch`: no dispatch has pinned a budget yet.
   * Either way nothing applies until the draft is saved.
   */
  appliesTo: 'next_dispatch' | 'later_dispatches'
}
