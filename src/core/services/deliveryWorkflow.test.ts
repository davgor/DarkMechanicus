import { describe, expect, it } from 'vitest'
import { baselineDeliveryPolicy } from '../../shared/domain/standardsPrompts'
import { makeBundle, sid, tid } from '../../test/bundles'
import { runRow, seedRun } from '../../test/checkpointSeed'
import { claim, startedRun, submitClaim } from '../../test/execution'
import { createTestCtx } from '../../test/testContext'
import { createKanbanCard } from './kanban/cards'
import { acceptAttempt } from './attempts'
import { getCheckpoint } from './checkpoints'
import { getSprintReport, submitSprintReport } from './reports'
import { encodeStandards, type AppliedStandard } from './workStandards'
import { itemWorkflow, pinPlanWorkflows } from './workflowPolicy'
import { checkKanbanSubmission, deliveryReportGap, verifyTicketIntegration } from './deliveryWorkflow'

const commit = 'a'.repeat(40)
const checks = [{ name: 'Delivery smoke', status: 'passed' as const, detail: 'Passed on the release revision' }]
function configured() {
  return { ...createTestCtx(), deliveryStandards: () => ({ revision: 1, policy: baselineDeliveryPolicy }) }
}

describe('project delivery workflows', () => {
  it('requires integration before accepting a work ticket and freezes the reviewed revision', async () => {
    const ctx = configured()
    const run = startedRun(ctx, { branch: { name: 'epic/1', repository: null, startCommit: null } })
    pinPlanWorkflows(ctx, run.epicId, run.bundle)
    const claimed = claim(ctx, run.runId, 1)
    submitClaim(ctx, claimed, { outputs: { summary: 'Implemented', commits: [commit] }, evidence: { checks } })
    const input = { attemptId: claimed.attempt.id, integration: { branch: 'epic/1', commit, verification: 'Integrated tests passed' } }
    expect(() => acceptAttempt(ctx, input)).toThrow('integration branch')
    const tip = { ...ctx, gitFor: () => ({ isAncestor: async () => true } as unknown as ReturnType<typeof ctx.gitFor>) }
    const verified = await verifyTicketIntegration(tip, input.attemptId, input.integration)
    expect(acceptAttempt(ctx, input, verified.passed, verified.assertCurrent).decision?.integration).toEqual(input.integration)
  })

  it('leaves the sprint running until deployment and final epic review are recorded, then requires a human checkpoint', () => {
    const ctx = configured()
    const bundle = makeBundle([[1]])
    bundle.sprints[0].checkpoint.mode = 'auto'
    const { runId, epicId } = seedRun(ctx, { bundle, autoContinue: true })
    pinPlanWorkflows(ctx, epicId, bundle)
    const report = { summary: 'Ready', changes: { files: [], commits: [commit] }, checks }
    const submit = (extra = {}) => submitSprintReport(ctx, { runId, sprintId: sid(1), report: { ...report, ...extra } })
    expect(() => submit()).toThrow('deployed revision')
    const deployment = { pullRequest: 'https://example.com/pr/18', commit, environment: 'production', version: 'v1.2',
      verification: 'Smoke test passed on the deployed build', instructions: 'Install v1.2 and open the project tab.' }
    expect(() => submit({ deployment })).toThrow('epicVerification')
    expect(runRow(ctx, runId)?.state).toBe('running')
    submit({ deployment, epicVerification: 'Verified the delivered project tab against the saved Epic standards.' })
    expect(getSprintReport(ctx, { runId })?.report.deployment).toEqual(deployment)
    expect(getCheckpoint(ctx, { runId })).toMatchObject({ policy: 'human', canAdvance: false })
  })

})

it('resolves only the claimed ticket and sprint when several items have different revised requirements', () => {
  const ctx = configured()
  const bundle = makeBundle([[1, 2], [3]])
  const { runId, epicId } = startedRun(ctx, { bundle })
  const rule = (kind: AppliedStandard['kind'], id: string, instructions: string): AppliedStandard => ({
    id, kind, revision: 3, workflow: 'custom', disposition: 'updated', reason: 'Revised tests',
    prompt: instructions, requirements: instructions, deploymentVerification: instructions
  })
  const rules = [
    rule('ticket', tid(2), 'Other ticket'), rule('sprint', sid(2), 'Other sprint'),
    rule('ticket', tid(1), 'Check staged settings'), rule('sprint', sid(1), 'Open the installed release')
  ]
  ctx.db.run('UPDATE epics SET standards_json = ? WHERE id = ?', JSON.stringify(encodeStandards(rules)), epicId)
  const packet = claim(ctx, runId, 1).packet
  expect(packet.deliveryStandards?.prompt).toBe('Check staged settings')
  expect(packet.ticket.body).toContain('Check staged settings')
  expect(packet.sprint).toMatchObject({ ordinal: 1, id: sid(1), deploymentVerification: 'Open the installed release' })
  expect(packet.sprint.goal).toContain('Sprint 1 goal')
})

