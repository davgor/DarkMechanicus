import type { EventView, EventsPage } from '../../shared/domain/views'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'

export interface NewEvent {
  kind: string
  epicId?: string | null
  runId?: string | null
  ticketId?: string | null
  payload?: Record<string, unknown>
}

interface EventRow {
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

function toEventView(row: EventRow): EventView {
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

function latestSeq(ctx: Ctx, fallback: number): number {
  const row = ctx.db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM events')
  return Math.max(fallback, row?.seq ?? 0)
}
