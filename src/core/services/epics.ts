import type { CreateEpicInput } from '../../shared/domain/api'
import type { EpicBranch, EpicContent, EpicProvenance } from '../../shared/domain/bundle'
import type { RunState, WorkStatus } from '../../shared/domain/status'
import type { EpicDetailView, EpicOutcome, EpicSummaryView, RunSummaryView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { createInitialBundle, normalizeCriteria } from '../plan/normalize'
import { initialPlanIds } from './draftDeps'
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

/**
 * How a draft's text compares with the current saved bundle's; null without a draft or a saved plan.
 * Equal content always serializes to equal length (only key order can differ), so only `unsure` needs
 * the content hashed.
 */
type DraftMatch = 'same' | 'unsure' | 'changed'

/** An epic row plus what its summary needs, extracted in SQL (bundles are parsed only for an `unsure` draft). */
interface EpicSourceRow extends EpicRow {
  current_number: number | null
  draft_revision: number | null
  draft_match: DraftMatch | null
  /** Title of the current saved bundle, else of the draft of a never-saved epic. */
  content_title: string | null
  ticket_count: number | null
  sprint_count: number | null
  pending_save: number
  conflict: string | null
}

interface EpicDetailRow extends EpicSourceRow {
  /** `epic` object of the same bundle as `content_title`. */
  epic_json: string | null
}

interface RunSummaryRow {
  id: string
  state: RunState
  pause_reason: string | null
  revision_number: number
  active_sprint_ordinal: number | null
  sprint_count: number
}

const ACTIVE_RUN_SQL = `('queued','running','awaiting_checkpoint','paused')`

const SUMMARY_COLUMNS = `s.id, s.title, s.status, s.current_revision_id, s.branch_json, s.provenance_json,
  s.outcome_json, s.revision, s.created_at, s.updated_at, s.completed_at, s.current_number, s.draft_revision,
  s.draft_match, s.pending_save, s.conflict, json_extract(s.bundle_json, '$.epic.title') AS content_title,
  json_array_length(s.bundle_json, '$.tickets') AS ticket_count,
  json_array_length(s.bundle_json, '$.sprints') AS sprint_count`

/** Epics joined with their content bundle: the current saved one, else the draft of a never-saved epic. */
function epicSourceSql(columns: string, where: string): string {
  return `SELECT ${columns}
    FROM (
      SELECT e.*,
        (SELECT number FROM plan_revisions WHERE id = e.current_revision_id) AS current_number,
        (SELECT draft_revision FROM drafts WHERE epic_id = e.id) AS draft_revision,
        (SELECT CASE WHEN d.bundle_json = p.bundle_json THEN 'same'
            WHEN length(d.bundle_json) = length(p.bundle_json) THEN 'unsure' ELSE 'changed' END
          FROM drafts d JOIN plan_revisions p ON p.id = e.current_revision_id WHERE d.epic_id = e.id) AS draft_match,
        COALESCE(
          (SELECT bundle_json FROM plan_revisions WHERE id = e.current_revision_id),
          (SELECT bundle_json FROM drafts WHERE epic_id = e.id)
        ) AS bundle_json,
        EXISTS (SELECT 1 FROM plan_revisions WHERE epic_id = e.id AND state = 'pending') AS pending_save,
        (SELECT conflict FROM sync_state WHERE kind = 'epic' AND entity_id = e.id) AS conflict
      FROM epics e ${where}
    ) s`
}

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

function runSummary(ctx: Ctx, epicId: string): RunSummaryView | null {
  const run = ctx.db.get<RunSummaryRow>(
    `SELECT r.id, r.state, r.pause_reason, p.number AS revision_number,
       json_array_length(p.bundle_json, '$.sprints') AS sprint_count,
       (SELECT json_extract(sp.value, '$.ordinal') FROM json_each(p.bundle_json, '$.sprints') sp
         WHERE json_extract(sp.value, '$.id') = r.active_sprint_id) AS active_sprint_ordinal
     FROM runs r JOIN plan_revisions p ON p.id = r.revision_id
     WHERE r.epic_id = ?
     ORDER BY CASE WHEN r.state IN ${ACTIVE_RUN_SQL} THEN 0 ELSE 1 END, r.number DESC, r.created_at DESC
     LIMIT 1`,
    epicId
  )
  if (!run) {
    return null
  }
  return {
    id: run.id,
    state: run.state,
    revisionNumber: run.revision_number,
    activeSprintOrdinal: run.active_sprint_ordinal,
    sprintCount: run.sprint_count,
    pauseReason: run.pause_reason
  }
}

/**
 * Whether the draft holds changes the saved plan lacks. Edit draft copies the saved plan, so that
 * copy is no change; every draft of a never-saved epic is.
 */
function draftChanged(ctx: Ctx, row: EpicSourceRow): boolean {
  if (row.draft_revision === null) {
    return false
  }
  if (row.draft_match !== 'unsure') {
    return row.draft_match !== 'same'
  }
  const texts = ctx.db.get<{ draft_json: string; saved_hash: string }>(
    `SELECT d.bundle_json AS draft_json, p.content_hash AS saved_hash
     FROM drafts d JOIN plan_revisions p ON p.id = ? WHERE d.epic_id = ?`,
    row.current_revision_id,
    row.id
  )
  return texts === undefined || contentHash(JSON.parse(texts.draft_json)) !== texts.saved_hash
}

function toSummary(ctx: Ctx, row: EpicSourceRow): EpicSummaryView {
  return {
    id: row.id,
    title: row.content_title ?? row.title,
    status: row.status,
    revision: row.revision,
    currentRevisionId: row.current_revision_id,
    currentRevisionNumber: row.current_number,
    hasDraft: row.draft_revision !== null,
    draftRevision: row.draft_revision,
    draftChanged: draftChanged(ctx, row),
    ticketCount: row.ticket_count ?? 0,
    sprintCount: row.sprint_count ?? 0,
    run: runSummary(ctx, row.id),
    branch: parseJson<EpicBranch | null>(row.branch_json, null),
    pendingSave: row.pending_save === 1,
    conflict: row.conflict,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

function epicDetail(ctx: Ctx, epicId: string): EpicDetailView {
  const sql = epicSourceSql(`${SUMMARY_COLUMNS}, json_extract(s.bundle_json, '$.epic') AS epic_json`, 'WHERE e.id = ?')
  const row = ctx.db.get<EpicDetailRow>(sql, epicId) ?? fail('not_found', `Epic ${epicId} not found.`, { epicId })
  const epic = parseJson<EpicContent | null>(row.epic_json, null)
  return {
    ...toSummary(ctx, row),
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
  const bundle = createInitialBundle(initialContent(input, title), initialPlanIds(ctx))
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
    return epicDetail(ctx, id)
  })
}

/** Epics ordered in progress, backlog, completed; most recently updated first within a status. */
export function listEpics(ctx: Ctx): EpicSummaryView[] {
  requireCapability(ctx.session, 'read')
  const rows = ctx.db.all<EpicSourceRow>(
    `${epicSourceSql(SUMMARY_COLUMNS, '')}
     ORDER BY CASE s.status WHEN 'in_progress' THEN 0 WHEN 'backlog' THEN 1 ELSE 2 END, s.updated_at DESC, s.id DESC`
  )
  return rows.map((row) => toSummary(ctx, row))
}

export function getEpic(ctx: Ctx, input: { epicId: string }): EpicDetailView {
  requireCapability(ctx.session, 'read')
  return epicDetail(ctx, input.epicId)
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
    return epicDetail(ctx, row.id)
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
    return epicDetail(ctx, row.id)
  })
}
