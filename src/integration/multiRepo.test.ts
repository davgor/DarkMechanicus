/**
 * A folder of repositories end to end: a temp parent holds the Git repositories `alpha` and `beta`, set up as one
 * project (db mode, records only in a temp Dark Mechanicus home). An epic on branch `feature` runs one sprint with a
 * work ticket per repository; each packet names its repository's path and bound branch; each repository's sprint work
 * is squashed onto its own `feature` and the acceptance node names both increments and reports every
 * `<repo>: <check>` of each repository's Definition of Done, so both gates pass. A merged rather than squashed
 * increment in `beta` fails the increment gate naming `beta`. Nothing is written into the parent or either repository.
 */
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGitAdapter } from '../core/repo/git'
import type { Workspace } from '../core/workspace'
import type { CheckResult, ExecutionPacket, GateCondition, RunView } from '../shared/domain/views'
import { issued } from '../test/execution'
import { createGitRepo, type GitRepo } from '../test/gitRepo'
import { createHarness, type Harness } from '../test/workspaceHarness'

const EPIC_BRANCH = 'feature'
const REPOS = ['alpha', 'beta'] as const
type RepoName = (typeof REPOS)[number]
/** A whole run across two real repositories runs many Git commands; leave room for a loaded machine. */
const RUN_TIMEOUT = { timeout: 60_000 }

const DEFINITIONS: Record<RepoName, { name: string; command: string; description: string }[]> = {
  alpha: [
    { name: 'lint', command: 'npm run lint', description: 'The linter' },
    { name: 'test', command: 'npm test', description: 'The unit tests' }
  ],
  beta: [{ name: 'build', command: 'make build', description: 'The client build' }]
}

interface Scene {
  harness: Harness
  /** The folder of repositories: the project root. */
  parent: string
  repos: Record<RepoName, GitRepo>
  /** Where the workers' Git worktrees live: outside the parent. */
  worktrees: string
  desktop: Workspace
  planner: Workspace
  orchestrator: Workspace
}

interface Planned {
  epicId: string
  nodeId: string
  work: Record<RepoName, string>
}

/** The parent with both repositories, each with `feature` checked out one commit ahead of `main`, and a session per role. */
function useScene(): () => Scene {
  let scene: Scene | undefined
  beforeEach(() => {
    const harness = createHarness()
    const parent = harness.root
    const repos = {} as Record<RepoName, GitRepo>
    for (const name of REPOS) {
      const repo = createGitRepo({ root: join(parent, name) })
      repo.commit(`${name} history`)
      repo.branch(EPIC_BRANCH)
      repos[name] = repo
    }
    const worktrees = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-worktrees-')))
    // The parent is not a repository: its root adapter is a real one that finds no checkout, as in the app.
    const open = (role: 'desktop' | 'planner' | 'orchestrator') => harness.open(role, { git: createGitAdapter(parent) })
    scene = { harness, parent, repos, worktrees, desktop: open('desktop'), planner: open('planner'), orchestrator: open('orchestrator') }
  })
  afterEach(() => {
    scene?.harness.cleanup()
    if (scene !== undefined) {
      rmSync(scene.worktrees, { recursive: true, force: true })
    }
    scene = undefined
  })
  return () => {
    if (scene === undefined) {
      throw new Error('The scene exists only inside a test')
    }
    return scene
  }
}

/** Set-up, each repository's Definition of Done, and an epic on `feature` with one sprint saved. */
async function planEpic(scene: Scene): Promise<Planned> {
  const initialized = await scene.desktop.initializeRepository({ layout: 'multi_repo' })
  expect(initialized.storage.mode).toBe('db')
  for (const name of REPOS) {
    await scene.planner.setDefinitionOfDone({ repo: name, checks: DEFINITIONS[name] })
  }
  const project = await scene.planner.getProject()
  expect(project.repositories).toEqual([
    { name: 'alpha', missing: false, definitionOfDone: DEFINITIONS.alpha },
    { name: 'beta', missing: false, definitionOfDone: DEFINITIONS.beta }
  ])
  const epic = await scene.planner.createEpic({
    title: 'Two repositories',
    successCriteria: ['Both repositories landed squashed'],
    branch: { repository: null, name: EPIC_BRANCH, startCommit: null }
  })
  const [node] = (await scene.planner.getPlan({ epicId: epic.id, view: 'draft' })).bundle.tickets
  const nodeId = node?.id ?? ''
  const update = await scene.planner.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_ticket', ref: 'alpha', sprint: '1', ticket: { title: 'Build the API', repo: 'alpha', acceptanceCriteria: ['The API builds'] } },
      { op: 'add_ticket', ref: 'beta', sprint: '1', ticket: { title: 'Build the client', repo: 'beta', acceptanceCriteria: ['The client builds'] } },
      {
        op: 'update_ticket',
        ticket: nodeId,
        patch: {
          acceptanceCriteria: [
            { text: 'The API works end to end', covers: 'alpha' },
            { text: 'The client works end to end', covers: 'beta' }
          ]
        }
      }
    ]
  })
  expect(update.validation.errors).toEqual([])
  const saved = await scene.planner.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
  expect(saved.status).toBe('saved')
  return { epicId: epic.id, nodeId, work: { alpha: update.refMap['alpha'] ?? '', beta: update.refMap['beta'] ?? '' } }
}

