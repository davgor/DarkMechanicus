/**
 * Pure view model for the redraft at a checkpoint: the epic's draft, read as the plan for the next sprint,
 * what approving it does, and how a refusal of that approval reads. The draft counts as a redraft only when
 * it holds changes the saved plan lacks.
 */
import type { ApproveWithRedraftStep, PlanView, RunView } from '../../../shared/domain/views'
import { changeRows, STALE_DRAFT_NOTE, type ChangeRow } from '../epic/validationView'

export interface RedraftPanel {
  /** "REDRAFT · CHANGES AGAINST REV 4". */
  heading: string
  /** The draft's revision counter, which the approval names so it saves exactly what was shown. */
  draftRevision: number
  rows: ChangeRow[]
  /** What approving does, under the changes. */
  approves: string
  /** What the plan gate row says: approving is what makes the run execute the current plan. */
  gateDetail: string
  /**
   * The sprint's unfinished required work is no longer in the sprint in the draft, so the required-tickets gate is
   * met once the draft is adopted: approving does not wait for it.
   */
  clearsRequired: boolean
  /** The draft builds on a revision the run has not adopted; null when it builds on the run's. */
  warning: string | null
  /** Why approving is unavailable (a stale draft cannot be saved); null when it is available. */
  blocked: string | null
}

/** What a refused approval carries in its error details, as far as it is well formed. */
export interface RedraftRefusal {
  message: string
  step: ApproveWithRedraftStep | null
  stepNumber: number | null
  savedRevisionNumber: number | null
  adoptionNeeded: boolean
}

/** A refusal as the person reads it: which step stopped, why, and whether adoption is still needed. */
interface RefusalNotice {
  lead: string
  message: string
  adoption: string | null
}

const STEP_COUNT = 5

const STEP_ACTIONS: Record<ApproveWithRedraftStep, string> = {
  save: 'saving the draft',
  adopt: 'adopting the revision',
  recompute: 're-checking the gates',
  approve: 'approving the report',
  advance: 'advancing the sprint'
}

/** The saved revision the draft becomes: the one after its base. */
function nextRevision(draft: PlanView): number {
  return (draft.baseRevisionNumber ?? 0) + 1
}

function headingOf(draft: PlanView, run: RunView): string {
  if (draft.baseRevisionNumber === null) {
    return 'REDRAFT · CHANGES · FIRST REVISION'
  }
  return draft.baseRevisionId === run.revisionId
    ? `REDRAFT · CHANGES AGAINST REV ${run.revisionNumber}`
    : `REDRAFT · CHANGES SINCE REV ${draft.baseRevisionNumber}`
}

function warningOf(draft: PlanView, run: RunView): string | null {
  if (draft.baseRevisionId === run.revisionId) {
    return null
  }
  return `Run #${run.number} executes rev ${run.revisionNumber}; this draft builds on rev ${draft.baseRevisionNumber ?? '?'}, which the run has not adopted. Approving saves and adopts the draft as rev ${nextRevision(draft)}.`
}

/** True when every required ticket of the sprint the run has not accepted is out of that sprint in the draft (moved on, or gone). */
function clearsRequired(draft: PlanView, run: RunView, sprintId: string): boolean {
  const listed = new Set(draft.bundle.sprints.find((item) => item.id === sprintId)?.ticketIds ?? [])
  const optional = new Set(draft.bundle.tickets.filter((item) => item.optional).map((item) => item.id))
  return run.tickets
    .filter((item) => item.sprintId === sprintId && item.state !== 'accepted' && !optional.has(item.ticketId))
    .every((item) => !listed.has(item.ticketId))
}

/** The panel for the epic's draft at the checkpoint of this sprint; null when there is no draft, it holds no changes, or it has no revision counter. */
export function redraftPanel(draft: PlanView | null, run: RunView, sprintId: string): RedraftPanel | null {
  if (draft === null || draft.changes.length === 0 || draft.draftRevision === null) {
    return null
  }
  const next = nextRevision(draft)
  return {
    heading: headingOf(draft, run),
    draftRevision: draft.draftRevision,
    rows: changeRows(draft.changes),
    approves: `Approving saves this draft as rev ${next}, adopts it into Run #${run.number}, approves this report and advances.`,
    gateDetail: `Approve retro & redraft saves this draft as rev ${next} and adopts it into Run #${run.number}.`,
    clearsRequired: clearsRequired(draft, run, sprintId),
    warning: warningOf(draft, run),
    blocked: draft.stale ? STALE_DRAFT_NOTE : null
  }
}

const STEPS = Object.keys(STEP_ACTIONS) as ApproveWithRedraftStep[]

function stepOf(value: unknown): ApproveWithRedraftStep | null {
  return STEPS.find((step) => step === value) ?? null
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/** Reads the step, the saved revision and whether adoption is still needed from a failed command's details. */
export function redraftRefusal(failure: { message: string; details?: Record<string, unknown> }): RedraftRefusal {
  const details = failure.details ?? {}
  return {
    message: failure.message,
    step: stepOf(details['step']),
    stepNumber: numberOf(details['stepNumber']),
    savedRevisionNumber: numberOf(details['savedRevisionNumber']),
    adoptionNeeded: details['adoptionNeeded'] === true
  }
}

function adoptionText(refusal: RedraftRefusal): string {
  const saved = refusal.savedRevisionNumber
  const lead = saved === null ? 'The draft was saved' : `The draft was saved as rev ${saved}`
  const which = saved === null ? 'the saved revision' : `rev ${saved}`
  return `${lead}, but adoption is still needed: the run still executes its earlier revision. Adopt ${which} from the run bar, then approve. Nothing was approved or advanced.`
}

export function refusalNotice(refusal: RedraftRefusal): RefusalNotice {
  const lead =
    refusal.step === null || refusal.stepNumber === null
      ? "Approve retro & redraft didn't go through."
      : `Approve retro & redraft stopped at step ${refusal.stepNumber} of ${STEP_COUNT}: ${STEP_ACTIONS[refusal.step]}.`
  return { lead, message: refusal.message, adoption: refusal.adoptionNeeded ? adoptionText(refusal) : null }
}
