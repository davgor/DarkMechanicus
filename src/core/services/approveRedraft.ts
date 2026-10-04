/**
 * Approve with redraft: one approval by the person covers the sprint's retro and the redraft of the next sprint.
 * In order it saves the draft, adopts the saved revision into the run, recomputes the gates on it, approves the
 * current report and advances. A refusal stops the steps after it and names its step.
 *
 * The save commits on its own. Saving is two-phase: the request records a pending revision and a snapshot outbox
 * entry, and the flush writes the snapshot file and then marks the revision saved and current (the finalizer). A
 * file write cannot be rolled back with a database transaction, and adoption only takes the epic's current saved
 * revision, so the flush runs between the save and the rest. If it leaves the revision pending, the save step
 * refuses. Adopting, recomputing, approving and advancing then run in one transaction: a refusal at any of them
 * rolls all of them back, so the run stays on its old revision with nothing approved or advanced, the saved
 * revision stays in place, and the error says that adoption is still needed.
 */
import type { ApproveWithRedraftResultView, ApproveWithRedraftStep } from '../../shared/domain/views'
import { requireCapability, type Capability } from '../authz'
import type { Ctx } from '../context'
import { DomainError, fail } from '../errors'
import { adoptRevision } from './adoption'
import { advanceSprint, approveCheckpoint, requireCheckpointGates } from './checkpoints'
import { expireLeases } from './execution'
import { requestSave, revisionNumberOf, saveResult } from './plans'
import { loadRun, requireOwnedRun, type RunRow } from './reports'

const STEPS: readonly ApproveWithRedraftStep[] = ['save', 'adopt', 'recompute', 'approve', 'advance']

/** Approving is human-only, so no agent role holds all of these: agents are refused before anything is saved. */
const REQUIRED: readonly Capability[] = ['checkpoint.approve', 'plan.save', 'run.adopt', 'checkpoint.advance']

type Outcome = Omit<ApproveWithRedraftResultView, 'run'>
type Saved = Outcome['save']

interface ApproveWithRedraftInput {
  runId: string
  expectedDraftRevision: number
  /** The report the person reviewed; when given it must still be the sprint's latest. */
  reportId?: string
}