/** Queued in the desktop app, then started by the orchestrator, which binds `feature` in each repository. */
async function startRun(scene: Scene, planned: Planned): Promise<RunView> {
  const queued = await scene.desktop.queueRun({ epicId: planned.epicId })
  expect(queued.state).toBe('queued')
  const run = await scene.orchestrator.startRun({ epicId: planned.epicId })
  expect([run.id, run.state]).toEqual([queued.id, 'running'])
  return run
}

/** Commits one file in a worktree and returns the commit id. */
function commitIn(repo: GitRepo, worktree: string, file: string, message: string): string {
  writeFileSync(join(worktree, file), `${message}\n`)
  repo.git('-C', worktree, 'add', '--', file)
  repo.git('-C', worktree, 'commit', '-q', '-m', message)
  return repo.git('-C', worktree, 'rev-parse', 'HEAD')
}

/**
 * The worker of `name`'s ticket: claims it and checks its packet, commits in a worktree of that repository (outside the
 * parent) on its own branch off `feature`, submits, and the orchestrator accepts. Returns the worker's branch.
 */
async function deliverWork(scene: Scene, run: RunView, planned: Planned, name: RepoName): Promise<string> {
  const { orchestrator, repos, parent, worktrees } = scene
  const claim = issued(await orchestrator.claimTicket({ runId: run.id, ticketId: planned.work[name], worker: { label: `${name}-worker` } }))
  const start = repos[name].rev(EPIC_BRANCH)
  expect(claim.packet.ticket.title.startsWith(`${name} - `)).toBe(true)
  expect(claim.packet.repository).toEqual({
    name,
    path: join(parent, name),
    branch: { repository: name, name: EPIC_BRANCH, startCommit: start }
  })
  expect(claim.packet.repositories).toBeUndefined()
  expect(claim.packet.definitionOfDone).toBeUndefined()

  const branch = `dm-${name}`
  const worktree = join(worktrees, branch)
  repos[name].git('worktree', 'add', '-q', '-b', branch, worktree, EPIC_BRANCH)
  const commits = [commitIn(repos[name], worktree, `${name}-1.txt`, `${name}: first part`), commitIn(repos[name], worktree, `${name}-2.txt`, `${name}: second part`)]
  await orchestrator.submitAttempt({
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken,
    outputs: { summary: `Built ${name}.`, commits, branch }
  })
  await orchestrator.acceptAttempt({ attemptId: claim.attempt.id })
  return branch
}

/** Every check of both repositories' Definitions of Done, reported by its `<repo>: <check>` name as passed. */
function allChecksPassed(): CheckResult[] {
  return REPOS.flatMap((name) => DEFINITIONS[name].map((check) => ({ name: `${name}: ${check.name}`, status: 'passed' as const, detail: 'ok' })))
}

async function gate(agent: Workspace, runId: string, id: string): Promise<GateCondition | undefined> {
  return (await agent.getCheckpoint({ runId })).conditions.find((item) => item.id === id)
}

/** The parent holds only the two repositories, and neither holds a Dark Mechanicus file or any uncommitted change. */
function expectNothingWritten(scene: Scene): void {
  expect(readdirSync(scene.parent).sort()).toEqual(['alpha', 'beta'])
  for (const name of REPOS) {
    const entries = readdirSync(join(scene.parent, name))
    expect(entries.filter((entry) => entry.toLowerCase().includes('darkmechanicus') || entry === '.mcp.json')).toEqual([])
    expect(scene.repos[name].git('status', '--porcelain', '--untracked-files=all', '--ignored')).toBe('')
    expect(scene.repos[name].git('ls-files')).not.toMatch(/darkmechanicus/i)
  }
}

/** The orchestrator claims the acceptance node and submits both increments with every `<repo>: <check>` passed. */
async function submitNode(scene: Scene, run: RunView, planned: Planned, increments: Record<RepoName, string>) {
  const { orchestrator } = scene
  const node = issued(await orchestrator.claimTicket({ runId: run.id, ticketId: planned.nodeId, worker: { label: 'acceptor' } }))
  const attempt = await orchestrator.submitAttempt({
    attemptId: node.attempt.id,
    claimToken: node.packet.claimToken,
    outputs: { summary: 'Sprint verified in both repositories.' },
    evidence: { checks: allChecksPassed() },
    increments: REPOS.map((name) => ({ repo: name, branch: EPIC_BRANCH, commit: increments[name] }))
  })
  return { packet: node.packet, attempt }
}

