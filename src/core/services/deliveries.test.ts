/**
 * `record_delivery` against a real temporary repository: a two-sprint plan whose first sprint declares a delivery, the
 * first sprint squashed onto the epic branch and approved, then delivered to `origin/main` and tagged as a release.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecordDeliveryInput } from '../../shared/domain/api'
import type { SprintDelivery } from '../../shared/domain/bundle'
import { DomainError } from '../errors'
import { createGitAdapter } from '../repo/git'
import { recordInstalledApp } from '../installedApp'
import type { Workspace } from '../workspace'
import { clearOutbox, eventKinds, issued, lastEventPayload, pendingOutbox } from '../../test/execution'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { deliveryContextOf, recordDelivery } from './deliveries'

const EPIC_BRANCH = 'epic/x'
const VERSION = '1.2.3'
const TAG = `v${VERSION}`

interface Scene {
  repo: GitRepo
  harness: Harness
  orchestrator: Workspace
  desktop: Workspace
}

interface Delivered {
  runId: string
  epicId: string
  sprints: [string, string]
  /** Sprint 1's increment, squashed onto the epic branch. */
  increment: string
  /** The commit on origin/main and the release tag: the increment plus the release's package.json. */
  release: string
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return error instanceof DomainError ? error.code : 'thrown'
  }
}

