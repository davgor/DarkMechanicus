/**
 * Human management of published learnings (`src/shared/domain/learnings.ts`). Every role reads them; only the person
 * at the desktop (`learning.manage`) retires one or replaces it with new content. Both name the revision they last
 * read, so a stale concurrent change fails with `conflict` and changes nothing, and both require a reason.
 *
 * A replacement is a new record: it keeps its predecessor's evidence and source, links to it (`replaces`), and the
 * predecessor is retired with the reason and a link to its successor. A record's definition and source never change
 * (v30 triggers). Each change appends one entry per learning it touched to `learning_events`, which v31 makes
 * append-only; listing searches the learnings' content, source links and that history.
 */
import {
  learningDraftSchema,
  learningRecordSchema,
  type LearningDetailView,
  type LearningDraft,
  type LearningHistoryEntryView,
  type LearningReplacementContent,
  type LearningView,
  type ListLearningsInput,
  type ReplaceLearningInput,
  type ReplaceLearningResultView,
  type RetireLearningInput
} from '../../shared/domain/learnings'
import { requireCapability } from '../authz'
import { canonicalJson, contentHash } from '../canonical'
import type { Ctx } from '../context'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { withIntegration } from './learningReview'
import { enqueueOutbox } from './outbox'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

interface LearningRow {
  id: string
  run_id: string
  sprint_id: string
  card_id: string
  attempt_id: string
  definition_json: string
  definition_hash: string
  state: string
  replaces_id: string | null
  replaced_by_id: string | null
  created_at: string
  retired_at: string | null
  retired_reason: string | null
  revision: number
}

interface LearningEventRow {
  seq: number
  learning_id: string
  kind: LearningHistoryEntryView['kind']
  related_id: string | null
  reason: string
  revision: number
  actor_role: string
  actor_label: string
  run_id: string
  sprint_id: string
  card_id: string
  attempt_id: string
  at: string
}

/** A stored row as the shared record contract reads it; a row that breaks the contract is an internal fault. */
export function toLearningView(row: LearningRow): LearningView {
  const parsed = learningRecordSchema.safeParse({
    formatVersion: 1,
    id: row.id,
    ...(JSON.parse(row.definition_json) as object),
    source: { runId: row.run_id, sprintId: row.sprint_id, cardId: row.card_id, attemptId: row.attempt_id },
    state: row.state,
    replacedBy: row.replaced_by_id,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason
  })
  if (!parsed.success) {
    fail('internal', `Stored learning ${row.id} does not match the learning record contract.`, { learningId: row.id })
  }
  return { ...parsed.data, revision: row.revision, definitionHash: row.definition_hash }
}

function toHistoryEntry(row: LearningEventRow): LearningHistoryEntryView {
  return {
    seq: row.seq,
    learningId: row.learning_id,
    kind: row.kind,
    relatedId: row.related_id,
    reason: row.reason,
    revision: row.revision,
    actor: { role: row.actor_role, label: row.actor_label },
    source: { runId: row.run_id, sprintId: row.sprint_id, cardId: row.card_id, attemptId: row.attempt_id },
    at: row.at
  }
}

export function loadRow(db: Db, learningId: string): LearningRow {
  return (
    db.get<LearningRow>('SELECT * FROM learning_records WHERE id = ?', learningId) ??
    fail('not_found', `Learning ${learningId} not found.`, { learningId })
  )
}

function historyOf(db: Db, learningId: string): LearningHistoryEntryView[] {
  return db.all<LearningEventRow>('SELECT * FROM learning_events WHERE learning_id = ? ORDER BY seq', learningId).map(toHistoryEntry)
}

/** Lower-cased words of a free-text query; each must appear in the learning, its source links or its history. */
function queryTerms(query: string | undefined): string[] {
  return (query ?? '').toLowerCase().split(/\s+/).filter((term) => term !== '')
}

const TERM_MATCH = `(instr(lower(r.definition_json), ?) > 0
  OR instr(lower(r.id || ' ' || r.run_id || ' ' || r.sprint_id || ' ' || r.card_id || ' ' || r.attempt_id), ?) > 0
  OR EXISTS (SELECT 1 FROM learning_events e WHERE e.learning_id = r.id AND instr(lower(e.reason), ?) > 0))`

