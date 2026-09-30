/** SQL seeding and inspection helpers for execution tests (runs, attempts, hosts). Not shipped. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaimTicketInput, SubmitAttemptInput } from '../shared/domain/api'
import type { EpicBranch, PlanBundle, PlanPolicies } from '../shared/domain/bundle'
import type { WorkStatus } from '../shared/domain/status'
import type { AttemptView, ClaimResultView, HostCatalog, HostModel } from '../shared/domain/views'
import { contentHash } from '../core/canonical'
import type { Ctx } from '../core/context'
import { toJson } from '../core/db/database'
import { DomainError } from '../core/errors'
import { acceptAttempt, claimTicket, submitAttempt } from '../core/services/attempts'
import type { AttemptRow, RunRow } from '../core/services/execution'
import { startRun } from '../core/services/runs'
import { makeBundle, tid } from './bundles'
import { type TestCtx, withRole } from './testContext'

interface SeedEpicOptions {
  bundle?: PlanBundle
  status?: WorkStatus
  branch?: EpicBranch | null
  /** `false` leaves the epic without any saved revision. */
  saved?: boolean
}

interface SeededEpic {
  epicId: string
  revisionId: string | null
  bundle: PlanBundle
}

/** Adds a saved revision for `bundle` and makes it the epic's current revision. */
export function seedRevision(ctx: Ctx, epicId: string, bundle: PlanBundle): string {
  const id = ctx.ids.next('revision')
  const now = ctx.clock.nowIso()
  ctx.db.tx(() => {
    const last = ctx.db.get<{ number: number | null; current: string | null }>(
      `SELECT MAX(number) AS number, (SELECT current_revision_id FROM epics WHERE id = ?) AS current
       FROM plan_revisions WHERE epic_id = ?`,
      epicId,
      epicId
    )
    ctx.db.run(
      `INSERT INTO plan_revisions (id, epic_id, number, base_revision_id, content_hash, bundle_json, state, created_at, saved_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'saved', ?, ?, 'test')`,
      id,
      epicId,
      (last?.number ?? 0) + 1,
      last?.current ?? null,
      contentHash(bundle),
      toJson(bundle),
      now,
      now
    )
    ctx.db.run('UPDATE epics SET current_revision_id = ? WHERE id = ?', id, epicId)
  })
  return id
}

/** Inserts an epic (default `backlog`) with ticket_status rows and, unless `saved: false`, a saved revision. */
export function seedEpic(ctx: Ctx, options: SeedEpicOptions = {}): SeededEpic {
  const bundle = options.bundle ?? makeBundle([[1, 2]])
  const epicId = ctx.ids.next('epic')
  const now = ctx.clock.nowIso()
  ctx.db.tx(() => {
    ctx.db.run(
      'INSERT INTO epics (id, title, status, branch_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      epicId,
      bundle.epic.title,
      options.status ?? 'backlog',
      options.branch ? toJson(options.branch) : null,
      now,
      now
    )
    for (const ticket of bundle.tickets) {
      ctx.db.run(
        "INSERT INTO ticket_status (ticket_id, epic_id, status, updated_at) VALUES (?, ?, 'backlog', ?)",
        ticket.id,
        epicId,
        now
      )
    }
  })
  const revisionId = options.saved === false ? null : seedRevision(ctx, epicId, bundle)
  return { epicId, revisionId, bundle }
}

interface StartedRun extends SeededEpic {
  runId: string
}

/** Seeds an epic and starts a run on it through the real `startRun` (orchestrator session). */
export function startedRun(ctx: TestCtx, options: SeedEpicOptions = {}): StartedRun {
  const seeded = seedEpic(ctx, options)
  const run = startRun(withRole(ctx, 'orchestrator'), { epicId: seeded.epicId })
  return { ...seeded, runId: run.id }
}

export function bundleWith(
  sprints: number[][],
  edges: [number, number][],
  policies: Partial<PlanPolicies>
): PlanBundle {
  const bundle = makeBundle(sprints, edges)
  return { ...bundle, policies: { ...bundle.policies, ...policies } }
}

/** Claims ticket number `ticket` of the run with a default worker. */
export function claim(
  ctx: Ctx,
  runId: string,
  ticket: number,
  extra: Partial<ClaimTicketInput> = {}
): ClaimResultView {
  return claimTicket(ctx, { runId, ticketId: tid(ticket), worker: { label: 'worker-1' }, ...extra })
}

/** Submits a claim with its own token (default outputs: a one-line summary). */
export function submitClaim(
  ctx: Ctx,
  claimed: ClaimResultView,
  extra: Partial<SubmitAttemptInput> = {}
): AttemptView {
  return submitAttempt(ctx, {
    attemptId: claimed.attempt.id,
    claimToken: claimed.packet.claimToken,
    outputs: { summary: 'done' },
    ...extra
  })
}