function useScene(): () => Scene {
  let scene: Scene | undefined
  beforeEach(() => {
    const repo = createGitRepo()
    repo.branch(EPIC_BRANCH)
    const harness = createHarness()
    const git = createGitAdapter(repo.root)
    const open = (role: 'orchestrator' | 'desktop') => harness.open(role, { root: repo.root, git })
    scene = { repo, harness, orchestrator: open('orchestrator'), desktop: open('desktop') }
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

function named(id: string | undefined): string {
  return id ?? ''
}

/** Two sprints, each with a work ticket and its acceptance node; sprint 1 declares `delivery`. */
async function plan(agent: Workspace, delivery: SprintDelivery): Promise<{ epicId: string; nodes: [string, string]; work: [string, string] }> {
  await agent.initializeRepository({ name: 'demo-repo' })
  const epic = await agent.createEpic({ title: 'Delivered sprints', successCriteria: ['Both sprints delivered'] })
  const [first] = (await agent.getPlan({ epicId: epic.id, view: 'draft' })).bundle.tickets
  const update = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_sprint', ref: 's2', sprint: { goal: 'Second sprint' } },
      { op: 'update_sprint', sprint: '1', patch: { delivery } },
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

/** Runs sprint 1 to an accepted, passing increment; with `advance`, the person approves it and sprint 2 becomes active. */
async function deliveredSprint(scene: Scene, options: { advance: boolean; delivery?: SprintDelivery }): Promise<Delivered> {
  const { orchestrator, desktop, repo } = scene
  const planned = await plan(orchestrator, options.delivery ?? { target: 'main', release: true, verifyInstalled: false })
  const run = await orchestrator.startRun({ epicId: planned.epicId })
  const work = issued(await orchestrator.claimTicket({ runId: run.id, ticketId: planned.work[0], worker: { label: 'worker-1' } }))
  repo.branch('dm-1')
  const commit = repo.commit('work on dm-1')
  repo.switchTo(EPIC_BRANCH)
  await orchestrator.submitAttempt({ attemptId: work.attempt.id, claimToken: work.packet.claimToken, outputs: { summary: 'Built it.', commits: [commit], branch: 'dm-1' } })
  await orchestrator.acceptAttempt({ attemptId: work.attempt.id })
  const increment = repo.squash('dm-1', 'Sprint 1')
  const node = issued(await orchestrator.claimTicket({ runId: run.id, ticketId: planned.nodes[0], worker: { label: 'acceptor' } }))
  const submitted = await orchestrator.submitAttempt({
    attemptId: node.attempt.id,
    claimToken: node.packet.claimToken,
    outputs: { summary: 'Sprint verified.' },
    increment: { branch: EPIC_BRANCH, commit: increment }
  })
  expect(submitted.increment?.passed).toBe(true)
  await orchestrator.acceptAttempt({ attemptId: node.attempt.id })
  const sprints = (await orchestrator.getPlan({ epicId: planned.epicId, view: 'saved' })).bundle.sprints.map((sprint) => sprint.id)
  if (options.advance) {
    const report = await orchestrator.submitSprintReport({
      runId: run.id,
      sprintId: run.activeSprintId ?? '',
      report: { summary: 'Sprint 1 verified.', retro: { wentWell: ['The sprint squashed cleanly'] } }
    })
    expect((await desktop.approveAndAdvance({ runId: run.id, reportId: report.id })).activeSprintId).toBe(sprints[1])
  }
  writeFileSync(join(repo.root, 'package.json'), `${JSON.stringify({ name: 'demo', version: VERSION })}\n`)
  repo.git('add', 'package.json')
  repo.git('commit', '-m', `Release ${VERSION}`)
  const release = repo.rev('HEAD')
  repo.git('update-ref', 'refs/remotes/origin/main', release)
  repo.git('tag', TAG, release)
  return { runId: run.id, epicId: planned.epicId, sprints: [named(sprints[0]), named(sprints[1])], increment, release }
}

function input(delivered: Delivered, overrides: Partial<RecordDeliveryInput> = {}): RecordDeliveryInput {
  return { runId: delivered.runId, sprintId: delivered.sprints[0], commit: delivered.release, releaseTag: TAG, ...overrides }
}

function storedRows(agent: Workspace): number {
  return agent.ctx().db.get<{ n: number }>('SELECT COUNT(*) AS n FROM delivery_checks')?.n ?? -1
}

describe('recordDelivery stores the verdict', () => {
  const scene = useScene()

  it('stores a passing check as number 1 with the server checks and the event', async () => {
    const { orchestrator } = scene()
    const delivered = await deliveredSprint(scene(), { advance: true })
    const view = await orchestrator.recordDelivery(input(delivered))
    expect(view).toMatchObject({
      runId: delivered.runId,
      sprintId: delivered.sprints[0],
      number: 1,
      kind: 'check',
      commit: delivered.release,
      releaseTag: TAG,
      releaseVersion: VERSION,
      passed: true,
      reasons: [],
      recordedBy: 'orchestrator session'
    })
    expect(view.checks.map((check) => [check.name, check.status])).toEqual([
      ['Delivered commit exists', 'passed'],
      ['On the target branch', 'passed'],
      ['Carries the increment', 'passed'],
      ['Release tag', 'passed'],
      ['Release version', 'passed']
    ])
    expect(eventKinds(orchestrator.ctx(), 'run.delivery')).toEqual(['run.delivery_recorded'])
    expect(lastEventPayload(orchestrator.ctx(), 'run.delivery_recorded')).toEqual({ deliveryCheckId: view.id, sprintId: delivered.sprints[0], passed: true })
  })

  it('fails the check on a failed or skipped caller entry, after the server checks, and numbers each record', async () => {
    const { orchestrator } = scene()
    const delivered = await deliveredSprint(scene(), { advance: true })
    const failed = await orchestrator.recordDelivery(input(delivered, { checks: [{ name: 'gh release run', status: 'failed', detail: 'run 12 failed' }] }))
    expect(failed).toMatchObject({ number: 1, passed: false, reasons: ['gh release run: run 12 failed'] })
    expect(failed.checks.at(-1)).toEqual({ name: 'gh release run', status: 'failed', detail: 'run 12 failed' })
    expect(failed.checks.slice(0, -1).every((check) => check.status === 'passed')).toBe(true)
    const skipped = await orchestrator.recordDelivery(input(delivered, { checks: [{ name: 'gh release run', status: 'skipped' }] }))
    expect(skipped).toMatchObject({ number: 2, passed: false, reasons: ['gh release run: skipped'] })
    const passing = await orchestrator.recordDelivery(input(delivered, { checks: [{ name: 'gh release run', status: 'passed' }] }))
    expect(passing).toMatchObject({ number: 3, passed: true })
    expect(lastEventPayload(orchestrator.ctx(), 'run.delivery_recorded')).toEqual({ deliveryCheckId: passing.id, sprintId: delivered.sprints[0], passed: true })
  })

  it('stores a failed server verdict instead of throwing it', async () => {
    const { orchestrator } = scene()
    const delivered = await deliveredSprint(scene(), { advance: true })
    const view = await orchestrator.recordDelivery(input(delivered, { commit: 'f'.repeat(40) }))
    expect(view).toMatchObject({ number: 1, kind: 'check', passed: false })
    expect(view.reasons[0]).toContain('is not in this repository')
    expect(storedRows(orchestrator)).toBe(1)
  })
})

describe('recordDelivery stores each record once', () => {
  const scene = useScene()

  it('replays an idempotency key without storing a second record', async () => {
    const { orchestrator } = scene()
    const delivered = await deliveredSprint(scene(), { advance: true })
    const first = await orchestrator.recordDelivery(input(delivered, { idempotencyKey: 'delivery-1' }))
    expect(await orchestrator.recordDelivery(input(delivered, { idempotencyKey: 'delivery-1' }))).toEqual(first)
    expect(storedRows(orchestrator)).toBe(1)
    expect(eventKinds(orchestrator.ctx(), 'run.delivery')).toEqual(['run.delivery_recorded'])
    expect(await codeOf(orchestrator.recordDelivery(input(delivered, { idempotencyKey: 'delivery-1', commit: delivered.increment })))).toBe('idempotency_mismatch')
  })

  it('enqueues the run history from the service, and refuses a verdict made for another increment or a moved checkout', async () => {
    const { orchestrator } = scene()
    const delivered = await deliveredSprint(scene(), { advance: true })
    const ctx = orchestrator.ctx()
    const verdict = { passed: true, checks: [{ name: 'Delivered commit exists', status: 'passed' as const, detail: 'ok' }], reasons: [], releaseVersion: null, installedVersion: null, verifiedAt: ctx.clock.nowIso() }
    clearOutbox(ctx)
    const view = recordDelivery(ctx, input(delivered), { increment: delivered.increment, verdict })
    expect(view).toMatchObject({ number: 1, passed: true })
    expect(pendingOutbox(ctx)).toEqual([`run_history:${delivered.epicId}:${delivered.runId}`])
    expect(() => recordDelivery(ctx, input(delivered), { increment: delivered.release, verdict })).toThrow(expect.objectContaining({ code: 'conflict' }))
    const moved = (): void => {
      throw Object.assign(new Error('moved'), { code: 'conflict' })
    }
    expect(() => recordDelivery(ctx, input(delivered), { increment: delivered.increment, verdict, assertCurrent: moved })).toThrow('moved')
    expect(storedRows(orchestrator)).toBe(1)
  })
})

describe('the installed app version check', () => {
  const scene = useScene()

  it('falls back to the session serverInfo, naming it, and prefers the desktop app\'s own observation once recorded', async () => {
    const { orchestrator } = scene()
    const delivered = await deliveredSprint(scene(), { advance: true, delivery: { target: 'main', release: true, verifyInstalled: true } })
    const fallback = await orchestrator.recordDelivery(input(delivered))
    const sessionCheck = fallback.checks.find((check) => check.name === 'Installed app version')
    expect(sessionCheck).toMatchObject({ status: 'failed', detail: expect.stringContaining("source: the recording session's serverInfo") })
    expect(fallback.passed).toBe(false)
    recordInstalledApp(orchestrator.ctx(), { version: VERSION, packaged: true })
    const observed = await orchestrator.recordDelivery(input(delivered, { observedInstalledVersion: VERSION }))
    expect(observed.checks.find((check) => check.name === 'Installed app version')).toMatchObject({
      status: 'passed',
      detail: expect.stringContaining("source: the desktop app's observation of")
    })
    expect(observed).toMatchObject({ passed: true, installedVersion: VERSION })
  })
})

describe('recordDelivery refuses', () => {
  const scene = useScene()

  it('before the checkpoint, for a sprint without a delivery, outside the plan, and from any role but the orchestrator', async () => {
    const { orchestrator, harness, repo } = scene()
    const delivered = await deliveredSprint(scene(), { advance: false })
    const early = orchestrator.recordDelivery(input(delivered))
    await expect(early).rejects.toMatchObject({ code: 'unauthorized_transition', message: 'Sprint 1 has not passed its checkpoint yet; delivery follows the approval.' })
    await expect(orchestrator.recordDelivery(input(delivered, { sprintId: delivered.sprints[1] }))).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Sprint 2 declares no delivery.'
    })
    const unknown = delivered.sprints[1].replace(/.$/, (last) => (last === '0' ? '1' : '0'))
    expect(await codeOf(orchestrator.recordDelivery(input(delivered, { sprintId: unknown })))).toBe('not_found')
    for (const role of ['worker', 'reviewer', 'planner', 'reader', 'desktop'] as const) {
      const other = harness.open(role, { root: repo.root, git: createGitAdapter(repo.root) })
      expect(await codeOf(other.recordDelivery(input(delivered)))).toBe('unauthorized')
    }
    expect(storedRows(orchestrator)).toBe(0)
  })

  it('a run that is not owned or not active, and a completed run for any sprint but the last', async () => {
    const { orchestrator } = scene()
    const delivered = await deliveredSprint(scene(), { advance: true })
    const db = orchestrator.ctx().db
    db.run("UPDATE runs SET owner_machine_id = 'elsewhere' WHERE id = ?", delivered.runId)
    expect(await codeOf(orchestrator.recordDelivery(input(delivered)))).toBe('run_not_owned')
    db.run('UPDATE runs SET owner_machine_id = ? WHERE id = ?', orchestrator.ctx().machineId, delivered.runId)
    db.run("UPDATE runs SET state = 'canceled' WHERE id = ?", delivered.runId)
    expect(await codeOf(orchestrator.recordDelivery(input(delivered)))).toBe('run_not_active')
    db.run("UPDATE runs SET state = 'completed' WHERE id = ?", delivered.runId)
    expect(await codeOf(orchestrator.recordDelivery(input(delivered)))).toBe('run_not_active')
    expect(await codeOf(orchestrator.recordDelivery(input(delivered, { sprintId: delivered.sprints[1] })))).toBe('invalid_input')
    expect(storedRows(orchestrator)).toBe(0)
  })

  it('a sprint without an accepted, passing increment, and a folder of repositories', async () => {
    const { orchestrator } = scene()
    const delivered = await deliveredSprint(scene(), { advance: true })
    const ctx = orchestrator.ctx()
    expect(() => deliveryContextOf({ ...ctx, repositories: () => ['api'] }, input(delivered))).toThrow(
      expect.objectContaining({ code: 'invalid_input', message: expect.stringContaining('folder of repositories') })
    )
    ctx.db.run("UPDATE attempts SET state = 'rejected' WHERE increment_json IS NOT NULL")
    await expect(orchestrator.recordDelivery(input(delivered))).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Sprint 1 has no accepted acceptance-node attempt with a passing increment.'
    })
    expect(storedRows(orchestrator)).toBe(0)
  })
})
