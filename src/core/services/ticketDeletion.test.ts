import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import { captureError, createSavedEpic, eventKinds, insertAttempt, insertRun } from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { openDraft, updatePlanDraft } from './drafts'
import { createEpic } from './epics'
import { completeSavedRevision, getPlan, loadDraftRow, requestSave } from './plans'
import { deleteTicket } from './ticketDeletion'

/** Alpha, Beta (requires Alpha) and Gamma (related to Alpha) in sprint 1. */
const THREE_TICKETS: DraftOp[] = [
  { op: 'add_ticket', ref: 'a', sprint: '1', ticket: { title: 'Alpha', acceptanceCriteria: ['Alpha works'] } },
  { op: 'add_ticket', ref: 'b', sprint: '1', ticket: { title: 'Beta', acceptanceCriteria: ['Beta works'] } },
  { op: 'add_ticket', ref: 'c', sprint: '1', ticket: { title: 'Gamma', acceptanceCriteria: ['Gamma works'] } },
  { op: 'add_dependency', from: 'a', to: 'b' },
  { op: 'add_relation', kind: 'related_to', from: 'c', to: 'a' }
]

interface Seeded {
  ctx: TestCtx
  epicId: string
  revisionId: string
  ticket(ref: 'a' | 'b' | 'c'): string
}

function seeded(): Seeded {
  const ctx = createTestCtx({ role: 'desktop' })
  const saved = createSavedEpic(ctx, { ops: THREE_TICKETS })
  return { ctx, epicId: saved.epicId, revisionId: saved.revisionId, ticket: (ref) => saved.refMap[ref] ?? '' }
}

/** What a refused delete must leave exactly as it was. */
function snapshot(ctx: TestCtx, epicId: string): unknown {
  return {
    revisions: ctx.db.all('SELECT id, number, state FROM plan_revisions WHERE epic_id = ? ORDER BY number', epicId),
    draft: loadDraftRow(ctx, epicId),
    events: eventKinds(ctx),
    outbox: ctx.db.all('SELECT id FROM outbox ORDER BY id')
  }
}

