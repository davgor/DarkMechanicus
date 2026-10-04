/**
 * The project's Definition of Done end to end: a planner records it, the acceptance node's packet lists it,
 * and the checkpoint stays unmet until the node's accepted attempt reports every named check as passed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../core/workspace'
import type { CheckResult, ClaimResultView, GateCondition } from '../shared/domain/views'
import { createHarness, type Harness } from '../test/workspaceHarness'

const DEFINITION = [
  { name: 'lint', command: 'npm run lint', description: 'oxlint over src and scripts' },
  { name: 'test', command: 'npm test', description: 'The unit tests' },
  { name: 'build', command: 'npm run build', description: 'electron-vite production build' }
]

interface Planned {
  epicId: string
  nodeId: string
  workId: string
}

/** One sprint: a work ticket plus the acceptance node every new epic starts with. */
async function planSprint(agent: Workspace): Promise<Planned> {
  const epic = await agent.createEpic({ title: 'Definition of Done', successCriteria: ['The sprint is verified'] })
  const [node] = (await agent.getPlan({ epicId: epic.id, view: 'draft' })).bundle.tickets
  const nodeId = node?.id ?? ''
  const update = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_ticket', ref: 'build', sprint: '1', ticket: { title: 'Build it', acceptanceCriteria: ['It builds'] } },
      { op: 'update_ticket', ticket: nodeId, patch: { acceptanceCriteria: [{ text: 'Build works', covers: 'build' }] } }
    ]
  })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
  return { epicId: epic.id, nodeId, workId: update.refMap['build'] ?? '' }
}

async function claimAndAccept(agent: Workspace, runId: string, ticketId: string, checks: CheckResult[] = []): Promise<ClaimResultView> {
  const claim = await agent.claimTicket({ runId, ticketId, worker: { label: 'worker-1' } })
  await agent.submitAttempt({
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken,
    outputs: { summary: `Delivered ${claim.packet.ticket.title}` },
    evidence: { checks }
  })
  await agent.acceptAttempt({ attemptId: claim.attempt.id, notes: 'Verified' })
  return claim
}

function passed(...names: string[]): CheckResult[] {
  return names.map((name) => ({ name, status: 'passed', detail: 'ok' }))
}

async function definitionGate(agent: Workspace, runId: string): Promise<GateCondition | undefined> {
  return (await agent.getCheckpoint({ runId })).conditions.find((item) => item.id === 'definition_of_done')
}

let harness: Harness
let planned: Planned

beforeEach(async () => {
  harness = createHarness()
  const planner = harness.open('planner')
  await planner.initializeRepository({ name: 'demo-repo' })
  planned = await planSprint(planner)
})

afterEach(() => {
  harness.cleanup()
})

describe('a project with no Definition of Done', () => {
  it('gives the sprint no definition_of_done gate and an acceptance packet without one', async () => {
    const agent = harness.open('orchestrator')
    const run = await agent.startRun({ epicId: planned.epicId })
    await claimAndAccept(agent, run.id, planned.workId)
    const node = await agent.claimTicket({ runId: run.id, ticketId: planned.nodeId, worker: { label: 'worker-2' } })
    expect(node.packet.definitionOfDone).toBeUndefined()
    expect(await definitionGate(agent, run.id)).toBeUndefined()
  })
})

/** Gives every test of the surrounding describe a project whose planner recorded the Definition of Done. */
function withDefinition(): void {
  beforeEach(async () => {
    await harness.open('planner').setDefinitionOfDone({ checks: DEFINITION })
  })
}

describe('a project with a Definition of Done: what the acceptance node is told', () => {
  withDefinition()

  it('shows the orchestrator the checks, and puts them in the acceptance node packet but not in a work packet', async () => {
    const agent = harness.open('orchestrator')
    expect((await agent.getProject()).definitionOfDone).toEqual(DEFINITION)
    const run = await agent.startRun({ epicId: planned.epicId })
    const work = await claimAndAccept(agent, run.id, planned.workId)
    expect(work.packet.definitionOfDone).toBeUndefined()
    const node = await agent.claimTicket({ runId: run.id, ticketId: planned.nodeId, worker: { label: 'worker-2' } })
    expect(node.packet.definitionOfDone).toEqual(DEFINITION)
  })

  it('stays unmet while the node awaits review, even when it reports every check as passed', async () => {
    const agent = harness.open('orchestrator')
    const run = await agent.startRun({ epicId: planned.epicId })
    await claimAndAccept(agent, run.id, planned.workId)
    const node = await agent.claimTicket({ runId: run.id, ticketId: planned.nodeId, worker: { label: 'worker-2' } })
    await agent.submitAttempt({
      attemptId: node.attempt.id,
      claimToken: node.packet.claimToken,
      outputs: { summary: 'Verified.' },
      evidence: { checks: passed('lint', 'test', 'build') }
    })
    expect(await definitionGate(agent, run.id)).toMatchObject({ met: false, detail: expect.stringContaining('no accepted attempt yet') })
  })

})

describe('a project with a Definition of Done: what the accepted node reports', () => {
  withDefinition()

  it('names the checks the accepted node did not report as passed, and blocks the sprint on them', async () => {
    const agent = harness.open('orchestrator')
    const run = await agent.startRun({ epicId: planned.epicId })
    await claimAndAccept(agent, run.id, planned.workId)
    await claimAndAccept(agent, run.id, planned.nodeId, [
      ...passed('lint'),
      { name: 'test', status: 'failed', detail: '2 failing' }
    ])
    const gate = await definitionGate(agent, run.id)
    expect(gate).toMatchObject({
      met: false,
      detail: "DR-1's accepted attempt does not report these checks as passed: test (failed), build (not reported)"
    })
    const checkpoint = await agent.getCheckpoint({ runId: run.id })
    expect([checkpoint.gatesMet, checkpoint.canAdvance]).toEqual([false, false])
  })

  it('is met once the accepted node reports every named check as passed, whatever the case of the names', async () => {
    const agent = harness.open('orchestrator')
    const run = await agent.startRun({ epicId: planned.epicId })
    await claimAndAccept(agent, run.id, planned.workId)
    await claimAndAccept(agent, run.id, planned.nodeId, passed('Lint', ' TEST', 'build'))
    expect(await definitionGate(agent, run.id)).toMatchObject({
      met: true,
      detail: 'DR-1 reports all 3 Definition of Done checks as passed'
    })
  })

  it('applies a Definition of Done changed after the run started, without restarting any session', async () => {
    const agent = harness.open('orchestrator')
    const run = await agent.startRun({ epicId: planned.epicId })
    await claimAndAccept(agent, run.id, planned.workId)
    await claimAndAccept(agent, run.id, planned.nodeId, passed('lint', 'test', 'build'))
    expect((await definitionGate(agent, run.id))?.met).toBe(true)
    await harness.open('desktop').setDefinitionOfDone({ checks: [...DEFINITION, { name: 'coverage', command: 'npm run coverage' }] })
    expect(await definitionGate(agent, run.id)).toMatchObject({ met: false, detail: expect.stringContaining('coverage (not reported)') })
  })
})
