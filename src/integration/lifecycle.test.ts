import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftOp } from '../shared/domain/api'
import type { RunView } from '../shared/domain/views'
import { createHarness, type Harness } from '../test/workspaceHarness'
import type { Workspace } from '../core/workspace'

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

const FORK_JOIN: DraftOp[] = [
  { op: 'set_epic', successCriteria: ['Every ticket delivered'] },
  { op: 'update_sprint', sprint: '1', patch: { goal: 'Build the parts' } },
  { op: 'add_sprint', ref: 's2', sprint: { goal: 'Integrate' } },
  { op: 'add_ticket', ref: 'a', sprint: '1', ticket: { title: 'Schema', acceptanceCriteria: ['Tables exist'] } },
  { op: 'add_ticket', ref: 'b', sprint: '1', ticket: { title: 'API', acceptanceCriteria: ['Endpoints respond'] } },
  { op: 'add_ticket', ref: 'c', sprint: '1', ticket: { title: 'UI', acceptanceCriteria: ['Screens render'] } },
  { op: 'add_ticket', ref: 'd', sprint: 's2', ticket: { title: 'Integration pass', acceptanceCriteria: ['All parts work together'] } },
  { op: 'add_dependency', from: 'a', to: 'b' },
  { op: 'add_dependency', from: 'a', to: 'c' },
  { op: 'add_dependency', from: 'b', to: 'd' },
  { op: 'add_dependency', from: 'c', to: 'd' }
]

interface Planned {
  epicId: string
  ids: { a: string; b: string; c: string; d: string }
}

function refId(refs: Record<string, string>, ref: string): string {
  const id = refs[ref]
  if (id === undefined) {
    throw new Error(`ref ${ref} was not assigned`)
  }
  return id
}

async function planForkJoin(agent: Workspace): Promise<Planned> {
  await agent.initializeRepository({ name: 'demo-repo' })
  const epic = await agent.createEpic({ title: 'Fork and join', intent: 'Prove parallel work and a join.' })
  const update = await agent.updatePlanDraft({ epicId: epic.id, ops: FORK_JOIN, expectedDraftRevision: 1 })
  expect(update.validation.errors).toEqual([])
  const saved = await agent.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
  expect(saved.status).toBe('saved')
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((ref) => refId(update.refMap, ref))
  return { epicId: epic.id, ids: { a: a ?? '', b: b ?? '', c: c ?? '', d: d ?? '' } }
}

async function claimSubmitAccept(agent: Workspace, runId: string, ticketId: string): Promise<void> {
  const claim = await agent.claimTicket({ runId, ticketId, worker: { label: 'worker-1', modelId: null } })
  await agent.submitAttempt({
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken,
    outputs: { summary: `Delivered ${claim.packet.ticket.title}` },
    evidence: { checks: [{ name: 'unit tests', status: 'passed', detail: '12 passed' }] }
  })
  await agent.acceptAttempt({ attemptId: claim.attempt.id, notes: 'Criteria verified' })
}

async function readyIds(agent: Workspace, runId: string): Promise<string[]> {
  return (await agent.getReadyTickets({ runId })).ready.map((ticket) => ticket.ticketId).sort()
}

/** Sprint 1: the fork opens after A is accepted; a submission alone never unlocks it. */
async function forkAfterAcceptance(agent: Workspace, runId: string, planned: Planned): Promise<void> {
  const { a, b, c } = planned.ids
  expect(await readyIds(agent, runId)).toEqual([a])
  const claim = await agent.claimTicket({ runId, ticketId: a, worker: { label: 'w1' } })
  expect(await codeOf(agent.claimTicket({ runId, ticketId: a, worker: { label: 'w2' } }))).toBe('already_claimed')
  await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'schema done' } })
  expect(await readyIds(agent, runId)).toEqual([])
  await agent.acceptAttempt({ attemptId: claim.attempt.id })
  expect(await readyIds(agent, runId)).toEqual([b, c].sort())
}

