/**
 * Comments: append-only Markdown notes on an epic or one of its tickets, written by people (desktop)
 * and agents (MCP). The author is always the calling session. There is no edit or delete.
 */
import type { AddCommentInput } from '../../shared/domain/api'
import type { CommentView, SessionRole } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { LIMITS } from '../schemas'
import { assertEpicOpen, type EpicRow, loadEpicRow } from './epics'
import { appendEvent } from './events'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'
import { indexComment } from './searchIndex'

interface CommentRow {
  id: string
  epic_id: string
  ticket_id: string | null
  body: string
  author_role: SessionRole
  author_label: string
  created_at: string
}

function toCommentView(row: CommentRow): CommentView {
  return {
    id: row.id,
    epicId: row.epic_id,
    ticketId: row.ticket_id,
    body: row.body,
    author: { role: row.author_role, label: row.author_label },
    createdAt: row.created_at
  }
}

/** A ticket belongs to the epic when its current saved plan or its draft contains it. */
function assertTicketOfEpic(ctx: Ctx, epic: EpicRow, ticketId: string): void {
  const found = ctx.db.get<{ found: number }>(
    `SELECT 1 AS found
     FROM (SELECT bundle_json FROM plan_revisions WHERE id = ?
           UNION ALL SELECT bundle_json FROM drafts WHERE epic_id = ?) plan,
       json_each(plan.bundle_json, '$.tickets') ticket
     WHERE json_extract(ticket.value, '$.id') = ?
     LIMIT 1`,
    epic.current_revision_id,
    epic.id,
    ticketId
  )
  if (found === undefined) {
    fail('not_found', `Ticket ${ticketId} is not in the saved plan or draft of epic ${epic.id}.`, {
      epicId: epic.id,
      ticketId
    })
  }
}

/** Exports stay importable: an epic never holds more comments than a reconcile reads back. */
function assertRoomForComment(ctx: Ctx, epicId: string): void {
  const count = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE epic_id = ?', epicId)?.n ?? 0
  if (count >= LIMITS.commentsPerEpic) {
    fail(
      'capacity_exceeded',
      `Epic ${epicId} already holds ${LIMITS.commentsPerEpic} comments, the most one epic can keep.`,
      { epicId, limit: LIMITS.commentsPerEpic }
    )
  }
}

function insertComment(ctx: Ctx, input: AddCommentInput): CommentView {
  const epic = loadEpicRow(ctx, input.epicId)
  assertEpicOpen(epic)
  if (input.ticketId !== undefined) {
    assertTicketOfEpic(ctx, epic, input.ticketId)
  }
  assertRoomForComment(ctx, epic.id)
  const row: CommentRow = {
    id: ctx.ids.next('comment'),
    epic_id: epic.id,
    ticket_id: input.ticketId ?? null,
    body: input.body,
    author_role: ctx.session.role,
    author_label: ctx.session.label.slice(0, LIMITS.label),
    created_at: ctx.clock.nowIso()
  }
  ctx.db.run(
    `INSERT INTO comments (id, epic_id, ticket_id, body, author_role, author_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.epic_id,
    row.ticket_id,
    row.body,
    row.author_role,
    row.author_label,
    row.created_at
  )
  const comment = toCommentView(row)
  appendEvent(ctx, {
    kind: 'comment.added',
    epicId: epic.id,
    ticketId: comment.ticketId,
    payload: { commentId: comment.id, author: comment.author }
  })
  indexComment(ctx.db, comment)
  // Like the epic itself, comments of a never-saved epic stay local; its first save exports them.
  if (epic.current_revision_id !== null) {
    enqueueOutbox(ctx, { kind: 'comment', epicId: epic.id, entityId: comment.id })
  }
  return comment
}

/** Adds a comment to an open epic or one of its tickets, authored by the calling session. */
export function addComment(ctx: Ctx, input: AddCommentInput): CommentView {
  requireCapability(ctx.session, 'comment.write')
  ctx.assertBranch()
  const scope = { command: 'addComment', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => insertComment(ctx, input))
}

/** The epic's comments oldest first; with `ticketId`, only that ticket's. */
export function listComments(ctx: Ctx, input: { epicId: string; ticketId?: string }): CommentView[] {
  requireCapability(ctx.session, 'read')
  const epic = loadEpicRow(ctx, input.epicId)
  const ticketId = input.ticketId ?? null
  const rows = ctx.db.all<CommentRow>(
    `SELECT * FROM comments WHERE epic_id = ? AND (? IS NULL OR ticket_id = ?) ORDER BY created_at, id`,
    epic.id,
    ticketId,
    ticketId
  )
  return rows.map(toCommentView)
}

/**
 * Queues the export of the epic's comments that have no export or import record and no queued
 * entry: those written before its first save (the finalizer calls this once a save completes).
 */
export function enqueueUnexportedComments(ctx: Ctx, epicId: string): void {
  const rows = ctx.db.all<{ id: string }>(
    `SELECT c.id FROM comments c
     WHERE c.epic_id = ?
       AND NOT EXISTS (SELECT 1 FROM sync_state s WHERE s.kind = 'comment' AND s.entity_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.kind = 'comment' AND o.entity_id = c.id
                         AND o.state IN ('pending', 'failed'))
     ORDER BY c.created_at, c.id`,
    epicId
  )
  for (const row of rows) {
    enqueueOutbox(ctx, { kind: 'comment', epicId, entityId: row.id })
  }
}
