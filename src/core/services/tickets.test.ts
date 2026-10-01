import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import {
  captureError,
  createSavedEpic,
  eventKinds,
  insertAttempt,
  insertRun,
  outboxRows,
  saveNow,
  TWO_TICKETS
} from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { updatePlanDraft } from './drafts'
import { getEpic } from './epics'
import { getPlan } from './plans'
import { getTicket, listTickets, setTicketStatus } from './tickets'

const GRAPH: DraftOp[] = [
  ...TWO_TICKETS,
  { op: 'add_ticket', ref: 'c', sprint: '1', ticket: { title: 'Gamma' } },
  { op: 'add_dependency', from: 'b', to: 'c' },
  { op: 'add_relation', kind: 'duplicate_of', from: 'c', to: 'a' },
  { op: 'add_relation', kind: 'related_to', from: 'b', to: 'c' }
]

function sprintIdAt(ctx: TestCtx, epicId: string, ordinal: number): string {
  const sprint = getPlan(ctx, { epicId, view: 'saved' }).bundle.sprints.find((item) => item.ordinal === ordinal)
  return sprint?.id ?? 'missing'
}

function link(ticketId: string, key: string, title: string, status: string | null = 'backlog'): unknown {
  return { ticketId, key, title, status, executionState: null }
}

describe('listTickets', () => {
  it('lists saved tickets in sprint order, then position, with their statuses', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx, {
      ops: [
        { op: 'add_sprint', ref: 's2', sprint: { goal: 'Second' } },
        { op: 'add_ticket', ref: 'late', sprint: 's2', ticket: { title: 'Late', tags: ['ui'], priority: 'high', optional: true } },
        { op: 'add_ticket', ref: 'second', sprint: '1', ticket: { title: 'Second' } },
        { op: 'add_ticket', ref: 'first', sprint: '1', ticket: { title: 'First' } },
        { op: 'move_ticket', ticket: 'first', toSprint: '1', position: 0 }
      ]
    })
    ctx.db.run("UPDATE ticket_status SET status = 'in_progress' WHERE ticket_id = ?", saved.refMap.second)
    const sprint1 = sprintIdAt(ctx, saved.epicId, 1)
    expect(listTickets(ctx, { epicId: saved.epicId, view: 'saved' })).toEqual([
      { id: saved.refMap.first, key: 'DM-3', title: 'First', status: 'backlog', sprintId: sprint1, sprintOrdinal: 1, priority: 'normal', tags: [], optional: false },
      { id: saved.refMap.second, key: 'DM-2', title: 'Second', status: 'in_progress', sprintId: sprint1, sprintOrdinal: 1, priority: 'normal', tags: [], optional: false },
      { id: saved.refMap.late, key: 'DM-1', title: 'Late', status: 'backlog', sprintId: saved.refMap.s2, sprintOrdinal: 2, priority: 'high', tags: ['ui'], optional: true }
    ])
  })

  it('keeps draft-only tickets out of the saved view and gives them no status', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const extra = updatePlanDraft(ctx, {
      epicId: saved.epicId,
      ops: [{ op: 'add_ticket', ref: 'd', sprint: '1', ticket: { title: 'Draft only' } }]
    }).refMap.d
    expect(listTickets(ctx, { epicId: saved.epicId, view: 'saved' }).map((ticket) => ticket.title)).toEqual(['Alpha', 'Beta'])
    const draft = listTickets(ctx, { epicId: saved.epicId, view: 'draft' })
    expect(draft.map((ticket) => [ticket.title, ticket.status])).toEqual([
      ['Alpha', 'backlog'],
      ['Beta', 'backlog'],
      ['Draft only', null]
    ])
    expect(draft[2].id).toBe(extra)
  })

  it('lists tickets that belong to no sprint last', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'set_rationale', rationale: 'x' }] })
    ctx.db.run("UPDATE drafts SET bundle_json = json_set(bundle_json, '$.sprints[0].ticketIds', json_array(?))", saved.refMap.b)
    const draft = listTickets(ctx, { epicId: saved.epicId, view: 'draft' })
    expect(draft.map((ticket) => [ticket.title, ticket.sprintId === null, ticket.sprintOrdinal])).toEqual([
      ['Beta', false, 1],
      ['Alpha', true, null]
    ])
  })
})

