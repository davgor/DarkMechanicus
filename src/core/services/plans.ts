import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'
import type { PlanView, RevisionSummaryView, SaveResultView, ValidationReport } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { toJson } from '../db/database'
import { fail } from '../errors'
import { computeChanges } from '../plan/diff'
import { validatePlan } from '../plan/graph'
import { enqueueUnexportedComments } from './comments'
import { assertEpicOpen, type EpicRow, loadEpicRow } from './epics'
import { appendEvent } from './events'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'
import { withRunWarnings } from './runWarnings'
import { indexDocument } from './searchIndex'

type RevisionState = 'pending' | 'saved' | 'failed'

interface RevisionRow {
  id: string
  epic_id: string
  number: number
  base_revision_id: string | null
  content_hash: string
  bundle_json: string
  state: RevisionState
  created_at: string
  saved_at: string | null
  created_by: string | null
}

/** Row of the `drafts` table (at most one per epic). */
export interface DraftRow {
  epic_id: string
  base_revision_id: string | null
  draft_revision: number
  bundle_json: string
  created_at: string
  updated_at: string
  updated_by: string | null
}

interface SaveRequestResult {
  status: 'pending' | 'unchanged'
  revisionId: string
  revisionNumber: number
  contentHash: string
}

interface RevisionListRow {
  id: string
  number: number
  state: RevisionState
  content_hash: string
  base_revision_id: string | null
  created_at: string
  saved_at: string | null
  ticket_count: number
}

const COMPLETED_READ_ONLY = 'Completed epics are read-only.'
const SAVED_READ_ONLY = 'Saved revisions are immutable. Edit a draft to change the plan.'
const STALE_DRAFT =
  'The saved plan changed since this draft was opened (e.g. after a pull). Review and rebase before saving.'

function parseBundle(json: string): PlanBundle {
  return JSON.parse(json) as PlanBundle
}

function loadRevisionRow(ctx: Ctx, revisionId: string): RevisionRow {
  const row = ctx.db.get<RevisionRow>('SELECT * FROM plan_revisions WHERE id = ?', revisionId)
  return row ?? fail('not_found', `Revision ${revisionId} not found.`, { revisionId })
}

export function loadRevisionBundle(ctx: Ctx, revisionId: string): PlanBundle {
  return parseBundle(loadRevisionRow(ctx, revisionId).bundle_json)
}

/** The epic's current saved revision, or null for a never-saved epic. */
export function currentSavedBundle(
  ctx: Ctx,
  epicId: string
): { revisionId: string; number: number; bundle: PlanBundle } | null {
  const row = ctx.db.get<RevisionRow>(
    'SELECT p.* FROM plan_revisions p JOIN epics e ON e.current_revision_id = p.id WHERE e.id = ?',
    epicId
  )
  return row ? { revisionId: row.id, number: row.number, bundle: parseBundle(row.bundle_json) } : null
}

export function loadDraftRow(ctx: Ctx, epicId: string): DraftRow | null {
  return ctx.db.get<DraftRow>('SELECT * FROM drafts WHERE epic_id = ?', epicId) ?? null
}

/**
 * The revision of the epic's draft when it holds changes the current saved plan lacks; null when there is no
 * draft or it equals the saved plan (Edit draft copies it, which is no change). Equal means what saving
 * compares: the content hash, so a save of such a draft would be `unchanged`.
 */
export function changedDraftRevision(ctx: Ctx, epicId: string): number | null {
  const row = ctx.db.get<{ draft_revision: number; bundle_json: string; saved_hash: string | null }>(
    `SELECT d.draft_revision, d.bundle_json, p.content_hash AS saved_hash
     FROM drafts d JOIN epics e ON e.id = d.epic_id LEFT JOIN plan_revisions p ON p.id = e.current_revision_id
     WHERE d.epic_id = ?`,
    epicId
  )
  if (row === undefined) {
    return null
  }
  return contentHash(parseBundle(row.bundle_json)) === row.saved_hash ? null : row.draft_revision
}

/** Optimistic concurrency for drafts: a stale `expected` revision is a `conflict`. */
export function assertDraftRevision(draft: DraftRow, expected: number | undefined): void {
  if (expected !== undefined && expected !== draft.draft_revision) {
    fail('conflict', `The draft changed (now revision ${draft.draft_revision}). Reload and reapply your edit.`, {
      currentDraftRevision: draft.draft_revision
    })
  }
}