/** Stored learnings, newest first: active ones by default, retired or all on request, filtered by `query`. */
export function listLearnings(ctx: Ctx, input: ListLearningsInput): LearningView[] {
  requireCapability(ctx.session, 'read')
  const state = input.state ?? 'active'
  const terms = queryTerms(input.query)
  const limit = Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT)
  const rows = ctx.db.all<LearningRow>(
    `SELECT * FROM learning_records r
     WHERE (? = 'all' OR r.state = ?) ${terms.map(() => `AND ${TERM_MATCH}`).join(' ')}
     ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    state,
    state,
    ...terms.flatMap((term) => [term, term, term]),
    limit
  )
  return rows.map((row) => withIntegration(ctx, toLearningView(row)))
}

/** Every active learning, newest first: the candidates context selection filters by role, event and path (DM-936). */
export function activeLearnings(db: Db): LearningView[] {
  return db
    .all<LearningRow>("SELECT * FROM learning_records WHERE state = 'active' ORDER BY created_at DESC, id DESC")
    .map(toLearningView)
}

/** One learning with its whole append-only history, oldest entry first. */
export function getLearning(ctx: Ctx, input: { learningId: string }): LearningDetailView {
  requireCapability(ctx.session, 'read')
  return { learning: withIntegration(ctx, toLearningView(loadRow(ctx.db, input.learningId))), history: historyOf(ctx.db, input.learningId) }
}

/** The active learning at exactly `expectedRevision`, or the failure that says why it cannot change. */
function loadChangeable(ctx: Ctx, input: RetireLearningInput): LearningRow {
  const row = loadRow(ctx.db, input.learningId)
  if (row.revision !== input.expectedRevision) {
    fail('conflict', `Learning ${row.id} changed (now revision ${row.revision}). Reload it and try again.`, {
      learningId: row.id,
      currentRevision: row.revision
    })
  }
  if (row.state !== 'active') {
    fail('invalid_state', `Learning ${row.id} is already retired.`, { learningId: row.id, replacedBy: row.replaced_by_id })
  }
  return row
}

interface HistoryEntry {
  learning: LearningRow
  kind: LearningHistoryEntryView['kind']
  relatedId: string | null
  reason: string
  revision: number
}

export function appendHistory(ctx: Ctx, entry: HistoryEntry): void {
  const { learning } = entry
  ctx.db.run(
    `INSERT INTO learning_events (learning_id, kind, related_id, reason, revision, actor_role, actor_label,
       run_id, sprint_id, card_id, attempt_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    learning.id,
    entry.kind,
    entry.relatedId,
    entry.reason,
    entry.revision,
    ctx.session.role,
    ctx.session.label,
    learning.run_id,
    learning.sprint_id,
    learning.card_id,
    learning.attempt_id,
    ctx.clock.nowIso()
  )
  // DM-935: every publication, retirement and replacement appends history, so each exports the learning's file.
  enqueueOutbox(ctx, { kind: 'learning_record', entityId: learning.id })
}

/** Retires `row` at its current revision; the guarded update makes a concurrent change a `conflict` too. */
export function retireRow(ctx: Ctx, row: LearningRow, reason: string, replacedBy: string | null): void {
  const changed = ctx.db.run(
    `UPDATE learning_records SET state = 'retired', retired_at = ?, retired_reason = ?, replaced_by_id = ?,
       revision = revision + 1
     WHERE id = ? AND revision = ? AND state = 'active'`,
    ctx.clock.nowIso(),
    reason,
    replacedBy,
    row.id,
    row.revision
  ).changes
  if (changed !== 1) {
    fail('conflict', `Learning ${row.id} changed while it was being retired. Reload it and try again.`, { learningId: row.id })
  }
}

function requireManage(ctx: Ctx): void {
  requireCapability(ctx.session, 'learning.manage', 'Only a person at the desktop may retire or replace a learning.')
}

/** Retires an active learning with the person's reason; it stays readable with its history. */
export function retireLearning(ctx: Ctx, input: RetireLearningInput): LearningView {
  requireManage(ctx)
  const scope = { command: 'retireLearning', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const row = loadChangeable(ctx, input)
    retireRow(ctx, row, input.reason, null)
    appendHistory(ctx, { learning: row, kind: 'retired', relatedId: null, reason: input.reason, revision: row.revision + 1 })
    return toLearningView(loadRow(ctx.db, row.id))
  })
}

function sameContent(definition: LearningDraft, replacement: LearningReplacementContent): boolean {
  const { title, rule, check, applicability } = definition
  return canonicalJson({ title, rule, check, applicability }) === canonicalJson(replacement)
}

/** The successor's definition: the new content, the predecessor's evidence, and a link to the predecessor. */
function successorDefinition(predecessor: LearningRow, replacement: LearningReplacementContent): LearningDraft {
  const previous = learningDraftSchema.parse(JSON.parse(predecessor.definition_json))
  if (sameContent(previous, replacement)) {
    fail('invalid_input', `The replacement repeats learning ${predecessor.id} unchanged; retire it instead.`, { learningId: predecessor.id })
  }
  const parsed = learningDraftSchema.safeParse({ ...replacement, evidence: previous.evidence, replaces: predecessor.id })
  if (!parsed.success) {
    fail('invalid_input', `Invalid replacement: ${parsed.error.issues[0]?.message ?? 'malformed content'}`, { learningId: predecessor.id })
  }
  return parsed.data
}

function insertSuccessor(ctx: Ctx, predecessor: LearningRow, definition: LearningDraft): string {
  const id = ctx.ids.next('learningRecord')
  ctx.db.run(
    `INSERT INTO learning_records (id, run_id, sprint_id, card_id, attempt_id, definition_json, definition_hash, state,
       replaces_id, replaced_by_id, created_at, retired_at, retired_reason, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, NULL, NULL, 1)`,
    id,
    predecessor.run_id,
    predecessor.sprint_id,
    predecessor.card_id,
    predecessor.attempt_id,
    JSON.stringify(definition),
    contentHash(definition),
    predecessor.id,
    ctx.clock.nowIso()
  )
  return id
}

/**
 * Replaces an active learning with new content: a new active record that keeps the predecessor's evidence and
 * source and links to it, while the predecessor is retired with the reason and a link to its successor.
 */
export function replaceLearning(ctx: Ctx, input: ReplaceLearningInput): ReplaceLearningResultView {
  requireManage(ctx)
  const scope = { command: 'replaceLearning', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const predecessor = loadChangeable(ctx, input)
    const successorId = insertSuccessor(ctx, predecessor, successorDefinition(predecessor, input.replacement))
    retireRow(ctx, predecessor, input.reason, successorId)
    const successor = loadRow(ctx.db, successorId)
    appendHistory(ctx, { learning: predecessor, kind: 'replaced', relatedId: successorId, reason: input.reason, revision: predecessor.revision + 1 })
    appendHistory(ctx, { learning: successor, kind: 'created_by_replacement', relatedId: predecessor.id, reason: input.reason, revision: 1 })
    return { retired: toLearningView(loadRow(ctx.db, predecessor.id)), replacement: toLearningView(successor) }
  })
}
