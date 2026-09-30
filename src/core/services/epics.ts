import type { CreateEpicInput } from '../../shared/domain/api'
import type { EpicBranch, EpicContent, EpicProvenance, PlanBundle } from '../../shared/domain/bundle'
import type { RunState, WorkStatus } from '../../shared/domain/status'
import type { EpicDetailView, EpicOutcome, EpicSummaryView, RunSummaryView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { createInitialBundle, normalizeCriteria } from '../plan/normalize'
import { appendEvent } from './events'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'

/** Row of the `epics` table. */
export interface EpicRow {
  id: string
  title: string
  status: WorkStatus
  current_revision_id: string | null
  branch_json: string | null
  provenance_json: string | null
  outcome_json: string | null
  revision: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface ActiveRunRow {
  id: string
  number: number
  revision_id: string
}

interface EpicSource {
  row: EpicRow
  /** Current saved bundle, else the draft of a never-saved epic. */
  bundle: PlanBundle | null
  currentNumber: number | null
  draftRevision: number | null
}

interface RunSummaryRow {
  id: string
  state: RunState
  active_sprint_id: string | null
  pause_reason: string | null
  revision_number: number
  bundle_json: string
}

const ACTIVE_RUN_SQL = `('queued','running','awaiting_checkpoint','paused')`

const COMPLETION_RULE =
  'Epics complete when the final sprint checkpoint advances (advance_sprint); status tools cannot bypass completion rules.'

export function loadEpicRow(ctx: Ctx, epicId: string): EpicRow {
  const row = ctx.db.get<EpicRow>('SELECT * FROM epics WHERE id = ?', epicId)
  return row ?? fail('not_found', `Epic ${epicId} not found.`, { epicId })
}

/** Completed epics are terminal: no status change, draft, save, or run. */
export function assertEpicOpen(row: EpicRow): void {
  if (row.status === 'completed') {
    fail('completed_epic', 'Completed epics are read-only. Create a new epic to extend this work.')
  }
}

/** The epic's run in `queued|running|awaiting_checkpoint|paused`, if any. */
export function activeRun(ctx: Ctx, epicId: string): ActiveRunRow | null {
  const run = ctx.db.get<ActiveRunRow>(
    `SELECT id, number, revision_id FROM runs WHERE epic_id = ? AND state IN ${ACTIVE_RUN_SQL}`,
    epicId
  )
  return run ?? null
}

function assertNoActiveRun(ctx: Ctx, epicId: string, consequence: string): void {
  const run = activeRun(ctx, epicId)
  if (run) {
    fail('active_run_exists', `Run #${run.number} is active. ${consequence}`, { runId: run.id })
  }
}

function assertEpicRevision(row: EpicRow, expected: number | undefined): void {
  if (expected !== undefined && expected !== row.revision) {
    fail('conflict', `The epic changed (now revision ${row.revision}). Reload and try again.`, {
      currentRevision: row.revision
    })
  }
}

/** Unsaved epics (no saved revision) are never exported. */
function exportEpicState(ctx: Ctx, row: EpicRow): void {
  if (row.current_revision_id !== null) {
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: row.id })
  }
}

/** Changes an epic's status inside the caller's transaction (revision bump, event, export). */
export function applyEpicStatus(ctx: Ctx, row: EpicRow, status: WorkStatus): void {
  ctx.db.run(
    'UPDATE epics SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
    status,
    ctx.clock.nowIso(),
    row.id
  )
  appendEvent(ctx, { kind: 'epic.status_changed', epicId: row.id, payload: { from: row.status, to: status } })
  exportEpicState(ctx, row)
}

function loadSource(ctx: Ctx, row: EpicRow): EpicSource {
  const current = ctx.db.get<{ number: number; bundle_json: string }>(
    'SELECT number, bundle_json FROM plan_revisions WHERE id = ?',
    row.current_revision_id
  )
  const draft = ctx.db.get<{ draft_revision: number; bundle_json: string }>(
    'SELECT draft_revision, bundle_json FROM drafts WHERE epic_id = ?',
    row.id
  )
  const json = current?.bundle_json ?? draft?.bundle_json
  return {
    row,
    bundle: json === undefined ? null : (JSON.parse(json) as PlanBundle),
    currentNumber: current?.number ?? null,
    draftRevision: draft?.draft_revision ?? null
  }
}