/** The number of a revision, or null when there is no such revision. */
export function revisionNumberOf(ctx: Ctx, revisionId: string | null): number | null {
  const row = ctx.db.get<{ number: number }>('SELECT number FROM plan_revisions WHERE id = ?', revisionId)
  return row?.number ?? null
}

function findSavedRevision(ctx: Ctx, epic: EpicRow, revisionId: string | undefined): RevisionRow {
  const row = ctx.db.get<RevisionRow>(
    "SELECT * FROM plan_revisions WHERE id = ? AND epic_id = ? AND state = 'saved'",
    revisionId ?? epic.current_revision_id,
    epic.id
  )
  if (row) {
    return row
  }
  return revisionId === undefined
    ? fail('not_found', 'This epic has no saved plan yet.', { epicId: epic.id })
    : fail('not_found', `Revision ${revisionId} is not a saved revision of this epic.`, { revisionId })
}

function savedView(ctx: Ctx, epic: EpicRow, revisionId: string | undefined): PlanView {
  const revision = findSavedRevision(ctx, epic, revisionId)
  const bundle = parseBundle(revision.bundle_json)
  return {
    epicId: epic.id,
    view: 'saved',
    revisionId: revision.id,
    revisionNumber: revision.number,
    baseRevisionId: revision.base_revision_id,
    baseRevisionNumber: revisionNumberOf(ctx, revision.base_revision_id),
    draftRevision: null,
    contentHash: contentHash(bundle),
    bundle,
    readOnly: true,
    readOnlyReason: epic.status === 'completed' ? COMPLETED_READ_ONLY : SAVED_READ_ONLY,
    changes: [],
    stale: false
  }
}

function requireDraft(ctx: Ctx, epic: EpicRow): DraftRow {
  const draft = loadDraftRow(ctx, epic.id)
  return draft ?? fail('not_found', 'No draft. Open one with openDraft or update_plan_draft.', { epicId: epic.id })
}

/**
 * The bundle a saved (current revision) or draft read sees, without building a full plan view.
 * Callers check the `read` capability.
 */
export function readPlanBundle(
  ctx: Ctx,
  epic: EpicRow,
  view: 'saved' | 'draft'
): { bundle: PlanBundle; revisionId: string | null } {
  if (view === 'draft') {
    return { bundle: parseBundle(requireDraft(ctx, epic).bundle_json), revisionId: null }
  }
  const revision = findSavedRevision(ctx, epic, undefined)
  return { bundle: parseBundle(revision.bundle_json), revisionId: revision.id }
}

function draftView(ctx: Ctx, epic: EpicRow): PlanView {
  const draft = requireDraft(ctx, epic)
  const bundle = parseBundle(draft.bundle_json)
  const base = ctx.db.get<{ bundle_json: string }>(
    'SELECT bundle_json FROM plan_revisions WHERE id = ?',
    draft.base_revision_id
  )
  const completed = epic.status === 'completed'
  return {
    epicId: epic.id,
    view: 'draft',
    revisionId: null,
    revisionNumber: null,
    baseRevisionId: draft.base_revision_id,
    baseRevisionNumber: revisionNumberOf(ctx, draft.base_revision_id),
    draftRevision: draft.draft_revision,
    contentHash: contentHash(bundle),
    bundle,
    readOnly: completed,
    readOnlyReason: completed ? COMPLETED_READ_ONLY : null,
    changes: computeChanges(base ? parseBundle(base.bundle_json) : null, bundle),
    stale: draft.base_revision_id !== epic.current_revision_id
  }
}

/** Explicit saved or draft read. Saved reads never include draft-only content. */
export function getPlan(
  ctx: Ctx,
  input: { epicId: string; view: 'saved' | 'draft'; revisionId?: string }
): PlanView {
  requireCapability(ctx.session, 'read')
  const epic = loadEpicRow(ctx, input.epicId)
  return input.view === 'saved' ? savedView(ctx, epic, input.revisionId) : draftView(ctx, epic)
}

/** The plan's validation report; while a run executes the epic it also carries the run-aware warnings. */
export function validatePlanView(ctx: Ctx, input: { epicId: string; view: 'saved' | 'draft' }): ValidationReport {
  requireCapability(ctx.session, 'read')
  const epic = loadEpicRow(ctx, input.epicId)
  const { bundle } = readPlanBundle(ctx, epic, input.view)
  return withRunWarnings(ctx, epic.id, bundle, validatePlan(bundle))
}

