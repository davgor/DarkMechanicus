import { describe, expect, it } from 'vitest'
import type { TicketBudget } from '../../shared/domain/bundle'
import { captureError, createSavedEpic, draftRevisionOf } from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { updatePlanDraft } from './drafts'
import { setTicketBudget } from './ticketBudgets'

function budgetOf(ctx: TestCtx, epicId: string, ticketId: string): TicketBudget | null {
  const row = ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM drafts WHERE epic_id = ?', epicId)
  const bundle = JSON.parse(row?.bundle_json ?? '{"tickets":[]}') as { tickets: { id: string; budget?: TicketBudget }[] }
  return bundle.tickets.find((ticket) => ticket.id === ticketId)?.budget ?? null
}

/** A saved epic with tickets a and b; `a` holds a person's estimate set by the desktop. */
function setup(): { desktop: TestCtx; agent: TestCtx; epicId: string; a: string; b: string } {
  const agent = createTestCtx()
  const { epicId, refMap } = createSavedEpic(agent)
  const desktop = withRole(agent, 'desktop')
  updatePlanDraft(desktop, { epicId, ops: [{ op: 'update_ticket', ticket: refMap.a, patch: { budget: { tokens: 500, basis: 'person_estimate' } } }] })
  return { desktop, agent, epicId, a: refMap.a, b: refMap.b }
}

interface Refusal {
  code: string
  draftRevisionKept: boolean
  budgets: [TicketBudget | null, TicketBudget | null]
}

/** Runs a refused write and reports its error code, whether the draft revision stayed, and both tickets' budgets after. */
function refusalOf(ctx: TestCtx, epicId: string, action: () => unknown, ids: [string, string]): Refusal {
  const revision = draftRevisionOf(ctx, epicId)
  const error = captureError(action)
  return {
    code: error.code,
    draftRevisionKept: draftRevisionOf(ctx, epicId) === revision,
    budgets: [budgetOf(ctx, epicId, ids[0]), budgetOf(ctx, epicId, ids[1])]
  }
}

const UNCHANGED: Refusal = { code: 'unauthorized', draftRevisionKept: true, budgets: [{ tokens: 500, basis: 'person_estimate' }, null] }

describe('DM-183 c3 review fix: only the desktop labels a budget as a person’s estimate', () => {
  it('refuses an agent session introducing person_estimate, writing nothing', () => {
    const { agent, epicId, a, b } = setup()
    const refusal = refusalOf(
      agent,
      epicId,
      () => updatePlanDraft(agent, { epicId, ops: [{ op: 'update_ticket', ticket: b, patch: { budget: { tokens: 10, basis: 'person_estimate' } } }] }),
      [a, b]
    )
    expect(refusal).toEqual(UNCHANGED)
  })

  it('refuses an agent session changing a budget that carries person_estimate, writing nothing', () => {
    const { agent, epicId, a, b } = setup()
    const refusal = refusalOf(
      agent,
      epicId,
      () => updatePlanDraft(agent, { epicId, ops: [{ op: 'update_ticket', ticket: a, patch: { budget: { tokens: 900, basis: 'person_estimate' } } }] }),
      [a, b]
    )
    expect(refusal).toEqual(UNCHANGED)
  })

  it('refuses the same change made through setTicketBudget', () => {
    const { agent, epicId, a, b } = setup()
    const expectedDraftRevision = draftRevisionOf(agent, epicId) ?? 0
    const refusal = refusalOf(
      agent,
      epicId,
      () => setTicketBudget(agent, { epicId, ticketId: a, budget: { activeMs: 60_000, basis: 'person_estimate' }, expectedDraftRevision }),
      [a, b]
    )
    expect(refusal).toEqual(UNCHANGED)
  })

  it('lets an agent keep an untouched person’s estimate while editing another ticket, or relabel with its own basis', () => {
    const { agent, epicId, a, b } = setup()
    updatePlanDraft(agent, { epicId, ops: [{ op: 'update_ticket', ticket: b, patch: { budget: { tokens: 20, basis: 'planner_estimate' } } }] })
    expect(budgetOf(agent, epicId, a)).toEqual({ tokens: 500, basis: 'person_estimate' })
    expect(budgetOf(agent, epicId, b)).toEqual({ tokens: 20, basis: 'planner_estimate' })
    updatePlanDraft(agent, { epicId, ops: [{ op: 'update_ticket', ticket: a, patch: { budget: { tokens: 700, basis: 'prior_tickets' } } }] })
    expect(budgetOf(agent, epicId, a)).toEqual({ tokens: 700, basis: 'prior_tickets' })
  })

  it('allows the desktop session to introduce and change a person’s estimate', () => {
    const { desktop, epicId, a, b } = setup()
    expect(budgetOf(desktop, epicId, a)).toEqual({ tokens: 500, basis: 'person_estimate' })
    setTicketBudget(desktop, { epicId, ticketId: a, budget: { tokens: 800, basis: 'person_estimate' }, expectedDraftRevision: draftRevisionOf(desktop, epicId) ?? 0 })
    updatePlanDraft(desktop, { epicId, ops: [{ op: 'update_ticket', ticket: b, patch: { budget: { activeMs: 1000, basis: 'person_estimate' } } }] })
    expect(budgetOf(desktop, epicId, a)).toEqual({ tokens: 800, basis: 'person_estimate' })
    expect(budgetOf(desktop, epicId, b)).toEqual({ activeMs: 1000, basis: 'person_estimate' })
  })
})
