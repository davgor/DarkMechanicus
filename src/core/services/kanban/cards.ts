/**
 * Kanban cards: isolated tickets on the folder's board. People, planners and orchestrators add and edit them; a card
 * can be edited only while it is in Backlog and has never been claimed. The board reads slim summaries, with Done
 * paged newest first; the full card (body, criteria and attempts) loads only when it is opened.
 */
import {
  TICKET_PRIORITIES,
  type TicketCriterion,
  type TicketPriority,
  type TicketReference,
  type TicketSize
} from '../../../shared/domain/bundle'
import type { CreateKanbanCardInput, ListKanbanCardsInput, UpdateKanbanCardInput } from '../../../shared/domain/api'
import {
  KANBAN_EDITABLE_FIELDS,
  KANBAN_LANE_LABELS,
  KANBAN_OPEN_ATTEMPT_STATES,
  type KanbanAttemptState,
  type KanbanAttemptView,
  type KanbanBoardView,
  type KanbanCardSummaryView,
  type KanbanCardView,
  type KanbanDoneSummary,
  type KanbanLane
} from '../../../shared/domain/kanban'
import type { AttachmentRef, AttemptEvidence, AttemptOutputs, SessionRole } from '../../../shared/domain/views'
import { requireCapability } from '../../authz'
import type { Ctx } from '../../context'
import { parseJson, toJson } from '../../db/database'
import { fail } from '../../errors'
import { ID_PREFIXES, STABLE_ID_PATTERN } from '../../ids'
import { normalizeCriteria } from '../../plan/normalize'
import { LIMITS } from '../../schemas'
import { nextProjectKey } from '../draftDeps'
import { appendEvent } from '../events'
import { claimAttachments, listAttachmentRefs } from '../attachments'
import { requestWithoutKey, withIdempotency } from '../idempotency'
import { enqueueOutbox } from '../outbox'

/** Done cards one board page shows when the caller names no limit. */
const DEFAULT_DONE_LIMIT = 20

interface CardRow {
  id: string
  key: string
  title: string
  body: string
  acceptance_criteria_json: string
  expected_artifacts_json: string
  references_json: string
  priority: TicketPriority
  size: TicketSize | null
  lane: KanbanLane
  play_requested_at: string | null
  created_by_role: SessionRole
  created_by_label: string
  created_at: string
  updated_at: string
  completed_at: string | null
  summary_json: string | null
  revision: number
}

/** A card row with its open attempt (at most one) and its kick-back count, as the summary needs them. */
export interface SummaryRow extends CardRow {
  open_number: number | null
  open_state: KanbanAttemptState | null
  kick_backs: number
  /** When the card reached Done: its completion time, or its last update for a card without one. */
  done_at: string
}

export interface AttemptRow {
  id: string
  card_id: string
  number: number
  state: KanbanAttemptState
  machine_id: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  progress_note: string | null
  outputs_json: string | null
  evidence_json: string | null
  review_comment: string | null
  created_at: string
  submitted_at: string | null
  decided_at: string | null
}

const OPEN_STATES_SQL = KANBAN_OPEN_ATTEMPT_STATES.map((state) => `'${state}'`).join(', ')

/** Highest priority first: `critical`, `high`, `normal`, then `low`. */
const PRIORITY_ORDER_SQL = `CASE c.priority ${[...TICKET_PRIORITIES]
  .reverse()
  .map((priority, rank) => `WHEN '${priority}' THEN ${rank}`)
  .join(' ')} ELSE ${TICKET_PRIORITIES.length} END`

/** Every card column, its open attempt and its kick-backs (rejected attempts carry the person's comment). */
const SUMMARY_SELECT = `
  SELECT c.*, oa.number AS open_number, oa.state AS open_state,
    (SELECT COUNT(*) FROM kanban_attempts k WHERE k.card_id = c.id AND k.state = 'rejected') AS kick_backs,
    COALESCE(c.completed_at, c.updated_at) AS done_at
  FROM kanban_cards c
  LEFT JOIN kanban_attempts oa ON oa.card_id = c.id AND oa.state IN (${OPEN_STATES_SQL})`

function toSummaryView(row: SummaryRow): KanbanCardSummaryView {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    lane: row.lane,
    priority: row.priority,
    updatedAt: row.updated_at,
    playPending: row.play_requested_at !== null,
    openAttempt: row.open_number === null || row.open_state === null ? null : { number: row.open_number, state: row.open_state },
    kickBackCount: row.kick_backs,
    summary: parseJson<KanbanDoneSummary | null>(row.summary_json, null)
  }
}

