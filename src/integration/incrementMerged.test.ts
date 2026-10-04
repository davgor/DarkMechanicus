/**
 * A sprint reaches the epic branch as one squashed commit, and the server checks that instead of trusting
 * it: the acceptance node's submission names the increment, the server verifies it against a real
 * temporary repository and stores the verdict, and the `increment_merged` gate reads it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitAdapter } from '../core/repo/git'
import type { Workspace } from '../core/workspace'
import type { AttemptView, CheckpointView, GateCondition, RunView } from '../shared/domain/views'
import { createGitRepo, type GitRepo } from '../test/gitRepo'
import { createHarness, type Harness } from '../test/workspaceHarness'

const EPIC_BRANCH = 'epic/x'

interface Scene {
  repo: GitRepo
  harness: Harness
  orchestrator: Workspace
  desktop: Workspace
  /** The commit the epic branch started from. */
  start: string
}

interface Planned {
  epicId: string
  nodeId: string
  workId: string
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

/** A real repository with the epic branch checked out, and a workspace on it for each role. */
function useScene(): () => Scene {
  let scene: Scene | undefined
  beforeEach(() => {
    const repo = createGitRepo()
    const start = repo.rev('main')
    repo.branch(EPIC_BRANCH)
    const harness = createHarness()
    const git = createGitAdapter(repo.root)
    const open = (role: 'orchestrator' | 'desktop') => harness.open(role, { root: repo.root, git })
    scene = { repo, harness, orchestrator: open('orchestrator'), desktop: open('desktop'), start }
  })
  afterEach(() => {
    scene?.harness.cleanup()
    scene?.repo.cleanup()
    scene = undefined
  })
  return () => {
    if (scene === undefined) {
      throw new Error('The scene exists only inside a test')
    }
    return scene
  }
}

/** One sprint: a work ticket, and the acceptance node every new epic starts with, covering it. */
async function planSprint(agent: Workspace): Promise<Planned> {
  await agent.initializeRepository({ name: 'demo-repo' })
  const epic = await agent.createEpic({ title: 'Increment epic', successCriteria: ['The sprint landed squashed'] })
  const [node] = (await agent.getPlan({ epicId: epic.id, view: 'draft' })).bundle.tickets
  const nodeId = node?.id ?? ''
  const update = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_ticket', ref: 'build', sprint: '1', ticket: { title: 'Build it', acceptanceCriteria: ['It builds'] } },
      {
        op: 'update_ticket',
        ticket: nodeId,
        patch: { acceptanceCriteria: [{ text: 'Build works end to end', covers: 'build' }] }
      }
    ]
  })
  expect(update.validation.errors).toEqual([])
  const saved = await agent.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
  expect(saved.status).toBe('saved')
  return { epicId: epic.id, nodeId, workId: update.refMap['build'] ?? '' }
}

/** The worker commits on its own branch, submits those commits, and the orchestrator accepts. */
async function deliverWork(scene: Scene, runId: string, workId: string, branch: string): Promise<string> {
  const claim = await scene.orchestrator.claimTicket({ runId, ticketId: workId, worker: { label: 'worker-1' } })
  scene.repo.branch(branch)
  const commit = scene.repo.commit(`work on ${branch}`)
  scene.repo.switchTo(EPIC_BRANCH)
  await scene.orchestrator.submitAttempt({
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken,
    outputs: { summary: 'Built it.', commits: [commit], branch }
  })
  await scene.orchestrator.acceptAttempt({ attemptId: claim.attempt.id })
  return commit
}

/** Claims the acceptance node and submits it, naming `commit` on the epic branch unless told otherwise. */
async function submitNode(
  scene: Scene,
  run: { runId: string; nodeId: string },
  commit: string | null,
  branch = EPIC_BRANCH
): Promise<AttemptView> {
  const claim = await scene.orchestrator.claimTicket({ runId: run.runId, ticketId: run.nodeId, worker: { label: 'acceptor' } })
  return scene.orchestrator.submitAttempt({
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken,
    outputs: { summary: 'Sprint verified.' },
    ...(commit === null ? {} : { increment: { branch, commit } })
  })
}

async function gateOf(agent: Workspace, runId: string): Promise<GateCondition | undefined> {
  const checkpoint = await agent.getCheckpoint({ runId })
  return checkpoint.conditions.find((item) => item.id === 'increment_merged')
}