function savableBundle(epic: EpicRow, draft: DraftRow): PlanBundle {
  if (draft.base_revision_id !== epic.current_revision_id) {
    fail('stale_draft', STALE_DRAFT, {
      baseRevisionId: draft.base_revision_id,
      currentRevisionId: epic.current_revision_id
    })
  }
  const bundle = parseBundle(draft.bundle_json)
  const report = validatePlan(bundle)
  const [first] = report.errors
  if (first) {
    fail('invalid_plan', `The plan has ${report.errors.length} error(s) that block saving. ${first.message}`, {
      errors: report.errors
    })
  }
  return bundle
}

function assertNoPendingSave(ctx: Ctx, epicId: string): void {
  const pending = ctx.db.get<{ id: string; number: number }>(
    "SELECT id, number FROM plan_revisions WHERE epic_id = ? AND state = 'pending'",
    epicId
  )
  if (pending) {
    fail('save_pending', `Revision ${pending.number} is still being saved. Flush portable state, then try again.`, {
      revisionId: pending.id
    })
  }
}

function nextRevisionNumber(ctx: Ctx, epicId: string): number {
  const row = ctx.db.get<{ n: number | null }>('SELECT MAX(number) AS n FROM plan_revisions WHERE epic_id = ?', epicId)
  return (row?.n ?? 0) + 1
}

function insertPendingRevision(ctx: Ctx, save: { epic: EpicRow; bundle: PlanBundle; hash: string }): SaveRequestResult {
  const id = ctx.ids.next('revision')
  const number = nextRevisionNumber(ctx, save.epic.id)
  ctx.db.run(
    `INSERT INTO plan_revisions (id, epic_id, number, base_revision_id, content_hash, bundle_json, state, created_at,
       saved_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)`,
    id,
    save.epic.id,
    number,
    save.epic.current_revision_id,
    save.hash,
    toJson(save.bundle),
    ctx.clock.nowIso(),
    ctx.session.id
  )
  enqueueOutbox(ctx, { kind: 'snapshot', epicId: save.epic.id, revisionId: id })
  appendEvent(ctx, { kind: 'plan.save_requested', epicId: save.epic.id, payload: { revisionId: id, number } })
  return { status: 'pending', revisionId: id, revisionNumber: number, contentHash: save.hash }
}

function saveDraft(ctx: Ctx, input: { epicId: string; expectedDraftRevision: number }): SaveRequestResult {
  const epic = loadEpicRow(ctx, input.epicId)
  assertEpicOpen(epic)
  const draft = loadDraftRow(ctx, epic.id) ?? fail('not_found', 'There is no draft to save.', { epicId: epic.id })
  assertDraftRevision(draft, input.expectedDraftRevision)
  const bundle = savableBundle(epic, draft)
  assertNoPendingSave(ctx, epic.id)
  const hash = contentHash(bundle)
  const current = ctx.db.get<RevisionRow>('SELECT * FROM plan_revisions WHERE id = ?', epic.current_revision_id)
  if (current?.content_hash === hash) {
    ctx.db.run('DELETE FROM drafts WHERE epic_id = ?', epic.id)
    return { status: 'unchanged', revisionId: current.id, revisionNumber: current.number, contentHash: hash }
  }
  return insertPendingRevision(ctx, { epic, bundle, hash })
}

/**
 * Save, step one: validates the draft and records a `pending` revision plus a snapshot outbox
 * entry in one transaction. The finalizer makes it `saved` via `completeSavedRevision`.
 */
export function requestSave(
  ctx: Ctx,
  input: { epicId: string; expectedDraftRevision: number; idempotencyKey?: string }
): SaveRequestResult {
  requireCapability(ctx.session, 'plan.save')
  ctx.assertBranch()
  const scope = { command: 'savePlan', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => saveDraft(ctx, input))
}

function searchBody(parts: string[]): string {
  return parts.filter((part) => part !== '').join('\n')
}

function ticketSearchBody(ticket: TicketContent): string {
  return searchBody([ticket.body, ...ticket.acceptanceCriteria.map((item) => item.text), ticket.tags.join(' ')])
}