/** Where a refusal leaves things: the run as it was before the steps, and the saved revision once the save completed. */
interface Aftermath {
  run: RunRow | null
  saved: Saved | null
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function adoptionNeeded(after: Aftermath): boolean {
  return after.saved !== null && after.run !== null && after.saved.revisionId !== after.run.revision_id
}

/** What the refusal left as it was. */
function consequence(ctx: Ctx, after: Aftermath): string {
  if (after.saved === null || after.run === null) {
    return 'The run was not changed: nothing was adopted, approved or advanced.'
  }
  if (!adoptionNeeded(after)) {
    return 'Nothing was approved or advanced.'
  }
  const executes = revisionNumberOf(ctx, after.run.revision_id)
  return (
    `The draft is saved as revision ${after.saved.revisionNumber}, but Run #${after.run.number} still executes revision ` +
    `${executes}: adoption is still needed. Nothing was approved or advanced.`
  )
}

/** The refusal of one step, keeping the cause's code and details and naming the step. */
function stepError(ctx: Ctx, step: ApproveWithRedraftStep, cause: unknown, after: Aftermath): DomainError {
  const shaped = cause instanceof DomainError ? cause : new DomainError('internal', cause instanceof Error ? cause.message : String(cause))
  const stepNumber = STEPS.indexOf(step) + 1
  const message = `Approve with redraft stopped at step ${stepNumber} of ${STEPS.length} (${step}): ${sentence(shaped.message)} ${consequence(ctx, after)}`
  return new DomainError(shaped.code, message, {
    ...shaped.details,
    step,
    stepNumber,
    savedRevisionId: after.saved?.revisionId ?? null,
    savedRevisionNumber: after.saved?.revisionNumber ?? null,
    adoptionNeeded: adoptionNeeded(after)
  })
}

function inStep<T>(ctx: Ctx, step: ApproveWithRedraftStep, after: Aftermath, work: () => T): T {
  try {
    return work()
  } catch (error: unknown) {
    throw stepError(ctx, step, error, after)
  }
}

function latestReportId(ctx: Ctx, run: RunRow): string | null {
  const row = ctx.db.get<{ id: string }>(
    'SELECT id FROM sprint_reports WHERE run_id = ? AND sprint_id = ? ORDER BY report_revision DESC LIMIT 1',
    run.id,
    run.active_sprint_id
  )
  return row?.id ?? null
}

/** Before anything is written: the run is this machine's, waits at its checkpoint, and has the report the person read. */
function requireApprovableRun(ctx: Ctx, input: ApproveWithRedraftInput): RunRow {
  const run = loadRun(ctx, input.runId)
  requireOwnedRun(ctx, run)
  if (run.state !== 'awaiting_checkpoint') {
    fail('run_not_active', `Run #${run.number} is ${run.state}; approve with redraft needs the run waiting at its checkpoint.`, {
      runId: run.id,
      state: run.state
    })
  }
  const latest = latestReportId(ctx, run)
  if (input.reportId !== undefined && input.reportId !== latest) {
    fail('conflict', 'The report changed; review the latest revision.', { reportId: input.reportId, latestReportId: latest })
  }
  return run
}

/** Step 1: save the draft and flush, so the revision is saved and current before adoption reads it. */
function save(ctx: Ctx, input: ApproveWithRedraftInput, flush: () => void): { run: RunRow; saved: Saved } {
  const run = requireApprovableRun(ctx, input)
  const request = requestSave(ctx, { epicId: run.epic_id, expectedDraftRevision: input.expectedDraftRevision })
  const saved: Saved = { status: 'unchanged', revisionId: request.revisionId, revisionNumber: request.revisionNumber }
  if (request.status === 'unchanged') {
    return { run, saved }
  }
  flush()
  const result = saveResult(ctx, request.revisionId)
  if (result.status !== 'saved') {
    const reason = result.error === null ? '' : ` (${result.error})`
    fail('save_pending', `Revision ${result.revisionNumber} is still being saved${reason}: flush portable state, then adopt it and approve.`, {
      revisionId: request.revisionId
    })
  }
  return { run, saved: { ...saved, status: 'saved' } }
}

/** Step 2: adopt the saved revision, unless the run already executes it. */
function adopt(ctx: Ctx, run: RunRow, saved: Saved): Outcome['adoption'] {
  if (saved.revisionId === run.revision_id) {
    return null
  }
  const result = adoptRevision(ctx, { runId: run.id, revisionId: saved.revisionId })
  return { revisionId: saved.revisionId, kept: result.kept, superseded: result.superseded, freshBudget: result.freshBudget }
}

/** Steps 2 to 5, all or nothing. */
function adoptApproveAdvance(ctx: Ctx, input: ApproveWithRedraftInput, after: { run: RunRow; saved: Saved }): Outcome {
  return ctx.db.tx(() => {
    const { run, saved } = after
    const adoption = inStep(ctx, 'adopt', after, () => adopt(ctx, run, saved))
    const report = inStep(ctx, 'recompute', after, () => requireCheckpointGates(ctx, run.id))
    const reportId = input.reportId ?? report.id
    const approval = inStep(ctx, 'approve', after, () => approveCheckpoint(ctx, { runId: run.id, reportId }))
    const advanced = inStep(ctx, 'advance', after, () => advanceSprint(ctx, { runId: run.id }))
    return { save: saved, adoption, approval, advance: { outcome: advanced.outcome, activeSprintId: advanced.activeSprintId } }
  })
}

/**
 * Desktop only. Saves the epic's draft, adopts the saved revision into the run, recomputes the gates on it,
 * approves the sprint's current report and advances. `flush` writes pending portable state (the workspace's
 * outbox flush), which completes the save.
 */
export function approveWithRedraft(ctx: Ctx, input: ApproveWithRedraftInput, flush: () => void): Outcome {
  for (const capability of REQUIRED) {
    requireCapability(ctx.session, capability)
  }
  const after = inStep(ctx, 'save', { run: null, saved: null }, () => {
    // Gates read attempt states as stored, so overdue leases are expired first.
    expireLeases(ctx, input.runId)
    return save(ctx, input, flush)
  })
  return adoptApproveAdvance(ctx, input, after)
}
