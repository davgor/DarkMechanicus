import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReadinessView, TicketExecutionView } from '../../shared/domain/views'
import { dropAcceptanceNodes } from '../../test/acceptanceNodes'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { encodeBase32, ID_PREFIXES } from '../ids'
import type { Workspace } from '../workspace'

interface Planned {
  epicId: string
  ticket(ref: string): string
}

/** A saved one-sprint plan: `first` and `later` (after `first`) plus an independent `side` ticket. */
async function plannedEpic(agent: Workspace): Promise<Planned> {
  await agent.initializeRepository({ name: 'exec-repo' })
  const epic = await agent.createEpic({ title: 'Execution epic' })
  await dropAcceptanceNodes(agent, epic.id)
  const draft = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_ticket', ref: 'first', sprint: '1', ticket: { title: 'First' } },
      { op: 'add_ticket', ref: 'later', sprint: '1', ticket: { title: 'Later' } },
      { op: 'add_ticket', ref: 'side', sprint: '1', ticket: { title: 'Side' } },
      { op: 'add_dependency', from: 'first', to: 'later' }
    ]
  })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return { epicId: epic.id, ticket: (ref) => draft.refMap[ref] ?? '' }
}

function titles(tickets: TicketExecutionView[], plan: Planned): string[] {
  const names = new Map(['first', 'later', 'side'].map((ref) => [plan.ticket(ref), ref]))
  return tickets.map((ticket) => names.get(ticket.ticketId) ?? ticket.ticketId).sort()
}

function split(view: ReadinessView, plan: Planned): Record<'ready' | 'blocked' | 'inFlight', string[]> {
  return { ready: titles(view.ready, plan), blocked: titles(view.blocked, plan), inFlight: titles(view.inFlight, plan) }
}

describe('run views carry the checkpoint gate', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('attaches the gate while a run executes, and not while it is paused', async () => {
    const agent = harness.open('orchestrator')
    const plan = await plannedEpic(agent)
    const run = await agent.startRun({ epicId: plan.epicId })
    const running = await agent.getRun({ runId: run.id })
    expect([running?.state, running?.checkpoint?.runId, running?.checkpoint?.sprintOrdinal]).toEqual(['running', run.id, 1])
    await agent.pauseRun({ runId: run.id })
    const paused = await agent.getRun({ runId: run.id })
    expect([paused?.state, paused?.checkpoint]).toEqual(['paused', null])
  })

  it('answers null for an epic without a run, and not_found for an unknown run id', async () => {
    const agent = harness.open('orchestrator')
    const plan = await plannedEpic(agent)
    expect(await agent.getRun({ epicId: plan.epicId })).toBeNull()
    const missing = agent.getRun({ runId: `${ID_PREFIXES.run}_${encodeBase32(7n, 26)}` })
    await expect(missing).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('ready tickets as work moves through the active sprint', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('splits tickets into ready, blocked, and in flight from claim to acceptance', async () => {
    const agent = harness.open('orchestrator')
    const plan = await plannedEpic(agent)
    const run = await agent.startRun({ epicId: plan.epicId })
    const view = async (): Promise<Record<'ready' | 'blocked' | 'inFlight', string[]>> =>
      split(await agent.getReadyTickets({ runId: run.id }), plan)
    expect(await view()).toEqual({ ready: ['first', 'side'], blocked: ['later'], inFlight: [] })

    const claim = await agent.claimTicket({ runId: run.id, ticketId: plan.ticket('first'), worker: { label: 'w' } })
    expect(await view()).toEqual({ ready: ['side'], blocked: ['later'], inFlight: ['first'] })

    await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'done' } })
    expect(await view()).toEqual({ ready: ['side'], blocked: ['later'], inFlight: ['first'] })

    await agent.acceptAttempt({ attemptId: claim.attempt.id })
    expect(await view()).toEqual({ ready: ['later', 'side'], blocked: [], inFlight: [] })
  })
})
