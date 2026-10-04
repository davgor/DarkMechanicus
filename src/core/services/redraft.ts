import type { PlanBundle } from '../../shared/domain/bundle'
import type { SprintRetro } from '../../shared/domain/retro'
import type { RedraftResultView, SprintReportView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { validatePlan } from '../plan/graph'
import { redraftBundle, type RedraftOutcome } from '../plan/redraft'
import { retroIsEmpty } from '../plan/retro'
import { draftDeps } from './draftDeps'
import { ensureDraft, writeDraft } from './drafts'
import { assertEpicOpen, loadEpicRow } from './epics'
import { appendEvent } from './events'
import { latestReport, loadBundle, loadRun, requireOwnedRun, type RunRow } from './reports'
import { withRunWarnings } from './runWarnings'

/** The run's active sprint, once the run is waiting at its checkpoint: the only time the next sprint is redrafted. */
function requireCheckpointSprint(run: RunRow): string {
  if (run.state !== 'awaiting_checkpoint' || run.active_sprint_id === null) {
    fail(
      'run_not_active',
      `Run #${run.number} is ${run.state}; the next sprint is redrafted while the run waits at its checkpoint.`,
      { runId: run.id, state: run.state }
    )
  }
  return run.active_sprint_id
}

/** The retro of the latest report for the sprint; refuses a sprint with no report, or a report without a retro. */
function retroOf(run: RunRow, bundle: PlanBundle, report: SprintReportView | null): { report: SprintReportView; retro: SprintRetro } {
  const ordinal = bundle.sprints.find((sprint) => sprint.id === run.active_sprint_id)?.ordinal ?? 0
  if (report === null) {
    fail('not_found', `No report for Sprint ${ordinal} yet: submit it, with a retro, before redrafting the next sprint.`, {
      runId: run.id,
      sprintId: run.active_sprint_id
    })
  }
  const retro = report.report.retro
  if (retro === null || retroIsEmpty(retro)) {
    fail(
      'conflict',
      `The Sprint ${ordinal} report (revision ${report.reportRevision}) has no retro to redraft from: resubmit it with a retro that lists the leftovers and discoveries.`,
      { runId: run.id, reportId: report.id }
    )
  }
  return { report, retro }
}

/** Tickets the run holds a current accepted attempt for. */
function acceptedTicketIds(ctx: Ctx, runId: string): Set<string> {
  const rows = ctx.db.all<{ ticket_id: string }>(
    "SELECT DISTINCT ticket_id FROM attempts WHERE run_id = ? AND state = 'accepted' AND superseded_at IS NULL",
    runId
  )
  return new Set(rows.map((row) => row.ticket_id))
}

function recordRedraft(ctx: Ctx, run: RunRow, outcome: RedraftOutcome, draftRevision: number): void {
  const { changes } = outcome
  appendEvent(ctx, {
    kind: 'draft.redrafted',
    epicId: run.epic_id,
    runId: run.id,
    payload: {
      sprintId: changes.sprintId,
      nextSprintId: changes.nextSprintId,
      draftRevision,
      moved: changes.moved.map((item) => item.ticketId),
      dependentsMoved: changes.dependentsMoved.map((item) => item.ticketId),
      added: changes.added.map((item) => item.ticketId)
    }
  })
}

/**
 * At a checkpoint, rewrites the epic's draft from the retro of the run's latest report for the active sprint:
 * each leftover moves to the next sprint (a sprint is added after a final one) together with the tickets that
 * require it, and each discovery becomes an unsized ticket there. Only the draft changes, never the saved plan or
 * the run: the person saves the draft and adopts the revision. A repeat over the same retro changes nothing, so
 * it neither bumps the draft revision nor writes an event.
 */
export function redraftNextSprint(ctx: Ctx, input: { runId: string }): RedraftResultView {
  requireCapability(ctx.session, 'run.redraft')
  requireCapability(ctx.session, 'draft.edit')
  return ctx.db.tx(() => {
    const run = loadRun(ctx, input.runId)
    requireOwnedRun(ctx, run)
    const sprintId = requireCheckpointSprint(run)
    const epic = loadEpicRow(ctx, run.epic_id)
    assertEpicOpen(epic)
    const runBundle = loadBundle(ctx, run.revision_id)
    const { report, retro } = retroOf(run, runBundle, latestReport(ctx, run.id, sprintId))
    const draft = ensureDraft(ctx, epic)
    const outcome = redraftBundle(
      JSON.parse(draft.bundle_json) as PlanBundle,
      {
        sprintId,
        leftovers: retro.leftovers,
        discoveries: retro.discoveries,
        accepted: acceptedTicketIds(ctx, run.id),
        keys: new Map(runBundle.tickets.map((ticket) => [ticket.id, ticket.key]))
      },
      draftDeps(ctx)
    )
    const draftRevision = outcome.changed ? writeDraft(ctx, draft, outcome.bundle) : draft.draft_revision
    if (outcome.changed) {
      recordRedraft(ctx, run, outcome, draftRevision)
    }
    return {
      ...outcome.changes,
      epicId: epic.id,
      runId: run.id,
      reportId: report.id,
      reportRevision: report.reportRevision,
      changed: outcome.changed,
      draftRevision,
      validation: withRunWarnings(ctx, epic.id, outcome.bundle, validatePlan(outcome.bundle))
    }
  })
}
