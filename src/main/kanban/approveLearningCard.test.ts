/**
 * DM-956: one human approval of a sprint learning card at the desktop, end to end through real core services (the
 * desktop workspace's production operation allow-list), the real coordinator and real Git: single and two-repository
 * approval to Done with one publication, partial integration then restart, stale replays, a failed finalization, a
 * conflict that leaves the card in Ready for review, the ordinary approve path, and quit drainage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMAND_SCHEMAS } from '../../core/commandSchemas'
import { kanbanCommands } from '../../core/commands/kanban'
import { DomainError } from '../../core/errors'
import { createGitAdapter } from '../../core/repo/git'
import { approveKanbanCard, claimKanbanCard, kickBackKanbanCard, playKanbanCard } from '../../core/services/kanban/attempts'
import { createKanbanCard } from '../../core/services/kanban/cards'
import { collectLearningEvidence } from '../../core/services/learningEvidence'
import { prepareLearningIntegration } from '../../core/services/learningIntegrations'
import { getStagedLearningDrafts } from '../../core/services/learningPublication'
import type { KanbanPacket } from '../../shared/domain/kanban'
import type { LearningEvidenceItem, SprintLearningCardView } from '../../shared/domain/learnings'
import { makeBundle, sid } from '../../test/bundles'
import { seedAttempt, seedRun } from '../../test/checkpointSeed'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { type TestCtx, withRole } from '../../test/testContext'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { type TestWorkspace, testWorkspace } from '../desktop/__mocks__/projectWorkspaceFixture'
import { createLearningIntegrationLocks } from '../git/learningIntegration'
import { createOperationLocks } from '../git/operationLock'
import { createGitRunner, type GitRunner } from '../git/runner'
import type { ApproveLearningCardRequest } from '../../shared/desktop/api'
import { createLearningApprovals, type LearningApprovalController } from './approveLearningCard'

const EPIC = 'epic/x'
const cleanups: Array<() => void> = []
let harness: Harness

beforeEach(() => {
  isolateGitConfig(cleanups)
  harness = createHarness()
  cleanups.push(() => harness.cleanup())
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

interface Repo {
  name: string | null
  repo: GitRepo
  increment: string
}

interface Project {
  root: string
  repos: Repo[]
  workspace: TestWorkspace
  ctx: TestCtx
}

/** A desktop workspace: on one repository (`[null]`), or on a folder of child repositories, each at its increment on `EPIC`. */
async function project(names: (string | null)[]): Promise<Project> {
  const single = names.length === 1 && names[0] === null
  const repos = names.map((name) => {
    const repo = createGitRepo(name === null ? {} : { root: join(harness.root, name) })
    cleanups.push(repo.cleanup)
    repo.branch(EPIC)
    return { name, repo, increment: repo.commit(`increment of ${name ?? 'root'}`) }
  })
  const root = single ? (repos[0] as Repo).repo.root : harness.root
  const core = harness.open('desktop', single ? { root, git: createGitAdapter(root) } : {})
  // A single repository holds the workspace's database: close it before the repository's cleanup removes the folder.
  cleanups.push(() => harness.closeWorkspaces())
  const workspace = testWorkspace(core, harness.homeDir)
  await workspace.initializeRepository(single ? { name: 'learnings' } : { name: 'learnings', layout: 'multi_repo' })
  return { root, repos, workspace, ctx: workspace.ctx() as TestCtx }
}

