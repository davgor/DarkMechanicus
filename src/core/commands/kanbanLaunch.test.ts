import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'

let harness: Harness
let desktop: Workspace
let orchestrator: Workspace

beforeEach(async () => {
  harness = createHarness()
  desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'launch-repo' })
  orchestrator = harness.open('orchestrator')
})
afterEach(() => harness.cleanup())

async function card(title = 'Named card'): Promise<string> {
  return (await desktop.createKanbanCard({ title })).id
}

async function snapshot(): Promise<unknown> {
  return Promise.all((await desktop.listKanbanCards({})).lanes.backlog.map((item) => desktop.getKanbanCard({ cardId: item.id })))
}

describe('authorized external Kanban launch', () => {
  it('queues a named card and uses the existing claim, token report and human review workflow', async () => {
    const id = await card()
    const { token } = await desktop.issueGrant({ role: 'orchestrator', label: 'External CLI' })
    orchestrator = harness.open('reader', { transport: 'cli', grantToken: token })
    expect(await orchestrator.launchKanbanCards({ cardIds: [id] })).toMatchObject([{ id, lane: 'backlog', playPending: true, attempts: [] }])
    const packet = await orchestrator.claimKanbanCard({ cardId: id })
    expect(packet.claimToken).toBeTypeOf('string')
    await orchestrator.submitKanbanCard({ attemptId: packet.attemptId, claimToken: packet.claimToken ?? '', outputs: { summary: 'Finished' } })
    await expect(desktop.getKanbanCard({ cardId: id })).resolves.toMatchObject({ lane: 'ready_for_review' })
    await expect(orchestrator.approveKanbanCard({ cardId: id })).rejects.toMatchObject({ code: 'unauthorized' })
    await desktop.approveKanbanCard({ cardId: id })
    await expect(desktop.getKanbanCard({ cardId: id })).resolves.toMatchObject({ lane: 'done' })
  })

  it('deduplicates a batch and repeated pending requests without duplicate events or attempts', async () => {
    const ids = [await card('First'), await card('Second')]
    const first = await orchestrator.launchKanbanCards({ cardIds: [ids[0] ?? '', ids[1] ?? '', ids[0] ?? ''] })
    expect(first.map((item) => item.id)).toEqual(ids)
    harness.clock.advanceSeconds(1)
    expect(await orchestrator.launchKanbanCards({ cardIds: ids })).toEqual(first)
    const events = await desktop.listEvents({})
    expect(events.events.filter((event) => event.kind === 'kanban.played')).toHaveLength(2)
    for (const id of ids) {
      await orchestrator.claimKanbanCard({ cardId: id })
      await expect(orchestrator.claimKanbanCard({ cardId: id })).rejects.toMatchObject({ code: 'already_claimed' })
      expect((await desktop.getKanbanCard({ cardId: id })).attempts).toHaveLength(1)
    }
  })
})

describe('atomic external launch validation', () => {

  it('reports every unknown or ineligible card and leaves the entire mixed batch unchanged', async () => {
    const valid = await card('Valid')
    const active = await card('Active')
    await orchestrator.launchKanbanCards({ cardIds: [active] })
    await orchestrator.claimKanbanCard({ cardId: active, leaseSeconds: 30 })
    const before = await snapshot()
    const missing = 'kc_00000000000000000000000000'
    await expect(orchestrator.launchKanbanCards({ cardIds: [valid, missing, active] })).rejects.toMatchObject({
      code: 'invalid_state', details: { cards: [
        { cardId: missing, code: 'not_found', message: expect.stringContaining(missing) },
        { cardId: active, code: 'invalid_state', message: expect.stringContaining('open attempt') }
      ] }
    })
    expect(await snapshot()).toEqual(before)
    const activeBefore = await desktop.getKanbanCard({ cardId: active })
    harness.clock.advanceSeconds(31)
    // The failed batch must roll back even lazy expiry and its event/outbox writes.
    const events = await desktop.listEvents({})
    await expect(orchestrator.launchKanbanCards({ cardIds: [active, missing] })).rejects.toMatchObject({ code: 'invalid_state' })
    expect(await desktop.listEvents({})).toEqual(events)
    // A valid request may recover the expired claim, without changing its history.
    const recovered = await orchestrator.launchKanbanCards({ cardIds: [active] })
    expect(recovered[0]).toMatchObject({ playPending: true, attempts: [{ id: activeBefore.attempts[0]?.id, state: 'lease_expired' }] })
  })

  it('never requeues active, submitted or completed work when launch is retried', async () => {
    const id = await card()
    await orchestrator.launchKanbanCards({ cardIds: [id] })
    const packet = await orchestrator.claimKanbanCard({ cardId: id })
    for (const state of ['claimed', 'running', 'submitted', 'accepted']) {
      if (state === 'running') await orchestrator.heartbeatKanbanCard({ attemptId: packet.attemptId, claimToken: packet.claimToken ?? '' })
      if (state === 'submitted') await orchestrator.submitKanbanCard({ attemptId: packet.attemptId, claimToken: packet.claimToken ?? '', outputs: { summary: 'Complete' } })
      if (state === 'accepted') await desktop.approveKanbanCard({ cardId: id })
      const before = await desktop.getKanbanCard({ cardId: id })
      await expect(orchestrator.launchKanbanCards({ cardIds: [id] })).rejects.toMatchObject({ code: 'invalid_state', details: { cards: [{ cardId: id }] } })
      expect(await desktop.getKanbanCard({ cardId: id })).toEqual(before)
    }
  })
})

describe('external launch authorization and input', () => {

  it.each(['reader', 'planner', 'worker', 'reviewer', 'desktop'] as const)('denies launch to %s without mutating cards', async (role) => {
    const id = await card()
    await expect(harness.open(role).launchKanbanCards({ cardIds: [id] })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(desktop.getKanbanCard({ cardId: id })).resolves.toMatchObject({ playPending: false, attempts: [] })
  })

  it.each(['revoked', 'expired'] as const)('denies an already open CLI session with a %s grant', async (state) => {
    const id = await card()
    const { grant, token } = await desktop.issueGrant({ role: 'orchestrator', label: 'External caller', minutes: 5 })
    const cli = harness.open('reader', { transport: 'cli', grantToken: token })
    expect((await cli.getCapabilities()).capabilities).toContain('kanban.launch')
    if (state === 'revoked') await desktop.revokeGrant({ grantId: grant.id })
    else harness.clock.advanceSeconds(301)
    await expect(cli.launchKanbanCards({ cardIds: [id] })).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(desktop.getKanbanCard({ cardId: id })).resolves.toMatchObject({ playPending: false, attempts: [] })
  })

  it.each([{}, { cardIds: [] }, { cardIds: ['bad-id'] }, { cardIds: ['kc_00000000000000000000000000'], all: true }])('requires explicit nonempty valid IDs: %j', async (input) => {
    await expect(orchestrator.execute('launchKanbanCards', input)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await snapshot()).toEqual([])
  })
})
