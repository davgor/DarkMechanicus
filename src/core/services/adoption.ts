import type { PlanBundle } from '../../shared/domain/bundle'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { indexBundle, sortedSprints, ticketLabel } from '../plan/graph'
import { appendEvent } from './events'
import { enqueueOutbox } from './outbox'
import { loadBundle, loadRun, requireOwnedRun, type RunRow } from './reports'

interface AdoptionResult {
  runId: string
  /** Tickets whose acceptance in this run carries over to the adopted revision. */
  kept: string[]
  /** Tickets whose accepted attempt was superseded: they need new work in this run. */
  superseded: string[]
  activeSprintId: string
}

interface Reconciliation {
  run: RunRow
  current: PlanBundle
  target: PlanBundle
  carryForward: ReadonlySet<string>
}

function requireAdoptableRun(ctx: Ctx, run: RunRow): void {
  if (run.state !== 'awaiting_checkpoint' && run.state !== 'paused') {
    fail('run_not_active', 'Adopt a new revision at a checkpoint or while paused.', { runId: run.id, state: run.state })
  }
  const open = ctx.db.all<{ id: string }>(
    `SELECT id FROM attempts WHERE run_id = ? AND state IN ('claimed', 'running', 'submitted') ORDER BY id`,
    run.id
  )
  if (open.length > 0) {
    fail('conflict', 'Finish or reconcile the open attempts before adopting a new revision.', {
      openAttempts: open.map((attempt) => attempt.id)
    })
  }
}

/** Only the epic's current saved revision can replace the run's pinned one. */
function loadTargetBundle(ctx: Ctx, run: RunRow, revisionId: string): PlanBundle {
  if (revisionId === run.revision_id) {
    fail('conflict', 'The run already executes this revision.', { revisionId })
  }
  const epic = ctx.db.get<{ current_revision_id: string | null }>(
    'SELECT current_revision_id FROM epics WHERE id = ?',
    run.epic_id
  )
  if (epic?.current_revision_id !== revisionId) {
    fail('conflict', "Only the epic's current saved revision can be adopted.", {
      revisionId,
      currentRevisionId: epic?.current_revision_id ?? null
    })
  }
  const revision = ctx.db.get<{ state: string }>('SELECT state FROM plan_revisions WHERE id = ?', revisionId)
  if (revision?.state !== 'saved') {
    fail('conflict', `Revision ${revisionId} is not saved yet.`, { revisionId })
  }
  return loadBundle(ctx, revisionId)
}

function ticketHashes(bundle: PlanBundle): Map<string, string> {
  return new Map(bundle.tickets.map((ticket) => [ticket.id, contentHash(ticket)]))
}

function supersede(ctx: Ctx, attempt: { id: string; ticket_id: string }, stillPlanned: boolean): void {
  const now = ctx.clock.nowIso()
  ctx.db.run('UPDATE attempts SET superseded_at = ?, updated_at = ? WHERE id = ?', now, now, attempt.id)
  if (stillPlanned) {
    ctx.db.run(
      `UPDATE ticket_status SET status = 'in_progress', revision = revision + 1, updated_at = ?
       WHERE ticket_id = ? AND status = 'completed'`,
      now,
      attempt.ticket_id
    )
  }
}

/**
 * Unchanged tickets keep their acceptance; changed ones keep it only with explicit carry-forward;
 * everything else (changed, or removed from the plan) is superseded and needs new work.
 */
function reconcileAcceptances(ctx: Ctx, input: Reconciliation): { kept: string[]; superseded: string[] } {
  const before = ticketHashes(input.current)
  const after = ticketHashes(input.target)
  const accepted = ctx.db.all<{ id: string; ticket_id: string }>(
    `SELECT id, ticket_id FROM attempts WHERE run_id = ? AND state = 'accepted' AND superseded_at IS NULL
     ORDER BY created_at, id`,
    input.run.id
  )
  const kept = new Set<string>()
  const superseded = new Set<string>()
  for (const attempt of accepted) {
    const next = after.get(attempt.ticket_id)
    const unchanged = next !== undefined && before.get(attempt.ticket_id) === next
    if (unchanged || (next !== undefined && input.carryForward.has(attempt.ticket_id))) {
      kept.add(attempt.ticket_id)
    } else {
      supersede(ctx, attempt, next !== undefined)
      superseded.add(attempt.ticket_id)
    }
  }
  return { kept: [...kept], superseded: [...superseded] }
}