/** A lost worker's lease expires; the ticket needs reconciliation and the stale token stops working. */
async function recoverLostWorker(harness: Harness, agent: Workspace, runId: string, ticketId: string): Promise<void> {
  const lost = await agent.claimTicket({ runId, ticketId, worker: { label: 'flaky' }, leaseSeconds: 60 })
  harness.clock.advanceSeconds(120)
  expect(await codeOf(agent.heartbeatAttempt({ attemptId: lost.attempt.id, claimToken: lost.packet.claimToken }))).toBe('expired_claim')
  expect(await codeOf(agent.claimTicket({ runId, ticketId, worker: { label: 'w3' } }))).toBe('needs_reconciliation')
  await agent.reconcileAttempt({ attemptId: lost.attempt.id, resolution: 'abandon', notes: 'worker vanished' })
  const retry = await agent.claimTicket({ runId, ticketId, worker: { label: 'w3' } })
  const late = agent.submitAttempt({ attemptId: lost.attempt.id, claimToken: lost.packet.claimToken, outputs: { summary: 'late' } })
  expect(await codeOf(late)).toMatch(/stale_claim|expired_claim/)
  await agent.submitAttempt({ attemptId: retry.attempt.id, claimToken: retry.packet.claimToken, outputs: { summary: 'ui done' } })
  await agent.acceptAttempt({ attemptId: retry.attempt.id })
}

/** Only the desktop can approve; the orchestrator's advance waits for the person. */
async function approveFirstCheckpoint(agent: Workspace, desktop: Workspace, epicId: string, runId: string): Promise<RunView> {
  const sprintOne = (await agent.getPlan({ epicId, view: 'saved' })).bundle.sprints[0]?.id ?? ''
  const report = await agent.submitSprintReport({ runId, sprintId: sprintOne, report: { summary: 'Sprint 1 delivered all parts.' } })
  expect(await codeOf(agent.advanceSprint({ runId }))).toBe('approval_required')
  expect(await codeOf(agent.approveCheckpoint({ runId, reportId: report.id }))).toBe('unauthorized')
  const checkpoint = await desktop.getCheckpoint({ runId })
  expect([checkpoint.gatesMet, checkpoint.canAdvance]).toEqual([true, false])
  return desktop.approveAndAdvance({ runId, reportId: report.id })
}

async function completeEpic(agent: Workspace, desktop: Workspace, epicId: string, run: RunView): Promise<RunView> {
  const criterionId = (await agent.getEpic({ epicId })).successCriteria[0]?.id ?? ''
  const finalReport = await agent.submitSprintReport({
    runId: run.id,
    sprintId: run.activeSprintId ?? '',
    report: {
      summary: 'Integrated.',
      epicOutcome: { summary: 'Delivered.', successCriteria: [{ criterionId, met: true, note: 'verified' }] }
    }
  })
  return desktop.approveAndAdvance({ runId: run.id, reportId: finalReport.id })
}