export function toAttemptView(row: AttemptRow): KanbanAttemptView {
  return {
    id: row.id,
    cardId: row.card_id,
    number: row.number,
    state: row.state,
    machineId: row.machine_id,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    progressNote: row.progress_note,
    outputs: parseJson<AttemptOutputs | null>(row.outputs_json, null),
    evidence: parseJson<AttemptEvidence | null>(row.evidence_json, null),
    reviewComment: row.review_comment,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at
  }
}

export function loadSummaryRow(ctx: Ctx, cardId: string): SummaryRow {
  const row = ctx.db.get<SummaryRow>(`${SUMMARY_SELECT} WHERE c.id = ?`, cardId)
  if (row === undefined) {
    fail('not_found', `Kanban card ${cardId} does not exist.`, { cardId })
  }
  return row
}

/** The full card: never the claim secret, which no attempt view carries. */
export function cardView(ctx: Ctx, cardId: string): KanbanCardView {
  const row = loadSummaryRow(ctx, cardId)
  const attempts = ctx.db.all<AttemptRow>('SELECT * FROM kanban_attempts WHERE card_id = ? ORDER BY number', cardId)
  const attachments = cardAttachments(ctx, cardId)
  return {
    ...toSummaryView(row),
    body: row.body,
    acceptanceCriteria: parseJson<TicketCriterion[]>(row.acceptance_criteria_json, []),
    expectedArtifacts: parseJson<string[]>(row.expected_artifacts_json, []),
    references: parseJson<TicketReference[]>(row.references_json, []),
    size: row.size,
    createdBy: { role: row.created_by_role, label: row.created_by_label },
    createdAt: row.created_at,
    completedAt: row.completed_at,
    revision: row.revision,
    ...(attachments.length > 0 ? { attachments } : {}),
    attempts: attempts.map(toAttemptView)
  }
}

/** The reference images the card holds; empty when it holds none. */
function cardAttachments(ctx: Ctx, cardId: string): AttachmentRef[] {
  return listAttachmentRefs(ctx.db, { kind: 'kanban_card', id: cardId })
}

/** Refuses a repeated id, and an image staged as evidence: a card carries references. */
function assertReferenceImages(ctx: Ctx, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) {
    fail('invalid_input', 'The same attachment is listed more than once.')
  }
  for (const id of ids) {
    const row = ctx.db.get<{ purpose: string }>('SELECT purpose FROM attachments WHERE id = ?', id)
    if (row?.purpose === 'evidence') {
      fail('invalid_input', `Attachment ${id} was staged as evidence; a card carries reference images.`, { id })
    }
  }
}

/**
 * Makes `ids` the card's reference images: ids it already holds stay, the others are claimed (a foreign or unknown id is
 * refused), and the card's images not listed are deleted. Runs inside the write transaction, before the card's events.
 */
function setCardAttachments(ctx: Ctx, cardId: string, ids: readonly string[]): void {
  assertReferenceImages(ctx, ids)
  const held = cardAttachments(ctx, cardId).map((ref) => ref.id)
  for (const id of held.filter((heldId) => !ids.includes(heldId))) {
    ctx.db.run("DELETE FROM attachments WHERE id = ? AND owner_kind = 'kanban_card' AND owner_id = ?", id, cardId)
    ctx.db.run("DELETE FROM sync_state WHERE kind = 'attachment' AND entity_id = ?", id)
  }
  claimAttachments(
    ctx,
    ids.filter((id) => !held.includes(id)),
    { kind: 'kanban_card', id: cardId }
  )
}

/** A title without its surrounding whitespace; a blank one is refused. */
function cardTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') {
    fail('invalid_input', 'A Kanban card needs a title.')
  }
  return trimmed
}

/**
 * One transition of a card; `attemptId` names the attempt it concerns, if any. `at` is the time the transition wrote
 * into the card and attempt rows (default now), so a card rebuilt from its events gets the very same timestamps.
 */
interface CardEvent {
  kind: string
  payload: Record<string, unknown>
  attemptId?: string
  at?: string
}

/**
 * Records one transition: a `kanban_events` row, the workspace event the desktop refreshes on, and its record exports.
 * Every event is exported as an immutable file of its own; `card.json` holds the definition, so only a create or an
 * edit rewrites it. In `db` mode the finalizer settles both entries without a file.
 */
