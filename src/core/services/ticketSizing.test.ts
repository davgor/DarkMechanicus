import { describe, expect, it } from 'vitest'
import { createSavedEpic, saveNow } from '../../test/authoring'
import { createTestCtx } from '../../test/testContext'
import { openDraft, updatePlanDraft } from './drafts'
import { getPlan, validatePlanView } from './plans'
import { getTicket, listTickets } from './tickets'

const SIZED = {
  title: 'Rename the flag',
  acceptanceCriteria: ['Flag renamed'],
  size: 'micro' as const,
  capability: { reasoning: { level: 'routine' as const, effort: 'low' as const } }
}

function savedEpicWithSizedTicket(): { ctx: ReturnType<typeof createTestCtx>; epicId: string; ticketId: string } {
  const ctx = createTestCtx()
  const saved = createSavedEpic(ctx, { ops: [{ op: 'add_ticket', ref: 'sized', sprint: '1', ticket: SIZED }] })
  return { ctx, epicId: saved.epicId, ticketId: saved.refMap.sized }
}

describe('ticket size and effort in the plan draft', () => {
  it('stores the size and effort an added ticket carries and returns them from get_ticket', () => {
    const { ctx, epicId, ticketId } = savedEpicWithSizedTicket()
    openDraft(ctx, { epicId })
    const detail = getTicket(ctx, { epicId, ticketId, view: 'draft' })
    expect(detail.ticket.size).toBe('micro')
    expect(detail.ticket.capability.reasoning).toEqual({ level: 'routine', rationale: '', effort: 'low' })
  })

  it('lists the size and effort in list_tickets, in the draft and in the saved plan', () => {
    const { ctx, epicId, ticketId } = savedEpicWithSizedTicket()
    openDraft(ctx, { epicId })
    for (const view of ['draft', 'saved'] as const) {
      const row = listTickets(ctx, { epicId, view }).find((ticket) => ticket.id === ticketId)
      expect(row).toMatchObject({ size: 'micro', effort: 'low' })
    }
    expect(getTicket(ctx, { epicId, ticketId, view: 'saved' }).ticket.size).toBe('micro')
  })

  it('leaves a ticket without a size or effort out of its list_tickets row', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const [first] = listTickets(ctx, { epicId: saved.epicId, view: 'saved' })
    expect(Object.keys(first ?? {})).not.toContain('size')
    expect(Object.keys(first ?? {})).not.toContain('effort')
  })

})

describe('ticket size and effort in the draft changes', () => {
  it('shows a size change in the draft changes', () => {
    const { ctx, epicId, ticketId } = savedEpicWithSizedTicket()
    updatePlanDraft(ctx, { epicId, ops: [{ op: 'update_ticket', ticket: ticketId, patch: { size: 'medium' } }] })
    const changes = getPlan(ctx, { epicId, view: 'draft' }).changes
    expect(changes).toEqual([
      expect.objectContaining({ kind: 'edited', target: 'ticket', id: ticketId, detail: 'size micro → medium' })
    ])
  })

  it('shows an effort change in the draft changes and keeps the reasoning level', () => {
    const { ctx, epicId, ticketId } = savedEpicWithSizedTicket()
    updatePlanDraft(ctx, {
      epicId,
      ops: [{ op: 'update_ticket', ticket: ticketId, patch: { capability: { reasoning: { effort: 'high' } } } }]
    })
    const draft = getPlan(ctx, { epicId, view: 'draft' })
    expect(draft.changes).toEqual([
      expect.objectContaining({ kind: 'edited', target: 'ticket', id: ticketId, detail: 'reasoning effort low → high' })
    ])
    expect(draft.bundle.tickets.find((ticket) => ticket.id === ticketId)?.capability.reasoning).toEqual({
      level: 'routine',
      rationale: '',
      effort: 'high'
    })
  })

})

describe('ticket size and effort in validation and Save', () => {
  it('warns without blocking when the draft holds a large ticket or a micro ticket at deep reasoning', () => {
    const { ctx, epicId, ticketId } = savedEpicWithSizedTicket()
    updatePlanDraft(ctx, {
      epicId,
      ops: [
        { op: 'update_ticket', ticket: ticketId, patch: { capability: { reasoning: { level: 'deep' } } } },
        { op: 'add_ticket', ref: 'big', sprint: '1', ticket: { title: 'Rewrite everything', acceptanceCriteria: ['Rewritten'], size: 'large' } }
      ]
    })
    const report = validatePlanView(ctx, { epicId, view: 'draft' })
    expect(report.valid).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['large_ticket', 'micro_ticket_deep_reasoning'])
    )
  })

  it('keeps the size and effort in the revision a Save freezes', () => {
    const { ctx, epicId, ticketId } = savedEpicWithSizedTicket()
    updatePlanDraft(ctx, { epicId, ops: [{ op: 'update_ticket', ticket: ticketId, patch: { size: 'small' } }] })
    saveNow(ctx, epicId)
    const ticket = getPlan(ctx, { epicId, view: 'saved' }).bundle.tickets.find((item) => item.id === ticketId)
    expect(ticket?.size).toBe('small')
    expect(ticket?.capability.reasoning.effort).toBe('low')
  })
})

describe('clearing a ticket size and effort in the plan draft', () => {
  it('removes both from the draft ticket, so the stored shape has no size or effort key', () => {
    const { ctx, epicId, ticketId } = savedEpicWithSizedTicket()
    updatePlanDraft(ctx, {
      epicId,
      ops: [{ op: 'update_ticket', ticket: ticketId, patch: { size: null, capability: { reasoning: { effort: null } } } }]
    })
    const draft = getPlan(ctx, { epicId, view: 'draft' })
    const ticket = draft.bundle.tickets.find((item) => item.id === ticketId)
    expect(Object.keys(ticket ?? {})).not.toContain('size')
    expect(ticket?.capability.reasoning).toEqual({ level: 'routine', rationale: '' })
    expect(draft.changes).toEqual([
      expect.objectContaining({ id: ticketId, detail: 'size micro → unset; reasoning effort low → unset' })
    ])
  })

  it('freezes a Save of the cleared ticket without a size or effort', () => {
    const { ctx, epicId, ticketId } = savedEpicWithSizedTicket()
    updatePlanDraft(ctx, {
      epicId,
      ops: [{ op: 'update_ticket', ticket: ticketId, patch: { size: null, capability: { reasoning: { effort: null } } } }]
    })
    saveNow(ctx, epicId)
    const ticket = getPlan(ctx, { epicId, view: 'saved' }).bundle.tickets.find((item) => item.id === ticketId)
    expect(Object.keys(ticket ?? {})).not.toContain('size')
    expect(Object.keys(ticket?.capability.reasoning ?? {})).not.toContain('effort')
    expect(listTickets(ctx, { epicId, view: 'saved' }).find((row) => row.id === ticketId)).not.toHaveProperty('size')
  })
})
