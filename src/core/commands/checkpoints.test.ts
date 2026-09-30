import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'

describe('checkpoint commands sweep expired leases first', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('reports an expired claim as released instead of still holding a lease', async () => {
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'lease-repo' })
    const epic = await agent.createEpic({ title: 'Lease epic' })
    const draft = await agent.updatePlanDraft({
      epicId: epic.id,
      ops: [{ op: 'add_ticket', ref: 'only', sprint: '1', ticket: { title: 'Only ticket' } }]
    })
    await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    const run = await agent.startRun({ epicId: epic.id })
    const ticketId = draft.refMap['only'] ?? ''
    await agent.claimTicket({ runId: run.id, ticketId, worker: { label: 'w' }, leaseSeconds: 60 })
    const held = await agent.getCheckpoint({ runId: run.id })
    expect(held.conditions.find((condition) => condition.id === 'no_active_leases')?.met).toBe(false)

    harness.clock.advanceSeconds(61)
    const checkpoint = await agent.getCheckpoint({ runId: run.id })
    const lease = checkpoint.conditions.find((condition) => condition.id === 'no_active_leases')
    const required = checkpoint.conditions.find((condition) => condition.id === 'required_accepted')
    expect([lease?.met, required?.detail]).toEqual([true, 'LR-1 needs reconciliation after its lease expired'])
  })
})
