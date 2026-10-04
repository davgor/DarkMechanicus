/**
 * SQL seeding for checkpoint, adoption, and history tests: epics, saved revisions, runs, and
 * attempts written straight into the schema (no dependency on the run/attempt services). Not shipped.
 */
import { contentHash } from '../core/canonical'
import type { EpicBranch, PlanBundle } from '../shared/domain/bundle'
import type { AttemptKind, AttemptState, RunState, WorkStatus } from '../shared/domain/status'
import type { CheckResult, SprintIncrement } from '../shared/domain/views'
import { makeBundle, tid } from './bundles'
import type { TestCtx } from './testContext'

export interface SeededRun {
  epicId: string
  revisionId: string
  runId: string
  bundle: PlanBundle
}

export interface SeedRunOptions {
  /** Default: sprint 1 = {DM-1, DM-2}, sprint 2 = {DM-3}. */
  bundle?: PlanBundle
  state?: RunState
  /** Ordinal of the active sprint (default 1); null leaves the run without an active sprint. */
  activeSprint?: number | null
  ownerMachineId?: string
  autoContinue?: boolean
  /** The epic's integration branch (default: none). */
  branch?: EpicBranch
}

export function seedEpic(ctx: TestCtx, title = 'Test epic'): string {
  const id = ctx.ids.next('epic')
  const now = ctx.clock.nowIso()
  ctx.db.run(
    `INSERT INTO epics (id, title, status, created_at, updated_at) VALUES (?, ?, 'in_progress', ?, ?)`,
    id,
    title,
    now,
    now
  )
  return id
}

interface SeedRevisionOptions {
  state?: 'pending' | 'saved' | 'failed'
  /** Point the epic's current_revision_id at the new revision (default true). */
  current?: boolean
}