/**
 * Earlier sprints are closed for this run, so a changed ticket there could never be redone: refuse
 * unless the orchestrator explicitly carries its old acceptance forward.
 */
function assertNoClosedSprintRework(ctx: Ctx, input: Reconciliation & { activeSprintId: string }): void {
  const before = ticketHashes(input.current)
  const after = ticketHashes(input.target)
  const index = indexBundle(input.target)
  const activeOrdinal = index.sprints.get(input.activeSprintId)?.ordinal ?? 0
  const accepted = ctx.db.all<{ ticket_id: string }>(
    `SELECT DISTINCT ticket_id FROM attempts WHERE run_id = ? AND state = 'accepted' AND superseded_at IS NULL
     ORDER BY ticket_id`,
    input.run.id
  )
  const closed = accepted
    .map((row) => row.ticket_id)
    .filter((id) => {
      const next = after.get(id)
      const changed = next !== undefined && next !== before.get(id) && !input.carryForward.has(id)
      return changed && (index.sprintOf.get(id)?.ordinal ?? activeOrdinal) < activeOrdinal
    })
  if (closed.length > 0) {
    const labels = closed.map((id) => ticketLabel(index, id)).join(', ')
    const pronoun = closed.length === 1 ? 'it' : 'them'
    fail(
      'conflict',
      `${labels} changed in a sprint this run already passed. Carry ${pronoun} forward or start a new run to redo ${pronoun}.`,
      { tickets: closed }
    )
  }
}

/** Same sprint id if it survives, else the same ordinal, else the last sprint. */
function chooseActiveSprint(activeSprintId: string | null, current: PlanBundle, target: PlanBundle): string {
  const sprints = sortedSprints(target)
  const ordinal = current.sprints.find((sprint) => sprint.id === activeSprintId)?.ordinal
  const match =
    sprints.find((sprint) => sprint.id === activeSprintId) ?? sprints.find((sprint) => sprint.ordinal === ordinal)
  return (match ?? sprints[sprints.length - 1]).id
}

/**
 * Switches a run to the epic's newer saved revision at a checkpoint (or while paused) with no open
 * attempts. Grants bound to the old revision stop matching because their binding names it.
 */
export function adoptRevision(
  ctx: Ctx,
  input: { runId: string; revisionId: string; carryForward?: string[] }
): AdoptionResult {
  requireCapability(ctx.session, 'run.adopt')
  ctx.assertBranch()
  return ctx.db.tx(() => {
    const run = loadRun(ctx, input.runId)
    requireOwnedRun(ctx, run)
    requireAdoptableRun(ctx, run)
    const target = loadTargetBundle(ctx, run, input.revisionId)
    const current = loadBundle(ctx, run.revision_id)
    const carryForward = new Set(input.carryForward ?? [])
    const activeSprintId = chooseActiveSprint(run.active_sprint_id, current, target)
    assertNoClosedSprintRework(ctx, { run, current, target, carryForward, activeSprintId })
    const { kept, superseded } = reconcileAcceptances(ctx, { run, current, target, carryForward })
    ctx.db.run(
      'UPDATE runs SET revision_id = ?, active_sprint_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
      input.revisionId,
      activeSprintId,
      ctx.clock.nowIso(),
      run.id
    )
    appendEvent(ctx, {
      kind: 'run.revision_adopted',
      epicId: run.epic_id,
      runId: run.id,
      payload: { from: run.revision_id, to: input.revisionId, kept, superseded }
    })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
    if (superseded.length > 0) {
      enqueueOutbox(ctx, { kind: 'epic_state', epicId: run.epic_id })
    }
    return { runId: run.id, kept, superseded, activeSprintId }
  })
}
