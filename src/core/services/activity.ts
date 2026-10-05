/**
 * Activity timelines: read models that merge what Dark Mechanicus knows about an attempt, or about a run,
 * into one time-ordered list. Both read the event log (which orders and paces them) and the attempt as it
 * stands now (for the facts an event does not carry); neither writes anything except that, like `getRun`,
 * they first expire overdue leases so `isLive` and the lease entries are current.
 *
 * Cursor: `cursor` is an event `seq`. A page holds the entries whose event came after `sinceSeq`. The one
 * thing that grows without an event is the attempt's alive span (a plain heartbeat writes no event), so the
 * span is sent again, by id, while the attempt holds a lease and whenever the page carries anything else.
 */
import type {
  ActivityEntry,
  ActivitySession,
  AttemptTimelineView,
  RunActivityGroup,
  RunTimelineView,
  TimelineWindow
} from '../../shared/domain/activity'
import { isActiveRunState, isLeasedAttemptState, isOpenAttemptState } from '../../shared/domain/status'
import type { AttemptView, CommentView, EventView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { maskClaimTokensDeep } from '../claimTokenMask'
import type { Ctx } from '../context'
import { type Draft, ATTEMPT_ONLY_BODIES, entryOf, LIFECYCLE_BODIES, RUN_BODIES, text, texts } from './activityEntries'
import { type EventRow, latestSeq, MAX_EVENT_PAGE, toEventView } from './events'
import { type AttemptRow, attemptView, expireLeases, loadAttempt, requireRun } from './execution'

const DEFAULT_PAGE = 200
const UNKNOWN_SESSION = 'Unknown session'

interface Window {
  since: number
  limit: number
  horizon: number
}

function windowOf(ctx: Ctx, input: TimelineWindow): Window {
  return {
    since: Math.max(0, Math.floor(input.sinceSeq ?? 0)),
    limit: Math.min(MAX_EVENT_PAGE, Math.max(1, Math.floor(input.limit ?? DEFAULT_PAGE))),
    horizon: latestSeq(ctx, 0)
  }
}

interface Slice {
  taken: Draft[]
  cursor: number
}

/** The first `limit` drafts after the cursor; the new cursor is the last one taken, or the log head when nothing is left. */
function sliceOf(drafts: Draft[], window: Window): Slice {
  const fresh = drafts.filter((draft) => draft.seq > window.since).sort((a, b) => a.seq - b.seq)
  const taken = fresh.slice(0, window.limit)
  const last = taken[taken.length - 1]
  const truncated = fresh.length > window.limit && last !== undefined
  return { taken, cursor: truncated ? last.seq : Math.max(window.since, window.horizon) }
}

function sessionOf(ctx: Ctx, id: string | null): ActivitySession {
  const row = id === null ? undefined : ctx.db.get<{ role: ActivitySession['role']; label: string }>('SELECT role, label FROM sessions WHERE id = ?', id)
  return { id, role: row?.role ?? null, label: row?.label ?? UNKNOWN_SESSION }
}

function payloadAttemptId(event: EventView): string | null {
  return text(event.payload.attemptId)
}

// ---- attempt timeline

function attemptEvents(ctx: Ctx, attempt: AttemptView, horizon: number): EventView[] {
  const rows = ctx.db.all<EventRow>(
    `SELECT * FROM events
     WHERE run_id = ? AND seq <= ?
       AND (json_extract(payload_json, '$.attemptId') = ? OR kind IN ('run.canceled', 'run.failed', 'run.taken_over'))
     ORDER BY seq`,
    attempt.runId,
    horizon,
    attempt.id
  )
  return rows.map(toEventView).filter((event) => concerns(event, attempt.id))
}

/** The attempt's own events, and the run events that name it (a run ended or taken over only touches the attempts it lists). */
function concerns(event: EventView, attemptId: string): boolean {
  const named = [payloadAttemptId(event), ...texts(event.payload.canceledAttempts), ...texts(event.payload.expiredAttempts)]
  return named.includes(attemptId)
}

function eventDrafts(events: EventView[], attempt: AttemptView): Draft[] {
  const drafts: Draft[] = []
  for (const event of events) {
    const build = ATTEMPT_ONLY_BODIES[event.kind] ?? LIFECYCLE_BODIES[event.kind]
    const body = build?.(event, attempt) ?? null
    if (body !== null) {
      drafts.push({ seq: event.seq, entry: entryOf(event, body) })
    }
  }
  return drafts
}

/** An attempt that no longer occupies its ticket and needs nothing more from the orchestrator. */
function isClosed(attempt: AttemptView): boolean {
  if (isOpenAttemptState(attempt.state)) {
    return false
  }
  return attempt.state !== 'lease_expired' || attempt.reconciledAt !== null
}

interface CommentEventRow extends EventRow {
  comment_id: string
}

function commentEntry(ctx: Ctx, row: CommentEventRow): Draft | null {
  const comment = ctx.db.get<{ id: string; ticket_id: string | null; body: string; author_role: CommentView['author']['role']; author_label: string }>(
    'SELECT id, ticket_id, body, author_role, author_label FROM comments WHERE id = ?',
    row.comment_id
  )
  if (comment === undefined) {
    return null
  }
  const body = {
    kind: 'comment',
    ticketId: comment.ticket_id,
    commentId: comment.id,
    body: comment.body,
    author: { role: comment.author_role, label: comment.author_label }
  } as const
  return { seq: row.seq, entry: entryOf(toEventView(row), body) }
}

/** Comments on the attempt's ticket logged after its first event and, once it is closed, before its last. */
function commentDrafts(ctx: Ctx, attempt: AttemptView, events: EventView[], horizon: number): Draft[] {
  const first = events[0]?.seq ?? 0
  const closedAt = isClosed(attempt) ? (events[events.length - 1]?.seq ?? horizon) : horizon + 1
  const epic = requireRun(ctx, attempt.runId).epic_id
  const rows = ctx.db.all<CommentEventRow>(
    `SELECT *, json_extract(payload_json, '$.commentId') AS comment_id FROM events
     WHERE kind = 'comment.added' AND epic_id = ? AND ticket_id = ? AND seq > ? AND seq < ?
     ORDER BY seq`,
    epic,
    attempt.ticketId,
    first,
    closedAt
  )
  return rows.map((row) => commentEntry(ctx, row)).filter((draft): draft is Draft => draft !== null)
}

/** First heartbeat to latest, as one entry. Its place in the order is that of the event that recorded the first heartbeat. */
function aliveDraft(events: EventView[], attempt: AttemptView): Draft | null {
  const first = events.find((event) => event.kind === 'attempt.running')
  if (first === undefined) {
    return null
  }
  const entry: ActivityEntry = {
    kind: 'alive',
    id: `alive:${attempt.id}`,
    at: first.at,
    sessionId: first.sessionId,
    attemptId: attempt.id,
    ticketId: attempt.ticketId,
    until: attempt.heartbeatAt ?? first.at,
    leaseExpiresAt: attempt.leaseExpiresAt,
    active: isLeasedAttemptState(attempt.state)
  }
  return { seq: first.seq, entry }
}

/** The span is due when it is new, when it can still grow, or when this page shows anything else (the attempt may have just closed). */
function spanDue(span: Draft, slice: Slice, window: Window, attempt: AttemptView): boolean {
  return span.seq > window.since || isLeasedAttemptState(attempt.state) || slice.taken.length > 0
}

function sessionsOf(ctx: Ctx, entries: ActivityEntry[]): ActivitySession[] {
  const ids = [...new Set(entries.map((entry) => entry.sessionId))]
  return ids.map((id) => sessionOf(ctx, id))
}

function buildAttemptTimeline(ctx: Ctx, attempt: AttemptView, window: Window): AttemptTimelineView {
  const events = attemptEvents(ctx, attempt, window.horizon)
  const slice = sliceOf([...eventDrafts(events, attempt), ...commentDrafts(ctx, attempt, events, window.horizon)], window)
  const span = aliveDraft(events, attempt)
  const drafts = span !== null && spanDue(span, slice, window, attempt) ? [...slice.taken, span] : slice.taken
  const entries = drafts.sort((a, b) => a.seq - b.seq).map((draft) => draft.entry)
  return {
    attemptId: attempt.id,
    runId: attempt.runId,
    ticketId: attempt.ticketId,
    state: attempt.state,
    isLive: isOpenAttemptState(attempt.state),
    cursor: slice.cursor,
    entries,
    sessions: sessionsOf(ctx, entries)
  }
}

/** One attempt's story: claim, alive span, notes, comments, submission, decision, failure, expiry and reconciliation. */
export function getAttemptTimeline(ctx: Ctx, input: { attemptId: string } & TimelineWindow): AttemptTimelineView {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => {
    expireLeases(ctx, loadAttempt(ctx, input.attemptId).run_id)
    const attempt = attemptView(loadAttempt(ctx, input.attemptId))
    return maskClaimTokensDeep(buildAttemptTimeline(ctx, attempt, windowOf(ctx, input)))
  })
}