describe('getTicket links', () => {
  it('resolves a ticket by key with its prerequisites, dependents, and relations', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx, { ops: GRAPH })
    const { a, c } = saved.refMap
    const bundle = getPlan(ctx, { epicId: saved.epicId, view: 'saved' }).bundle
    expect(getTicket(ctx, { epicId: saved.epicId, ticketId: 'DM-2', view: 'saved' })).toEqual({
      epicId: saved.epicId,
      view: 'saved',
      ticket: bundle.tickets[1],
      status: 'backlog',
      sprintId: sprintIdAt(ctx, saved.epicId, 1),
      sprintOrdinal: 1,
      prerequisites: [link(a, 'DM-1', 'Alpha')],
      dependents: [link(c, 'DM-3', 'Gamma')],
      relations: [{ kind: 'related_to', ticket: link(c, 'DM-3', 'Gamma') }],
      execution: null,
      attempts: [],
      readOnly: true,
      readOnlyReason: 'Saved revisions are immutable. Edit a draft.'
    })
  })

  it('names incoming relations from the other side and resolves ids', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx, { ops: GRAPH })
    const { a, b, c } = saved.refMap
    const alpha = getTicket(ctx, { epicId: saved.epicId, ticketId: a, view: 'saved' })
    expect(alpha.prerequisites).toEqual([])
    expect(alpha.relations).toEqual([{ kind: 'duplicated_by', ticket: link(c, 'DM-3', 'Gamma') }])
    const gamma = getTicket(ctx, { epicId: saved.epicId, ticketId: c, view: 'saved' })
    expect(gamma.dependents).toEqual([])
    expect(gamma.relations).toEqual([
      { kind: 'duplicate_of', ticket: link(a, 'DM-1', 'Alpha') },
      { kind: 'related_to', ticket: link(b, 'DM-2', 'Beta') }
    ])
  })

})

describe('getTicket in the draft view', () => {
  it('shows draft-only tickets without a status in the draft view', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const extra = updatePlanDraft(ctx, {
      epicId: saved.epicId,
      ops: [
        { op: 'add_ticket', ref: 'd', sprint: '1', ticket: { title: 'Delta' } },
        { op: 'add_dependency', from: saved.refMap.b, to: 'd' }
      ]
    }).refMap.d
    const delta = getTicket(ctx, { epicId: saved.epicId, ticketId: 'DM-3', view: 'draft' })
    expect(delta).toMatchObject({ view: 'draft', status: null, readOnly: false, readOnlyReason: null })
    expect(delta.ticket.id).toBe(extra)
    expect(delta.prerequisites).toEqual([link(saved.refMap.b, 'DM-2', 'Beta')])
    expect(getTicket(ctx, { epicId: saved.epicId, ticketId: saved.refMap.b, view: 'draft' }).dependents).toEqual([
      link(extra, 'DM-3', 'Delta', null)
    ])
  })

  it('rejects tickets missing from the requested view', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Delta' } }] })
    expect(captureError(() => getTicket(ctx, { epicId: saved.epicId, ticketId: 'DM-3', view: 'saved' }))).toEqual({
      code: 'not_found',
      message: 'Ticket DM-3 is not in the saved plan.',
      details: { ticketId: 'DM-3' }
    })
  })
})

describe('getTicket read-only reasons', () => {
  it('names the active run that pins the saved revision', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'awaiting_checkpoint', number: 4 })
    const ticket = getTicket(ctx, { epicId: saved.epicId, ticketId: 'DM-1', view: 'saved' })
    expect(ticket.readOnly).toBe(true)
    expect(ticket.readOnlyReason).toBe('Read-only while run #4 is active. Changes go to a draft.')
  })

  it('ignores active runs pinned to an older revision and finished runs', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'running' })
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'set_rationale', rationale: 'Newer' }] })
    const newer = saveNow(ctx, saved.epicId)
    insertRun(ctx, { epicId: saved.epicId, revisionId: newer, state: 'completed', number: 2 })
    const reason = getTicket(ctx, { epicId: saved.epicId, ticketId: 'DM-1', view: 'saved' }).readOnlyReason
    expect(reason).toBe('Saved revisions are immutable. Edit a draft.')
  })

  it('keeps every view of a completed epic read-only', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'set_rationale', rationale: 'Leftover' }] })
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", saved.epicId)
    for (const view of ['saved', 'draft'] as const) {
      expect(getTicket(ctx, { epicId: saved.epicId, ticketId: 'DM-1', view })).toMatchObject({
        readOnly: true,
        readOnlyReason: 'Completed epics are read-only.'
      })
    }
    expect(getEpic(ctx, { epicId: saved.epicId }).status).toBe('completed')
  })
})

