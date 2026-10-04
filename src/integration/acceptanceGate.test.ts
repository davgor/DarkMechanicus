import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../core/workspace'
import type { RunView } from '../shared/domain/views'
import { createHarness, type Harness } from '../test/workspaceHarness'

interface Planned {
  epicId: string
  nodeId: string
  workIds: string[]
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

/** One sprint: Build and Test, plus the acceptance node every new epic starts with, covering both. */
async function planSprint(agent: Workspace): Promise<Planned> {
  await agent.initializeRepository({ name: 'demo-repo' })
  const epic = await agent.createEpic({ title: 'Gated sprint', successCriteria: ['The sprint is verified'] })
  const [node] = (await agent.getPlan({ epicId: epic.id, view: 'draft' })).bundle.tickets
  const nodeId = node?.id ?? ''
  const update = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_ticket', ref: 'build', sprint: '1', ticket: { title: 'Build it', acceptanceCriteria: ['It builds'] } },
      { op: 'add_ticket', ref: 'test', sprint: '1', ticket: { title: 'Test it', acceptanceCriteria: ['It is tested'] } },
      {
        op: 'update_ticket',
        ticket: nodeId,
        patch: {
          acceptanceCriteria: [
            { text: 'Build works end to end', covers: 'build' },
            { text: 'Tests cover it', covers: 'test' }
          ]
        }
      }
    ]
  })
  expect(update.validation).toEqual({ valid: true, errors: [], warnings: [] })
  const saved = await agent.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
  expect(saved.status).toBe('saved')
  return { epicId: epic.id, nodeId, workIds: [update.refMap['build'] ?? '', update.refMap['test'] ?? ''] }
}

async function claimSubmitAccept(agent: Workspace, runId: string, ticketId: string): Promise<string[]> {
  const claim = await agent.claimTicket({ runId, ticketId, worker: { label: 'worker-1' } })
  await agent.submitAttempt({
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken,
    outputs: { summary: `Delivered ${claim.packet.ticket.title}` },
    evidence: { checks: [{ name: 'unit tests', status: 'passed', detail: 'ok' }] }
  })
  await agent.acceptAttempt({ attemptId: claim.attempt.id, notes: 'Verified' })
  return claim.packet.predecessors.map((item) => item.ticketId)
}

async function finalReport(agent: Workspace, run: RunView, epicId: string) {
  const criterionId = (await agent.getEpic({ epicId })).successCriteria[0]?.id ?? ''
  return agent.submitSprintReport({
    runId: run.id,
    sprintId: run.activeSprintId ?? '',
    report: {
      summary: 'Sprint verified.',
      epicOutcome: { summary: 'Delivered.', successCriteria: [{ criterionId: criterionId, met: true, note: 'verified' }] }
    }
  })
}

/** A fresh temporary repository for every test of the surrounding describe. */
function useHarness(): () => Harness {
  let harness: Harness | undefined
  beforeEach(() => {
    harness = createHarness()
  })
  afterEach(() => {
    harness?.cleanup()
  })
  return () => {
    if (harness === undefined) {
      throw new Error('The harness exists only inside a test')
    }
    return harness
  }
}

describe('a sprint with an acceptance node: readiness', () => {
  const harness = useHarness()

  it('keeps the node blocked behind both work tickets and names them as prerequisites', async () => {
    const agent = harness().open('orchestrator')
    const { epicId, nodeId, workIds } = await planSprint(agent)
    const run = await agent.startRun({ epicId })
    const readiness = await agent.getReadyTickets({ runId: run.id })
    expect(readiness.ready.map((ticket) => ticket.ticketId).sort()).toEqual([...workIds].sort())
    const node = readiness.blocked.find((ticket) => ticket.ticketId === nodeId)
    expect(node?.state).toBe('waiting')
    expect(node?.prerequisites.map((item) => item.ticketId)).toEqual(workIds)
    expect(node?.blockers.map((item) => item.kind)).toEqual(['prerequisite', 'prerequisite'])
    expect(await codeOf(agent.claimTicket({ runId: run.id, ticketId: nodeId, worker: { label: 'eager' } }))).toBe(
      'unmet_prerequisite'
    )
    const shown = (await agent.getRun({ runId: run.id }))?.tickets.find((ticket) => ticket.ticketId === nodeId)
    expect(shown?.prerequisites.map((item) => item.ticketId)).toEqual(workIds)
  })

  it('opens the node after the second work ticket is accepted, not after the first', async () => {
    const agent = harness().open('orchestrator')
    const { epicId, nodeId, workIds } = await planSprint(agent)
    const run = await agent.startRun({ epicId })
    await claimSubmitAccept(agent, run.id, workIds[0] ?? '')
    const half = await agent.getReadyTickets({ runId: run.id })
    expect(half.ready.map((ticket) => ticket.ticketId)).toEqual([workIds[1]])
    expect(half.blocked.find((ticket) => ticket.ticketId === nodeId)?.blockers).toHaveLength(1)
    await claimSubmitAccept(agent, run.id, workIds[1] ?? '')
    expect((await agent.getReadyTickets({ runId: run.id })).ready.map((ticket) => ticket.ticketId)).toEqual([nodeId])
  })
})

describe('a sprint with an acceptance node: checkpoint', () => {
  const harness = useHarness()

  it('cannot be approved until the node is accepted, and acceptance alone leaves the increment gate unmet', async () => {
    const agent = harness().open('orchestrator')
    const desktop = harness().open('desktop')
    const { epicId, nodeId, workIds } = await planSprint(agent)
    const run = await agent.startRun({ epicId })
    for (const id of workIds) {
      await claimSubmitAccept(agent, run.id, id)
    }
    const early = await finalReport(agent, run, epicId)
    const waiting = await desktop.getCheckpoint({ runId: run.id })
    expect(waiting.conditions.find((item) => item.id === 'acceptance_accepted')).toMatchObject({ met: false })
    expect([waiting.gatesMet, waiting.canAdvance]).toEqual([false, false])
    expect(await codeOf(desktop.approveAndAdvance({ runId: run.id, reportId: early.id }))).toBe('gate_blocked')
    expect(await codeOf(agent.advanceSprint({ runId: run.id }))).toBe('gate_blocked')

    await agent.pauseRun({ runId: run.id, reason: 'Finish the acceptance node first' })
    await agent.resumeRun({ runId: run.id })
    expect(await claimSubmitAccept(agent, run.id, nodeId)).toEqual(workIds)
    const report = await finalReport(agent, run, epicId)
    const checkpoint = await desktop.getCheckpoint({ runId: run.id })
    expect(checkpoint.conditions.find((item) => item.id === 'acceptance_accepted')).toMatchObject({ met: true })
    // The node named no increment, so the checkpoint still cannot be passed. A node whose increment verified
    // reaches an approvable checkpoint and completes the epic in src/integration/incrementMerged.test.ts.
    expect(checkpoint.conditions.find((item) => item.id === 'increment_merged')).toMatchObject({ met: false })
    expect([checkpoint.gatesMet, checkpoint.canAdvance]).toEqual([false, false])
    expect(await codeOf(desktop.approveAndAdvance({ runId: run.id, reportId: report.id }))).toBe('gate_blocked')
  })
})