describe('deleteTicket', () => {
  it('saves a new revision without the ticket, its dependency edges and its relations', () => {
    const { ctx, epicId, revisionId, ticket } = seeded()
    const result = deleteTicket(ctx, { epicId, ticketId: ticket('a') })
    expect([result.status, result.revisionNumber]).toEqual(['pending', 2])
    ctx.db.tx(() => completeSavedRevision(ctx, result.revisionId))

    const saved = getPlan(ctx, { epicId, view: 'saved' })
    expect([saved.revisionId, saved.revisionNumber]).toEqual([result.revisionId, 2])
    expect(saved.bundle.tickets.map((item) => item.title)).toEqual(['Beta', 'Gamma'])
    expect(saved.bundle.sprints[0]?.ticketIds).toEqual([ticket('b'), ticket('c')])
    expect([saved.bundle.edges, saved.bundle.relations]).toEqual([[], []])
    expect(loadDraftRow(ctx, epicId)).toBeNull()
    const first = getPlan(ctx, { epicId, view: 'saved', revisionId })
    expect(first.bundle.tickets.map((item) => item.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('records the deletion between the draft edit and the save request', () => {
    const { ctx, epicId, ticket } = seeded()
    const before = eventKinds(ctx).length
    deleteTicket(ctx, { epicId, ticketId: ticket('b') })
    expect(eventKinds(ctx).slice(before)).toEqual(['draft.opened', 'draft.updated', 'ticket.deleted', 'plan.save_requested'])
    const event = ctx.db.get<{ ticket_id: string; payload_json: string }>(
      "SELECT ticket_id, payload_json FROM events WHERE kind = 'ticket.deleted'"
    )
    expect([event?.ticket_id, JSON.parse(event?.payload_json ?? '{}')]).toEqual([ticket('b'), { key: 'DM-2', title: 'Beta' }])
  })

  it('deletes while an Edit draft without changes is open, and that draft goes away with the save', () => {
    const { ctx, epicId, ticket } = seeded()
    openDraft(ctx, { epicId })
    const result = deleteTicket(ctx, { epicId, ticketId: ticket('c') })
    ctx.db.tx(() => completeSavedRevision(ctx, result.revisionId))
    expect(getPlan(ctx, { epicId, view: 'saved' }).bundle.tickets.map((item) => item.title)).toEqual(['Alpha', 'Beta'])
    expect(loadDraftRow(ctx, epicId)).toBeNull()
  })

  it('is not blocked by finished attempts on the ticket', () => {
    const { ctx, epicId, revisionId, ticket } = seeded()
    const runId = insertRun(ctx, { epicId, revisionId, state: 'running' })
    insertAttempt(ctx, { runId, ticketId: ticket('a'), state: 'rejected' })
    insertAttempt(ctx, { runId, ticketId: ticket('a'), state: 'accepted' })
    expect(deleteTicket(ctx, { epicId, ticketId: ticket('a') }).status).toBe('pending')
  })
})

describe('deleteTicket refusals', () => {
  it('refuses while the draft holds unsaved changes', () => {
    const { ctx, epicId, ticket } = seeded()
    updatePlanDraft(ctx, { epicId, ops: [{ op: 'set_rationale', rationale: 'Work in progress' }] })
    const before = snapshot(ctx, epicId)
    const error = captureError(() => deleteTicket(ctx, { epicId, ticketId: ticket('a') }))
    expect(error).toMatchObject({ code: 'conflict', message: expect.stringContaining('unsaved changes') })
    expect(snapshot(ctx, epicId)).toEqual(before)
  })

  it('refuses while a save is still pending', () => {
    const { ctx, epicId, ticket } = seeded()
    const update = updatePlanDraft(ctx, { epicId, ops: [{ op: 'set_rationale', rationale: 'Saving' }] })
    requestSave(ctx, { epicId, expectedDraftRevision: update.draftRevision })
    const before = snapshot(ctx, epicId)
    expect(captureError(() => deleteTicket(ctx, { epicId, ticketId: ticket('a') })).code).toBe('save_pending')
    expect(snapshot(ctx, epicId)).toEqual(before)
  })

  it.each(['claimed', 'running', 'submitted'] as const)('refuses while the ticket has a %s attempt', (state) => {
    const { ctx, epicId, revisionId, ticket } = seeded()
    const runId = insertRun(ctx, { epicId, revisionId, state: 'running' })
    insertAttempt(ctx, { runId, ticketId: ticket('a'), state })
    insertAttempt(ctx, { runId, ticketId: ticket('b'), state: 'accepted' })
    const before = snapshot(ctx, epicId)
    const error = captureError(() => deleteTicket(ctx, { epicId, ticketId: ticket('a') }))
    expect(error).toMatchObject({ code: 'conflict', message: expect.stringContaining('DM-1 has an open attempt') })
    expect(snapshot(ctx, epicId)).toEqual(before)
  })
})

describe('deleteTicket refusals by epic, ticket and role', () => {
  it('refuses a completed epic', () => {
    const { ctx, epicId, ticket } = seeded()
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", epicId)
    const before = snapshot(ctx, epicId)
    expect(captureError(() => deleteTicket(ctx, { epicId, ticketId: ticket('a') })).code).toBe('completed_epic')
    expect(snapshot(ctx, epicId)).toEqual(before)
  })

  it('refuses a ticket that is not in the saved plan, and an epic that was never saved', () => {
    const { ctx, epicId } = seeded()
    const draftOnly = updatePlanDraft(ctx, { epicId, ops: [{ op: 'add_ticket', ref: 'd', sprint: '1', ticket: { title: 'Delta' } }] })
    ctx.db.run('DELETE FROM drafts WHERE epic_id = ?', epicId)
    const missing = captureError(() => deleteTicket(ctx, { epicId, ticketId: draftOnly.refMap['d'] ?? '' }))
    expect(missing).toMatchObject({ code: 'not_found', message: expect.stringContaining('not in the saved plan') })
    const unsaved = createEpic(ctx, { title: 'Never saved' })
    const neverSaved = captureError(() => deleteTicket(ctx, { epicId: unsaved.id, ticketId: draftOnly.refMap['d'] ?? '' }))
    expect(neverSaved).toMatchObject({ code: 'not_found', message: expect.stringContaining('no saved plan') })
  })

  it.each([
    ['planner', true],
    ['orchestrator', true],
    ['worker', false],
    ['reviewer', false]
  ] as const)('refuses a %s session', (role, allowSave) => {
    const { ctx, epicId, ticket } = seeded()
    const agent = withRole(ctx, role, { allowSave })
    expect(captureError(() => deleteTicket(agent, { epicId, ticketId: ticket('a') })).code).toBe('unauthorized')
  })
})
