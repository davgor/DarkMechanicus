/**
 * DM-171 c3 through the desktop's budget control: setting a budget is a draft edit under draft ownership, and only a
 * save freezes it, as a prospective version for later dispatches.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { metricsWorld, type MetricsWorld } from '../../test/metricsWorld'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'

let harness: Harness
let w: MetricsWorld
let desktop: Workspace

beforeEach(async () => {
  harness = createHarness()
  w = await metricsWorld(
    harness,
    {
      alpha: { title: 'Alpha', budget: { tokens: 200_000 } },
      beta: { title: 'Beta', budget: { tokens: 50_000 } }
    },
    ['alpha']
  )
  desktop = harness.open('desktop')
})

afterEach(() => {
  harness.cleanup()
})

async function draftRevision(): Promise<number> {
  return (await desktop.openDraft({ epicId: w.epicId })).draftRevision ?? 0
}

describe('DM-171 c3: a budget set on a dispatched ticket is prospective', () => {
  it('applies to later dispatches only: the draft holds the raise while the applied budget stays 200,000', async () => {
    const result = await desktop.setTicketBudget({
      epicId: w.epicId,
      ticketId: w.ticket.alpha ?? '',
      budget: { tokens: 300_000 },
      expectedDraftRevision: await draftRevision(),
      runId: w.runId
    })
    const tokens = result.ticket?.budgets.find((item) => item.metric === 'tokens')
    expect(result.appliesTo).toBe('later_dispatches')
    expect([tokens?.state, tokens?.applied?.value, tokens?.draft, tokens?.versions.length]).toEqual(['frozen', 200_000, { value: 300_000, basis: null }, 1])
  })

  it('an undispatched ticket’s edit applies at its next dispatch', async () => {
    const result = await desktop.setTicketBudget({
      epicId: w.epicId,
      ticketId: w.ticket.beta ?? '',
      budget: { tokens: 70_000 },
      expectedDraftRevision: await draftRevision(),
      runId: w.runId
    })
    expect(result.appliesTo).toBe('next_dispatch')
    expect(result.ticket?.budgets.find((item) => item.metric === 'tokens')?.draft).toEqual({ value: 70_000, basis: null })
  })

  it('saving freezes the edit as version 2, prospective for the run; clearing a budget is a version with no value', async () => {
    const set = await desktop.setTicketBudget({
      epicId: w.epicId,
      ticketId: w.ticket.alpha ?? '',
      budget: null,
      expectedDraftRevision: await draftRevision(),
      runId: w.runId
    })
    expect(set.ticket?.budgets.find((item) => item.metric === 'tokens')?.draft).toEqual({ value: null, basis: null })
    harness.clock.advanceSeconds(60)
    await desktop.savePlan({
      epicId: w.epicId,
      expectedDraftRevision: set.draftRevision
    })
    const view = await desktop.getPlannedBaselines({
      epicId: w.epicId,
      runId: w.runId
    })
    const tokens = view.tickets.find((item) => item.ticketId === w.ticket.alpha)?.budgets.find((item) => item.metric === 'tokens')
    expect(tokens?.applied?.value).toBe(200_000)
    expect(tokens?.versions.map((item) => [item.version, item.value, item.baselineId === null, item.status])).toEqual([
      [1, 200_000, false, 'pinned'],
      [2, null, true, 'prospective']
    ])
  })
})

describe('DM-171 c3: budget edits follow draft ownership', () => {
  it('an edit against a draft that moved is refused as conflict and changes nothing', async () => {
    const stale = await draftRevision()
    await desktop.setTicketBudget({
      epicId: w.epicId,
      ticketId: w.ticket.beta ?? '',
      budget: { tokens: 60_000 },
      expectedDraftRevision: stale
    })
    await expect(
      desktop.setTicketBudget({
        epicId: w.epicId,
        ticketId: w.ticket.beta ?? '',
        budget: { tokens: 1 },
        expectedDraftRevision: stale
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    const view = await desktop.getPlannedBaselines({ epicId: w.epicId })
    expect(view.tickets.find((item) => item.ticketId === w.ticket.beta)?.budgets.find((item) => item.metric === 'tokens')?.draft).toEqual({
      value: 60_000,
      basis: null
    })
  })

  it('a reader cannot set a budget', async () => {
    await expect(
      harness.open('reader').setTicketBudget({
        epicId: w.epicId,
        ticketId: w.ticket.beta ?? '',
        budget: { tokens: 1 },
        expectedDraftRevision: 0
      })
    ).rejects.toMatchObject({
      code: 'unauthorized'
    })
  })

  it('a ticket of a never-saved epic has no versions yet and applies at its next dispatch', async () => {
    const epic = await w.orchestrator.createEpic({ title: 'Unsaved' })
    const draft = await w.orchestrator.updatePlanDraft({
      epicId: epic.id,
      ops: [{ op: 'add_ticket', ref: 'x', sprint: '1', ticket: { title: 'X' } }]
    })
    const result = await desktop.setTicketBudget({
      epicId: epic.id,
      ticketId: draft.refMap.x ?? '',
      budget: { tokens: 5_000 },
      expectedDraftRevision: draft.draftRevision
    })
    expect([result.ticket, result.appliesTo, result.draftRevision]).toEqual([null, 'next_dispatch', draft.draftRevision + 1])
  })
})

describe('DM-171 c3: a person’s estimate is labelled only by a person', () => {
  it('an agent labelling a budget as a person’s estimate is refused as unauthorized', async () => {
    const ops = [
      {
        op: 'update_ticket' as const,
        ticket: w.ticket.beta ?? '',
        patch: { budget: { tokens: 1_000, basis: 'person_estimate' as const } }
      }
    ]
    await expect(w.orchestrator.updatePlanDraft({ epicId: w.epicId, ops })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('the desktop may label it, and an agent may not then change that budget', async () => {
    const set = await desktop.setTicketBudget({
      epicId: w.epicId,
      ticketId: w.ticket.beta ?? '',
      budget: { tokens: 1_000, basis: 'person_estimate' },
      expectedDraftRevision: await draftRevision()
    })
    expect(set.ticket?.budgets.find((item) => item.metric === 'tokens')?.draft).toEqual({ value: 1_000, basis: 'person_estimate' })
    const ops = [
      {
        op: 'update_ticket' as const,
        ticket: w.ticket.beta ?? '',
        patch: { budget: { tokens: 2_000, basis: 'person_estimate' as const } }
      }
    ]
    await expect(w.orchestrator.updatePlanDraft({ epicId: w.epicId, ops })).rejects.toMatchObject({ code: 'unauthorized' })
  })
})
