import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftOp } from '../shared/domain/api'
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
  refs: Record<string, string>
}

async function planForkJoin(agent: Workspace): Promise<Planned> {
  await agent.initializeRepository({ name: 'demo-repo' })
  const epic = await agent.createEpic({ title: 'Fork and join', intent: 'Prove parallel work and a join.' })
  const update = await agent.updatePlanDraft({ epicId: epic.id, ops: FORK_JOIN, expectedDraftRevision: 1 })
  expect(update.validation.errors).toEqual([])
  const saved = await agent.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
  expect(saved.status).toBe('saved')
  return { epicId: epic.id, refs: update.refMap }
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

describe('repository lifecycle through the Workspace', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('refuses work before initialization and creates the layout on initialize', async () => {
    const agent = harness.open('orchestrator')
    const before = await agent.getCapabilities()
    expect(before.initialized).toBe(false)
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
    const { epicId, refs } = await planForkJoin(agent)

    const saved = await agent.getPlan({ epicId, view: 'saved' })
    expect(saved.revisionNumber).toBe(1)
    expect(saved.bundle.tickets.map((ticket) => ticket.title)).toEqual(['Schema', 'API', 'UI', 'Integration pass'])
    const pointer = join(harness.root, '.darkmechanicus', 'epics', epicId, 'current.json')
    expect(JSON.parse(readFileSync(pointer, 'utf8')).revisionId).toBe(saved.revisionId)

    const rejected = agent.updatePlanDraft({ epicId, ops: [{ op: 'add_dependency', from: refs['d'] ?? '', to: refs['a'] ?? '' }] })
    await expect(rejected).rejects.toMatchObject({ code: 'invalid_graph' })
    await expect(agent.updatePlanDraft({ epicId, ops: [{ op: 'add_dependency', from: refs['d'] ?? '', to: refs['a'] ?? '' }] }))
      .rejects.toThrow(/can't require/)
  })

  it('surfaces stale draft edits as conflicts between the desktop and an agent', async () => {
    const agent = harness.open('orchestrator')
    const desktop = harness.open('desktop')
    const { epicId } = await planForkJoin(agent)

    const draft = await desktop.openDraft({ epicId })
    await agent.updatePlanDraft({
      epicId,
      ops: [{ op: 'set_rationale', rationale: 'Agent edit' }],
      expectedDraftRevision: draft.draftRevision ?? 0
    })
    const stale = desktop.updatePlanDraft({
      epicId,
      ops: [{ op: 'set_rationale', rationale: 'Desktop edit' }],
      expectedDraftRevision: draft.draftRevision ?? 0
    })
    expect(await codeOf(stale)).toBe('conflict')
    expect((await desktop.getPlan({ epicId, view: 'draft' })).bundle.rationale).toBe('Agent edit')
  })

  it('only lets a planner save when launched with --allow-save', async () => {
    const setup = harness.open('orchestrator')
    await setup.initializeRepository({ name: 'demo-repo' })
    const planner = harness.open('planner', { allowSave: false })
    const epic = await planner.createEpic({ title: 'Planner epic' })
    const update = await planner.updatePlanDraft({
      epicId: epic.id,
      ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'One' } }]
    })
    expect(await codeOf(planner.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision }))).toBe('unauthorized')
  })

  it('runs parallel branches, blocks the join, rejects stale workers, and gates sprints on human approval', async () => {
    const agent = harness.open('orchestrator')
    const desktop = harness.open('desktop')
    const { epicId, refs } = await planForkJoin(agent)
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((ref) => refs[ref] ?? '')

    const run = await agent.startRun({ epicId, host: { label: 'Test host', type: 'test' } })
    expect((await agent.getReadyTickets({ runId: run.id })).ready.map((ticket) => ticket.ticketId)).toEqual([a])

    const claim = await agent.claimTicket({ runId: run.id, ticketId: a ?? '', worker: { label: 'w1' } })
    expect(await codeOf(agent.claimTicket({ runId: run.id, ticketId: a ?? '', worker: { label: 'w2' } }))).toBe('already_claimed')
    await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'schema done' } })
    expect((await agent.getReadyTickets({ runId: run.id })).ready).toEqual([])
    await agent.acceptAttempt({ attemptId: claim.attempt.id })

    const ready = (await agent.getReadyTickets({ runId: run.id })).ready.map((ticket) => ticket.ticketId).sort()
    expect(ready).toEqual([b, c].sort())

    await claimSubmitAccept(agent, run.id, b ?? '')
    const lost = await agent.claimTicket({ runId: run.id, ticketId: c ?? '', worker: { label: 'flaky', modelId: null }, leaseSeconds: 60 })
    harness.clock.advanceSeconds(120)
    expect(await codeOf(agent.heartbeatAttempt({ attemptId: lost.attempt.id, claimToken: lost.packet.claimToken }))).toBe('expired_claim')
    expect(await codeOf(agent.claimTicket({ runId: run.id, ticketId: c ?? '', worker: { label: 'w3' } }))).toBe('needs_reconciliation')
    await agent.reconcileAttempt({ attemptId: lost.attempt.id, resolution: 'abandon', notes: 'worker vanished' })
    const retry = await agent.claimTicket({ runId: run.id, ticketId: c ?? '', worker: { label: 'w3' } })
    const staleSubmit = agent.submitAttempt({ attemptId: lost.attempt.id, claimToken: lost.packet.claimToken, outputs: { summary: 'late' } })
    expect(await codeOf(staleSubmit)).toMatch(/stale_claim|expired_claim/)
    await agent.submitAttempt({ attemptId: retry.attempt.id, claimToken: retry.packet.claimToken, outputs: { summary: 'ui done' } })
    await agent.acceptAttempt({ attemptId: retry.attempt.id })

    const sprintOne = (await agent.getPlan({ epicId, view: 'saved' })).bundle.sprints[0]?.id ?? ''
    const report = await agent.submitSprintReport({ runId: run.id, sprintId: sprintOne, report: { summary: 'Sprint 1 delivered all parts.' } })
    expect(await codeOf(agent.advanceSprint({ runId: run.id }))).toBe('approval_required')
    expect(await codeOf(agent.approveCheckpoint({ runId: run.id, reportId: report.id }))).toBe('unauthorized')

    const checkpoint = await desktop.getCheckpoint({ runId: run.id })
    expect(checkpoint.gatesMet).toBe(true)
    expect(checkpoint.canAdvance).toBe(false)
    const advanced = await desktop.approveAndAdvance({ runId: run.id, reportId: report.id })
    expect(advanced.state).toBe('running')
    expect(advanced.activeSprintOrdinal).toBe(2)

    await claimSubmitAccept(agent, run.id, d ?? '')
    const epic = await agent.getEpic({ epicId })
    const criterionId = epic.successCriteria[0]?.id ?? ''
    const sprintTwo = advanced.activeSprintId ?? ''
    const finalReport = await agent.submitSprintReport({
      runId: run.id,
      sprintId: sprintTwo,
      report: {
        summary: 'Integrated.',
        epicOutcome: { summary: 'Delivered.', successCriteria: [{ criterionId, met: true, note: 'verified' }] }
      }
    })
    const completed = await desktop.approveAndAdvance({ runId: run.id, reportId: finalReport.id })
    expect(completed.state).toBe('completed')
    expect((await agent.getEpic({ epicId })).status).toBe('completed')
    expect(await codeOf(desktop.openDraft({ epicId }))).toBe('completed_epic')
    expect(await codeOf(desktop.queueRun({ epicId }))).toBe('completed_epic')
  })

  it('reconstructs saved state and history in a clone without the local database', async () => {
    const agent = harness.open('orchestrator')
    const { epicId, refs } = await planForkJoin(agent)
    const run = await agent.startRun({ epicId })
    await claimSubmitAccept(agent, run.id, refs['a'] ?? '')

    const clone = harness.cloneTracked()
    expect(existsSync(join(clone, '.darkmechanicus', 'local'))).toBe(false)
    const reopened = harness.open('orchestrator', { root: clone })
    const epics = await reopened.listEpics()
    expect(epics.map((epic) => [epic.id, epic.status])).toEqual([[epicId, 'in_progress']])
    const plan = await reopened.getPlan({ epicId, view: 'saved' })
    expect(plan.bundle.tickets).toHaveLength(4)
    const history = await reopened.getRun({ epicId })
    expect(history?.attempts.some((attempt) => attempt.state === 'accepted')).toBe(true)
    expect(history?.ownedByThisMachine).toBe(false)
    const found = await reopened.searchHistory({ query: 'Schema' })
    expect(found.some((result) => result.epicId === epicId)).toBe(true)
  })
})
