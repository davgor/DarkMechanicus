/** Authoring fixtures: epics with saved revisions, raw runs/attempts, and error capture. Not shipped. */
import type { Ctx } from '../core/context'
import { DomainError } from '../core/errors'
import { updatePlanDraft } from '../core/services/drafts'
import { createEpic } from '../core/services/epics'
import { completeSavedRevision, requestSave } from '../core/services/plans'
import type { DraftOp } from '../shared/domain/api'
import type { AttemptState, RunState } from '../shared/domain/status'

interface CapturedError {
  code: string
  message: string
  details: Record<string, unknown> | undefined
}

/** Runs `action` and returns the DomainError it throws; fails the test when nothing is thrown. */
export function captureError(action: () => unknown): CapturedError {
  try {
    action()
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message, details: error.details }
    }
    throw error
  }
  throw new Error('Expected a DomainError, but the action succeeded.')
}

/** Sprint 1 with Alpha and Beta; Beta requires Alpha. */
export const TWO_TICKETS: DraftOp[] = [
  { op: 'add_ticket', ref: 'a', sprint: '1', ticket: { title: 'Alpha', acceptanceCriteria: ['Alpha works'] } },
  { op: 'add_ticket', ref: 'b', sprint: '1', ticket: { title: 'Beta', acceptanceCriteria: ['Beta works'] } },
  { op: 'add_dependency', from: 'a', to: 'b' }
]

export function draftRevisionOf(ctx: Ctx, epicId: string): number | null {
  const row = ctx.db.get<{ draft_revision: number }>('SELECT draft_revision FROM drafts WHERE epic_id = ?', epicId)
  return row?.draft_revision ?? null
}

/** Requests a save of the current draft and completes it the way the finalizer would. */
export function saveNow(ctx: Ctx, epicId: string): string {
  const result = requestSave(ctx, { epicId, expectedDraftRevision: draftRevisionOf(ctx, epicId) ?? 0 })
  ctx.db.tx(() => completeSavedRevision(ctx, result.revisionId))
  return result.revisionId
}

interface SavedEpic {
  epicId: string
  revisionId: string
  refMap: Record<string, string>
}

export function createSavedEpic(ctx: Ctx, options: { title?: string; ops?: DraftOp[] } = {}): SavedEpic {
  const epic = createEpic(ctx, {
    title: options.title ?? 'Checkout',
    intent: 'Ship it',
    successCriteria: ['Customers can pay']
  })
  const update = updatePlanDraft(ctx, { epicId: epic.id, ops: options.ops ?? TWO_TICKETS })
  return { epicId: epic.id, revisionId: saveNow(ctx, epic.id), refMap: update.refMap }
}

interface RunFixture {
  epicId: string
  revisionId: string
  state: RunState
  number?: number
  activeSprintId?: string | null
  pauseReason?: string | null
}

/** Inserts a run row directly (execution services are out of scope for authoring tests). */
export function insertRun(ctx: Ctx, run: RunFixture): string {
  const id = ctx.ids.next('run')
  const now = ctx.clock.nowIso()
  ctx.db.run(
    `INSERT INTO runs (id, epic_id, number, revision_id, state, active_sprint_id, owner_machine_id, pause_reason,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    run.epicId,
    run.number ?? 1,
    run.revisionId,
    run.state,
    run.activeSprintId ?? null,
    ctx.machineId,
    run.pauseReason ?? null,
    now,
    now
  )
  return id
}

interface AttemptFixture {
  runId: string
  ticketId: string
  state: AttemptState
  superseded?: boolean
}

export function insertAttempt(ctx: Ctx, attempt: AttemptFixture): string {
  const id = ctx.ids.next('attempt')
  const now = ctx.clock.nowIso()
  const run = ctx.db.get<{ revision_id: string }>('SELECT revision_id FROM runs WHERE id = ?', attempt.runId)
  const count = ctx.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND ticket_id = ?',
    attempt.runId,
    attempt.ticketId
  )
  ctx.db.run(
    `INSERT INTO attempts (id, run_id, ticket_id, number, kind, state, fencing_token, worker_json, revision_id,
       ticket_content_hash, created_at, updated_at, superseded_at)
     VALUES (?, ?, ?, ?, 'work', ?, 1, '{}', ?, 'sha256:test', ?, ?, ?)`,
    id,
    attempt.runId,
    attempt.ticketId,
    (count?.n ?? 0) + 1,
    attempt.state,
    run?.revision_id ?? '',
    now,
    now,
    attempt.superseded === true ? now : null
  )
  return id
}

export function eventKinds(ctx: Ctx): string[] {
  return ctx.db.all<{ kind: string }>('SELECT kind FROM events ORDER BY seq').map((row) => row.kind)
}

interface OutboxFixtureRow {
  kind: string
  epicId: string | null
  revisionId: string | null
}

export function outboxRows(ctx: Ctx): OutboxFixtureRow[] {
  return ctx.db
    .all<{ kind: string; epic_id: string | null; revision_id: string | null }>(
      'SELECT kind, epic_id, revision_id FROM outbox ORDER BY id'
    )
    .map((row) => ({ kind: row.kind, epicId: row.epic_id, revisionId: row.revision_id }))
}