function statusRow(ctx: TestCtx, ticketId: string): { status: string; revision: number } | undefined {
  return ctx.db.get('SELECT status, revision FROM ticket_status WHERE ticket_id = ?', ticketId)
}

describe('setTicketStatus starting work', () => {
  it('moves a backlog ticket and its backlog epic to in progress', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const summary = setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'in_progress', expectedRevision: 1 })
    expect(summary).toEqual({
      id: saved.refMap.a,
      key: 'DM-1',
      title: 'Alpha',
      status: 'in_progress',
      sprintId: sprintIdAt(ctx, saved.epicId, 1),
      sprintOrdinal: 1,
      priority: 'normal',
      tags: [],
      optional: false
    })
    expect(statusRow(ctx, saved.refMap.a)).toEqual({ status: 'in_progress', revision: 2 })
    expect(getEpic(ctx, { epicId: saved.epicId })).toMatchObject({ status: 'in_progress', revision: 3 })
    expect(eventKinds(ctx).slice(-2)).toEqual(['ticket.status_changed', 'epic.status_changed'])
    expect(outboxRows(ctx).filter((row) => row.kind === 'epic_state')).toEqual([
      { kind: 'epic_state', epicId: saved.epicId, revisionId: null }
    ])
  })

  it('leaves an epic that is already in progress alone', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'in_progress' })
    setTicketStatus(ctx, { ticketId: saved.refMap.b, status: 'in_progress' })
    expect(getEpic(ctx, { epicId: saved.epicId }).revision).toBe(3)
    const event = ctx.db.get<{ ticket_id: string; payload_json: string }>(
      "SELECT ticket_id, payload_json FROM events WHERE kind = 'ticket.status_changed' ORDER BY seq DESC LIMIT 1"
    )
    expect(event?.ticket_id).toBe(saved.refMap.b)
    expect(JSON.parse(event?.payload_json ?? '{}')).toEqual({ from: 'backlog', to: 'in_progress' })
  })

  it('treats the current status as a no-op and rejects stale revisions', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const events = eventKinds(ctx)
    expect(setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'backlog', expectedRevision: 7 }).status).toBe('backlog')
    expect(eventKinds(ctx)).toEqual(events)
    expect(captureError(() => setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'in_progress', expectedRevision: 2 }))).toEqual({
      code: 'conflict',
      message: 'The ticket changed (now revision 1). Reload and try again.',
      details: { currentRevision: 1 }
    })
    expect(statusRow(ctx, saved.refMap.a)).toEqual({ status: 'backlog', revision: 1 })
  })
})

describe('setTicketStatus completion evidence', () => {
  it('completes a ticket only with an accepted, current attempt', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const run = insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'running' })
    insertAttempt(ctx, { runId: run, ticketId: saved.refMap.a, state: 'accepted', superseded: true })
    insertAttempt(ctx, { runId: run, ticketId: saved.refMap.a, state: 'rejected' })
    insertAttempt(ctx, { runId: run, ticketId: saved.refMap.b, state: 'accepted' })
    expect(captureError(() => setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'completed' }))).toEqual({
      code: 'unauthorized_transition',
      message: 'Tickets complete through accept_attempt so acceptance evidence exists.',
      details: undefined
    })
    insertAttempt(ctx, { runId: run, ticketId: saved.refMap.a, state: 'accepted' })
    expect(setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'completed' }).status).toBe('completed')
    expect(getEpic(ctx, { epicId: saved.epicId }).status).toBe('backlog')
  })

  it('never reopens a completed ticket', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", saved.refMap.a)
    for (const status of ['backlog', 'in_progress'] as const) {
      expect(captureError(() => setTicketStatus(ctx, { ticketId: saved.refMap.a, status }))).toEqual({
        code: 'unauthorized_transition',
        message: 'Completed tickets stay completed; their acceptance evidence is final.',
        details: undefined
      })
    }
    expect(setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'completed' }).status).toBe('completed')
  })
})