export function recordCardEvent(ctx: Ctx, card: { id: string; key: string }, event: CardEvent): void {
  const eventId = ctx.ids.next('kanbanEvent')
  const attemptId = event.attemptId ?? null
  ctx.db.run(
    `INSERT INTO kanban_events (id, card_id, kind, attempt_id, actor_role, actor_label, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    card.id,
    event.kind,
    attemptId,
    ctx.session.role,
    ctx.session.label.slice(0, LIMITS.label),
    toJson(event.payload),
    event.at ?? ctx.clock.nowIso()
  )
  if (event.kind === 'created' || event.kind === 'updated') {
    enqueueOutbox(ctx, { kind: 'kanban_card', entityId: card.id })
  }
  enqueueOutbox(ctx, { kind: 'kanban_event', entityId: eventId })
  const payload = { cardId: card.id, key: card.key, ...(attemptId === null ? {} : { attemptId }) }
  appendEvent(ctx, { kind: `kanban.${event.kind}`, payload })
}

function insertCard(ctx: Ctx, input: CreateKanbanCardInput): KanbanCardView {
  const id = ctx.ids.next('kanbanCard')
  // Inside the write transaction, so no concurrent card or plan ticket takes the same key.
  const key = nextProjectKey(ctx)
  const now = ctx.clock.nowIso()
  ctx.db.run(
    `INSERT INTO kanban_cards (id, key, title, body, acceptance_criteria_json, expected_artifacts_json, references_json,
       priority, size, lane, created_by_role, created_by_label, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?, 1)`,
    id,
    key,
    cardTitle(input.title),
    input.body ?? '',
    toJson(normalizeCriteria(input.acceptanceCriteria ?? [], [], 'c')),
    toJson(input.expectedArtifacts ?? []),
    toJson(input.references ?? []),
    input.priority ?? 'normal',
    input.size ?? null,
    ctx.session.role,
    ctx.session.label.slice(0, LIMITS.label),
    now,
    now
  )
  setCardAttachments(ctx, id, input.attachments ?? [])
  recordCardEvent(ctx, { id, key }, { kind: 'created', payload: { revision: 1 }, at: now })
  return cardView(ctx, id)
}

/** Adds a card to Backlog with the next key of the project's ticket sequence, authored by the calling session. */
export function createKanbanCard(ctx: Ctx, input: CreateKanbanCardInput): KanbanCardView {
  requireCapability(ctx.session, 'kanban.write')
  ctx.assertBranch()
  const scope = { command: 'createKanbanCard', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => insertCard(ctx, input))
}

function assertEditable(ctx: Ctx, row: SummaryRow): void {
  if (row.lane !== 'backlog') {
    fail('invalid_state', `${row.key} is in ${KANBAN_LANE_LABELS[row.lane]}; only a card in Backlog can be edited.`, {
      cardId: row.id,
      lane: row.lane
    })
  }
  const attempts = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM kanban_attempts WHERE card_id = ?', row.id)?.n ?? 0
  if (attempts > 0) {
    fail('invalid_state', `${row.key} has been claimed, so it can no longer be edited.`, { cardId: row.id, attempts })
  }
}

function applyCardUpdate(ctx: Ctx, input: UpdateKanbanCardInput): KanbanCardView {
  const row = loadSummaryRow(ctx, input.cardId)
  assertEditable(ctx, row)
  if (row.revision !== input.expectedRevision) {
    fail(
      'conflict',
      `${row.key} is at revision ${row.revision}, not ${input.expectedRevision}. Reload the card and edit it again.`,
      { cardId: row.id, currentRevision: row.revision }
    )
  }
  const existingCriteria = parseJson<TicketCriterion[]>(row.acceptance_criteria_json, [])
  const revision = row.revision + 1
  const now = ctx.clock.nowIso()
  ctx.db.run(
    `UPDATE kanban_cards SET title = ?, body = ?, acceptance_criteria_json = ?, expected_artifacts_json = ?,
       references_json = ?, priority = ?, size = ?, updated_at = ?, revision = ?
     WHERE id = ?`,
    input.title === undefined ? row.title : cardTitle(input.title),
    input.body ?? row.body,
    input.acceptanceCriteria === undefined
      ? row.acceptance_criteria_json
      : toJson(normalizeCriteria(input.acceptanceCriteria, existingCriteria, 'c')),
    input.expectedArtifacts === undefined ? row.expected_artifacts_json : toJson(input.expectedArtifacts),
    input.references === undefined ? row.references_json : toJson(input.references),
    input.priority ?? row.priority,
    input.size === undefined ? row.size : input.size,
    now,
    revision,
    row.id
  )
  if (input.attachments !== undefined) {
    setCardAttachments(ctx, row.id, input.attachments)
  }
  const fields = KANBAN_EDITABLE_FIELDS.filter((field) => input[field] !== undefined)
  recordCardEvent(ctx, row, { kind: 'updated', payload: { revision, fields }, at: now })
  return cardView(ctx, row.id)
}

/** Edits a card in Backlog that has never been claimed, at the revision the caller last read. */
export function updateKanbanCard(ctx: Ctx, input: UpdateKanbanCardInput): KanbanCardView {
  requireCapability(ctx.session, 'kanban.write')
  ctx.assertBranch()
  const scope = { command: 'updateKanbanCard', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => applyCardUpdate(ctx, input))
}

const CURSOR_REFUSAL = 'doneCursor is not a cursor listKanbanCards returned. Omit it to start from the newest Done card.'

function decodeDoneCursor(cursor: string): { doneAt: string; id: string } {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    fail('invalid_input', CURSOR_REFUSAL)
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    fail('invalid_input', CURSOR_REFUSAL)
  }
  const [doneAt, id]: unknown[] = decoded
  const validTime = typeof doneAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(doneAt) && !Number.isNaN(Date.parse(doneAt))
  const validId = typeof id === 'string' && STABLE_ID_PATTERN.test(id) && id.startsWith(`${ID_PREFIXES.kanbanCard}_`)
  if (!validTime || !validId) {
    fail('invalid_input', CURSOR_REFUSAL)
  }
  return { doneAt, id }
}

/** One page of Done, newest first, and the cursor of the next page (null on the last one). */
function donePage(ctx: Ctx, input: ListKanbanCardsInput): { cards: KanbanCardSummaryView[]; nextCursor: string | null } {
  const after = input.doneCursor === undefined ? null : decodeDoneCursor(input.doneCursor)
  const afterAt = after === null ? null : after.doneAt
  const afterId = after === null ? null : after.id
  const limit = input.doneLimit ?? DEFAULT_DONE_LIMIT
  // One row past the page tells whether another page follows.
  const rows = ctx.db.all<SummaryRow>(
    `SELECT * FROM (${SUMMARY_SELECT} WHERE c.lane = 'done')
     WHERE ? IS NULL OR done_at < ? OR (done_at = ? AND id < ?)
     ORDER BY done_at DESC, id DESC
     LIMIT ?`,
    afterAt,
    afterAt,
    afterAt,
    afterId,
    limit + 1
  )
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    cards: page.map(toSummaryView),
    // Where this page ends, the last card's completion time and id, opaque to the caller.
    nextCursor:
      rows.length > limit && last !== undefined ? Buffer.from(JSON.stringify([last.done_at, last.id])).toString('base64url') : null
  }
}

/**
 * The board: each open lane whole, ordered by priority and then age, and one page of Done, newest first. Summaries
 * never carry a body, criteria or evidence.
 */
export function listKanbanCards(ctx: Ctx, input: ListKanbanCardsInput): KanbanBoardView {
  requireCapability(ctx.session, 'read')
  const done = donePage(ctx, input)
  const lanes: Record<KanbanLane, KanbanCardSummaryView[]> = { backlog: [], in_progress: [], ready_for_review: [], done: done.cards }
  const open = ctx.db.all<SummaryRow>(
    `${SUMMARY_SELECT} WHERE c.lane <> 'done' ORDER BY ${PRIORITY_ORDER_SQL}, c.created_at, c.id`
  )
  for (const row of open) {
    lanes[row.lane].push(toSummaryView(row))
  }
  const doneTotal = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kanban_cards WHERE lane = 'done'")?.n ?? 0
  return { lanes, doneTotal, doneNextCursor: done.nextCursor }
}

/** The full card, with its body, criteria and every attempt oldest first. */
export function getKanbanCard(ctx: Ctx, input: { cardId: string }): KanbanCardView {
  requireCapability(ctx.session, 'read')
  return cardView(ctx, input.cardId)
}