function runSummary(ctx: Ctx, epicId: string): RunSummaryView | null {
  const run = ctx.db.get<RunSummaryRow>(
    `SELECT r.id, r.state, r.active_sprint_id, r.pause_reason, p.number AS revision_number, p.bundle_json
     FROM runs r JOIN plan_revisions p ON p.id = r.revision_id
     WHERE r.epic_id = ?
     ORDER BY CASE WHEN r.state IN ${ACTIVE_RUN_SQL} THEN 0 ELSE 1 END, r.number DESC, r.created_at DESC
     LIMIT 1`,
    epicId
  )
  if (!run) {
    return null
  }
  const sprints = (JSON.parse(run.bundle_json) as PlanBundle).sprints
  return {
    id: run.id,
    state: run.state,
    revisionNumber: run.revision_number,
    activeSprintOrdinal: sprints.find((sprint) => sprint.id === run.active_sprint_id)?.ordinal ?? null,
    sprintCount: sprints.length,
    pauseReason: run.pause_reason
  }
}

function hasPendingSave(ctx: Ctx, epicId: string): boolean {
  const row = ctx.db.get<{ pending: number }>(
    "SELECT EXISTS (SELECT 1 FROM plan_revisions WHERE epic_id = ? AND state = 'pending') AS pending",
    epicId
  )
  return row?.pending === 1
}

function syncConflict(ctx: Ctx, epicId: string): string | null {
  const row = ctx.db.get<{ conflict: string | null }>(
    "SELECT conflict FROM sync_state WHERE kind = 'epic' AND entity_id = ?",
    epicId
  )
  return row?.conflict ?? null
}