it('reassesses a final sprint report against newly applied epic review requirements before approval', () => {
  const ctx = configured()
  const bundle = makeBundle([[1]])
  const { runId, epicId } = seedRun(ctx, { bundle })
  submitSprintReport(ctx, { runId, sprintId: sid(1), report: { summary: 'Report created under legacy rules' } })
  const rule: AppliedStandard = { kind: 'epic', id: epicId, revision: 2, workflow: 'custom',
    disposition: 'updated', reason: 'New release audit', prompt: 'Verify signed release manifests.' }
  ctx.db.run('UPDATE epics SET standards_json = ? WHERE id = ?', JSON.stringify(encodeStandards([rule])), epicId)
  expect(getCheckpoint(ctx, { runId }).conditions.find(c => c.id === 'report_submitted')).toMatchObject({
    met: false, detail: expect.stringContaining('epicVerification')
  })
})

describe('ticket integration evidence', () => {
  const branch = 'epic/isolated'
  const workerCommit = 'b'.repeat(40)
  const integrated = { commit, branch, verification: 'Integration tests passed' }

  async function verify(options: { submitted?: boolean; target?: string; remoteContains?: boolean; commits: string[] }) {
    const ctx = configured()
    const { runId } = startedRun(ctx, { branch: { name: branch, repository: null, startCommit: null } })
    const claimed = claim(ctx, runId, 1)
    if (options.submitted !== false) submitClaim(ctx, claimed, { outputs: { summary: 'Worker revisions', commits: options.commits } })
    const git = { isAncestor: async (left: string, right: string) =>
      (left === commit && right === 'refs/heads/' + branch && options.remoteContains !== false) ||
      (left === workerCommit && right === commit) }
    const proof = await verifyTicketIntegration({ ...ctx, gitFor: () => git as ReturnType<typeof ctx.gitFor> },
      claimed.attempt.id, { ...integrated, branch: options.target ?? branch })
    return proof.passed
  }

  it('accepts only submitted work with every worker revision reachable from the integrated revision on the bound ref', async () => {
    expect(await verify({ commits: [workerCommit] })).toBe(true)
    expect(await verify({ commits: [workerCommit], submitted: false })).toBe(false)
    expect(await verify({ commits: [workerCommit], target: 'another-epic' })).toBe(false)
    expect(await verify({ commits: [workerCommit], remoteContains: false })).toBe(false)
    expect(await verify({ commits: [] })).toBe(false)
    expect(await verify({ commits: [workerCommit, 'c'.repeat(40)] })).toBe(false)
    expect(await verify({ commits: ['main'] })).toBe(false)
  })
})

describe('delivery policy revisions', () => {
  it('requires project-specific verification when prompts customize ticket and sprint delivery', () => {
    const ctx = configured()
    ctx.deliveryStandards = () => ({ revision: 4, policy: { ...baselineDeliveryPolicy, prompts: {
      ...baselineDeliveryPolicy.prompts!, ticket: 'Review the handoff artifact.', sprint: 'Publish to the internal catalog.'
    } } })
    const bundle = makeBundle([[1]])
    const { runId, epicId } = startedRun(ctx, { bundle })
    pinPlanWorkflows(ctx, epicId, bundle)
    const claimed = claim(ctx, runId, 1)
    submitClaim(ctx, claimed)
    const attemptId = claimed.attempt.id
    expect(() => acceptAttempt(ctx, { attemptId })).toThrow('custom Ticket standards')
    expect(acceptAttempt(ctx, { attemptId, notes: 'Reviewed the handoff artifact v2.' }).decision?.standardsRevision).toBe(4)
    const card = createKanbanCard(ctx, { title: 'Produce a handoff artifact' })
    const rule = itemWorkflow(ctx, card.id, 'kanban', card.id)
    expect(() => checkKanbanSubmission(rule, { notes: '', checks: [], criteria: [] }, false)).toThrow('custom Ticket standards')
    const scope = { epicId, sprintId: sid(1), final: false }
    expect(deliveryReportGap(ctx, scope, { summary: 'Published' })).toContain('custom Sprint standards')
    expect(deliveryReportGap(ctx, scope, { summary: 'Published', standardsVerification: 'Catalog entry #32 verified.' })).toBeNull()
  })

  it('pins newly added work without changing an existing ticket when the user saves new prompts for later', () => {
    const ctx = configured()
    const first = makeBundle([[1]])
    const { epicId } = seedRun(ctx, { bundle: first })
    pinPlanWorkflows(ctx, epicId, first)
    ctx.deliveryStandards = () => ({ revision: 2, policy: { ...baselineDeliveryPolicy,
      prompts: { ...baselineDeliveryPolicy.prompts!, ticket: 'Human sign-off before integration.' } } })
    pinPlanWorkflows(ctx, epicId, makeBundle([[1, 2]]), first)
    expect(itemWorkflow(ctx, epicId, 'ticket', tid(1))).toMatchObject({ revision: 1, workflow: 'default' })
    expect(itemWorkflow(ctx, epicId, 'ticket', tid(2))).toMatchObject({ revision: 2, workflow: 'custom' })
  })
})
