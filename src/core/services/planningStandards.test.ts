import { expect, it } from 'vitest'
import { defaultPrompts, baselineDeliveryPolicy } from '../../shared/domain/standardsPrompts'
import { createSavedEpic, saveNow } from '../../test/authoring'
import { claim, startedRun } from '../../test/execution'
import { createTestCtx, withRole } from '../../test/testContext'
import { planBundle, ticketInput } from '../schemas'
import { openDraft, updatePlanDraft } from './drafts'
import { createEpic } from './epics'
import { claimKanbanCard, playKanbanCard } from './kanban/attempts'
import { createKanbanCard } from './kanban/cards'
import { pinPlanWorkflows } from './workflowPolicy'
import { getPlan, requestSave, validatePlanView } from './plans'

const standards = {
  revision: 7,
  policy: { ...baselineDeliveryPolicy, prompts: { ...defaultPrompts, planned: 'Demonstrate per-member persistence with two repositories.' } }
}
const testCase = {
  startingCondition: 'Two members share a Forge World.',
  action: 'Edit the first member and reopen both.',
  expectedResult: 'Only the first member changes.',
  verificationMethod: 'Compare the two persisted policy revisions.'
}
const deploymentVerification = 'Open the installed release, reopen the two members, and compare their saved prompts.'

it('requires concrete cases and verification on new work and carries them into the saved snapshot', () => {
  const ctx = createTestCtx()
  ctx.deliveryStandards = () => standards
  const epicId = createEpic(ctx, { title: 'Forge members' }).id
  expect(openDraft(ctx, { epicId }).deliveryStandards).toEqual(standards)
  const draft = updatePlanDraft(ctx, { epicId, ops: [
    { op: 'add_ticket', ref: 'member', sprint: '1', ticket: { title: 'Isolate member settings' } }
  ] })
  expect(draft.validation.errors.map(issue => issue.code)).toEqual(['missing_test_cases', 'missing_deployment_verification'])
  expect(() => requestSave(ctx, { epicId, expectedDraftRevision: draft.draftRevision })).toThrow()
  updatePlanDraft(ctx, { epicId, ops: [
    { op: 'update_sprint', sprint: '1', patch: { goal: 'Set independent standards per member', deploymentVerification } },
    { op: 'update_ticket', ticket: draft.refMap.member!, patch: { testCases: [testCase] } }
  ] })
  expect(validatePlanView(ctx, { epicId, view: 'draft' }).valid).toBe(true)
  saveNow(ctx, epicId)
  const saved = planBundle.parse(getPlan(ctx, { epicId, view: 'saved' }).bundle)
  expect(saved.sprints[0]?.deploymentVerification).toBe(deploymentVerification)
  expect(saved.tickets.find(t => t.id === draft.refMap.member)?.testCases).toEqual([testCase])
  expect(ticketInput.safeParse({ title: 'Discard blank checks', testCases: [{ ...testCase, verificationMethod: '   ' }] }).success).toBe(false)
})

it('retains unchanged legacy items while validating an edited implementation ticket', () => {
  const ctx = createTestCtx()
  const { epicId, refMap } = createSavedEpic(ctx)
  ctx.deliveryStandards = () => standards
  openDraft(ctx, { epicId })
  expect(validatePlanView(ctx, { epicId, view: 'draft' }).valid).toBe(true)
  const result = updatePlanDraft(ctx, { epicId, ops: [{ op: 'update_ticket', ticket: refMap.a!, patch: { body: 'Revised implementation' } }] })
  expect(result.validation.errors.map(e => e.ticketIds)).toEqual([[refMap.a]])
})

it('supplies the selected project revision and prompts on epic and standalone claims', () => {
  const ctx = createTestCtx()
  const { runId, epicId, bundle } = startedRun(ctx)
  ctx.deliveryStandards = () => standards
  pinPlanWorkflows(ctx, epicId, bundle)
  const expected = { revision: standards.revision, prompt: defaultPrompts.ticket }
  expect(claim(ctx, runId, 1).packet.deliveryStandards).toEqual(expected)
  const desktop = withRole(ctx, 'desktop')
  desktop.deliveryStandards = () => standards
  const card = createKanbanCard(desktop, { title: 'Prepare isolated work' })
  playKanbanCard(desktop, { cardId: card.id })
  ctx.deliveryStandards = () => ({ revision: 8, policy: { ...standards.policy, prompts: { ...defaultPrompts, ticket: 'Later rules' } } })
  const packet = claimKanbanCard(ctx, { cardId: card.id })
  expect(packet.deliveryStandards).toEqual(expected)
  expect(packet.reporting.instructions).toContain('evidence.merge')
})
