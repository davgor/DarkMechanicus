/**
 * The sprint delivery gate end to end, through the command table over a real temporary repository: a two-sprint plan
 * whose first sprint declares `delivery`, that sprint squashed onto the epic branch, accepted, reported and approved,
 * and then the next sprint held until `record_delivery` passes or the person waives it in the desktop app.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contentHash } from '../core/canonical'
import { createGitAdapter } from '../core/repo/git'
import type { Workspace } from '../core/workspace'
import type { SprintDelivery } from '../shared/domain/bundle'
import type { TicketExecutionView } from '../shared/domain/views'
import { issued } from '../test/execution'
import { createGitRepo, type GitRepo } from '../test/gitRepo'
import { createHarness, type Harness } from '../test/workspaceHarness'

const EPIC_BRANCH = 'epic/x'
const DELIVERY: SprintDelivery = { target: 'main', release: true, verifyInstalled: true }
const VERSION = '1.2.0'
const TAG = `v${VERSION}`

interface Scene {
  repo: GitRepo
  harness: Harness
  orchestrator: Workspace
  desktop: Workspace
  /** An orchestrator session that reports `version` as its own packaged build. */
  installedAt(version: string): Workspace
}

interface Approved {
  runId: string
  sprints: [string, string]
  /** Sprint 2's work ticket, which the delivery hold keeps from being claimed. */
  nextWork: string
  /** Sprint 1's increment, squashed onto the epic branch. */
  increment: string
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
    return { code: 'ok', message: '' }
  } catch (error: unknown) {
    const { code, message } = error as { code?: string; message?: string }
    return { code: code ?? 'thrown', message: message ?? '' }
  }
}