function toSummary(ctx: Ctx, source: EpicSource): EpicSummaryView {
  const { row, bundle } = source
  return {
    id: row.id,
    title: bundle?.epic.title ?? row.title,
    status: row.status,
    revision: row.revision,
    currentRevisionId: row.current_revision_id,
    currentRevisionNumber: source.currentNumber,
    hasDraft: source.draftRevision !== null,
    draftRevision: source.draftRevision,
    ticketCount: bundle?.tickets.length ?? 0,
    sprintCount: bundle?.sprints.length ?? 0,
    run: runSummary(ctx, row.id),
    branch: parseJson<EpicBranch | null>(row.branch_json, null),
    pendingSave: hasPendingSave(ctx, row.id),
    conflict: syncConflict(ctx, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

function epicDetail(ctx: Ctx, row: EpicRow): EpicDetailView {
  const source = loadSource(ctx, row)
  const epic = source.bundle?.epic
  return {
    ...toSummary(ctx, source),
    intent: epic?.intent ?? '',
    successCriteria: epic?.successCriteria ?? [],
    ownerRole: epic?.ownerRole ?? null,
    provenance: parseJson<EpicProvenance | null>(row.provenance_json, null),
    outcome: parseJson<EpicOutcome | null>(row.outcome_json, null)
  }
}

function resolveProvenance(ctx: Ctx, input: CreateEpicInput['provenance']): EpicProvenance | null {
  if (!input) {
    return null
  }
  const source = ctx.db.get<{ id: string }>('SELECT id FROM epics WHERE id = ?', input.sourceEpicId)
  if (!source) {
    fail('not_found', `Source epic ${input.sourceEpicId} not found.`, { epicId: input.sourceEpicId })
  }
  return { sourceEpicId: source.id, note: input.note ?? '' }
}

function initialContent(input: CreateEpicInput, title: string): EpicContent {
  return {
    title,
    intent: input.intent ?? '',
    successCriteria: normalizeCriteria(input.successCriteria ?? [], [], 's'),
    ownerRole: input.ownerRole ?? null
  }
}

function insertEpic(ctx: Ctx, input: CreateEpicInput, title: string): string {
  const provenance = resolveProvenance(ctx, input.provenance)
  const id = ctx.ids.next('epic')
  const now = ctx.clock.nowIso()
  ctx.db.run(
    `INSERT INTO epics (id, title, status, current_revision_id, branch_json, provenance_json, outcome_json, revision,
       created_at, updated_at, completed_at)
     VALUES (?, ?, 'backlog', NULL, ?, ?, NULL, 1, ?, ?, NULL)`,
    id,
    title,
    input.branch ? toJson(input.branch) : null,
    provenance ? toJson(provenance) : null,
    now,
    now
  )
  const bundle = createInitialBundle(initialContent(input, title), ctx.ids.next('sprint'))
  ctx.db.run(
    `INSERT INTO drafts (epic_id, base_revision_id, draft_revision, bundle_json, created_at, updated_at, updated_by)
     VALUES (?, NULL, 1, ?, ?, ?, ?)`,
    id,
    toJson(bundle),
    now,
    now,
    ctx.session.id
  )
  return id
}

/** Creates a `backlog` epic plus its initial draft (one empty sprint). It has no saved revision yet. */
export function createEpic(ctx: Ctx, input: CreateEpicInput): EpicDetailView {
  requireCapability(ctx.session, 'epic.create')
  const scope = { command: 'createEpic', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const title = input.title.trim()
    if (title === '') {
      fail('invalid_input', 'The epic needs a title.')
    }
    const id = insertEpic(ctx, input, title)
    appendEvent(ctx, { kind: 'epic.created', epicId: id, payload: { title } })
    return epicDetail(ctx, loadEpicRow(ctx, id))
  })
}

/** Epics ordered in progress, backlog, completed; most recently updated first within a status. */
export function listEpics(ctx: Ctx): EpicSummaryView[] {
  requireCapability(ctx.session, 'read')
  const rows = ctx.db.all<EpicRow>(
    `SELECT * FROM epics
     ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'backlog' THEN 1 ELSE 2 END, updated_at DESC, id DESC`
  )
  return rows.map((row) => toSummary(ctx, loadSource(ctx, row)))
}

export function getEpic(ctx: Ctx, input: { epicId: string }): EpicDetailView {
  requireCapability(ctx.session, 'read')
  return epicDetail(ctx, loadEpicRow(ctx, input.epicId))
}

export function setEpicStatus(
  ctx: Ctx,
  input: { epicId: string; status: WorkStatus; expectedRevision?: number }
): EpicDetailView {
  requireCapability(ctx.session, 'epic.status')
  return ctx.db.tx(() => {
    const row = loadEpicRow(ctx, input.epicId)
    assertEpicOpen(row)
    if (input.status === 'completed') {
      fail('unauthorized_transition', COMPLETION_RULE)
    }
    if (input.status !== row.status) {
      assertEpicRevision(row, input.expectedRevision)
      if (input.status === 'backlog') {
        assertNoActiveRun(ctx, row.id, 'Cancel or finish it before moving the epic back to backlog.')
      }
      applyEpicStatus(ctx, row, input.status)
    }
    return epicDetail(ctx, loadEpicRow(ctx, row.id))
  })
}

export function setEpicBranch(
  ctx: Ctx,
  input: { epicId: string; branch: EpicBranch; expectedRevision?: number }
): EpicDetailView {
  requireCapability(ctx.session, 'epic.branch')
  return ctx.db.tx(() => {
    const row = loadEpicRow(ctx, input.epicId)
    assertEpicOpen(row)
    assertEpicRevision(row, input.expectedRevision)
    assertNoActiveRun(ctx, row.id, "The epic branch can't change while a run is using it.")
    ctx.db.run(
      'UPDATE epics SET branch_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      toJson(input.branch),
      ctx.clock.nowIso(),
      row.id
    )
    appendEvent(ctx, { kind: 'epic.branch_set', epicId: row.id, payload: { branch: input.branch } })
    exportEpicState(ctx, row)
    return epicDetail(ctx, loadEpicRow(ctx, row.id))
  })
}