function indexRevision(ctx: Ctx, epicId: string, bundle: PlanBundle): void {
  for (const ticket of bundle.tickets) {
    indexDocument(ctx.db, {
      docType: 'ticket',
      docId: ticket.id,
      epicId,
      ticketId: ticket.id,
      title: `${ticket.key} ${ticket.title}`,
      body: ticketSearchBody(ticket)
    })
  }
  const epicBody = searchBody([bundle.epic.intent, ...bundle.epic.successCriteria.map((item) => item.text), bundle.rationale])
  indexDocument(ctx.db, { docType: 'epic', docId: epicId, epicId, title: bundle.epic.title, body: epicBody })
}

/** Drops a draft that still equals the saved content; otherwise rebases it so later edits survive. */
function settleDraft(ctx: Ctx, revision: RevisionRow): void {
  const draft = loadDraftRow(ctx, revision.epic_id)
  if (!draft) {
    return
  }
  if (contentHash(parseBundle(draft.bundle_json)) === revision.content_hash) {
    ctx.db.run('DELETE FROM drafts WHERE epic_id = ?', revision.epic_id)
  } else if (draft.base_revision_id === revision.base_revision_id) {
    ctx.db.run('UPDATE drafts SET base_revision_id = ? WHERE epic_id = ?', revision.id, revision.epic_id)
  }
}

function markSaved(ctx: Ctx, revision: RevisionRow, bundle: PlanBundle): void {
  const now = ctx.clock.nowIso()
  ctx.db.run("UPDATE plan_revisions SET state = 'saved', saved_at = ? WHERE id = ?", now, revision.id)
  ctx.db.run(
    'UPDATE epics SET current_revision_id = ?, title = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
    revision.id,
    bundle.epic.title,
    now,
    revision.epic_id
  )
  for (const ticket of bundle.tickets) {
    ctx.db.run(
      `INSERT OR IGNORE INTO ticket_status (ticket_id, epic_id, status, revision, updated_at)
       VALUES (?, ?, 'backlog', 1, ?)`,
      ticket.id,
      revision.epic_id,
      now
    )
  }
}

/**
 * Save, step two — the finalizer's hook, called inside its transaction once the snapshot and the
 * pointer are durable. Makes the revision current. Repeated calls are no-ops.
 */
export function completeSavedRevision(ctx: Ctx, revisionId: string): void {
  ctx.db.tx(() => {
    const revision = loadRevisionRow(ctx, revisionId)
    if (revision.state === 'saved') {
      return
    }
    const bundle = parseBundle(revision.bundle_json)
    markSaved(ctx, revision, bundle)
    settleDraft(ctx, revision)
    indexRevision(ctx, revision.epic_id, bundle)
    // Comments written before the epic's first save were kept local until now.
    enqueueUnexportedComments(ctx, revision.epic_id)
    appendEvent(ctx, {
      kind: 'plan.saved',
      epicId: revision.epic_id,
      payload: { revisionId: revision.id, number: revision.number }
    })
  })
}

export function saveResult(ctx: Ctx, revisionId: string): SaveResultView {
  requireCapability(ctx.session, 'read')
  const revision = loadRevisionRow(ctx, revisionId)
  const saved = revision.state === 'saved'
  const outbox = ctx.db.get<{ last_error: string | null }>(
    "SELECT last_error FROM outbox WHERE kind = 'snapshot' AND revision_id = ? ORDER BY id DESC LIMIT 1",
    revision.id
  )
  return {
    status: saved ? 'saved' : 'pending',
    epicId: revision.epic_id,
    revisionId: revision.id,
    revisionNumber: revision.number,
    contentHash: revision.content_hash,
    error: saved ? null : (outbox?.last_error ?? null)
  }
}

/** Every revision of the epic, newest first. */
export function listRevisions(ctx: Ctx, input: { epicId: string }): RevisionSummaryView[] {
  requireCapability(ctx.session, 'read')
  const epic = loadEpicRow(ctx, input.epicId)
  const rows = ctx.db.all<RevisionListRow>(
    `SELECT id, number, state, content_hash, base_revision_id, created_at, saved_at,
       json_array_length(bundle_json, '$.tickets') AS ticket_count
     FROM plan_revisions WHERE epic_id = ? ORDER BY number DESC`,
    epic.id
  )
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    state: row.state,
    contentHash: row.content_hash,
    baseRevisionId: row.base_revision_id,
    createdAt: row.created_at,
    savedAt: row.saved_at,
    ticketCount: row.ticket_count,
    isCurrent: row.id === epic.current_revision_id
  }))
}