/** Each repository's `feature` tip, which the run bound as that repository's epic branch start. */
async function expectBound(scene: Scene, planned: Planned): Promise<Record<RepoName, string>> {
  const starts = { alpha: scene.repos.alpha.rev(EPIC_BRANCH), beta: scene.repos.beta.rev(EPIC_BRANCH) }
  expect((await scene.orchestrator.getEpic({ epicId: planned.epicId })).repositoryBranches).toEqual(
    REPOS.map((name) => ({ repository: name, name: EPIC_BRANCH, startCommit: starts[name] }))
  )
  return starts
}

/** The acceptance node's packet lists both repositories with their path, bound branch and own checks. */
function expectNodePacket(scene: Scene, packet: ExecutionPacket, starts: Record<RepoName, string>): void {
  expect(packet.repository).toBeUndefined()
  // Each repository's checks are listed by their own names; the evidence reports each as `<repo>: <check>`.
  expect(packet.repositories).toEqual(
    REPOS.map((name) => ({
      name,
      path: join(scene.parent, name),
      branch: { repository: name, name: EPIC_BRANCH, startCommit: starts[name] },
      definitionOfDone: DEFINITIONS[name]
    }))
  )
}

/** Both gates pass once the node is accepted, and the run shows one passing increment per repository. */
async function expectGatesPass(scene: Scene, run: RunView, squashed: Record<RepoName, string>): Promise<void> {
  const { orchestrator } = scene
  expect(await gate(orchestrator, run.id, 'increment_merged')).toMatchObject({
    met: true,
    detail: "Increments in alpha, beta are each one squashed commit on the repository's epic branch"
  })
  expect(await gate(orchestrator, run.id, 'definition_of_done')).toMatchObject({
    met: true,
    detail: expect.stringContaining('reports all 3 Definition of Done checks as passed')
  })
  const view = (await orchestrator.getRun({ runId: run.id })) as RunView
  expect(view.increments.map((item) => [item.repo, item.increment.commit, item.increment.passed])).toEqual([
    ['alpha', squashed.alpha, true],
    ['beta', squashed.beta, true]
  ])
}

describe('a two-repository sprint, each repository squashed onto its own feature branch', () => {
  const scene = useScene()

  it('hands out packets per repository, verifies both increments, and passes both gates', RUN_TIMEOUT, async () => {
    const { orchestrator, repos } = scene()
    const planned = await planEpic(scene())
    const run = await startRun(scene(), planned)
    const starts = await expectBound(scene(), planned)
    const branches = { alpha: await deliverWork(scene(), run, planned, 'alpha'), beta: await deliverWork(scene(), run, planned, 'beta') }
    const squashed = { alpha: repos.alpha.squash(branches.alpha, 'Sprint 1: alpha'), beta: repos.beta.squash(branches.beta, 'Sprint 1: beta') }

    const { packet, attempt } = await submitNode(scene(), run, planned, squashed)
    expectNodePacket(scene(), packet, starts)
    expect(attempt.increments).toMatchObject(
      REPOS.map((name) => ({
        repo: name,
        branch: EPIC_BRANCH,
        commit: squashed[name],
        parent: starts[name],
        base: { kind: 'epic_start', commit: starts[name] },
        passed: true,
        reasons: []
      }))
    )
    expect(await gate(orchestrator, run.id, 'definition_of_done')).toMatchObject({
      met: false,
      detail: expect.stringContaining('must report these checks as passed: alpha: lint, alpha: test, beta: build')
    })
    await orchestrator.acceptAttempt({ attemptId: attempt.id })
    await expectGatesPass(scene(), run, squashed)
    expectNothingWritten(scene())
  })
})

describe('a two-repository sprint whose beta work was merged rather than squashed', () => {
  const scene = useScene()

  it('fails the increment gate naming beta, and passes alpha', RUN_TIMEOUT, async () => {
    const { orchestrator, repos } = scene()
    const planned = await planEpic(scene())
    const run = await startRun(scene(), planned)
    await expectBound(scene(), planned)
    const alphaBranch = await deliverWork(scene(), run, planned, 'alpha')
    const betaBranch = await deliverWork(scene(), run, planned, 'beta')
    const alpha = repos.alpha.squash(alphaBranch, 'Sprint 1: alpha')
    repos.beta.commit('beta: feature moves on')
    const beta = repos.beta.merge(betaBranch)

    const { attempt } = await submitNode(scene(), run, planned, { alpha, beta })
    expect(attempt.state).toBe('submitted')
    expect(attempt.increments?.map((item) => [item.repo, item.passed])).toEqual([
      ['alpha', true],
      ['beta', false]
    ])
    expect(attempt.increments?.[1]?.reasons.join(' ')).toContain('merged rather than squashed')
    await orchestrator.acceptAttempt({ attemptId: attempt.id })

    const increment = await gate(orchestrator, run.id, 'increment_merged')
    expect(increment?.met).toBe(false)
    expect(increment?.detail).toMatch(/^beta: increment [0-9a-f]{7} failed verification: /)
    expect(increment?.detail).not.toContain('alpha')
    expect(await gate(orchestrator, run.id, 'definition_of_done')).toMatchObject({ met: true })
    expect((await orchestrator.getCheckpoint({ runId: run.id })).gatesMet).toBe(false)
    expectNothingWritten(scene())
  })
})
