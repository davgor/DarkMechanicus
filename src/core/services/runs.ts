/**
 * Runs: queue (desktop), start (orchestrator), read, pause/resume/cancel, and takeover. An epic has
 * at most one active run, and every run is pinned to one saved plan revision.
 */
import type { StartRunInput } from '../../shared/domain/api'
import type { EpicBranch } from '../../shared/domain/bundle'
import {
  ACTIVE_RUN_STATES,
  isOpenAttemptState,
  type RunState,
  type TicketExecutionState,
  type WorkStatus
} from '../../shared/domain/status'
import type { AttemptView, RunCounts, RunView, TicketExecutionView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { sortedSprints } from '../plan/graph'
import { SKILLS_VERSION } from '../version'
import { appendEvent } from './events'
import {
  type AttemptRow,
  attemptView,
  executionOf,
  expireLeases,
  guardUnique,
  loadBundle,
  loadRunContext,
  recordCarryForward,
  requireRun,
  type RunRow
} from './execution'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'

interface EpicRow {
  id: string
  status: WorkStatus
  current_revision_id: string | null
  branch_json: string | null
}

const ACTIVE_STATES_SQL = "('queued', 'running', 'awaiting_checkpoint', 'paused')"
const RECENT_ATTEMPTS = 50

/** Run states from which a run may be paused (manually or by the ticket-failure policy). */
export const PAUSABLE_STATES: readonly RunState[] = ['queued', 'running', 'awaiting_checkpoint']

const COUNT_KEYS: Partial<Record<TicketExecutionState, keyof RunCounts>> = {
  accepted: 'accepted',
  submitted: 'submitted',
  running: 'running',
  waiting: 'waiting',
  blocked: 'blocked',
  failed: 'failed',
  needs_reconciliation: 'needsReconciliation'
}

function recordRun(ctx: Ctx, run: RunRow, kind: string, payload: Record<string, unknown>): void {
  appendEvent(ctx, { kind, epicId: run.epic_id, runId: run.id, payload })
  enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
}

function requireOpenEpic(ctx: Ctx, epicId: string): EpicRow {
  const epic =
    ctx.db.get<EpicRow>('SELECT id, status, current_revision_id, branch_json FROM epics WHERE id = ?', epicId) ??
    fail('not_found', `Epic ${epicId} not found.`, { epicId })
  if (epic.status === 'completed') {
    fail('completed_epic', 'This epic is completed; create a new epic for further work.', { epicId })
  }
  return epic
}

function savedRevisionId(ctx: Ctx, epic: EpicRow): string {
  const saved = ctx.db.get<{ id: string }>(
    "SELECT id FROM plan_revisions WHERE id = ? AND state = 'saved'",
    epic.current_revision_id ?? ''
  )
  return saved?.id ?? fail('invalid_plan', 'Save the plan before starting a run.', { epicId: epic.id })
}

function activeRunOf(ctx: Ctx, epicId: string): RunRow | undefined {
  return ctx.db.get<RunRow>(`SELECT * FROM runs WHERE epic_id = ? AND state IN ${ACTIVE_STATES_SQL}`, epicId)
}

function rejectActiveRun(epicId: string, runId: string | null): never {
  return fail('active_run_exists', 'This epic already has an active run. Resume, finish, or cancel it first.', {
    epicId,
    runId
  })
}

/** Inserts a `queued` run; the partial unique index backs up the one-active-run rule. */
function createRun(ctx: Ctx, epic: EpicRow, revisionId: string): RunRow {
  const id = ctx.ids.next('run')
  const now = ctx.clock.nowIso()
  const last = ctx.db.get<{ number: number | null }>('SELECT MAX(number) AS number FROM runs WHERE epic_id = ?', epic.id)
  guardUnique(
    () =>
      ctx.db.run(
        `INSERT INTO runs (id, epic_id, number, revision_id, state, owner_machine_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        id,
        epic.id,
        (last?.number ?? 0) + 1,
        revisionId,
        ctx.machineId,
        now,
        now
      ),
    'runs.epic_id',
    () => rejectActiveRun(epic.id, null)
  )
  return requireRun(ctx, id)
}

export function requireOwnedRun(ctx: Ctx, runId: string): RunRow {
  const run = requireRun(ctx, runId)
  if (run.owner_machine_id !== ctx.machineId) {
    fail('run_not_owned', 'This run belongs to another machine; take it over first.', {
      runId,
      ownerMachineId: run.owner_machine_id
    })
  }
  return run
}

function requireRunState(run: RunRow, allowed: readonly RunState[], action: string): void {
  if (!allowed.includes(run.state)) {
    fail('run_not_active', `Can't ${action} a ${run.state} run.`, { runId: run.id, state: run.state })
  }
}

function hostView(run: RunRow): RunView['host'] {
  const host = parseJson<{ label: string; type: string } | null>(run.host_json, null)
  if (host === null && run.host_catalog_id === null) {
    return null
  }
  return { label: host?.label ?? '', type: host?.type ?? '', catalogId: run.host_catalog_id }
}

function countTickets(tickets: TicketExecutionView[]): RunCounts {
  const counts: RunCounts = { accepted: 0, submitted: 0, running: 0, ready: 0, waiting: 0, blocked: 0, failed: 0, needsReconciliation: 0 }
  for (const ticket of tickets) {
    // A ready ticket held back by run state or capacity is still waiting from the run's point of view.
    const readyKey = ticket.blockers.length === 0 ? 'ready' : 'waiting'
    const key = ticket.state === 'ready' ? readyKey : COUNT_KEYS[ticket.state]
    if (key !== undefined) {
      counts[key] += 1
    }
  }
  return counts
}

/** Open attempts plus the most recent ones, newest first. */
function recentAttempts(rows: AttemptRow[]): AttemptView[] {
  return [...rows]
    .reverse()
    .filter((row, index) => index < RECENT_ATTEMPTS || isOpenAttemptState(row.state))
    .map(attemptView)
}

function buildRunView(ctx: Ctx, runId: string): RunView {
  const context = loadRunContext(ctx, runId)
  const { run, bundle } = context
  const execution = executionOf(context)
  const revision = ctx.db.get<{ number: number }>('SELECT number FROM plan_revisions WHERE id = ?', run.revision_id)
  return {
    id: run.id,
    epicId: run.epic_id,
    revisionId: run.revision_id,
    revisionNumber: revision?.number ?? 0,
    state: run.state,
    activeSprintId: run.active_sprint_id,
    activeSprintOrdinal: bundle.sprints.find((sprint) => sprint.id === run.active_sprint_id)?.ordinal ?? null,
    sprintCount: bundle.sprints.length,
    host: hostView(run),
    skillVersion: run.skill_version,
    ownerMachineId: run.owner_machine_id,
    ownedByThisMachine: run.owner_machine_id === ctx.machineId,
    pauseReason: run.pause_reason,
    autoContinue: run.auto_continue === 1,
    createdAt: run.created_at,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    endedAt: run.ended_at,
    counts: countTickets(execution.tickets),
    tickets: execution.tickets,
    attempts: recentAttempts(context.attempts),
    checkpoint: null
  }
}

/** Desktop only: queues a run pinned to the epic's current saved revision. */
export function queueRun(ctx: Ctx, input: { epicId: string }): RunView {
  requireCapability(ctx.session, 'run.queue')
  return ctx.db.tx(() => {
    const epic = requireOpenEpic(ctx, input.epicId)
    const revisionId = savedRevisionId(ctx, epic)
    const active = activeRunOf(ctx, epic.id)
    if (active) {
      rejectActiveRun(epic.id, active.id)
    }
    const run = createRun(ctx, epic, revisionId)
    recordRun(ctx, run, 'run.queued', { revisionId })
    return buildRunView(ctx, run.id)
  })
}

/** The queued run (keeping its pinned revision) or a new run pinned to the current saved revision. */
function pickUpRun(ctx: Ctx, epic: EpicRow): RunRow {
  const active = activeRunOf(ctx, epic.id)
  if (!active) {
    return createRun(ctx, epic, savedRevisionId(ctx, epic))
  }
  if (active.state !== 'queued') {
    rejectActiveRun(epic.id, active.id)
  }
  return requireOwnedRun(ctx, active.id)
}

function requireCatalogId(ctx: Ctx, catalogId: string | null | undefined): string | null {
  if (!catalogId) {
    return null
  }
  const row = ctx.db.get<{ id: string }>('SELECT id FROM host_catalogs WHERE id = ?', catalogId)
  return (
    row?.id ??
    fail('not_found', `Host catalog ${catalogId} is not registered; call register_host first.`, { hostCatalogId: catalogId })
  )
}

function activateRun(ctx: Ctx, run: RunRow, input: StartRunInput): void {
  const catalogId = requireCatalogId(ctx, input.hostCatalogId)
  const firstSprint = sortedSprints(loadBundle(ctx, run.revision_id))[0]
  const now = ctx.clock.nowIso()
  ctx.db.run(
    `UPDATE runs SET state = 'running', started_at = ?, orchestrator_session_id = ?, host_json = ?, host_catalog_id = ?,
       skill_version = ?, active_sprint_id = ?, updated_at = ?, revision = revision + 1
     WHERE id = ?`,
    now,
    ctx.session.id,
    input.host ? toJson(input.host) : null,
    catalogId,
    input.skillVersion ?? SKILLS_VERSION,
    firstSprint?.id ?? null,
    now,
    run.id
  )
}

function checkoutBranch(ctx: Ctx): EpicBranch | null {
  const checkout = ctx.checkout()
  return checkout.branch === null ? null : { repository: null, name: checkout.branch, startCommit: checkout.commit }
}

/** Binds the epic's feature branch once: the explicit branch, else the coordinating checkout's branch + HEAD. */
function bindEpicBranch(ctx: Ctx, epic: EpicRow, requested: EpicBranch | null): void {
  if (epic.branch_json !== null) {
    return
  }
  const branch = requested ?? checkoutBranch(ctx)
  if (branch === null) {
    return
  }
  ctx.db.run(
    'UPDATE epics SET branch_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
    toJson(branch),
    ctx.clock.nowIso(),
    epic.id
  )
  appendEvent(ctx, { kind: 'epic.branch_set', epicId: epic.id, payload: { branch } })
  enqueueOutbox(ctx, { kind: 'epic_state', epicId: epic.id })
}

function markEpicStarted(ctx: Ctx, epic: EpicRow): void {
  if (epic.status !== 'backlog') {
    return
  }
  ctx.db.run(
    "UPDATE epics SET status = 'in_progress', revision = revision + 1, updated_at = ? WHERE id = ?",
    ctx.clock.nowIso(),
    epic.id
  )
  appendEvent(ctx, { kind: 'epic.status_changed', epicId: epic.id, payload: { from: 'backlog', to: 'in_progress' } })
  enqueueOutbox(ctx, { kind: 'epic_state', epicId: epic.id })
}

/** Orchestrator: starts the queued run or a new one, binds the epic branch, and activates sprint 1. */
export function startRun(ctx: Ctx, input: StartRunInput): RunView {
  requireCapability(ctx.session, 'run.start')
  ctx.assertBranch()
  return withIdempotency(ctx, { command: 'startRun', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const epic = requireOpenEpic(ctx, input.epicId)
    const run = pickUpRun(ctx, epic)
    activateRun(ctx, run, input)
    bindEpicBranch(ctx, epic, input.branch ?? null)
    markEpicStarted(ctx, epic)
    const context = loadRunContext(ctx, run.id)
    for (const entry of input.carryForward ?? []) {
      recordCarryForward(ctx, context, entry)
    }
    recordRun(ctx, context.run, 'run.started', {
      revisionId: context.run.revision_id,
      activeSprintId: context.run.active_sprint_id
    })
    return buildRunView(ctx, run.id)
  })
}

function runIdForEpic(ctx: Ctx, epicId: string | undefined): string | null {
  if (epicId === undefined) {
    fail('invalid_input', 'Pass a runId or an epicId.')
  }
  const row = ctx.db.get<{ id: string }>(
    `SELECT id FROM runs WHERE epic_id = ? ORDER BY state IN ${ACTIVE_STATES_SQL} DESC, number DESC LIMIT 1`,
    epicId
  )
  return row?.id ?? null
}

/** A run by id, or an epic's active run (else its most recent run); overdue leases expire first. */
export function getRun(ctx: Ctx, input: { runId?: string; epicId?: string }): RunView | null {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => {
    const runId = input.runId ?? runIdForEpic(ctx, input.epicId)
    if (runId === null) {
      return null
    }
    expireLeases(ctx, runId)
    return buildRunView(ctx, runId)
  })
}

/** Pauses a run in place (shared with the ticket-failure policy); open attempts may still report. */
export function pauseRunRow(ctx: Ctx, run: RunRow, reason: string): void {
  ctx.db.run(
    "UPDATE runs SET state = 'paused', pause_reason = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
    reason,
    ctx.clock.nowIso(),
    run.id
  )
  recordRun(ctx, run, 'run.paused', { from: run.state, reason })
}

export function pauseRun(ctx: Ctx, input: { runId: string; reason?: string }): RunView {
  requireCapability(ctx.session, 'run.control')
  return ctx.db.tx(() => {
    const run = requireRun(ctx, input.runId)
    requireRunState(run, PAUSABLE_STATES, 'pause')
    pauseRunRow(ctx, run, input.reason ?? 'paused')
    return buildRunView(ctx, run.id)
  })
}

export function resumeRun(ctx: Ctx, input: { runId: string }): RunView {
  requireCapability(ctx.session, 'run.control')
  ctx.assertBranch()
  return ctx.db.tx(() => {
    const run = requireOwnedRun(ctx, input.runId)
    requireRunState(run, ['paused'], 'resume')
    // A run paused before it ever started goes back to the queue rather than running without a sprint.
    const to: RunState = run.started_at === null ? 'queued' : 'running'
    ctx.db.run(
      'UPDATE runs SET state = ?, pause_reason = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?',
      to,
      ctx.clock.nowIso(),
      run.id
    )
    recordRun(ctx, run, 'run.resumed', { to })
    return buildRunView(ctx, run.id)
  })
}

/** Ends a run as `canceled` or `failed` and cancels its open attempts; returns their ids. */
function endRun(ctx: Ctx, run: RunRow, state: 'canceled' | 'failed'): string[] {
  const now = ctx.clock.nowIso()
  const open = ctx.db
    .all<{ id: string }>(
      "SELECT id FROM attempts WHERE run_id = ? AND state IN ('claimed', 'running', 'submitted') ORDER BY rowid",
      run.id
    )
    .map((row) => row.id)
  ctx.db.run(
    `UPDATE attempts SET state = 'canceled', lease_expires_at = NULL, updated_at = ?
     WHERE run_id = ? AND state IN ('claimed', 'running', 'submitted')`,
    now,
    run.id
  )
  ctx.db.run('UPDATE runs SET state = ?, ended_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?', state, now, now, run.id)
  return open
}

/** Ticket-failure policy `fail_run`: the run becomes terminal `failed` and its open attempts are canceled. */
export function failRunRow(ctx: Ctx, run: RunRow, reason: string): void {
  const canceledAttempts = endRun(ctx, run, 'failed')
  ctx.db.run('UPDATE runs SET pause_reason = ? WHERE id = ?', reason, run.id)
  recordRun(ctx, run, 'run.failed', { reason, canceledAttempts })
}

export function cancelRun(ctx: Ctx, input: { runId: string; reason?: string }): RunView {
  requireCapability(ctx.session, 'run.control')
  return ctx.db.tx(() => {
    const run = requireRun(ctx, input.runId)
    requireRunState(run, ACTIVE_RUN_STATES, 'cancel')
    const canceledAttempts = endRun(ctx, run, 'canceled')
    recordRun(ctx, run, 'run.canceled', { reason: input.reason ?? null, canceledAttempts })
    return buildRunView(ctx, run.id)
  })
}

function transferRun(ctx: Ctx, run: RunRow): void {
  const now = ctx.clock.nowIso()
  const leased = ctx.db
    .all<{ id: string }>("SELECT id FROM attempts WHERE run_id = ? AND state IN ('claimed', 'running') ORDER BY rowid", run.id)
    .map((row) => row.id)
  ctx.db.run(
    "UPDATE attempts SET state = 'lease_expired', updated_at = ? WHERE run_id = ? AND state IN ('claimed', 'running')",
    now,
    run.id
  )
  ctx.db.run(
    `UPDATE runs SET owner_machine_id = ?, state = 'paused', pause_reason = 'taken_over', auto_continue = 0,
       updated_at = ?, revision = revision + 1 WHERE id = ?`,
    ctx.machineId,
    now,
    run.id
  )
  recordRun(ctx, run, 'run.taken_over', { previousOwner: run.owner_machine_id, expiredAttempts: leased })
}

/**
 * Claims an active run for this machine. Leased attempts become `lease_expired` (their workers may
 * still be running elsewhere, so they need reconciliation), the run pauses until resumed, and any
 * auto-continue authorization from the other machine is dropped.
 */
export function takeoverRun(ctx: Ctx, input: { runId: string }): RunView {
  requireCapability(ctx.session, 'run.takeover')
  return ctx.db.tx(() => {
    const run = requireRun(ctx, input.runId)
    requireRunState(run, ACTIVE_RUN_STATES, 'take over')
    if (run.owner_machine_id !== ctx.machineId) {
      transferRun(ctx, run)
    }
    return buildRunView(ctx, run.id)
  })
}