/** Stores `bundle` as the epic's next plan revision and creates missing ticket_status rows. */
export function seedRevision(
  ctx: TestCtx,
  epicId: string,
  bundle: PlanBundle,
  options: SeedRevisionOptions = {}
): string {
  const id = ctx.ids.next('revision')
  const now = ctx.clock.nowIso()
  const count = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM plan_revisions WHERE epic_id = ?', epicId)
  const state = options.state ?? 'saved'
  ctx.db.run(
    `INSERT INTO plan_revisions (id, epic_id, number, content_hash, bundle_json, state, created_at, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    epicId,
    (count?.n ?? 0) + 1,
    contentHash(bundle),
    JSON.stringify(bundle),
    state,
    now,
    state === 'saved' ? now : null
  )
  if (options.current !== false) {
    ctx.db.run('UPDATE epics SET current_revision_id = ? WHERE id = ?', id, epicId)
  }
  for (const ticket of bundle.tickets) {
    ctx.db.run(
      `INSERT OR IGNORE INTO ticket_status (ticket_id, epic_id, status, updated_at) VALUES (?, ?, 'backlog', ?)`,
      ticket.id,
      epicId,
      now
    )
  }
  return id
}

function sprintIdAt(bundle: PlanBundle, ordinal: number | null): string | null {
  return bundle.sprints.find((sprint) => sprint.ordinal === ordinal)?.id ?? null
}

/** An epic, its saved revision (current), and a run pinned to it, owned by `ctx.machineId`. */
export function seedRun(ctx: TestCtx, options: SeedRunOptions = {}): SeededRun {
  const bundle = options.bundle ?? makeBundle([[1, 2], [3]])
  const epicId = seedEpic(ctx)
  if (options.branch !== undefined) {
    ctx.db.run('UPDATE epics SET branch_json = ? WHERE id = ?', JSON.stringify(options.branch), epicId)
  }
  const revisionId = seedRevision(ctx, epicId, bundle)
  const runId = ctx.ids.next('run')
  const now = ctx.clock.nowIso()
  ctx.db.run(
    `INSERT INTO runs (id, epic_id, number, revision_id, state, active_sprint_id, owner_machine_id,
       auto_continue, created_at, started_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    runId,
    epicId,
    revisionId,
    options.state ?? 'running',
    sprintIdAt(bundle, options.activeSprint === undefined ? 1 : options.activeSprint),
    options.ownerMachineId ?? ctx.machineId,
    options.autoContinue === true ? 1 : 0,
    now,
    now,
    now
  )
  return { epicId, revisionId, runId, bundle }
}

interface SeedAttemptOptions {
  /** Ticket number (as in `tid(n)`) or a ticket id. */
  ticket: number | string
  state: AttemptState
  kind?: AttemptKind
  superseded?: boolean
  /** Sets reconciled_at (an expired lease that was abandoned, or a resubmission). */
  reconciled?: boolean
  /** Commits recorded in the attempt's outputs. */
  commits?: string[]
  /** The increment verdict stored with the attempt: a passing verdict with these fields changed. */
  increment?: Partial<SprintIncrement>
  /** The checks the attempt's evidence reports (default: no evidence at all). */
  checks?: CheckResult[]
}

/** A passing increment verdict, the shape the server stores when a submission names a good increment. */
export function incrementVerdict(patch: Partial<SprintIncrement> = {}): SprintIncrement {
  return {
    branch: 'epic/x',
    commit: 'c'.repeat(40),
    parent: 'b'.repeat(40),
    base: { kind: 'epic_start', commit: 'a'.repeat(40) },
    passed: true,
    reasons: [],
    checks: [{ name: 'Squashed, not merged', status: 'passed', detail: 'ok' }],
    verifiedAt: '2026-01-01T00:00:00.000Z',
    ...patch
  }
}

/** The evidence JSON of an attempt that reported `checks`; null when it reported none. */
function recordedEvidence(checks: CheckResult[] | undefined): string | null {
  return checks === undefined ? null : JSON.stringify({ checks, criteria: [], notes: '' })
}

/** The outputs JSON of an attempt that recorded `commits`; null when the attempt has no outputs. */
function recordedOutputs(commits: string[] | undefined): string | null {
  return commits === undefined
    ? null
    : JSON.stringify({ summary: '', artifacts: [], commits, changedFiles: [], branch: null })
}

function ticketIdOf(ticket: number | string): string {
  return typeof ticket === 'number' ? tid(ticket) : ticket
}

/** Inserts the ticket's next attempt in the run, pinned to the run's current revision. */
export function seedAttempt(ctx: TestCtx, run: SeededRun, options: SeedAttemptOptions): string {
  const ticketId = ticketIdOf(options.ticket)
  const id = ctx.ids.next('attempt')
  const now = ctx.clock.nowIso()
  const pinned = ctx.db.get<{ revision_id: string }>('SELECT revision_id FROM runs WHERE id = ?', run.runId)
  const previous = ctx.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND ticket_id = ?',
    run.runId,
    ticketId
  )
  const number = (previous?.n ?? 0) + 1
  const ticket = run.bundle.tickets.find((candidate) => candidate.id === ticketId)
  ctx.db.run(
    `INSERT INTO attempts (id, run_id, ticket_id, number, kind, state, fencing_token, worker_json, revision_id,
       ticket_content_hash, created_at, updated_at, reconciled_at, superseded_at, outputs_json, increment_json,
       evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    run.runId,
    ticketId,
    number,
    options.kind ?? 'work',
    options.state,
    number,
    JSON.stringify({ label: 'test worker' }),
    pinned?.revision_id ?? run.revisionId,
    contentHash(ticket ?? null),
    now,
    now,
    options.reconciled === true ? now : null,
    options.superseded === true ? now : null,
    recordedOutputs(options.commits),
    options.increment === undefined ? null : JSON.stringify(incrementVerdict(options.increment)),
    recordedEvidence(options.checks)
  )
  return id
}

function markTicketStatus(ctx: TestCtx, ticket: number | string, status: WorkStatus): void {
  ctx.db.run('UPDATE ticket_status SET status = ? WHERE ticket_id = ?', status, ticketIdOf(ticket))
}

/**
 * Accepted attempts for `tickets`, with their ticket status completed (what acceptance records). An
 * acceptance node's attempt also carries a passing increment verdict, as an accepted node's does when its
 * increment verified; seed the node with `seedAttempt` to leave the increment out or make it fail.
 */
export function acceptTickets(ctx: TestCtx, run: SeededRun, tickets: number[]): void {
  for (const ticket of tickets) {
    const node = run.bundle.tickets.find((item) => item.id === ticketIdOf(ticket))?.kind === 'acceptance'
    seedAttempt(ctx, run, { ticket, state: 'accepted', ...(node ? { increment: {} } : {}) })
    markTicketStatus(ctx, ticket, 'completed')
  }
}

export function ticketStatusOf(ctx: TestCtx, ticket: number | string): string | null {
  const row = ctx.db.get<{ status: string }>('SELECT status FROM ticket_status WHERE ticket_id = ?', ticketIdOf(ticket))
  return row?.status ?? null
}

interface RunSnapshot {
  state: string
  revision_id: string
  active_sprint_id: string | null
  auto_continue: number
  revision: number
  updated_at: string
  ended_at: string | null
}

export function runRow(ctx: TestCtx, runId: string): RunSnapshot | undefined {
  return ctx.db.get<RunSnapshot>(
    `SELECT state, revision_id, active_sprint_id, auto_continue, revision, updated_at, ended_at
     FROM runs WHERE id = ?`,
    runId
  )
}

export function setRunState(ctx: TestCtx, runId: string, state: RunState): void {
  ctx.db.run('UPDATE runs SET state = ? WHERE id = ?', state, runId)
}

interface OutboxSnapshot {
  kind: string
  epic_id: string | null
  run_id: string | null
}

export function outboxEntries(ctx: TestCtx): OutboxSnapshot[] {
  return ctx.db.all<OutboxSnapshot>('SELECT kind, epic_id, run_id FROM outbox ORDER BY id')
}

interface EventSnapshot {
  kind: string
  epicId: string | null
  runId: string | null
  ticketId: string | null
  payload: Record<string, unknown>
}

export function eventLog(ctx: TestCtx): EventSnapshot[] {
  const rows = ctx.db.all<{
    kind: string
    epic_id: string | null
    run_id: string | null
    ticket_id: string | null
    payload_json: string
  }>('SELECT kind, epic_id, run_id, ticket_id, payload_json FROM events ORDER BY seq')
  return rows.map((row) => ({
    kind: row.kind,
    epicId: row.epic_id,
    runId: row.run_id,
    ticketId: row.ticket_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>
  }))
}

/** Runs `action` and returns the thrown domain error's code and message (or 'ok'). */
export function errorOf(action: () => unknown): { code: string; message: string; details?: unknown } {
  try {
    action()
    return { code: 'ok', message: '' }
  } catch (error: unknown) {
    const shaped = error as { code?: string; message?: string; details?: unknown }
    return { code: shaped.code ?? 'thrown', message: shaped.message ?? '', details: shaped.details }
  }
}