/** A real repository with the epic branch checked out, and a workspace on it for each role. */
function useScene(): () => Scene {
  let scene: Scene | undefined
  beforeEach(() => {
    const repo = createGitRepo()
    repo.branch(EPIC_BRANCH)
    const harness = createHarness()
    const git = createGitAdapter(repo.root)
    const open = (role: 'orchestrator' | 'desktop') => harness.open(role, { root: repo.root, git })
    scene = {
      repo,
      harness,
      orchestrator: open('orchestrator'),
      desktop: open('desktop'),
      installedAt: (version) =>
        harness.open('orchestrator', { root: repo.root, git, serverInfo: { name: 'darkmechanicus', version, packaged: true } })
    }
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

/** An id the plan was just asked to create; an empty string would fail the next call with a clear error. */
function named(id: string | undefined): string {
  return id ?? ''
}

/** Two sprints, each with a work ticket and its own acceptance node covering it; sprint 1 declares `delivery` when given. */
async function planTwoSprints(agent: Workspace, delivery: SprintDelivery | null): Promise<{ epicId: string; nodes: [string, string]; work: [string, string] }> {
  await agent.initializeRepository({ name: 'demo-repo' })
  const epic = await agent.createEpic({ title: 'Delivered sprints', successCriteria: ['Both sprints delivered'] })
  const [first] = (await agent.getPlan({ epicId: epic.id, view: 'draft' })).bundle.tickets
  const update = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_sprint', ref: 's2', sprint: { goal: 'Second sprint' } },
      ...(delivery === null ? [] : [{ op: 'update_sprint' as const, sprint: '1', patch: { delivery } }]),
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

/**
 * Starts the run and completes Sprint 1: the work accepted, the increment squashed onto the epic branch and accepted,
 * the report submitted, and the person's approval and advance in the desktop.
 */
async function approvedSprint(scene: Scene, delivery: SprintDelivery | null): Promise<Approved> {
  const { orchestrator, desktop, repo } = scene
  const planned = await planTwoSprints(orchestrator, delivery)
  const run = await orchestrator.startRun({ epicId: planned.epicId })
  const work = issued(await orchestrator.claimTicket({ runId: run.id, ticketId: planned.work[0], worker: { label: 'worker-1' } }))
  repo.branch('dm-1')
  const commit = repo.commit('work on dm-1')
  repo.switchTo(EPIC_BRANCH)
  await orchestrator.submitAttempt({ attemptId: work.attempt.id, claimToken: work.packet.claimToken, outputs: { summary: 'Built it.', commits: [commit], branch: 'dm-1' } })
  await orchestrator.acceptAttempt({ attemptId: work.attempt.id })
  const increment = repo.squash('dm-1', 'Sprint 1: first part')
  const node = issued(await orchestrator.claimTicket({ runId: run.id, ticketId: planned.nodes[0], worker: { label: 'acceptor' } }))
  const submitted = await orchestrator.submitAttempt({
    attemptId: node.attempt.id,
    claimToken: node.packet.claimToken,
    outputs: { summary: 'Sprint verified.' },
    increment: { branch: EPIC_BRANCH, commit: increment }
  })
  expect(submitted.increment?.passed).toBe(true)
  await orchestrator.acceptAttempt({ attemptId: node.attempt.id })
  const sprints = (await orchestrator.getPlan({ epicId: planned.epicId, view: 'saved' })).bundle.sprints.map((sprint) => named(sprint.id))
  const report = await orchestrator.submitSprintReport({
    runId: run.id,
    sprintId: run.activeSprintId ?? '',
    report: { summary: 'Sprint 1 verified.', retro: { wentWell: ['The sprint squashed cleanly'] } }
  })
  expect((await desktop.approveAndAdvance({ runId: run.id, reportId: report.id })).activeSprintId).toBe(sprints[1])
  return { runId: run.id, sprints: [named(sprints[0]), named(sprints[1])], nextWork: planned.work[1], increment }
}

/**
 * Delivers the epic branch: squashed onto `main`, published as `origin/main`, then the release's package.json
 * committed and tagged. Returns the delivered commit, the squash on main.
 */
function release(repo: GitRepo): string {
  repo.switchTo('main')
  const delivered = repo.squash(EPIC_BRANCH, 'Deliver the epic branch')
  repo.git('update-ref', 'refs/remotes/origin/main', delivered)
  writeFileSync(join(repo.root, 'package.json'), `${JSON.stringify({ version: VERSION })}\n`)
  repo.git('add', 'package.json')
  repo.git('commit', '-q', '-m', `Release ${VERSION}`)
  repo.git('tag', TAG, 'HEAD')
  repo.switchTo(EPIC_BRANCH)
  return delivered
}

/** The ticket as readiness shows it, wherever it is listed. */
async function executionOf(agent: Workspace, runId: string, ticketId: string): Promise<TicketExecutionView | undefined> {
  const readiness = await agent.getReadyTickets({ runId })
  return [...readiness.ready, ...readiness.blocked, ...readiness.inFlight].find((item) => item.ticketId === ticketId)
}

async function expectHeld(scene: Scene, approved: Approved): Promise<void> {
  const held = await executionOf(scene.orchestrator, approved.runId, approved.nextWork)
  expect(held).toMatchObject({ state: 'waiting', blockers: [{ kind: 'delivery_pending', sprintId: approved.sprints[0], ordinal: 1 }] })
  const refused = await failure(scene.orchestrator.claimTicket({ runId: approved.runId, ticketId: approved.nextWork, worker: { label: 'worker-2' } }))
  expect(refused.code).toBe('unmet_prerequisite')
  expect(refused.message).toContain('record_delivery')
}

async function expectReleased(scene: Scene, approved: Approved): Promise<void> {
  const ready = await scene.orchestrator.getReadyTickets({ runId: approved.runId })
  expect(ready.ready.find((item) => item.ticketId === approved.nextWork)).toMatchObject({ state: 'ready', blockers: [] })
  const claim = issued(await scene.orchestrator.claimTicket({ runId: approved.runId, ticketId: approved.nextWork, worker: { label: 'worker-2' } }))
  expect(claim.attempt).toMatchObject({ ticketId: approved.nextWork, state: 'claimed' })
}

describe('a sprint that declares delivery', () => {
  const scene = useScene()

  it('holds the next sprint, refuses its claim, stores a failed record, and releases it once a record passes', async () => {
    const { repo } = scene()
    const approved = await approvedSprint(scene(), DELIVERY)
    await expectHeld(scene(), approved)

    const early = await scene().orchestrator.recordDelivery({ runId: approved.runId, sprintId: approved.sprints[0], commit: approved.increment })
    expect(early).toMatchObject({ number: 1, kind: 'check', passed: false })
    expect(early.checks.find((check) => check.name === 'On the target branch')).toMatchObject({
      status: 'failed',
      detail: 'origin/main is unknown here: run git fetch origin first'
    })
    await expectHeld(scene(), approved)

    const delivered = release(repo)
    const recorder = scene().installedAt(VERSION)
    const passing = await recorder.recordDelivery({ runId: approved.runId, sprintId: approved.sprints[0], commit: delivered, releaseTag: TAG })
    expect(passing).toMatchObject({ number: 2, kind: 'check', commit: delivered, releaseTag: TAG, releaseVersion: VERSION, installedVersion: VERSION, passed: true, reasons: [] })
    expect(passing.checks.map((check) => [check.name, check.status])).toEqual([
      ['Delivered commit exists', 'passed'],
      ['On the target branch', 'passed'],
      ['Carries the increment', 'passed'],
      ['Release tag', 'passed'],
      ['Release version', 'passed'],
      ['Installed app version', 'passed']
    ])
    expect(passing.checks.find((check) => check.name === 'Carries the increment')?.detail).toContain('squash-merged')
    expect(passing.checks.find((check) => check.name === 'Installed app version')?.detail).toContain("source: the recording session's serverInfo")
    await expectReleased(scene(), approved)
  })

  it('fails the installed check for an app older than the release and keeps the hold', async () => {
    const { repo } = scene()
    const approved = await approvedSprint(scene(), DELIVERY)
    const delivered = release(repo)
    const recorder = scene().installedAt('1.1.0')
    const old = await recorder.recordDelivery({ runId: approved.runId, sprintId: approved.sprints[0], commit: delivered, releaseTag: TAG })
    expect(old).toMatchObject({ number: 1, passed: false, installedVersion: '1.1.0' })
    expect(old.checks.filter((check) => check.status === 'failed').map((check) => check.name)).toEqual(['Installed app version'])
    expect(old.checks.find((check) => check.name === 'Installed app version')?.detail).toContain(`runs 1.1.0, not ${VERSION} or later`)
    await expectHeld(scene(), approved)
  })
})

describe("the person's waiver", () => {
  const scene = useScene()

  it('releases the hold from the desktop app, and an orchestrator cannot give it', async () => {
    const { orchestrator, desktop } = scene()
    const approved = await approvedSprint(scene(), DELIVERY)
    const request = { runId: approved.runId, sprintId: approved.sprints[0], reason: 'Released by hand outside the gate.' }
    expect((await failure(orchestrator.waiveDelivery(request))).code).toBe('unauthorized')
    await expectHeld(scene(), approved)
    const waiver = await desktop.waiveDelivery(request)
    expect(waiver).toMatchObject({ number: 1, kind: 'waiver', reason: request.reason, passed: true })
    await expectReleased(scene(), approved)
  })
})

describe('a sprint without delivery', () => {
  const scene = useScene()

  it('never holds the next sprint', async () => {
    const approved = await approvedSprint(scene(), null)
    const execution = await executionOf(scene().orchestrator, approved.runId, approved.nextWork)
    expect(execution?.blockers.some((blocker) => blocker.kind === 'delivery_pending')).toBe(false)
    await expectReleased(scene(), approved)
  })

  it('keeps its content hash when a delivery is set and then cleared', async () => {
    const { orchestrator } = scene()
    const { epicId } = await planTwoSprints(orchestrator, null)
    const sprintOne = async () => {
      const plan = await orchestrator.getPlan({ epicId, view: 'saved' })
      return plan.bundle.sprints.find((sprint) => sprint.ordinal === 1)
    }
    const saveWith = async (delivery: SprintDelivery | null) => {
      const draft = await orchestrator.updatePlanDraft({ epicId, ops: [{ op: 'update_sprint', sprint: '1', patch: { delivery } }] })
      expect(draft.validation.errors).toEqual([])
      expect((await orchestrator.savePlan({ epicId, expectedDraftRevision: draft.draftRevision })).status).toBe('saved')
      return sprintOne()
    }
    const without = await sprintOne()
    const declared = await saveWith(DELIVERY)
    expect(declared?.delivery).toEqual(DELIVERY)
    expect(contentHash(declared)).not.toBe(contentHash(without))
    const cleared = await saveWith(null)
    expect(cleared).toBeDefined()
    expect(Object.hasOwn(cleared ?? {}, 'delivery')).toBe(false)
    expect(contentHash(cleared)).toBe(contentHash(without))
  })
})
