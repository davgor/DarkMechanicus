/**
 * Execution glue shared by runs, attempts, and hosts: row types, pinned-plan loading, lazy lease
 * expiry, the attempt read model, and the few writes several commands share.
 */
import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'
import type { AttemptKind, AttemptState, RunState, WorkStatus } from '../../shared/domain/status'
import type {
  AttemptDecision,
  AttemptEvidence,
  AttemptFailure,
  AttemptOutputs,
  AttemptView,
  HostCatalog,
  WorkerInfo
} from '../../shared/domain/views'
import { contentHash } from '../canonical'
import { isBefore } from '../clock'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { type AttemptSnapshot, computeExecution, type ExecutionSnapshot } from '../plan/readiness'
import { appendEvent } from './events'
import { enqueueOutbox } from './outbox'

/** One row of the `attempts` table. */
export interface AttemptRow {
  id: string
  run_id: string
  ticket_id: string
  number: number
  kind: AttemptKind
  state: AttemptState
  fencing_token: number
  claim_secret: string | null
  worker_json: string
  revision_id: string
  ticket_content_hash: string
  lease_expires_at: string | null
  heartbeat_at: string | null
  outputs_json: string | null
  evidence_json: string | null
  failure_json: string | null
  decision_json: string | null
  created_at: string
  updated_at: string
  submitted_at: string | null
  decided_at: string | null
  reconciled_at: string | null
  superseded_at: string | null
}

/** One row of the `runs` table. */
export interface RunRow {
  id: string
  epic_id: string
  number: number
  revision_id: string
  state: RunState
  active_sprint_id: string | null
  orchestrator_session_id: string | null
  host_json: string | null
  host_catalog_id: string | null
  skill_version: string | null
  owner_machine_id: string
  pause_reason: string | null
  auto_continue: number
  revision: number
  created_at: string
  started_at: string | null
  updated_at: string
  ended_at: string | null
}

export interface RunContext {
  run: RunRow
  bundle: PlanBundle
  /** Every attempt of the run, in creation order. */
  attempts: AttemptRow[]
  retryGrants: Record<string, number>
}

/** Columns reported by SQLite when `attempts_one_open_per_ticket` rejects a second open attempt. */
export const OPEN_ATTEMPT_COLUMNS = 'attempts.run_id, attempts.ticket_id'

const EMPTY_WORKER: WorkerInfo = {
  sessionId: null,
  label: '',
  modelId: null,
  hostId: null,
  catalogRevision: null,
  rationale: null
}

export function attemptView(row: AttemptRow): AttemptView {
  return {
    id: row.id,
    runId: row.run_id,
    ticketId: row.ticket_id,
    number: row.number,
    kind: row.kind,
    state: row.state,
    fencingToken: row.fencing_token,
    worker: parseJson<WorkerInfo>(row.worker_json, EMPTY_WORKER),
    revisionId: row.revision_id,
    ticketContentHash: row.ticket_content_hash,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    outputs: parseJson<AttemptOutputs | null>(row.outputs_json, null),
    evidence: parseJson<AttemptEvidence | null>(row.evidence_json, null),
    failure: parseJson<AttemptFailure | null>(row.failure_json, null),
    decision: parseJson<AttemptDecision | null>(row.decision_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    reconciledAt: row.reconciled_at,
    superseded: row.superseded_at !== null
  }
}

export function requireRun(ctx: Ctx, runId: string): RunRow {
  return ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId) ?? fail('not_found', `Run ${runId} not found.`, { runId })
}

export function loadAttempt(ctx: Ctx, attemptId: string): AttemptRow {
  return (
    ctx.db.get<AttemptRow>('SELECT * FROM attempts WHERE id = ?', attemptId) ??
    fail('not_found', `Attempt ${attemptId} not found.`, { attemptId })
  )
}

/** The immutable bundle of a saved revision (a run's pinned plan). */
export function loadBundle(ctx: Ctx, revisionId: string): PlanBundle {
  const row =
    ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', revisionId) ??
    fail('not_found', `Plan revision ${revisionId} not found.`, { revisionId })
  return JSON.parse(row.bundle_json) as PlanBundle
}

export function ticketOf(bundle: PlanBundle, ticketId: string): TicketContent {
  return (
    bundle.tickets.find((ticket) => ticket.id === ticketId) ??
    fail('not_found', `Ticket ${ticketId} is not part of this run's pinned plan.`, { ticketId })
  )
}

export function loadRunContext(ctx: Ctx, runId: string): RunContext {
  const run = requireRun(ctx, runId)
  const grants = ctx.db.all<{ ticket_id: string; extra: number }>(
    'SELECT ticket_id, extra FROM retry_grants WHERE run_id = ?',
    runId
  )
  return {
    run,
    bundle: loadBundle(ctx, run.revision_id),
    attempts: ctx.db.all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid', runId),
    retryGrants: Object.fromEntries(grants.map((grant) => [grant.ticket_id, grant.extra]))
  }
}

function snapshotOf(row: AttemptRow): AttemptSnapshot {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    number: row.number,
    kind: row.kind,
    state: row.state,
    reconciled: row.reconciled_at !== null,
    superseded: row.superseded_at !== null
  }
}