/** The sprint learning card linked as DM-937 writes it over a completed run, then played and claimed. */
function linkedCard(p: Project): KanbanPacket {
  const run = seedRun(p.ctx, { bundle: makeBundle([[1, 2], [3]]) })
  const rejected = seedAttempt(p.ctx, run, { ticket: 1, state: 'rejected' })
  p.ctx.db.run('UPDATE attempts SET decision_json = ? WHERE id = ?', JSON.stringify({ outcome: 'rejected', notes: '', reasons: ['Missing test'], decidedBy: 'reviewer' }), rejected)
  const card = createKanbanCard(p.ctx, { title: 'Sprint 1 learnings', acceptanceCriteria: ['Classified'] })
  const snapshot = collectLearningEvidence(p.ctx, { runId: run.runId, sprintId: sid(1) })
  const bases: SprintLearningCardView['bases'] = p.repos.map((entry) => ({ repo: entry.name, branch: EPIC, commit: entry.increment, attemptId: 'at_acceptance' }))
  p.ctx.db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at, checkpoint_id, revision_id, snapshot_json, bases_json)
     VALUES (?, ?, ?, ?, 'rp_report', ?, ?, 'ck_checkpoint', ?, ?, ?)`,
    card.id, run.epicId, run.runId, sid(1), snapshot.contentHash, p.ctx.clock.nowIso(), snapshot.revisionId, JSON.stringify(snapshot), JSON.stringify(bases)
  )
  playKanbanCard(p.ctx, { cardId: card.id })
  return claimKanbanCard(withRole(p.ctx, 'orchestrator'), { cardId: card.id })
}

/** Commits the guardrail on each isolated branch (`file` names the same path in every repository when given). */
function codify(p: Project, packet: KanbanPacket, file?: string) {
  return (packet.learning?.branches ?? []).map((plan) => {
    const entry = p.repos.find((candidate) => candidate.name === plan.repo) as Repo
    entry.repo.git('branch', plan.branch, plan.base.commit)
    entry.repo.switchTo(plan.branch)
    if (file !== undefined) put(entry.repo.root, file, 'guardrail\n')
    const commit = file === undefined ? entry.repo.commit(`guardrail for ${plan.repo ?? 'root'}`) : (entry.repo.git('add', '--', file), entry.repo.git('commit', '-q', '-m', 'guardrail'), entry.repo.rev('HEAD'))
    entry.repo.switchTo(EPIC)
    return { repo: plan.repo, base: plan.base.commit, branch: plan.branch, commit }
  })
}

/** The submission DM-938 stores: every item classified, one draft, the verified manifests. The card is in Ready for review. */
async function submit(p: Project, packet: KanbanPacket, manifests: ReturnType<typeof codify>): Promise<ApproveLearningCardRequest> {
  const items = packet.learning?.snapshot?.items ?? []
  const item = items[0] as LearningEvidenceItem
  const learning = {
    dispositions: items.map((one, index) => ({ kind: one.kind, sourceId: one.sourceId, disposition: index === 0 ? 'learning' : 'not_reusable', reason: 'Classified.' })),
    drafts: [{
      title: 'Run the migration tests',
      rule: 'Run the migration upgrade tests before submitting a schema change.',
      check: 'The attempt evidence lists the migration test run.',
      applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/db/**'] },
      evidence: [{ kind: item.kind, sourceId: item.sourceId, contentHash: item.contentHash }],
      replaces: null
    }],
    manifests
  }
  const input = COMMAND_SCHEMAS.submitKanbanCard.parse({ attemptId: packet.attemptId, claimToken: packet.claimToken, outputs: { summary: 'Codified.' }, learning })
  await kanbanCommands.submitKanbanCard.run({ ctx: () => withRole(p.ctx, 'worker') } as never, input)
  return { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash: getStagedLearningDrafts(p.ctx, { attemptId: packet.attemptId }).draftsHash }
}

/** A learning card in Ready for review with its guardrails codified, and the person's exact reviewed input. */
async function reviewed(names: (string | null)[], file?: string): Promise<{ p: Project; input: ApproveLearningCardRequest; manifests: ReturnType<typeof codify> }> {
  const p = await project(names)
  const packet = linkedCard(p)
  const manifests = codify(p, packet, file)
  const input = await submit(p, packet, manifests)
  await commitRecords(p)
  return { p, input, manifests }
}

/** The person commits every record so far, so the registered root checkout is clean before approval. */
async function commitRecords(p: Project): Promise<void> {
  await p.workspace.flushPortableState()
  const root = p.repos.find((entry) => entry.name === null)?.repo
  if (root === undefined || root.git('status', '--porcelain', '--untracked-files=all', '--', '.darkmechanicus') === '') return
  root.git('add', '--', '.darkmechanicus')
  root.git('commit', '-q', '-m', 'records')
}

/** The real runner, counting each Git process from its request to its actual exit. */
function countingRunner(): { runner: GitRunner; live: () => number } {
  const real = createGitRunner()
  let live = 0
  return {
    runner: { run: (request) => ((live += 1), real.run({ ...request, onExit: () => ((live -= 1), request.onExit?.()) })) },
    live: () => live
  }
}

/** The coordinator over the project's workspace, as bootstrap composes it with the shared runner and locks. */
function coordinator(p: Project, runner: GitRunner = createGitRunner(), workspace: TestWorkspace = p.workspace): LearningApprovalController {
  return createLearningApprovals({
    resolve: (folder) => (folder === p.root ? p.root : null),
    workspace: () => workspace,
    git: { runner, operations: createOperationLocks(runner), cards: createLearningIntegrationLocks() }
  })
}

/** Closes the workspace and opens a new one on the same folder: the app restarted. */
function restart(p: Project): TestWorkspace {
  p.workspace.close()
  const single = p.repos.length === 1 && p.repos[0]?.name === null
  return testWorkspace(harness.open('desktop', single ? { root: p.root, git: createGitAdapter(p.root) } : {}), harness.homeDir)
}

const integrations = (ctx: TestCtx) =>
  ctx.db.all<{ id: string; state: string; failure_json: string | null }>('SELECT id, state, failure_json FROM learning_integrations ORDER BY created_at, id')
const publications = (ctx: TestCtx) => ctx.db.all<{ attempt_id: string }>('SELECT attempt_id FROM learning_publications')
const activeLearnings = (ctx: TestCtx) => ctx.db.all<{ id: string }>("SELECT id FROM learning_records WHERE state = 'active'")
const plans = (ctx: TestCtx) => ctx.db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'learning_integration_plan:%'")
const lane = (ctx: TestCtx, cardId: string) => ctx.db.get<{ lane: string }>('SELECT lane FROM kanban_cards WHERE id = ?', cardId)?.lane
const integrated = (repo: GitRepo) => repo.git('reflog', 'show', '--format=%gs', `refs/heads/${EPIC}`).split('\n').filter((line) => line.startsWith('learning integration'))

/** The target branch now holds the merge of the guardrail onto its increment (or the fast-forwarded guardrail). */
function expectGuardrail(entry: Repo, manifest: { commit: string }): void {
  const head = entry.repo.rev(EPIC)
  expect(entry.repo.git('merge-base', '--is-ancestor', manifest.commit, head)).toBe('')
  expect(integrated(entry.repo)).toHaveLength(1)
  expect(entry.repo.git('for-each-ref', 'refs/darkmechanicus/learning-prep')).toBe('')
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  if (!(error instanceof DomainError)) throw new Error(`expected a domain error, got ${String(error)}`)
  return error
}

describe('one approval drives prepare, every repository and publication', () => {
  it('approves a single-repository card to Done with the canonical guardrail, one publication and no plan left', async () => {
    const { p, input, manifests } = await reviewed([null])
    const card = await coordinator(p).approve(p.root, input)
    expect(card).toMatchObject({ id: input.cardId, lane: 'done' })
    expectGuardrail(p.repos[0] as Repo, manifests[0] as { commit: string })
    expect(integrations(p.ctx)).toEqual([expect.objectContaining({ state: 'published', failure_json: null })])
    expect(publications(p.ctx)).toEqual([{ attempt_id: input.attemptId }])
    expect(activeLearnings(p.ctx)).toHaveLength(1)
    expect(plans(p.ctx)).toEqual([])
  })

  it('integrates every repository of a folder of repositories before Done and publishes once', async () => {
    const { p, input, manifests } = await reviewed(['alpha', 'beta'])
    const card = await coordinator(p).approve(p.root, input)
    expect(card.lane).toBe('done')
    for (const [index, entry] of p.repos.entries()) expectGuardrail(entry, manifests[index] as { commit: string })
    expect(publications(p.ctx)).toHaveLength(1)
    expect(activeLearnings(p.ctx)).toHaveLength(1)
  })
})

class Crash extends Error {}

/** The workspace as the dying app saw it: the process ends right after the first repository's receipt is stored. */
function crashingAfterFirstReceipt(workspace: TestWorkspace): TestWorkspace {
  let receipts = 0
  async function call(name: string, ...args: unknown[]): Promise<unknown> {
    const result = await (workspace.call as (name: string, ...args: unknown[]) => Promise<unknown>)(name, ...args)
    if (name === 'recordLearningReceipt' && ++receipts === 1) throw new Crash('the app died after the first receipt')
    return result
  }
  return Object.assign(Object.create(workspace) as TestWorkspace, { call: call as TestWorkspace['call'] })
}

/** Every portable record file of the project (not `local/`, the machine's own database), as text. */
function portableText(root: string): string {
  const walk = (path: string): string[] => (statSync(path).isDirectory() ? readdirSync(path).flatMap((entry) => walk(join(path, entry))) : [readFileSync(path, 'utf8')])
  return readdirSync(join(root, '.darkmechanicus')).filter((entry) => entry !== 'local').flatMap((entry) => walk(join(root, '.darkmechanicus', entry))).join('\n')
}

describe('the stored plan', () => {
  it('stays machine-local: the flushed portable records never carry it, and it is deleted once published', async () => {
    const { p, input } = await reviewed([null])
    await coordinator(p, createGitRunner(), crashingAfterFirstReceipt(p.workspace)).approve(p.root, input).catch(() => undefined)
    const [operation] = integrations(p.ctx)
    const [plan] = plans(p.ctx)
    const stored = JSON.parse(p.ctx.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', plan?.key ?? '')?.value ?? '{}') as { targets: { identity: { token: string } }[] }
    const token = stored.targets[0]?.identity.token as string
    await p.workspace.flushPortableState()
    expect([operation?.state, token]).toEqual(['integrated', expect.stringMatching(/^[0-9a-f]{32}$/)])
    expect(portableText(p.root)).toContain(operation?.id)
    expect(portableText(p.root)).not.toContain(token)
    expect(portableText(p.root)).not.toContain('learning_integration_plan')
    const restarted = restart(p)
    await coordinator(p, createGitRunner(), restarted).recover(p.root)
    expect([lane(restarted.ctx() as TestCtx, input.cardId), plans(restarted.ctx() as TestCtx)]).toEqual(['done', []])
  })
})

interface ReplayCheck {
  again: LearningApprovalController
  root: string
  input: ApproveLearningCardRequest
  repos: [Repo, Repo]
  ctx: TestCtx
}

/** A later replay of the same approval, or another recovery, changes nothing. */
async function expectReplayChangesNothing({ again, root, input, repos, ctx }: ReplayCheck): Promise<void> {
  await again.recover(root)
  expect((await again.approve(root, input)).lane).toBe('done')
  expect([integrations(ctx).length, publications(ctx).length, integrated(repos[0].repo).length, integrated(repos[1].repo).length]).toEqual([1, 1, 1, 1])
}

describe('closing or restarting after partial integration', () => {
  it('resumes from the durable plan and Git heads: no second operation, no republication', async () => {
    const { p, input, manifests } = await reviewed(['alpha', 'beta'])
    const [alpha, beta] = p.repos as [Repo, Repo]
    const error = await coordinator(p, createGitRunner(), crashingAfterFirstReceipt(p.workspace)).approve(p.root, input).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Crash)
    const [operation] = integrations(p.ctx)
    expect(operation?.state).toBe('integrating')
    expect(integrated(alpha.repo)).toHaveLength(1)
    expect(beta.repo.rev(EPIC)).toBe(beta.increment)
    expect([lane(p.ctx, input.cardId), publications(p.ctx)]).toEqual(['ready_for_review', []])
    const restarted = restart(p)
    const ctx = restarted.ctx() as TestCtx
    await coordinator(p, createGitRunner(), restarted).recover(p.root)
    expect(lane(ctx, input.cardId)).toBe('done')
    for (const [index, entry] of p.repos.entries()) expectGuardrail(entry, manifests[index] as { commit: string })
    expect(integrations(ctx)).toEqual([expect.objectContaining({ id: operation?.id, state: 'published' })])
    expect([publications(ctx).length, activeLearnings(ctx).length, plans(ctx)]).toEqual([1, 1, []])
    await expectReplayChangesNothing({ again: coordinator(p, createGitRunner(), restarted), root: p.root, input, repos: [alpha, beta], ctx })
  })

  it('never recovers an imported (inert) operation', async () => {
    const { p, input } = await reviewed(['alpha', 'beta'])
    await coordinator(p, createGitRunner(), crashingAfterFirstReceipt(p.workspace)).approve(p.root, input).catch(() => undefined)
    p.ctx.db.run('UPDATE learning_integrations SET owner_machine_id = NULL')
    const beta = p.repos[1] as Repo
    await coordinator(p).recover(p.root)
    expect([integrations(p.ctx)[0]?.state, beta.repo.rev(EPIC), lane(p.ctx, input.cardId), publications(p.ctx)]).toEqual(['integrating', beta.increment, 'ready_for_review', []])
    // The person's explicit re-preparation aborts the inert operation, and its machine-local plan goes with it.
    expect(plans(p.ctx)).toHaveLength(1)
    await prepareLearningIntegration(p.ctx, { ...input, recover: true })
    expect([integrations(p.ctx).map((row) => row.state), plans(p.ctx)]).toEqual([['aborted', 'prepared'], []])
  })

  it('quit aborts at once and waits for the workflow and every Git process; the next launch completes it', async () => {
    const { p, input, manifests } = await reviewed([null])
    const counted = countingRunner()
    const approvals = coordinator(p, counted.runner)
    const approval = approvals.approve(p.root, input).catch((caught: unknown) => caught)
    expect(approvals.busy()).toBe(true)
    await approvals.dispose()
    expect([approvals.busy(), counted.live()]).toEqual([false, 0])
    expect(await approval).toMatchObject({ code: 'conflict', details: { reason: 'interrupted' } })
    expect([lane(p.ctx, input.cardId), publications(p.ctx)]).toEqual(['ready_for_review', []])
    expect((await refusal(approvals.approve(p.root, input))).message).toContain('closing')

    const restarted = restart(p)
    await coordinator(p, createGitRunner(), restarted).recover(p.root)
    expect(lane(restarted.ctx() as TestCtx, input.cardId)).toBe('done')
    expectGuardrail(p.repos[0] as Repo, manifests[0] as { commit: string })
  })
})

describe('stale and failed approvals', () => {
  it('refuses other drafts, a superseded attempt, another folder and a concurrent different request', async () => {
    const { p, input, manifests } = await reviewed([null])
    const approvals = coordinator(p)
    expect((await refusal(approvals.approve(p.root, { ...input, draftsHash: `sha256:${'0'.repeat(64)}` }))).code).toBe('conflict')
    expect((await refusal(approvals.approve(join(p.root, 'elsewhere'), input))).code).toBe('unauthorized')
    expect((await refusal(approvals.approve(p.root, { ...input, cardId: 'not an id' }))).code).toBe('invalid_input')
    expect(integrations(p.ctx)).toEqual([])
    // The person kicks the card back; the agent resubmits; the first attempt is no longer the one under review.
    kickBackKanbanCard(p.ctx, { cardId: input.cardId, comment: 'Tighten the rule.' })
    const packet = claimKanbanCard(withRole(p.ctx, 'orchestrator'), { cardId: input.cardId })
    const resubmitted = await submit(p, packet, manifests)
    await commitRecords(p)
    expect((await refusal(approvals.approve(p.root, input))).code).toBe('approval_required')
    const first = approvals.approve(p.root, resubmitted)
    const joined = approvals.approve(p.root, resubmitted)
    expect((await refusal(approvals.approve(p.root, { ...resubmitted, attemptId: input.attemptId }))).message).toContain('Another approval')
    expect([(await first).lane, (await joined).lane]).toEqual(['done', 'done'])
    expect([integrations(p.ctx).length, publications(p.ctx)]).toEqual([1, [{ attempt_id: resubmitted.attemptId }]])
  })

  it('a failed finalization leaves the card in Ready for review with nothing published; approving again finishes once', async () => {
    const { p, input, manifests } = await reviewed([null])
    p.ctx.db.exec(`CREATE TRIGGER refuse_publication BEFORE INSERT ON learning_publications BEGIN SELECT RAISE(ABORT, 'publication refused'); END;`)
    const approvals = coordinator(p)
    expect(await approvals.approve(p.root, input).catch((caught: unknown) => String(caught))).toContain('publication refused')
    expect([lane(p.ctx, input.cardId), publications(p.ctx), activeLearnings(p.ctx), integrations(p.ctx)[0]?.state]).toEqual(['ready_for_review', [], [], 'integrated'])
    expectGuardrail(p.repos[0] as Repo, manifests[0] as { commit: string })
    p.ctx.db.exec('DROP TRIGGER refuse_publication')
    expect((await approvals.approve(p.root, input)).lane).toBe('done')
    expectGuardrail(p.repos[0] as Repo, manifests[0] as { commit: string })
    expect([publications(p.ctx).length, activeLearnings(p.ctx).length, integrations(p.ctx).length, plans(p.ctx)]).toEqual([1, 1, 1, []])
  })
})

describe('conflicts and ordinary cards', () => {
  it('a conflict stays visible on the Ready-for-review card, keeps the isolated branches and publishes nothing', async () => {
    const { p, input, manifests } = await reviewed(['alpha', 'beta'], 'GUARDRAILS.md')
    const beta = p.repos[1] as Repo
    put(beta.repo.root, 'GUARDRAILS.md', 'the epic wrote this first\n')
    beta.repo.git('add', '--', 'GUARDRAILS.md')
    beta.repo.git('commit', '-q', '-m', 'epic change')
    const heads = p.repos.map((entry) => entry.repo.rev(EPIC))
    const error = await refusal(coordinator(p).approve(p.root, input))
    expect(error.message).toContain('beta')
    expect(error.message).toContain('GUARDRAILS.md')
    expect(integrations(p.ctx)).toEqual([expect.objectContaining({ state: 'conflicted', failure_json: expect.stringContaining('GUARDRAILS.md') })])
    expect([lane(p.ctx, input.cardId), publications(p.ctx), plans(p.ctx)]).toEqual(['ready_for_review', [], []])
    expect(p.repos.map((entry) => entry.repo.rev(EPIC))).toEqual(heads)
    for (const [index, entry] of p.repos.entries()) expect(entry.repo.rev((manifests[index] as { branch: string }).branch)).toBe((manifests[index] as { commit: string }).commit)
    const messages = await p.workspace.listKanbanMessages({ cardId: input.cardId })
    expect(messages.at(-1)?.body).toContain('GUARDRAILS.md')
  })

  it('an ordinary card is refused here and still approved through approveKanbanCard', async () => {
    const p = await project([null])
    const card = createKanbanCard(p.ctx, { title: 'Fix the upload test', acceptanceCriteria: ['It passes'] })
    playKanbanCard(p.ctx, { cardId: card.id })
    const packet = claimKanbanCard(withRole(p.ctx, 'orchestrator'), { cardId: card.id })
    await kanbanCommands.submitKanbanCard.run({ ctx: () => withRole(p.ctx, 'worker') } as never, COMMAND_SCHEMAS.submitKanbanCard.parse({
      attemptId: packet.attemptId, claimToken: packet.claimToken, outputs: { summary: 'Fixed.' },
      evidence: { checks: [{ name: 'lint', status: 'passed', detail: '' }], criteria: [{ criterionId: 'c1', met: true, note: 'ok' }] }
    }))
    const input = { cardId: card.id, attemptId: packet.attemptId, draftsHash: `sha256:${'1'.repeat(64)}` }
    expect((await refusal(coordinator(p).approve(p.root, input))).code).toBe('invalid_state')
    expect(await prepareLearningIntegration(p.ctx, input).catch((caught: DomainError) => caught.code)).toBe('invalid_state')
    expect(lane(p.ctx, card.id)).toBe('ready_for_review')
    expect(approveKanbanCard(p.ctx, { cardId: card.id }).lane).toBe('done')
    expect([integrations(p.ctx), publications(p.ctx)]).toEqual([[], []])
  })
})

const status = (repo: GitRepo): string[] => repo.git('status', '--porcelain=v1', '--untracked-files=all').split('\n').filter((line) => line !== '')

/** DM-982: two learning cards in Ready for review on one repository (repo storage), every record so far committed once. */
async function twoReviewed(): Promise<{ p: Project; root: GitRepo; inputs: ApproveLearningCardRequest[] }> {
  const p = await project([null])
  const inputs: ApproveLearningCardRequest[] = []
  for (const packet of [linkedCard(p), linkedCard(p)]) inputs.push(await submit(p, packet, codify(p, packet)))
  await commitRecords(p)
  const root = (p.repos[0] as Repo).repo
  expect(status(root)).toEqual([])
  return { p, root, inputs }
}

/** The record files the published approval of `input` left in the checkout: its integration, learning and approval event. */
function publishedFiles(p: Project, input: ApproveLearningCardRequest): string[] {
  const operation = p.ctx.db.get<{ id: string }>("SELECT id FROM learning_integrations WHERE attempt_id = ? AND state = 'published'", input.attemptId)
  const learning = p.ctx.db.get<{ id: string }>('SELECT id FROM learning_records WHERE attempt_id = ?', input.attemptId)
  const event = p.ctx.db.get<{ id: string }>("SELECT id FROM kanban_events WHERE card_id = ? AND kind = 'approved'", input.cardId)
  return [
    `.darkmechanicus/kanban/${input.cardId}/events/${event?.id}.json`,
    `.darkmechanicus/learnings/integrations/${operation?.id}.json`,
    `.darkmechanicus/learnings/records/${learning?.id}.json`
  ]
}

describe('DM-982: consecutive approvals in repository storage mode', () => {
  it('approves two cards in a row to Done with no commit between them, keeping only the untracked published records', async () => {
    const { p, root, inputs } = await twoReviewed()
    const [first, second] = inputs as [ApproveLearningCardRequest, ApproveLearningCardRequest]
    const commits = root.git('rev-list', '--count', '--all')
    expect((await coordinator(p).approve(p.root, first)).lane).toBe('done')
    const firstFiles = publishedFiles(p, first)
    expect(status(root)).toEqual(firstFiles.map((path) => `?? ${path}`))
    expect((await coordinator(p).approve(p.root, second)).lane).toBe('done')
    expect([lane(p.ctx, first.cardId), lane(p.ctx, second.cardId), publications(p.ctx).length, activeLearnings(p.ctx).length]).toEqual(['done', 'done', 2, 2])
    expect(status(root)).toEqual([...firstFiles, ...publishedFiles(p, second)].sort().map((path) => `?? ${path}`))
    // The only new commits are the two integrations' (each a guardrail merged into the epic branch): nothing was committed for the person.
    expect(Number(root.git('rev-list', '--count', '--all')) - Number(commits)).toBe(2)
    expect(root.git('stash', 'list')).toBe('')
  })

  it.each<[string, (root: GitRepo, files: string[]) => string]>([
    ['an unrelated untracked file', (root) => (put(root.root, 'notes.txt', 'mine\n'), 'notes.txt')],
    ['a foreign learning record', (root) => (put(root.root, '.darkmechanicus/learnings/records/lr_0000000000000000000000zz01.json', '{}\n'), '.darkmechanicus/learnings/records/lr_0000000000000000000000zz01.json')],
    ['a published record changed by hand', (root, files) => (put(root.root, files[2] as string, '{"edited":true}\n'), files[2] as string)],
    ['a staged published record', (root, files) => (root.git('add', '--', files[1] as string), files[1] as string)]
  ])('still refuses the next approval beside %s, changing nothing', async (_name, make) => {
    const { p, root, inputs } = await twoReviewed()
    const [first, second] = inputs as [ApproveLearningCardRequest, ApproveLearningCardRequest]
    await coordinator(p).approve(p.root, first)
    const blocker = make(root, publishedFiles(p, first))
    const [head, stage, dirty] = [root.rev(EPIC), root.git('ls-files', '--stage'), status(root)]
    const error = await refusal(coordinator(p).approve(p.root, second))
    expect([error.code, error.details?.reason]).toEqual(['conflict', 'dirty_worktree'])
    expect(error.message).toContain(`is not clean: ${blocker}. Nothing was changed`)
    // The refused approval's own prepared record is the only addition (DM-952: written by the flush before native apply).
    const prepared = p.ctx.db.get<{ id: string }>('SELECT id FROM learning_integrations WHERE attempt_id = ?', second.attemptId)?.id
    const untracked = [...dirty.filter((line) => line.startsWith('?? ')), `?? .darkmechanicus/learnings/integrations/${prepared}.json`].sort()
    expect([root.rev(EPIC), root.git('ls-files', '--stage'), status(root)]).toEqual([head, stage, [...dirty.filter((line) => !line.startsWith('?? ')), ...untracked]])
    expect([lane(p.ctx, second.cardId), publications(p.ctx).length]).toEqual(['ready_for_review', 1])
  })
})
