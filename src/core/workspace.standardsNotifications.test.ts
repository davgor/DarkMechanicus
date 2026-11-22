import { afterEach, beforeEach, expect, it } from 'vitest'
import type { StandardizationPatch } from '../shared/domain/standardization'
import type { GrantableRole } from '../shared/domain/views'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { baselineDeliveryPolicy } from './deliveryPolicySchema'
import { bindAgentMailEndpoint, provisionAgentMailEndpoint } from './services/agentMail'
import type { Workspace } from './workspace'

let h: Harness
let desktop: Workspace
beforeEach(async () => {
  h = createHarness()
  desktop = h.open('desktop', { mode: 'db' })
  await desktop.initializeRepository({ name: 'Mail routing', mode: 'db' })
})
afterEach(() => h.cleanup())

async function chat(role: GrantableRole, name: string) {
  const { token, grant } = await desktop.issueGrant({ role, label: name, allowSave: role === 'planner' })
  const endpoint = provisionAgentMailEndpoint(desktop.ctx(), { chatId: name, name })
  bindAgentMailEndpoint(desktop.ctx(), { endpointId: endpoint.id, grantId: grant.id })
  return h.open('reader', { transport: 'cli', grantToken: token })
}

it('delivers a revised submitted ticket to its worker and run owner exactly once, from the preparing chat', async () => {
  const epic = await desktop.createEpic({ title: 'Restore backups' })
  await dropAcceptanceNodes(desktop, epic.id)
  const draft = await desktop.updatePlanDraft({ epicId: epic.id, ops: [
    { op: 'add_ticket', sprint: '1', ticket: { title: 'Restore the selected version' } }
  ] })
  await desktop.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const owner = await chat('orchestrator', 'run owner')
  const worker = await chat('worker', 'restore worker')
  const unrelated = await chat('worker', 'other worker')
  const planner = await chat('planner', 'standards editor')
  const run = await owner.startRun({ epicId: epic.id })
  const [ticket] = await desktop.listTickets({ epicId: epic.id, view: 'saved' })
  const { packet } = await owner.claimTicket({ runId: run.id, ticketId: ticket.id, worker: { label: 'other worker' } })
  await worker.submitAttempt({ attemptId: packet.attemptId, claimToken: packet.claimToken!, outputs: { summary: 'Done' } })
  const { revision } = await planner.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
  const change: StandardizationPatch = { kind: 'ticket', id: ticket.id, epicId: epic.id, disposition: 'updated',
    reason: 'The restored revision must be independently verifiable', tests: ['Compare the restored bytes to the selected commit.'] }
  const input = { expectedRevision: revision, includeInProgress: true, items: [change] }
  await planner.standardizeProjectWork(input)
  const replay = await planner.standardizeProjectWork(input)
  expect(replay.items.find(i => i.id === ticket.id)?.notifications).toEqual({ worker: 'inbox', orchestrator: 'inbox' })
  expect((await unrelated.getProject()).assignedDeliveryRequirements).toBeUndefined()
  for (const recipient of [owner, worker]) {
    expect((await recipient.getProject()).assignedDeliveryRequirements).toEqual([expect.stringContaining(change.tests![0])])
    const { messages } = await recipient.readAgentInbox({})
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ from: { name: 'standards editor' }, body: expect.stringContaining(change.tests![0]) })
  }
  expect((await unrelated.readAgentInbox({})).messages).toEqual([])
})

it('reports refresh delivery when the sender has no mailbox and avoids writing from another identity', async () => {
  const owner = await chat('orchestrator', 'card owner')
  const worker = await chat('worker', 'card worker')
  const card = await desktop.createKanbanCard({ title: 'Recover deleted notes' })
  await desktop.playKanbanCard({ cardId: card.id })
  const packet = await owner.claimKanbanCard({ cardId: card.id })
  await worker.heartbeatKanbanCard({ attemptId: packet.attemptId, claimToken: packet.claimToken! })
  const saved = await desktop.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
  const patch: StandardizationPatch = { id: card.id, kind: 'kanban', disposition: 'updated',
    requirements: 'Recover the most recent revision.', reason: 'Restore needs a defined version.' }
  const input = { expectedRevision: saved.revision, includeInProgress: true, items: [patch] }
  expect((await desktop.standardizeProjectWork(input)).items[0].notifications).toEqual({ worker: 'refresh', orchestrator: 'refresh' })
  expect((await worker.getProject()).assignedDeliveryRequirements).toEqual([expect.stringContaining(patch.requirements!)])
  expect((await owner.readAgentInbox({})).messages).toEqual([])
  expect((await worker.readAgentInbox({})).messages).toEqual([])

  const planner = await chat('planner', 'card standards')
  const next = await planner.setDeliveryStandards({ expectedRevision: saved.revision, policy: { ...baselineDeliveryPolicy, sprint: 'Deliver the restored notes.' } })
  const second = await planner.standardizeProjectWork({ ...input, expectedRevision: next.revision })
  expect(second.items[0].notifications).toEqual({ worker: 'inbox', orchestrator: 'inbox' })
  expect((await worker.readAgentInbox({})).messages[0].body).toContain(patch.requirements)
  expect((await owner.readAgentInbox({})).messages[0].body).toContain(card.id)
})

it('bounds live context to four recent bodies and retires an assignment when it closes', async () => {
  const owner = await chat('orchestrator', 'parallel cards')
  const actions = []
  for (let index = 0; index < 5; index++) {
    const card = await desktop.createKanbanCard({ title: 'Release part ' + index })
    await desktop.playKanbanCard({ cardId: card.id })
    const claim = await owner.claimKanbanCard({ cardId: card.id })
    actions.push({ card, claim })
  }
  const saved = await desktop.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
  const items: StandardizationPatch[] = actions.map(({card}) => ({
    kind: 'kanban', id: card.id, disposition: 'updated', reason: 'Release verification changed.',
    requirements: 'Inspect the published build for ' + card.title
  }))
  await desktop.standardizeProjectWork({ expectedRevision: saved.revision, includeInProgress: true, items })
  const context = (await owner.getProject()).assignedDeliveryRequirements!
  expect(context).toHaveLength(5)
  expect(context.at(-1)).toMatch(/^1 additional active work item/)
  const { card, claim } = actions[0]
  await owner.failKanbanCard({ attemptId: claim.attemptId, claimToken: claim.claimToken!, reason: 'Build withdrawn' })
  const active = (await owner.getProject()).assignedDeliveryRequirements!
  expect(active).toHaveLength(4)
  expect(active.join(' ')).not.toContain(card.id)
})
