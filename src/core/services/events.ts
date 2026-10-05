import type { EventView, EventsPage } from '../../shared/domain/views'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'

interface NewEvent {
  kind: string
  epicId?: string | null
  runId?: string | null
  ticketId?: string | null
  payload?: Record<string, unknown>
}

export interface EventRow {
  seq: number
  at: string
  kind: string
  epic_id: string | null
  run_id: string | null
  ticket_id: string | null
  session_id: string | null
  payload_json: string
}

/** Appends to the append-only audit/event log; call inside the mutation's transaction. */
export function appendEvent(ctx: Ctx, event: NewEvent): number {
  const result = ctx.db.run(
    `INSERT INTO events (at, kind, epic_id, run_id, ticket_id, session_id, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ctx.clock.nowIso(),
    event.kind,
    event.epicId ?? null,
    event.runId ?? null,
    event.ticketId ?? null,
    ctx.session.id,
    toJson(event.payload ?? {})
  )
  return result.lastInsertRowid
}

const PROGRESS_EVENT_KIND = 'attempt.progress'
/** Progress notes kept per attempt; the oldest go first. */
const MAX_PROGRESS_NOTES = 200

interface ProgressNote {
  attemptId: string
  epicId: string
  runId: string
  ticketId: string
  note: string
  step?: string
}

/**
 * Records a worker's progress note as an event of its attempt (the event carries the sending session and the
 * time) and drops the attempt's notes beyond the last `MAX_PROGRESS_NOTES`. Notes are local working data: they
 * queue no outbox work, and no portable record reads the events table. The caller masks the text first. Call
 * inside the mutation's transaction.
 */
export function appendProgressNote(ctx: Ctx, progress: ProgressNote): void {
  const { attemptId, epicId, runId, ticketId, note, step } = progress
  appendEvent(ctx, { kind: PROGRESS_EVENT_KIND, epicId, runId, ticketId, payload: { attemptId, note, step: step ?? null } })
  ctx.db.run(
    `DELETE FROM events WHERE seq IN (
       SELECT seq FROM events
       WHERE kind = ? AND run_id = ? AND json_extract(payload_json, '$.attemptId') = ?
       ORDER BY seq DESC LIMIT -1 OFFSET ?)`,
    PROGRESS_EVENT_KIND,
    runId,
    attemptId,
    MAX_PROGRESS_NOTES
  )
}

export function toEventView(row: EventRow): EventView {
  return {
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    epicId: row.epic_id,
    runId: row.run_id,
    ticketId: row.ticket_id,
    sessionId: row.session_id,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {})
  }
}

export const MAX_EVENT_PAGE = 500

export function listEvents(
  ctx: Ctx,
  input: { sinceSeq?: number; limit?: number; epicId?: string; runId?: string }
): EventsPage {
  const since = Math.max(0, Math.floor(input.sinceSeq ?? 0))
  const limit = Math.min(MAX_EVENT_PAGE, Math.max(1, Math.floor(input.limit ?? 200)))
  // Read the high-water mark before the page: an event another process commits in between is
  // either in the page or newer than the cursor, so a polling client can never skip it.
  const horizon = latestSeq(ctx, since)
  const rows = ctx.db.all<EventRow>(
    `SELECT * FROM events
     WHERE seq > ? AND (? IS NULL OR epic_id = ?) AND (? IS NULL OR run_id = ?)
     ORDER BY seq ASC LIMIT ?`,
    since,
    input.epicId ?? null,
    input.epicId ?? null,
    input.runId ?? null,
    input.runId ?? null,
    limit
  )
  const events = rows.map(toEventView)
  const last = events[events.length - 1]
  return { events, cursor: last ? last.seq : horizon }
}

export function latestSeq(ctx: Ctx, fallback: number): number {
  const row = ctx.db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events')
  return Math.max(fallback, row?.seq ?? 0)
}
