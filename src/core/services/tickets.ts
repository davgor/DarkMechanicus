import type { PlanBundle, RelationKind, TicketContent } from '../../shared/domain/bundle'
import type { WorkStatus } from '../../shared/domain/status'
import type { TicketDetailView, TicketLinkView, TicketSummaryView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { type BundleIndex, dependentsOf, indexBundle, prerequisitesOf, sortedSprints } from '../plan/graph'
import { activeRun, applyEpicStatus, assertEpicOpen, type EpicRow, loadEpicRow } from './epics'
import { appendEvent } from './events'
import { enqueueOutbox } from './outbox'
import { readPlanBundle } from './plans'

type PlanViewKind = 'saved' | 'draft'

interface TicketStatusRow {
  ticket_id: string
  epic_id: string
  status: WorkStatus
  revision: number
}

/** How an incoming relation reads from the target ticket's side. */
const INCOMING_RELATION: Record<RelationKind, string> = {
  related_to: 'related_to',
  duplicate_of: 'duplicated_by'
}

function statusesOf(ctx: Ctx, epicId: string): Map<string, WorkStatus> {
  const rows = ctx.db.all<{ ticket_id: string; status: WorkStatus }>(
    'SELECT ticket_id, status FROM ticket_status WHERE epic_id = ?',
    epicId
  )
  return new Map(rows.map((row) => [row.ticket_id, row.status]))
}

function summarize(ticket: TicketContent, index: BundleIndex, status: WorkStatus | null): TicketSummaryView {
  const sprint = index.sprintOf.get(ticket.id)
  return {
    id: ticket.id,
    key: ticket.key,
    title: ticket.title,
    status,
    sprintId: sprint?.id ?? null,
    sprintOrdinal: sprint?.ordinal ?? null,
    priority: ticket.priority,
    ...(ticket.kind === undefined ? {} : { kind: ticket.kind }),
    ...(ticket.size === undefined ? {} : { size: ticket.size }),
    ...(ticket.capability.reasoning.effort === undefined ? {} : { effort: ticket.capability.reasoning.effort }),
    tags: ticket.tags,
    optional: ticket.optional
  }
}

/** Sprint order, then position within the sprint; tickets outside every sprint come last. */
function orderedTickets(bundle: PlanBundle, index: BundleIndex): TicketContent[] {
  const ids = new Set([
    ...sortedSprints(bundle).flatMap((sprint) => sprint.ticketIds),
    ...bundle.tickets.map((ticket) => ticket.id)
  ])
  return [...ids]
    .map((id) => index.tickets.get(id))
    .filter((ticket): ticket is TicketContent => ticket !== undefined)
}

export function listTickets(ctx: Ctx, input: { epicId: string; view: PlanViewKind }): TicketSummaryView[] {
  requireCapability(ctx.session, 'read')
  const epic = loadEpicRow(ctx, input.epicId)
  const { bundle } = readPlanBundle(ctx, epic, input.view)
  const statuses = statusesOf(ctx, epic.id)
  const index = indexBundle(bundle)
  return orderedTickets(bundle, index).map((ticket) => summarize(ticket, index, statuses.get(ticket.id) ?? null))
}

function linkTo(index: BundleIndex, statuses: Map<string, WorkStatus>, ticketId: string): TicketLinkView {
  const ticket = index.tickets.get(ticketId)
  return {
    ticketId,
    key: ticket?.key ?? ticketId,
    title: ticket?.title ?? '',
    status: statuses.get(ticketId) ?? null,
    executionState: null
  }
}

function relationsOf(bundle: PlanBundle, ticketId: string): { kind: string; other: string }[] {
  const outgoing = bundle.relations
    .filter((relation) => relation.from === ticketId)
    .map((relation) => ({ kind: relation.kind as string, other: relation.to }))
  const incoming = bundle.relations
    .filter((relation) => relation.to === ticketId)
    .map((relation) => ({ kind: INCOMING_RELATION[relation.kind], other: relation.from }))
  return [...outgoing, ...incoming]
}

function readOnlyReason(ctx: Ctx, epic: EpicRow, revisionId: string | null): string | null {
  if (epic.status === 'completed') {
    return 'Completed epics are read-only.'
  }
  if (revisionId === null) {
    return null
  }
  const run = activeRun(ctx, epic.id)
  return run?.revision_id === revisionId
    ? `Read-only while run #${run.number} is active. Changes go to a draft.`
    : 'Saved revisions are immutable. Edit a draft.'
}

/** One ticket of the saved or draft plan, by id or key. Execution details are added by the caller. */
export function getTicket(
  ctx: Ctx,
  input: { epicId: string; ticketId: string; view: PlanViewKind }
): TicketDetailView {
  requireCapability(ctx.session, 'read')
  const epic = loadEpicRow(ctx, input.epicId)
  const { bundle, revisionId } = readPlanBundle(ctx, epic, input.view)
  const ticket =
    bundle.tickets.find((item) => item.id === input.ticketId || item.key === input.ticketId) ??
    fail('not_found', `Ticket ${input.ticketId} is not in the ${input.view} plan.`, { ticketId: input.ticketId })
  const statuses = statusesOf(ctx, epic.id)
  const index = indexBundle(bundle)
  const link = (ticketId: string): TicketLinkView => linkTo(index, statuses, ticketId)
  const summary = summarize(ticket, index, statuses.get(ticket.id) ?? null)
  const reason = readOnlyReason(ctx, epic, revisionId)
  return {
    epicId: epic.id,
    view: input.view,
    ticket,
    status: summary.status,
    sprintId: summary.sprintId,
    sprintOrdinal: summary.sprintOrdinal,
    prerequisites: prerequisitesOf(bundle, ticket.id).map(link),
    dependents: dependentsOf(bundle, ticket.id).map(link),
    relations: relationsOf(bundle, ticket.id).map(({ kind, other }) => ({ kind, ticket: link(other) })),
    execution: null,
    attempts: [],
    readOnly: reason !== null,
    readOnlyReason: reason
  }
}

/** The ticket as the newest saved revision of its epic that contains it describes it. */
function savedTicket(ctx: Ctx, row: TicketStatusRow): { ticket: TicketContent; index: BundleIndex } {
  const revision = ctx.db.get<{ bundle_json: string }>(
    `SELECT p.bundle_json FROM plan_revisions p, json_each(p.bundle_json, '$.tickets') t
     WHERE p.epic_id = ? AND p.state = 'saved' AND json_extract(t.value, '$.id') = ?
     ORDER BY p.number DESC LIMIT 1`,
    row.epic_id,
    row.ticket_id
  )
  const bundle = revision ? (JSON.parse(revision.bundle_json) as PlanBundle) : null
  const ticket = bundle?.tickets.find((item) => item.id === row.ticket_id)
  if (!bundle || !ticket) {
    return fail('not_found', `Ticket ${row.ticket_id} is not in a saved plan.`, { ticketId: row.ticket_id })
  }
  return { ticket, index: indexBundle(bundle) }
}

function assertTicketRevision(row: TicketStatusRow, expected: number | undefined): void {
  if (expected !== undefined && expected !== row.revision) {
    fail('conflict', `The ticket changed (now revision ${row.revision}). Reload and try again.`, {
      currentRevision: row.revision
    })
  }
}

function hasAcceptedAttempt(ctx: Ctx, row: TicketStatusRow): boolean {
  const found = ctx.db.get<{ id: string }>(
    `SELECT a.id FROM attempts a JOIN runs r ON r.id = a.run_id
     WHERE a.ticket_id = ? AND r.epic_id = ? AND a.state = 'accepted' AND a.superseded_at IS NULL
     LIMIT 1`,
    row.ticket_id,
    row.epic_id
  )
  return found !== undefined
}

function assertNoOpenAttempt(ctx: Ctx, row: TicketStatusRow): void {
  const open = ctx.db.get<{ id: string; state: string }>(
    "SELECT id, state FROM attempts WHERE ticket_id = ? AND state IN ('claimed','running','submitted') LIMIT 1",
    row.ticket_id
  )
  if (open) {
    fail(
      'conflict',
      `The ticket has an open attempt (${open.state}). Let it finish before moving the ticket back to backlog.`,
      { attemptId: open.id }
    )
  }
}

function assertTicketTransition(ctx: Ctx, row: TicketStatusRow, status: WorkStatus): void {
  if (row.status === 'completed') {
    fail('unauthorized_transition', 'Completed tickets stay completed; their acceptance evidence is final.')
  }
  if (status === 'completed' && !hasAcceptedAttempt(ctx, row)) {
    fail('unauthorized_transition', 'Tickets complete through accept_attempt so acceptance evidence exists.')
  }
  if (status === 'backlog') {
    assertNoOpenAttempt(ctx, row)
  }
}

function applyTicketStatus(ctx: Ctx, row: TicketStatusRow, change: { epic: EpicRow; status: WorkStatus }): void {
  ctx.db.run(
    'UPDATE ticket_status SET status = ?, revision = revision + 1, updated_at = ? WHERE ticket_id = ?',
    change.status,
    ctx.clock.nowIso(),
    row.ticket_id
  )
  appendEvent(ctx, {
    kind: 'ticket.status_changed',
    epicId: row.epic_id,
    ticketId: row.ticket_id,
    payload: { from: row.status, to: change.status }
  })
  if (change.status === 'in_progress' && change.epic.status === 'backlog') {
    applyEpicStatus(ctx, change.epic, 'in_progress')
  }
  enqueueOutbox(ctx, { kind: 'epic_state', epicId: row.epic_id })
}

/**
 * Status changes for tickets of a saved plan. Completion needs an accepted attempt; completed
 * tickets never reopen; starting work also starts a backlog epic.
 */
export function setTicketStatus(
  ctx: Ctx,
  input: { ticketId: string; status: WorkStatus; expectedRevision?: number }
): TicketSummaryView {
  requireCapability(ctx.session, 'ticket.status')
  return ctx.db.tx(() => {
    const row =
      ctx.db.get<TicketStatusRow>('SELECT * FROM ticket_status WHERE ticket_id = ?', input.ticketId) ??
      fail('not_found', 'Only tickets in a saved plan have a status.', { ticketId: input.ticketId })
    const epic = loadEpicRow(ctx, row.epic_id)
    assertEpicOpen(epic)
    const { ticket, index } = savedTicket(ctx, row)
    if (input.status !== row.status) {
      assertTicketRevision(row, input.expectedRevision)
      assertTicketTransition(ctx, row, input.status)
      applyTicketStatus(ctx, row, { epic, status: input.status })
    }
    return summarize(ticket, index, input.status)
  })
}