/** Readiness of an already-loaded run context (no lease expiry). */
export function executionOf(context: RunContext): ExecutionSnapshot {
  return computeExecution({
    bundle: context.bundle,
    activeSprintId: context.run.active_sprint_id,
    runState: context.run.state,
    attempts: context.attempts.map(snapshotOf),
    retryGrants: context.retryGrants
  })
}

interface LeaseRow {
  id: string
  run_id: string
  ticket_id: string
  lease_expires_at: string | null
  epic_id: string
}

/**
 * Lazily expires overdue leases (optionally only in one run): `claimed/running` attempts whose
 * lease ended before now become `lease_expired`, which requires reconciliation before a new claim.
 */
export function expireLeases(ctx: Ctx, runId?: string): string[] {
  return ctx.db.tx(() => {
    const now = ctx.clock.nowIso()
    const leased = ctx.db.all<LeaseRow>(
      `SELECT a.id, a.run_id, a.ticket_id, a.lease_expires_at, r.epic_id
       FROM attempts a JOIN runs r ON r.id = a.run_id
       WHERE a.state IN ('claimed', 'running') AND (? IS NULL OR a.run_id = ?)
       ORDER BY a.rowid`,
      runId ?? null,
      runId ?? null
    )
    const expired = leased.filter((row) => row.lease_expires_at !== null && isBefore(row.lease_expires_at, now))
    for (const row of expired) {
      ctx.db.run("UPDATE attempts SET state = 'lease_expired', updated_at = ? WHERE id = ?", now, row.id)
      appendEvent(ctx, {
        kind: 'attempt.lease_expired',
        epicId: row.epic_id,
        runId: row.run_id,
        ticketId: row.ticket_id,
        payload: { attemptId: row.id, leaseExpiresAt: row.lease_expires_at }
      })
      enqueueOutbox(ctx, { kind: 'run_history', epicId: row.epic_id, runId: row.run_id })
    }
    return expired.map((row) => row.id)
  })
}

/** Expires the run's overdue leases, then computes its readiness. */
export function runExecution(ctx: Ctx, runId: string): ExecutionSnapshot {
  expireLeases(ctx, runId)
  return executionOf(loadRunContext(ctx, runId))
}

export function listAttempts(ctx: Ctx, filter: { runId?: string; ticketId?: string; epicId?: string }): AttemptView[] {
  return ctx.db
    .all<AttemptRow>(
      `SELECT a.* FROM attempts a JOIN runs r ON r.id = a.run_id
       WHERE (? IS NULL OR a.run_id = ?) AND (? IS NULL OR a.ticket_id = ?) AND (? IS NULL OR r.epic_id = ?)
       ORDER BY a.created_at DESC, a.rowid DESC`,
      filter.runId ?? null,
      filter.runId ?? null,
      filter.ticketId ?? null,
      filter.ticketId ?? null,
      filter.epicId ?? null,
      filter.epicId ?? null
    )
    .map(attemptView)
}

/** Runs a write, turning a UNIQUE violation on exactly `columns` into the caller's domain error. */
export function guardUnique<T>(write: () => T, columns: string, onViolation: () => never): T {
  try {
    return write()
  } catch (error: unknown) {
    if (error instanceof Error && error.message === `UNIQUE constraint failed: ${columns}`) {
      return onViolation()
    }
    throw error
  }
}

const STATUS_RANK: Record<WorkStatus, number> = { backlog: 0, in_progress: 1, completed: 2 }

/** Moves a ticket's work status forward only (backlog → in_progress → completed). */
export function advanceTicketStatus(ctx: Ctx, target: { epicId: string; ticketId: string }, to: WorkStatus): void {
  const row = ctx.db.get<{ status: WorkStatus }>('SELECT status FROM ticket_status WHERE ticket_id = ?', target.ticketId)
  const from = row?.status ?? null
  if (from !== null && STATUS_RANK[from] >= STATUS_RANK[to]) {
    return
  }
  const now = ctx.clock.nowIso()
  if (row) {
    ctx.db.run(
      'UPDATE ticket_status SET status = ?, revision = revision + 1, updated_at = ? WHERE ticket_id = ?',
      to,
      now,
      target.ticketId
    )
  } else {
    ctx.db.run(
      'INSERT INTO ticket_status (ticket_id, epic_id, status, revision, updated_at) VALUES (?, ?, ?, 1, ?)',
      target.ticketId,
      target.epicId,
      to,
      now
    )
  }
  appendEvent(ctx, { kind: 'ticket.status_changed', epicId: target.epicId, ticketId: target.ticketId, payload: { from, to } })
  enqueueOutbox(ctx, { kind: 'epic_state', epicId: target.epicId })
}

export interface NewAttempt {
  run: RunRow
  ticket: TicketContent
  kind: AttemptKind
  state: AttemptState
  worker: WorkerInfo
  claimSecret: string | null
  leaseExpiresAt: string | null
  outputs: AttemptOutputs | null
  decision: AttemptDecision | null
}