/** Claims, submits, and accepts ticket number `ticket`, returning the accepted attempt. */
export function completeTicket(
  ctx: Ctx,
  runId: string,
  ticket: number,
  outputs?: SubmitAttemptInput['outputs']
): AttemptView {
  const claimed = claim(ctx, runId, ticket)
  submitClaim(ctx, claimed, outputs ? { outputs } : {})
  return acceptAttempt(ctx, { attemptId: claimed.attempt.id })
}

/** Ids of the run's open (claimed/running/submitted) attempts in creation order. */
export function openAttemptIds(ctx: Ctx, runId: string): string[] {
  return ctx.db
    .all<{ id: string }>(
      "SELECT id FROM attempts WHERE run_id = ? AND state IN ('claimed', 'running', 'submitted') ORDER BY rowid",
      runId
    )
    .map((row) => row.id)
}

export function attemptRow(ctx: Ctx, attemptId: string): AttemptRow {
  const row = ctx.db.get<AttemptRow>('SELECT * FROM attempts WHERE id = ?', attemptId)
  if (!row) {
    throw new Error(`attempt ${attemptId} missing`)
  }
  return row
}

export function runRow(ctx: Ctx, runId: string): RunRow {
  const row = ctx.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId)
  if (!row) {
    throw new Error(`run ${runId} missing`)
  }
  return row
}

export function epicRow(ctx: Ctx, epicId: string): { status: string; branch_json: string | null; revision: number } {
  const row = ctx.db.get<{ status: string; branch_json: string | null; revision: number }>(
    'SELECT status, branch_json, revision FROM epics WHERE id = ?',
    epicId
  )
  if (!row) {
    throw new Error(`epic ${epicId} missing`)
  }
  return row
}

export function ticketStatus(ctx: Ctx, ticketId: string): { status: string; revision: number } | undefined {
  return ctx.db.get<{ status: string; revision: number }>(
    'SELECT status, revision FROM ticket_status WHERE ticket_id = ?',
    ticketId
  )
}

/** Event kinds in append order, optionally only those starting with `prefix`. */
export function eventKinds(ctx: Ctx, prefix = ''): string[] {
  return ctx.db
    .all<{ kind: string }>('SELECT kind FROM events ORDER BY seq')
    .map((row) => row.kind)
    .filter((kind) => kind.startsWith(prefix))
}

export function lastEventPayload(ctx: Ctx, kind: string): Record<string, unknown> {
  const row = ctx.db.get<{ payload_json: string }>(
    'SELECT payload_json FROM events WHERE kind = ? ORDER BY seq DESC LIMIT 1',
    kind
  )
  return row ? (JSON.parse(row.payload_json) as Record<string, unknown>) : {}
}

/** Pending outbox entries as `kind:epicId:runId`. */
export function pendingOutbox(ctx: Ctx): string[] {
  return ctx.db
    .all<{ kind: string; epic_id: string | null; run_id: string | null }>(
      "SELECT kind, epic_id, run_id FROM outbox WHERE state = 'pending' ORDER BY id"
    )
    .map((row) => `${row.kind}:${row.epic_id ?? ''}:${row.run_id ?? ''}`)
}

export function clearOutbox(ctx: Ctx): void {
  ctx.db.run('DELETE FROM outbox')
}

export function hostModel(id: string, overrides: Partial<HostModel> = {}): HostModel {
  return {
    id,
    label: id,
    reasoningLevels: ['routine', 'multi_step', 'deep'],
    modalities: ['text', 'images'],
    contextWindowTokens: null,
    skills: [],
    costTier: null,
    latencyTier: null,
    ...overrides
  }
}

export function hostCatalog(models: HostModel[], overrides: Partial<HostCatalog> = {}): HostCatalog {
  return {
    hostId: 'host-a',
    hostType: 'cli-agent',
    catalogRevision: 'cat-1',
    tools: ['repo_read', 'repo_write', 'shell', 'test_execution'],
    canSelectWorkerModel: true,
    models,
    ...overrides
  }
}

/** A unique temporary directory for a file-backed database; call `cleanup` when done. */
export function tempDatabasePath(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'dm-execution-'))
  return {
    path: join(dir, 'state.sqlite'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** Runs `action` and returns the thrown DomainError (or throws if it failed differently or not at all). */
export function domainError(action: () => unknown): DomainError {
  try {
    action()
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return error
    }
    throw error
  }
  throw new Error('expected a DomainError, but the action succeeded')
}

/** The DomainError code `action` throws; `raw:<message>` for other errors and `ok` when nothing is thrown. */
export function errorCode(action: () => unknown): string {
  try {
    action()
  } catch (error: unknown) {
    return error instanceof DomainError ? error.code : `raw:${error instanceof Error ? error.message : String(error)}`
  }
  return 'ok'
}