/** The final sprint's report, with the epic outcome it must carry. */
async function finalReport(agent: Workspace, run: RunView, epicId: string) {
  const criterion = (await agent.getEpic({ epicId })).successCriteria[0]
  return agent.submitSprintReport({
    runId: run.id,
    sprintId: run.activeSprintId ?? '',
    report: {
      summary: 'Sprint verified.',
      epicOutcome: { summary: 'Delivered.', successCriteria: [{ criterionId: criterion?.id ?? '', met: true, note: 'squashed' }] }
    }
  })
}

async function started(scene: Scene): Promise<{ planned: Planned; run: RunView }> {
  const planned = await planSprint(scene.orchestrator)
  const run = await scene.orchestrator.startRun({ epicId: planned.epicId })
  return { planned, run }
}

describe('a sprint squashed onto the epic branch', () => {
  const scene = useScene()

  it('verifies, shows the increment everywhere, and lets the sprint advance and the epic complete', async () => {
    const { orchestrator, desktop, repo, start } = scene()
    const { planned, run } = await started(scene())
    await deliverWork(scene(), run.id, planned.workId, 'dm-1')
    const squashed = repo.squash('dm-1', 'Sprint 1: build it')
    const attempt = await submitNode(scene(), { runId: run.id, nodeId: planned.nodeId }, squashed)
    expect(attempt.increment).toMatchObject({
      branch: EPIC_BRANCH,
      commit: squashed,
      parent: start,
      base: { kind: 'epic_start', commit: start },
      passed: true,
      reasons: []
    })
    expect(await gateOf(orchestrator, run.id)).toMatchObject({ met: true })
    await orchestrator.acceptAttempt({ attemptId: attempt.id })

    const view = (await orchestrator.getRun({ runId: run.id })) as RunView
    expect(view.increments).toEqual([
      expect.objectContaining({ sprintOrdinal: 1, key: 'DR-1', attemptId: attempt.id, increment: attempt.increment })
    ])
    const report = await finalReport(orchestrator, run, planned.epicId)
    expect(report.increment).toMatchObject({ sprintOrdinal: 1, increment: { commit: squashed } })
    expect((await orchestrator.getSprintReport({ runId: run.id }))?.increment?.increment.commit).toBe(squashed)
    const checkpoint: CheckpointView = await desktop.getCheckpoint({ runId: run.id })
    expect([checkpoint.gatesMet, checkpoint.report?.increment?.increment.commit]).toEqual([true, squashed])
    expect((await desktop.approveAndAdvance({ runId: run.id, reportId: report.id })).state).toBe('completed')
  })

  it('is exported with the run history and comes back in a clone', async () => {
    const { orchestrator, harness, repo } = scene()
    const { planned, run } = await started(scene())
    await deliverWork(scene(), run.id, planned.workId, 'dm-1')
    const squashed = repo.squash('dm-1', 'Sprint 1: build it')
    const attempt = await submitNode(scene(), { runId: run.id, nodeId: planned.nodeId }, squashed)
    await orchestrator.acceptAttempt({ attemptId: attempt.id })
    const file = join(repo.root, '.darkmechanicus', 'history', run.id, 'run.json')
    const written = JSON.parse(readFileSync(file, 'utf8')) as { attempts: { id: string; increment?: { commit: string; passed: boolean } }[] }
    expect(written.attempts.find((item) => item.id === attempt.id)?.increment).toMatchObject({ commit: squashed, passed: true })
    expect(written.attempts.filter((item) => item.increment !== undefined)).toHaveLength(1)
    const clone = harness.open('orchestrator', { root: harness.cloneTracked(repo.root) })
    const history = (await clone.getRun({ runId: run.id })) as RunView
    expect(history.increments).toEqual((await orchestrator.getRun({ runId: run.id }))?.increments)
  })
})