/** Inserts the next attempt for (run, ticket); a concurrent open attempt surfaces as `already_claimed`. */
export function insertAttempt(ctx: Ctx, attempt: NewAttempt): AttemptRow {
  const id = ctx.ids.next('attempt')
  const now = ctx.clock.nowIso()
  const last = ctx.db.get<{ number: number | null }>(
    'SELECT MAX(number) AS number FROM attempts WHERE run_id = ? AND ticket_id = ?',
    attempt.run.id,
    attempt.ticket.id
  )
  const number = (last?.number ?? 0) + 1
  guardUnique(
    () =>
      ctx.db.run(
        `INSERT INTO attempts (id, run_id, ticket_id, number, kind, state, fencing_token, claim_secret, worker_json,
           revision_id, ticket_content_hash, lease_expires_at, outputs_json, decision_json, created_at, updated_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        attempt.run.id,
        attempt.ticket.id,
        number,
        attempt.kind,
        attempt.state,
        number,
        attempt.claimSecret,
        toJson(attempt.worker),
        attempt.run.revision_id,
        contentHash(attempt.ticket),
        attempt.leaseExpiresAt,
        attempt.outputs === null ? null : toJson(attempt.outputs),
        attempt.decision === null ? null : toJson(attempt.decision),
        now,
        now,
        attempt.decision === null ? null : now
      ),
    OPEN_ATTEMPT_COLUMNS,
    () => fail('already_claimed', `${attempt.ticket.key} already has an open attempt in this run.`, { ticketId: attempt.ticket.id })
  )
  return loadAttempt(ctx, id)
}

/** The latest accepted outputs for the ticket from an earlier run of the same epic, if any. */
function earlierAcceptance(ctx: Ctx, run: RunRow, ticketId: string): { outputs_json: string | null } | undefined {
  return ctx.db.get<{ outputs_json: string | null }>(
    `SELECT a.outputs_json FROM attempts a JOIN runs r ON r.id = a.run_id
     WHERE a.ticket_id = ? AND a.state = 'accepted' AND r.epic_id = ? AND r.number < ?
     ORDER BY r.number DESC, a.number DESC LIMIT 1`,
    ticketId,
    run.epic_id,
    run.number
  )
}

/**
 * Records a `carry_forward` attempt (accepted) for a ticket already completed earlier — by status or by
 * an accepted attempt in an earlier run — copying the earlier accepted outputs when there are any.
 */
export function recordCarryForward(
  ctx: Ctx,
  context: { run: RunRow; bundle: PlanBundle },
  entry: { ticketId: string; note: string }
): AttemptRow {
  const { run } = context
  const ticket = ticketOf(context.bundle, entry.ticketId)
  const earlier = earlierAcceptance(ctx, run, ticket.id)
  const status = ctx.db.get<{ status: WorkStatus }>('SELECT status FROM ticket_status WHERE ticket_id = ?', ticket.id)
  if (status?.status !== 'completed' && earlier === undefined) {
    fail('unauthorized_transition', `${ticket.key} has no completed work to carry forward.`, { ticketId: ticket.id })
  }
  const occupied = ctx.db.get<{ id: string; state: AttemptState }>(
    `SELECT id, state FROM attempts WHERE run_id = ? AND ticket_id = ? AND superseded_at IS NULL
     AND state IN ('accepted', 'claimed', 'running', 'submitted')`,
    run.id,
    ticket.id
  )
  if (occupied) {
    fail('conflict', `${ticket.key} already has a ${occupied.state} attempt in this run.`, { attemptId: occupied.id })
  }
  const row = insertAttempt(ctx, {
    run,
    ticket,
    kind: 'carry_forward',
    state: 'accepted',
    worker: { ...EMPTY_WORKER, sessionId: ctx.session.id, label: ctx.session.label },
    claimSecret: null,
    leaseExpiresAt: null,
    outputs: parseJson<AttemptOutputs | null>(earlier?.outputs_json, null),
    decision: { outcome: 'accepted', notes: entry.note, reasons: [], decidedBy: ctx.session.label }
  })
  advanceTicketStatus(ctx, { epicId: run.epic_id, ticketId: ticket.id }, 'completed')
  appendEvent(ctx, {
    kind: 'attempt.carried_forward',
    epicId: run.epic_id,
    runId: run.id,
    ticketId: ticket.id,
    payload: { attemptId: row.id, note: entry.note }
  })
  enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
  return row
}

/** A registered host catalog by id, or the most recently registered one when `catalogId` is null. */
export function loadHostCatalog(ctx: Ctx, catalogId: string | null): { id: string; catalog: HostCatalog } | null {
  const row =
    catalogId === null
      ? ctx.db.get<{ id: string; catalog_json: string }>(
          'SELECT id, catalog_json FROM host_catalogs ORDER BY created_at DESC, rowid DESC LIMIT 1'
        )
      : ctx.db.get<{ id: string; catalog_json: string }>('SELECT id, catalog_json FROM host_catalogs WHERE id = ?', catalogId)
  return row ? { id: row.id, catalog: JSON.parse(row.catalog_json) as HostCatalog } : null
}