describe('setTicketStatus back to backlog', () => {
  it('waits for open attempts to finish', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'in_progress' })
    const run = insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'running' })
    for (const state of ['claimed', 'running', 'submitted'] as const) {
      const attempt = insertAttempt(ctx, { runId: run, ticketId: saved.refMap.a, state })
      expect(captureError(() => setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'backlog' }))).toEqual({
        code: 'conflict',
        message: `The ticket has an open attempt (${state}). Let it finish before moving the ticket back to backlog.`,
        details: { attemptId: attempt }
      })
      ctx.db.run("UPDATE attempts SET state = 'failed' WHERE id = ?", attempt)
    }
    expect(setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'backlog' }).status).toBe('backlog')
    expect(statusRow(ctx, saved.refMap.a)).toEqual({ status: 'backlog', revision: 3 })
  })
})

describe('setTicketStatus guards', () => {
  it('only tracks status for tickets in a saved plan', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const extra = updatePlanDraft(ctx, {
      epicId: saved.epicId,
      ops: [{ op: 'add_ticket', ref: 'd', sprint: '1', ticket: { title: 'Delta' } }]
    }).refMap.d
    expect(captureError(() => setTicketStatus(ctx, { ticketId: extra, status: 'in_progress' }))).toEqual({
      code: 'not_found',
      message: 'Only tickets in a saved plan have a status.',
      details: { ticketId: extra }
    })
  })

  it('rejects completed epics and sessions without ticket.status', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const planner = withRole(ctx, 'planner')
    expect(captureError(() => setTicketStatus(planner, { ticketId: saved.refMap.a, status: 'in_progress' })).code).toBe(
      'unauthorized'
    )
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", saved.epicId)
    expect(captureError(() => setTicketStatus(ctx, { ticketId: saved.refMap.a, status: 'in_progress' })).code).toBe(
      'completed_epic'
    )
    expect(statusRow(ctx, saved.refMap.a)).toEqual({ status: 'backlog', revision: 1 })
  })

})

describe('setTicketStatus ticket content', () => {
  it('fails cleanly for a status row whose ticket is in no saved revision', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    ctx.db.run(
      "INSERT INTO ticket_status (ticket_id, epic_id, status, revision, updated_at) VALUES ('tk_orphan', ?, 'backlog', 1, ?)",
      saved.epicId,
      '2026-01-01T00:00:00.000Z'
    )
    expect(captureError(() => setTicketStatus(ctx, { ticketId: 'tk_orphan', status: 'in_progress' }))).toEqual({
      code: 'not_found',
      message: 'Ticket tk_orphan is not in a saved plan.',
      details: { ticketId: 'tk_orphan' }
    })
    expect(statusRow(ctx, 'tk_orphan')).toEqual({ status: 'backlog', revision: 1 })
    expect(getEpic(ctx, { epicId: saved.epicId }).status).toBe('backlog')
  })

  it('describes tickets removed from the current plan using the newest saved revision that has them', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'remove_ticket', ticket: 'DM-2' }] })
    saveNow(ctx, saved.epicId)
    const summary = setTicketStatus(ctx, { ticketId: saved.refMap.b, status: 'in_progress' })
    expect(summary).toMatchObject({ id: saved.refMap.b, key: 'DM-2', title: 'Beta', status: 'in_progress' })
  })
})

describe('ticket reads', () => {
  it('require the read capability', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const noRead = withRole(ctx, 'worker', { capabilities: [] })
    expect(captureError(() => listTickets(noRead, { epicId: saved.epicId, view: 'saved' })).code).toBe('unauthorized')
    const error = captureError(() => getTicket(noRead, { epicId: saved.epicId, ticketId: 'DM-1', view: 'saved' }))
    expect(error.details).toEqual({ role: 'worker', capability: 'read' })
    expect(listTickets(withRole(ctx, 'worker'), { epicId: saved.epicId, view: 'saved' })).toHaveLength(2)
  })
})