describe('a sprint that was merged or left off the epic branch', () => {
  const scene = useScene()

  it('stores the failed verdict with its reasons, keeps the gate unmet, and does not reject the submission', async () => {
    const { orchestrator, repo } = scene()
    const { planned, run } = await started(scene())
    await deliverWork(scene(), run.id, planned.workId, 'dm-1')
    repo.commit('the epic branch moves on')
    const merged = repo.merge('dm-1')
    const attempt = await submitNode(scene(), { runId: run.id, nodeId: planned.nodeId }, merged)
    expect(attempt.state).toBe('submitted')
    expect(attempt.increment).toMatchObject({ commit: merged, passed: false, parent: null })
    expect(attempt.increment?.reasons).toHaveLength(2)
    expect(attempt.increment?.reasons[0]).toContain('2 parents')
    expect(attempt.increment?.reasons[1]).toContain('merged rather than squashed')
    const gate = await gateOf(orchestrator, run.id)
    expect(gate?.met).toBe(false)
    expect(gate?.detail).toContain('failed verification')
    await orchestrator.acceptAttempt({ attemptId: attempt.id })
    const checkpoint = await orchestrator.getCheckpoint({ runId: run.id })
    expect(checkpoint.conditions.filter((item) => !item.met).map((item) => item.id)).toContain('increment_merged')
    expect(checkpoint.gatesMet).toBe(false)
    expect((await orchestrator.getRun({ runId: run.id }))?.increments[0]?.increment.passed).toBe(false)
  })

  it('lets the orchestrator reject a commit that is not on the epic branch and accept the node\'s retry', async () => {
    const { orchestrator, repo } = scene()
    const { planned, run } = await started(scene())
    await deliverWork(scene(), run.id, planned.workId, 'dm-1')
    const offBranch = repo.rev('dm-1')
    const first = await submitNode(scene(), { runId: run.id, nodeId: planned.nodeId }, offBranch)
    expect(first.increment).toMatchObject({ passed: false })
    expect(first.increment?.reasons.join(' ')).toContain(`not reachable from ${EPIC_BRANCH}`)
    await orchestrator.rejectAttempt({ attemptId: first.id, reasons: first.increment?.reasons ?? [] })
    expect((await orchestrator.getRun({ runId: run.id }))?.increments[0]).toMatchObject({ attemptState: 'rejected' })
    const squashed = repo.squash('dm-1', 'Sprint 1: build it')
    const second = await submitNode(scene(), { runId: run.id, nodeId: planned.nodeId }, squashed)
    expect(second.increment).toMatchObject({ passed: true, commit: squashed })
    await orchestrator.acceptAttempt({ attemptId: second.id })
    expect(await gateOf(orchestrator, run.id)).toMatchObject({ met: true })
    expect((await orchestrator.getRun({ runId: run.id }))?.increments[0]).toMatchObject({ attemptId: second.id, attemptState: 'accepted' })
  })

  it('fails a commit the repository does not have, as a verdict and not as an error', async () => {
    const { planned, run } = await started(scene())
    await deliverWork(scene(), run.id, planned.workId, 'dm-1')
    const attempt = await submitNode(scene(), { runId: run.id, nodeId: planned.nodeId }, 'f'.repeat(40))
    expect(attempt.increment).toMatchObject({ passed: false, commit: 'f'.repeat(40) })
    expect(attempt.increment?.reasons).toEqual([expect.stringContaining('was not found')])
  })
})

describe('naming an increment', () => {
  const scene = useScene()

  it('is refused on a work ticket, which keeps its claim', async () => {
    const { orchestrator, repo } = scene()
    const { planned, run } = await started(scene())
    const claim = await orchestrator.claimTicket({ runId: run.id, ticketId: planned.workId, worker: { label: 'w' } })
    const submit = orchestrator.submitAttempt({
      attemptId: claim.attempt.id,
      claimToken: claim.packet.claimToken,
      outputs: { summary: 'Built it.' },
      increment: { branch: EPIC_BRANCH, commit: repo.rev(EPIC_BRANCH) }
    })
    expect(await codeOf(submit)).toBe('invalid_input')
  })

  it('is refused for a malformed commit or branch before git is asked anything', async () => {
    const { orchestrator } = scene()
    const { planned, run } = await started(scene())
    const claim = await orchestrator.claimTicket({ runId: run.id, ticketId: planned.workId, worker: { label: 'w' } })
    const base = { attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'x' } }
    expect(await codeOf(orchestrator.submitAttempt({ ...base, increment: { branch: EPIC_BRANCH, commit: 'HEAD' } }))).toBe('invalid_input')
    expect(await codeOf(orchestrator.submitAttempt({ ...base, increment: { branch: '--all', commit: 'abc1234' } }))).toBe('invalid_input')
  })

  it('is left out on a node: the gate says how to name one and the node can still be accepted', async () => {
    const { orchestrator } = scene()
    const { planned, run } = await started(scene())
    await deliverWork(scene(), run.id, planned.workId, 'dm-1')
    const attempt = await submitNode(scene(), { runId: run.id, nodeId: planned.nodeId }, null)
    expect(Object.keys(attempt)).not.toContain('increment')
    expect(await gateOf(orchestrator, run.id)).toEqual({
      id: 'increment_merged',
      label: 'Sprint increment merged',
      met: false,
      detail: 'No sprint increment named yet: submit DR-1 with increment { branch, commit }'
    })
  })

  it('fails when it names a branch other than the epic branch, whatever the commit', async () => {
    const { repo } = scene()
    const { planned, run } = await started(scene())
    await deliverWork(scene(), run.id, planned.workId, 'dm-1')
    const squashed = repo.squash('dm-1', 'Sprint 1: build it')
    const attempt = await submitNode(scene(), { runId: run.id, nodeId: planned.nodeId }, squashed, 'dm-1')
    expect(attempt.increment).toMatchObject({ passed: false, branch: 'dm-1' })
    expect(attempt.increment?.reasons).toEqual([expect.stringContaining(`integration branch is "${EPIC_BRANCH}"`)])
  })
})