// ---- run timeline

const RUN_EVENT_KINDS = [...Object.keys(RUN_BODIES), ...Object.keys(LIFECYCLE_BODIES)]

interface RunPage {
  events: EventView[]
  cursor: number
}

/** The run's listed events after the cursor, at most `limit`; when more remain, the cursor stops at the last one returned. */
function runPage(ctx: Ctx, runId: string, window: Window): RunPage {
  const marks = RUN_EVENT_KINDS.map(() => '?').join(', ')
  const rows = ctx.db.all<EventRow>(
    `SELECT * FROM events WHERE run_id = ? AND seq > ? AND seq <= ? AND kind IN (${marks}) ORDER BY seq LIMIT ?`,
    runId,
    window.since,
    window.horizon,
    ...RUN_EVENT_KINDS,
    window.limit + 1
  )
  const events = rows.slice(0, window.limit).map(toEventView)
  const last = events[events.length - 1]
  const truncated = rows.length > window.limit && last !== undefined
  return { events, cursor: truncated ? last.seq : Math.max(window.since, window.horizon) }
}

function attemptsOf(ctx: Ctx, runId: string): Map<string, AttemptView> {
  const rows = ctx.db.all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ?', runId)
  return new Map(rows.map((row) => [row.id, attemptView(row)]))
}