describe('repository lifecycle: initialization and planning', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('refuses work before initialization and creates the layout on initialize', async () => {
    const agent = harness.open('orchestrator')
    expect((await agent.getCapabilities()).initialized).toBe(false)
    expect(await codeOf(agent.listEpics())).toBe('not_initialized')
    const result = await agent.initializeRepository({ name: 'demo-repo' })
    expect(result.alreadyInitialized).toBe(false)
    expect(existsSync(join(harness.root, '.darkmechanicus', 'project.json'))).toBe(true)
    expect(readFileSync(join(harness.root, '.darkmechanicus', '.gitignore'), 'utf8')).toBe('local/\n')
    expect(await agent.listEpics()).toEqual([])
    expect((await agent.initializeRepository({})).alreadyInitialized).toBe(true)
  })

  it('saves a fork/join plan as an immutable snapshot and rejects a later-sprint prerequisite', async () => {
    const agent = harness.open('orchestrator')
    const { epicId, ids } = await planForkJoin(agent)
    const saved = await agent.getPlan({ epicId, view: 'saved' })
    expect(saved.revisionNumber).toBe(1)
    expect(saved.bundle.tickets.map((ticket) => ticket.title)).toEqual(['Schema', 'API', 'UI', 'Integration pass'])
    const pointer = join(harness.root, '.darkmechanicus', 'epics', epicId, 'current.json')
    expect(JSON.parse(readFileSync(pointer, 'utf8')).revisionId).toBe(saved.revisionId)
    const rejected = agent.updatePlanDraft({ epicId, ops: [{ op: 'add_dependency', from: ids.d, to: ids.a }] })
    await expect(rejected).rejects.toMatchObject({ code: 'invalid_graph', message: expect.stringMatching(/can't require/) })
  })
})

describe('repository lifecycle: concurrent editing and permissions', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('surfaces stale draft edits as conflicts between the desktop and an agent', async () => {
    const agent = harness.open('orchestrator')
    const desktop = harness.open('desktop')
    const { epicId } = await planForkJoin(agent)
    const draft = await desktop.openDraft({ epicId })
    const expected = draft.draftRevision ?? 0
    await agent.updatePlanDraft({ epicId, ops: [{ op: 'set_rationale', rationale: 'Agent edit' }], expectedDraftRevision: expected })
    const stale = desktop.updatePlanDraft({ epicId, ops: [{ op: 'set_rationale', rationale: 'Desktop edit' }], expectedDraftRevision: expected })
    expect(await codeOf(stale)).toBe('conflict')
    expect((await desktop.getPlan({ epicId, view: 'draft' })).bundle.rationale).toBe('Agent edit')
  })

  it('only lets a planner save when launched with --allow-save', async () => {
    await harness.open('orchestrator').initializeRepository({ name: 'demo-repo' })
    const planner = harness.open('planner', { allowSave: false })
    const epic = await planner.createEpic({ title: 'Planner epic' })
    const update = await planner.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'One' } }] })
    expect(await codeOf(planner.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision }))).toBe('unauthorized')
  })
})

describe('repository lifecycle: execution and checkpoints', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('runs parallel branches, blocks the join, rejects stale workers, and gates sprints on human approval', async () => {
    const agent = harness.open('orchestrator')
    const desktop = harness.open('desktop')
    const planned = await planForkJoin(agent)
    const run = await agent.startRun({ epicId: planned.epicId, host: { label: 'Test host', type: 'test' } })
    await forkAfterAcceptance(agent, run.id, planned)
    await claimSubmitAccept(agent, run.id, planned.ids.b)
    await recoverLostWorker(harness, agent, run.id, planned.ids.c)
    const advanced = await approveFirstCheckpoint(agent, desktop, planned.epicId, run.id)
    expect([advanced.state, advanced.activeSprintOrdinal]).toEqual(['running', 2])
    await claimSubmitAccept(agent, run.id, planned.ids.d)
    const completed = await completeEpic(agent, desktop, planned.epicId, advanced)
    expect(completed.state).toBe('completed')
    expect((await agent.getEpic({ epicId: planned.epicId })).status).toBe('completed')
    expect(await codeOf(desktop.openDraft({ epicId: planned.epicId }))).toBe('completed_epic')
    expect(await codeOf(desktop.queueRun({ epicId: planned.epicId }))).toBe('completed_epic')
  })

  it('reconstructs saved state and history in a clone without the local database', async () => {
    const agent = harness.open('orchestrator')
    const { epicId, ids } = await planForkJoin(agent)
    const run = await agent.startRun({ epicId })
    await claimSubmitAccept(agent, run.id, ids.a)
    const clone = harness.cloneTracked()
    expect(existsSync(join(clone, '.darkmechanicus', 'local'))).toBe(false)
    const reopened = harness.open('orchestrator', { root: clone })
    const epics = await reopened.listEpics()
    expect(epics.map((epic) => [epic.id, epic.status])).toEqual([[epicId, 'in_progress']])
    expect((await reopened.getPlan({ epicId, view: 'saved' })).bundle.tickets).toHaveLength(4)
    const history = await reopened.getRun({ epicId })
    expect(history?.attempts.some((attempt) => attempt.state === 'accepted')).toBe(true)
    expect(history?.ownedByThisMachine).toBe(false)
    const found = await reopened.searchHistory({ query: 'Schema' })
    expect(found.some((result) => result.epicId === epicId)).toBe(true)
  })
})