/** An id the plan was just asked to create; an empty string would fail the next call with a clear error. */
function named(id: string | undefined): string {
  return id ?? ''
}

interface TwoSprints {
  epicId: string
  nodes: [string, string]
  work: [string, string]
}

/** Two sprints, each with a work ticket and its own acceptance node covering it. */
async function planTwoSprints(agent: Workspace): Promise<TwoSprints> {
  await agent.initializeRepository({ name: 'demo-repo' })
  const epic = await agent.createEpic({ title: 'Two increments', successCriteria: ['Both sprints landed squashed'] })
  const [first] = (await agent.getPlan({ epicId: epic.id, view: 'draft' })).bundle.tickets
  const update = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_sprint', ref: 's2', sprint: { goal: 'Second sprint' } },
      { op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'First part', acceptanceCriteria: ['Part one works'] } },
      { op: 'add_ticket', ref: 'two', sprint: 's2', ticket: { title: 'Second part', acceptanceCriteria: ['Part two works'] } },
      { op: 'update_ticket', ticket: named(first?.id), patch: { acceptanceCriteria: [{ text: 'Part one verified', covers: 'one' }] } }
    ]
  })
  const second = (await agent.getPlan({ epicId: epic.id, view: 'draft' })).bundle.tickets.find(
    (ticket) => ticket.kind === 'acceptance' && ticket.id !== first?.id
  )
  const work: [string, string] = [named(update.refMap['one']), named(update.refMap['two'])]
  const covered = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [{ op: 'update_ticket', ticket: named(second?.id), patch: { acceptanceCriteria: [{ text: 'Part two verified', covers: work[1] }] } }]
  })
  expect(covered.validation.errors).toEqual([])
  const saved = await agent.savePlan({ epicId: epic.id, expectedDraftRevision: covered.draftRevision })
  expect(saved.status).toBe('saved')
  return { epicId: epic.id, nodes: [named(first?.id), named(second?.id)], work }
}

describe('two sprints, each squashed onto the epic branch', () => {
  const scene = useScene()

  it('measures the second increment against the first, and refuses it named again', async () => {
    const { orchestrator, desktop, repo } = scene()
    const planned = await planTwoSprints(orchestrator)
    const run = await orchestrator.startRun({ epicId: planned.epicId })
    await deliverWork(scene(), run.id, planned.work[0], 'dm-1')
    const first = repo.squash('dm-1', 'Sprint 1')
    const nodeOne = await submitNode(scene(), { runId: run.id, nodeId: planned.nodes[0] }, first)
    expect(nodeOne.increment).toMatchObject({ passed: true, base: { kind: 'epic_start' } })
    await orchestrator.acceptAttempt({ attemptId: nodeOne.id })
    const report = await orchestrator.submitSprintReport({ runId: run.id, sprintId: run.activeSprintId ?? '', report: { summary: 'Sprint 1 verified.' } })
    expect((await desktop.approveAndAdvance({ runId: run.id, reportId: report.id })).activeSprintId).not.toBe(run.activeSprintId)

    await deliverWork(scene(), run.id, planned.work[1], 'dm-2')
    const second = repo.squash('dm-2', 'Sprint 2')
    const again = await submitNode(scene(), { runId: run.id, nodeId: planned.nodes[1] }, first)
    expect(again.increment).toMatchObject({ passed: false, base: { kind: 'previous_increment', commit: first } })
    expect(again.increment?.reasons.join(' ')).toContain("previous sprint's increment")
    await orchestrator.rejectAttempt({ attemptId: again.id, reasons: again.increment?.reasons ?? [] })
    const right = await submitNode(scene(), { runId: run.id, nodeId: planned.nodes[1] }, second)
    expect(right.increment).toMatchObject({ passed: true, commit: second, parent: first, base: { kind: 'previous_increment', commit: first } })
    expect((await orchestrator.getRun({ runId: run.id }))?.increments.map((item) => [item.sprintOrdinal, item.increment.commit])).toEqual([
      [1, first],
      [2, second]
    ])
  })
})