function runEntry(event: EventView, attempts: Map<string, AttemptView>): ActivityEntry | null {
  const attempt = attempts.get(payloadAttemptId(event) ?? '')
  const lifecycle = attempt === undefined ? undefined : LIFECYCLE_BODIES[event.kind]
  const body = RUN_BODIES[event.kind]?.(event) ?? (attempt === undefined ? null : (lifecycle?.(event, attempt) ?? null))
  return body === null ? null : entryOf(event, body)
}

/** Groups entries by session in the order the sessions first acted; each group keeps its entries in order. */
function groupBySession(ctx: Ctx, entries: ActivityEntry[]): RunActivityGroup[] {
  const groups = new Map<string | null, RunActivityGroup>()
  for (const entry of entries) {
    const group = groups.get(entry.sessionId) ?? { session: sessionOf(ctx, entry.sessionId), entries: [] }
    group.entries.push(entry)
    groups.set(entry.sessionId, group)
  }
  return [...groups.values()]
}

function buildRunTimeline(ctx: Ctx, runId: string, window: Window): RunTimelineView {
  const run = requireRun(ctx, runId)
  const attempts = attemptsOf(ctx, runId)
  const page = runPage(ctx, runId, window)
  const entries = page.events.map((event) => runEntry(event, attempts)).filter((entry): entry is ActivityEntry => entry !== null)
  return {
    runId: run.id,
    epicId: run.epic_id,
    state: run.state,
    isLive: isActiveRunState(run.state),
    cursor: page.cursor,
    groups: groupBySession(ctx, entries)
  }
}

/** The run's story for the orchestrator's view: starts, claims, reviews, pauses, reports and checkpoints, by session. */
export function getRunTimeline(ctx: Ctx, input: { runId: string } & TimelineWindow): RunTimelineView {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => {
    requireRun(ctx, input.runId)
    expireLeases(ctx, input.runId)
    return maskClaimTokensDeep(buildRunTimeline(ctx, input.runId, windowOf(ctx, input)))
  })
}
