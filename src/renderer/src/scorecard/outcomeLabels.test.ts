import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { RequiredOutcome } from '../../../shared/domain/spaceGrades'
import { reportContext, world } from '../__mocks__/scorecardWorlds'
import { outcomeText, planTicketNames, ticketLabel } from './outcomeLabels'

const outcome = (patch: Partial<RequiredOutcome>): RequiredOutcome => ({
  runId: 'rn_1',
  ticketId: 'tk_1',
  role: 'work',
  state: 'verified',
  reason: 'reviewed',
  attemptId: 'at_1',
  movedOut: false,
  counted: true,
  ...patch
})

describe('DM-182 review fix (e): one shared wording for outcomes in the epic and report Scorecards', () => {
  it('reads role, state and reason, and a ticket moved out of the sprint', () => {
    expect(outcomeText(outcome({}), true)).toBe('feature ticket · verified: accepted after review')
    expect(outcomeText(outcome({ role: 'integrated', state: 'failed', reason: 'confirmed_failure' }), false)).toBe(
      'integrated (acceptance or administrative) · failed: confirmed failure (a criterion or check failed, or every try was used)'
    )
    expect(outcomeText(outcome({ role: 'optional', state: 'missing', reason: 'no_attempt', movedOut: true }), false)).toBe('optional · not verified: never dispatched · since moved out of this sprint')
  })

  it('marks an uncounted outcome only where the list asks for it', () => {
    const uncounted = outcome({ state: 'missing', reason: 'carried_forward', counted: false })
    expect(outcomeText(uncounted, true)).toBe('feature ticket · not verified: carried forward, not delivered here · not counted')
    expect(outcomeText(uncounted, false)).toBe('feature ticket · not verified: carried forward, not delivered here')
    expect(outcomeText(outcome({ state: 'pending', reason: 'in_progress' }), true)).toBe('feature ticket · pending: in progress')
  })

  it('names a ticket by key and title from any plan read, a later plan winning, else by its id', async () => {
    const { bundle } = await reportContext(world('reportApproved'))
    const renamed: PlanBundle = { ...bundle, tickets: bundle.tickets.map((ticket) => ({ ...ticket, title: `${ticket.title} (revised)` })) }
    const first = bundle.tickets[0]
    if (first === undefined) throw new Error('the plan holds tickets')
    expect(ticketLabel(planTicketNames([bundle]), first.id)).toBe(`${first.key} ${first.title}`)
    expect(ticketLabel(planTicketNames([bundle, renamed]), first.id)).toBe(`${first.key} ${first.title} (revised)`)
    expect(ticketLabel(planTicketNames([]), first.id)).toBe(first.id)
  })
})
