import { afterEach, beforeEach, expect, it } from 'vitest'
import { baselineDeliveryPolicy } from './deliveryPolicySchema'
import type { StandardizationPatch } from '../shared/domain/standardization'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { createHarness, type Harness } from '../test/workspaceHarness'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

it('accounts for all work, applies active-ticket changes once, and delivers them to the worker and run', async () => {
  const w = h.open('desktop')
  await w.initializeRepository({ name: 'Existing work' })
  const epic = await w.createEpic({ title: 'Recover the restore workflow' })
  await dropAcceptanceNodes(w, epic.id)
  const draft = await w.updatePlanDraft({ epicId: epic.id, ops: [
    { op: 'add_ticket', sprint: '1', ticket: { title: 'Check restored files' } }
  ] })
  await w.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const orchestrator = h.open('orchestrator')
  const run = await orchestrator.startRun({ epicId: epic.id })
  const ticket = (await w.listTickets({ epicId: epic.id, view: 'saved' }))[0]!
  const claim = await orchestrator.claimTicket({ runId: run.id, ticketId: ticket.id, worker: { label: 'Restore worker' } })
  const card = await w.createKanbanCard({ title: 'Review existing recovery notes' })
  const before = await w.getKanbanCard({ cardId: card.id })
  const saved = await w.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
  const scope = { expectedRevision: saved.revision, includeInProgress: true }
  const inventory = await w.standardizeProjectWork(scope)
  expect(inventory.items.map(i => i.kind).sort()).toEqual(['epic','kanban','sprint','ticket'])
  const patch: StandardizationPatch = { kind: 'ticket', id: ticket.id, epicId: epic.id, disposition: 'updated',
    requirements: 'Compare the restored archive to its manifest.', acceptanceCriteria: ['Every file matches its recorded digest.'],
    testCases: [{ startingCondition: 'The archive contains a corrupted file.', action: 'Run restore.',
      expectedResult: 'Restore reports the corrupt file.', verificationMethod: 'Check the diagnostic names its path.' }],
    reason: 'The original restore check did not exercise corruption.' }
  await expect(w.standardizeProjectWork({ ...scope, includeInProgress: false, items: [patch] })).rejects.toThrow('override')
  await w.standardizeProjectWork({ ...scope, items: [patch] })
  const eventCount = () => w.ctx().db.get<{n:number}>("SELECT COUNT(*) AS n FROM events WHERE kind = 'delivery.requirements_reviewed'")!.n
  const first = eventCount()
  await w.standardizeProjectWork({ ...scope, items: [patch] })
  expect(eventCount()).toBe(first)
  const worker = h.open('worker')
  expect((await worker.heartbeatAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken! })).deliveryRequirements)
    .toMatchObject({ revision: saved.revision, requirements: patch.requirements, testCases: patch.testCases, acceptanceCriteria: patch.acceptanceCriteria })
  const changed = await w.getTicket({ epicId: epic.id, ticketId: ticket.id, view: 'saved' })
  expect(changed.ticket).toMatchObject({ id: ticket.id, testCases: patch.testCases })
  expect(changed.ticket.acceptanceCriteria.map(c => c.text)).toContain(patch.acceptanceCriteria![0])
  expect((await w.listEvents({ runId: run.id })).events).toContainEqual(expect.objectContaining({
    kind: 'delivery.requirements_reviewed', payload: expect.objectContaining({ item: expect.objectContaining({ testCases: patch.testCases }) })
  }))
  const remaining: StandardizationPatch[] = inventory.items.filter(i => i.id !== ticket.id).map(i => ({
    id: i.id, kind: i.kind, epicId: i.epicId, disposition: 'compliant', reason: 'Reviewed current requirements against the project policy.'
  }))
  const completed = await w.standardizeProjectWork({ ...scope, items: remaining })
  expect(completed.items.some(i => i.disposition === 'pending')).toBe(false)
  expect((await w.getKanbanCard({ cardId: card.id })).attempts).toEqual(before.attempts)
  const clone = h.open('desktop', { root: h.cloneTracked() })
  expect((await clone.standardizeProjectWork(scope)).items.map(i => i.disposition).sort()).toEqual(['compliant','compliant','compliant','updated'])
})

it('keeps completed evidence intact and rejects an obsolete revision', async () => {
  const w = h.open('desktop')
  await w.initializeRepository({ name: 'Done cards' })
  const card = await w.createKanbanCard({ title: 'Shipped change' })
  w.ctx().db.run("UPDATE kanban_cards SET lane = 'done', summary_json = ? WHERE id = ?", '{"commit":"abc123"}', card.id)
  await w.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
  const scope = { expectedRevision: 1, includeInProgress: true }
  const target = { kind: 'kanban' as const, id: card.id, reason: 'Historical evidence lacks the deployed revision.' }
  await expect(w.standardizeProjectWork({ ...scope, items: [{ ...target, disposition: 'updated', requirements: 'Verify rollout.' }] })).rejects.toThrow('completed evidence')
  const result = await w.standardizeProjectWork({ ...scope, items: [{ ...target, disposition: 'follow_up' }] })
  expect(result.items).toMatchObject([{ id: card.id, completed: true, disposition: 'follow_up' }])
  expect(w.ctx().db.get<{summary_json:string}>('SELECT summary_json FROM kanban_cards WHERE id = ?', card.id)?.summary_json).toBe('{"commit":"abc123"}')
  await expect(w.standardizeProjectWork({ ...scope, expectedRevision: 2 })).rejects.toThrow('Reload')
})


it('delivers a revised card to its current worker and retains the approved contract after another policy save', async () => {
  const w = h.open('desktop')
  await w.initializeRepository({ name: 'Existing board' })
  const card = await w.createKanbanCard({ title: 'Recover a missing account', acceptanceCriteria: ['Retain access history.'] })
  await w.playKanbanCard({ cardId: card.id })
  const orchestrator = h.open('orchestrator')
  const packet = await orchestrator.claimKanbanCard({ cardId: card.id })
  const worker = h.open('worker')
  await w.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
  const patch: StandardizationPatch = { kind: 'kanban', id: card.id, disposition: 'updated',
    requirements: 'Record the recovered account ID.', acceptanceCriteria: ['The account ID matches its recovery record.'],
    reason: 'Recovery needs a stable audit identifier.' }
  await w.standardizeProjectWork({ expectedRevision: 1, includeInProgress: true, items: [patch] })
  await w.setDeliveryStandards({ expectedRevision: 1, policy: { ...baselineDeliveryPolicy, sprint: 'Verify staging.' } })
  expect((await worker.heartbeatKanbanCard({ attemptId: packet.attemptId, claimToken: packet.claimToken! })).deliveryRequirements)
    .toMatchObject({ revision: 1, requirements: patch.requirements, acceptanceCriteria: patch.acceptanceCriteria })
  const detail = await w.getKanbanCard({ cardId: card.id })
  expect(detail.body).toContain(patch.requirements)
  expect(detail.acceptanceCriteria.map(c => c.text)).toEqual(['Retain access history.', ...patch.acceptanceCriteria!])
  expect((await w.standardizeProjectWork({ expectedRevision: 2, includeInProgress: true })).items)
    .toMatchObject([{ active: true, disposition: 'pending' }])
})
