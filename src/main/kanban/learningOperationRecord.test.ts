/**
 * DM-952: a real repo-mode workspace prepares a learning approval (its flush writes the operation record into the
 * registered root checkout) and native apply then integrates that checkout with only that record kept; db mode and
 * operations this machine does not own stay strict. Real `RepositoryWorkspace.execute`, real Git.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SCHEMAS } from '../../core/commandSchemas'
import { kanbanCommands } from '../../core/commands/kanban'
import { createGitAdapter } from '../../core/repo/git'
import { claimKanbanCard, playKanbanCard } from '../../core/services/kanban/attempts'
import { createKanbanCard } from '../../core/services/kanban/cards'
import { collectLearningEvidence } from '../../core/services/learningEvidence'
import { prepareLearningIntegration } from '../../core/services/learningIntegrations'
import { getStagedLearningDrafts } from '../../core/services/learningPublication'
import { enqueueOutbox } from '../../core/services/outbox'
import { type TestWorkspace, testWorkspace } from '../desktop/__mocks__/projectWorkspaceFixture'
import type { LearningEvidenceItem, SprintLearningCardView } from '../../shared/domain/learnings'
import type {
  ApplyLearningIntegrationRequest,
  CleanCheckoutRequirement,
  LearningIntegrationPlan,
  LearningIntegrationReceipt
} from '../../shared/git/learningIntegration'
import { makeBundle, sid } from '../../test/bundles'
import { seedAttempt, seedRun } from '../../test/checkpointSeed'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { type TestCtx, withRole } from '../../test/testContext'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { applyLearningIntegration, recoverLearningIntegration } from '../git/learningApply'
import { createLearningIntegrationLocks, LearningIntegrationError } from '../git/learningIntegration'
import { createOperationLocks } from '../git/operationLock'
import { createGitRunner, type GitRunner } from '../git/runner'
import { learningOperationRecord } from './learningOperationRecord'

const EPIC = 'epic/x'
const runner = createGitRunner()
const cleanups: Array<() => void> = []
let harness: Harness

beforeEach(() => {
  isolateGitConfig(cleanups)
  harness = createHarness()
  cleanups.push(() => harness.cleanup())
})

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) cleanups.pop()?.()
})

interface Approved {
  workspace: TestWorkspace
  repo: GitRepo
  cardId: string
  attemptId: string
  draftsHash: string
  manifest: { base: string; branch: string; commit: string }
}

/** A desktop workspace on a real repository with `EPIC` checked out at the sprint's completed increment. */
async function desktopOn(mode: 'repo' | 'db'): Promise<{ workspace: TestWorkspace; repo: GitRepo; increment: string; ctx: TestCtx }> {
  const repo = createGitRepo()
  cleanups.push(repo.cleanup)
  repo.branch(EPIC)
  const increment = repo.commit('increment')
  const workspace = testWorkspace(harness.open('desktop', { root: repo.root, git: createGitAdapter(repo.root), mode }), harness.homeDir)
  // In repo mode the repository holds the workspace's database: close it before the repository's cleanup removes the folder.
  cleanups.push(() => harness.closeWorkspaces())
  await workspace.initializeRepository({ name: 'learnings', ...(mode === 'db' && { mode }) })
  return { workspace, repo, increment, ctx: workspace.ctx() as TestCtx }
}

/** The learning card linked, claimed, codified on its isolated root branch, submitted and approved, as DM-937/938 store it. */
async function approvedCard(mode: 'repo' | 'db'): Promise<Approved> {
  const { workspace, repo, increment, ctx } = await desktopOn(mode)
  const run = seedRun(ctx, { bundle: makeBundle([[1, 2], [3]]) })
  const rejected = seedAttempt(ctx, run, { ticket: 1, state: 'rejected' })
  ctx.db.run('UPDATE attempts SET decision_json = ? WHERE id = ?', JSON.stringify({ outcome: 'rejected', notes: '', reasons: ['Missing test'], decidedBy: 'reviewer' }), rejected)
  const card = createKanbanCard(ctx, { title: 'Sprint 1 learnings', acceptanceCriteria: ['Classified'] })
  const snapshot = collectLearningEvidence(ctx, { runId: run.runId, sprintId: sid(1) })
  const bases: SprintLearningCardView['bases'] = [{ repo: null, branch: EPIC, commit: increment, attemptId: 'at_acceptance' }]
  ctx.db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at, checkpoint_id, revision_id, snapshot_json, bases_json)
     VALUES (?, ?, ?, ?, 'rp_report', ?, ?, 'ck_checkpoint', ?, ?, ?)`,
    card.id, run.epicId, run.runId, sid(1), snapshot.contentHash, ctx.clock.nowIso(), snapshot.revisionId, JSON.stringify(snapshot), JSON.stringify(bases)
  )
  playKanbanCard(ctx, { cardId: card.id })
  const packet = claimKanbanCard(withRole(ctx, 'orchestrator'), { cardId: card.id })
  const plan = packet.learning?.branches[0]
  if (plan === undefined) throw new Error('the learning packet names no branch')
  repo.git('branch', plan.branch, increment)
  repo.switchTo(plan.branch)
  const commit = repo.commit('guardrail')
  repo.switchTo(EPIC)
  const manifest = { base: increment, branch: plan.branch, commit }
  const item = packet.learning?.snapshot?.items[0] as LearningEvidenceItem
  const learning = {
    dispositions: (packet.learning?.snapshot?.items ?? []).map((one, index) =>
      ({ kind: one.kind, sourceId: one.sourceId, disposition: index === 0 ? 'learning' : 'not_reusable', reason: 'Classified.' })),
    drafts: [{
      title: 'Run the migration tests',
      rule: 'Run the migration upgrade tests before submitting a schema change.',
      check: 'The attempt evidence lists the migration test run.',
      applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/db/**'] },
      evidence: [{ kind: item.kind, sourceId: item.sourceId, contentHash: item.contentHash }],
      replaces: null
    }],
    manifests: [{ repo: null, ...manifest }]
  }
  const input = COMMAND_SCHEMAS.submitKanbanCard.parse({ attemptId: packet.attemptId, claimToken: packet.claimToken, outputs: { summary: 'Codified.' }, learning })
  await kanbanCommands.submitKanbanCard.run({ ctx: () => withRole(ctx, 'worker') } as never, input)
  // The person's approval through the real command path, whose autoflush (repo mode) writes the card's records.
  await workspace.execute('approveKanbanCard', { cardId: packet.cardId })
  const draftsHash = getStagedLearningDrafts(ctx, { attemptId: packet.attemptId }).draftsHash
  return { workspace, repo, cardId: packet.cardId, attemptId: packet.attemptId, draftsHash, manifest }
}

/** The person commits every record so far: the registered root is otherwise clean before approval. */
async function commitRecords(a: Approved): Promise<void> {
  await a.workspace.flushPortableState()
  if (existsSync(join(a.repo.root, '.darkmechanicus'))) {
    a.repo.git('add', '--', '.darkmechanicus')
    a.repo.git('commit', '-q', '-m', 'records')
  }
  expect(a.repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('')
}

/** The core prepares the approval; the real workspace flush writes (in repo mode) its operation record. */
async function prepare(a: Approved): Promise<string> {
  const operation = await prepareLearningIntegration(a.workspace.ctx(), { cardId: a.cardId, attemptId: a.attemptId, draftsHash: a.draftsHash })
  await a.workspace.flushPortableState()
  return operation.id
}

const recordPath = (id: string): string => `.darkmechanicus/learnings/integrations/${id}.json`

/** Moves the operation to `state` and flushes, as the coordinator's durable prepared and receipt callbacks do. */
async function progress(a: Approved, id: string, state: string): Promise<void> {
  const ctx = a.workspace.ctx()
  ctx.db.run('UPDATE learning_integrations SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ?', state, ctx.clock.nowIso(), id)
  enqueueOutbox(ctx, { kind: 'learning_integration', entityId: id })
  await a.workspace.flushPortableState()
}

function applyRequest(a: Approved, cleanCheckout: CleanCheckoutRequirement, callbacks: Partial<ApplyLearningIntegrationRequest> = {}): ApplyLearningIntegrationRequest {
  return {
    cardId: a.cardId,
    attemptId: a.attemptId,
    manifests: [{ repo: null, ...a.manifest, passed: true, checks: [] }],
    targets: [{ repository: null, checkout: a.repo.root, branch: EPIC }],
    persistPrepared: async () => undefined,
    onApplied: async () => undefined,
    cleanCheckout,
    ...callbacks
  }
}

const deps = () => ({ runner, operations: createOperationLocks(runner), cards: createLearningIntegrationLocks() })

function readRecord(a: Approved, id: string): { id: string; state: string; revision: number } {
  return JSON.parse(readFileSync(join(a.repo.root, recordPath(id)), 'utf8')) as { id: string; state: string; revision: number }
}

/** The coordinator's durable callbacks: each moves the operation on and records the state its flushed record then holds. */
function durableProgress(a: Approved, id: string, seen: string[]): Partial<ApplyLearningIntegrationRequest> {
  return {
    persistPrepared: async () => {
      await progress(a, id, 'integrating')
      seen.push(`prepared ${readRecord(a, id).state}`)
    },
    onApplied: async () => {
      await progress(a, id, 'integrated')
      seen.push(`receipt ${readRecord(a, id).state}`)
    }
  }
}

describe('repo-mode approval on the registered root checkout', () => {
  it('keeps only the current operation record through prepared and receipt progress and reaches the reviewed result', async () => {
    const a = await approvedCard('repo')
    await commitRecords(a)
    const oldHead = a.repo.rev(EPIC)
    const id = await prepare(a)
    expect(a.repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(`?? ${recordPath(id)}`)
    expect(readRecord(a, id)).toMatchObject({ id, state: 'prepared', revision: 1 })
    const requirement = await learningOperationRecord(a.workspace, id)
    expect(requirement.record).toEqual({ checkout: a.workspace.repoRoot, path: recordPath(id), records: expect.any(Array) })
    const seen: string[] = []
    const result = await applyLearningIntegration(deps(), applyRequest(a, requirement, durableProgress(a, id, seen)))
    expect(seen).toEqual(['prepared integrating', 'receipt integrated'])
    const newHead = result.state === 'applied' ? result.receipts[0]?.newHead : null
    expect(a.repo.rev(EPIC)).toBe(newHead)
    expect(a.repo.git('rev-list', '--parents', '-n', '1', newHead as string).split(' ')).toEqual([newHead, oldHead, a.manifest.commit])
    expect(a.repo.git('symbolic-ref', 'HEAD')).toBe(`refs/heads/${EPIC}`)
    expect(a.repo.git('ls-files', '--stage')).toBe(a.repo.git('ls-tree', '-r', '--format=%(objectmode) %(objectname) 0\t%(path)', newHead as string))
    expect(a.repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(`?? ${recordPath(id)}`)
    expect(readRecord(a, id)).toMatchObject({ id, state: 'integrated', revision: 3 })
  })

  it('still refuses unrelated untracked or staged work beside the record, changing nothing', async () => {
    const a = await approvedCard('repo')
    await commitRecords(a)
    const id = await prepare(a)
    put(a.repo.root, 'notes.txt', 'mine\n')
    put(a.repo.root, 'staged.txt', 'staged\n')
    a.repo.git('add', '--', 'staged.txt')
    const before = [a.repo.rev(EPIC), a.repo.git('ls-files', '--stage'), readFileSync(join(a.repo.root, recordPath(id)), 'utf8')]
    const error = await applyLearningIntegration(deps(), applyRequest(a, await learningOperationRecord(a.workspace, id))).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LearningIntegrationError)
    expect((error as LearningIntegrationError).code).toBe('dirty_worktree')
    expect((error as LearningIntegrationError).message).toContain('is not clean: staged.txt, notes.txt.')
    expect([a.repo.rev(EPIC), a.repo.git('ls-files', '--stage'), readFileSync(join(a.repo.root, recordPath(id)), 'utf8')]).toEqual(before)
  })

  it('grants nothing for an operation this machine does not own', async () => {
    const a = await approvedCard('repo')
    await commitRecords(a)
    const id = await prepare(a)
    a.workspace.ctx().db.run('UPDATE learning_integrations SET owner_machine_id = NULL WHERE id = ?', id)
    expect(await learningOperationRecord(a.workspace, id)).toEqual({ record: null })
    expect(await learningOperationRecord(a.workspace, 'li_0000000000000000000000ff01')).toEqual({ record: null })
  })
})

describe('DM-982: the owned record files an approval may keep', () => {
  it('names exactly the current card records this machine exported, dropping missing, changed and foreign ones', async () => {
    const a = await approvedCard('repo')
    const id = await prepare(a)
    const ctx = a.workspace.ctx()
    const cardDir = `.darkmechanicus/kanban/${a.cardId}`
    const events = ctx.db.all<{ id: string }>('SELECT id FROM kanban_events WHERE card_id = ? ORDER BY created_at, id', a.cardId).map((row) => `${cardDir}/events/${row.id}.json`)
    expect(events.length).toBeGreaterThan(2)
    const files = () => a.workspace.call('learningApprovalFiles', id)
    expect(await files()).toEqual([`${cardDir}/card.json`, ...events])
    expect((await learningOperationRecord(a.workspace, id)).record?.records).toEqual([`${cardDir}/card.json`, ...events])
    put(a.repo.root, events[0] as string, '{"edited":true}\n')
    rmSync(join(a.repo.root, `${cardDir}/card.json`))
    // An unreadable owned file (empty: refused unread) is simply not named; it never fails the approval's derivation.
    put(a.repo.root, events[1] as string, '')
    expect(await files()).toEqual(events.slice(2))
    ctx.db.run('UPDATE learning_integrations SET owner_machine_id = NULL WHERE id = ?', id)
    expect(await files()).toEqual([])
  })
})

/** The real runner, counting each Git process from its request to its actual exit (`onExit`). */
function owningRunner(): { runner: GitRunner; live: () => number; started: () => number } {
  let live = 0
  let started = 0
  return {
    runner: {
      run(request) {
        live += 1
        started += 1
        return runner.run({ ...request, onExit: () => ((live -= 1), request.onExit?.()) })
      }
    },
    live: () => live,
    started: () => started
  }
}

class Crash extends Error {}

/** The coordinator's durable callbacks, storing the exact plan, with the process dying right after the first receipt. */
function crashAfterFirstReceipt(a: Approved, id: string, stored: { plan: string | null }, seen: string[]): Partial<ApplyLearningIntegrationRequest> {
  return {
    persistPrepared: async (plan) => {
      stored.plan = JSON.stringify(plan)
      await progress(a, id, 'integrating')
      seen.push(`prepared ${readRecord(a, id).state}`)
    },
    onApplied: async () => {
      await progress(a, id, 'integrated')
      seen.push(`receipt ${readRecord(a, id).state}`)
      throw new Crash('died after the first receipt')
    }
  }
}

describe('default repo-mode approval consumer: prepare, apply, receipt crash and recovery', () => {
  it('recovers from a crash after the first receipt with a re-derived allowance and leaves no Git process or folder behind', async () => {
    const a = await approvedCard('repo')
    await commitRecords(a)
    const oldHead = a.repo.rev(EPIC)
    const id = await prepare(a)
    const owned = owningRunner()
    const d = { runner: owned.runner, operations: createOperationLocks(owned.runner), cards: createLearningIntegrationLocks() }
    const stored: { plan: string | null } = { plan: null }
    const seen: string[] = []
    const crashing = crashAfterFirstReceipt(a, id, stored, seen)
    await expect(applyLearningIntegration(d, applyRequest(a, await learningOperationRecord(a.workspace, id), crashing))).rejects.toBeInstanceOf(Crash)
    expect(seen).toEqual(['prepared integrating', 'receipt integrated'])
    const plan = JSON.parse(stored.plan as string) as LearningIntegrationPlan
    const [target] = plan.targets
    expect(a.repo.rev(EPIC)).toBe(target?.newHead)
    expect(a.repo.git('for-each-ref', '--format=%(objectname)', 'refs/darkmechanicus/learning-prep')).toBe(target?.newHead)

    const requirement = await learningOperationRecord(a.workspace, id)
    expect(requirement.record).toEqual({ checkout: a.workspace.repoRoot, path: recordPath(id), records: expect.any(Array) })
    const receipts: LearningIntegrationReceipt[] = []
    const recovered = await recoverLearningIntegration(d, { attemptId: a.attemptId, plan, cleanCheckout: requirement, onApplied: async (receipt) => void receipts.push(receipt) })
    expect(recovered.state).toBe('applied')
    expect(receipts).toEqual([{ repository: null, oldHead, newHead: target?.newHead }])
    const newHead = target?.newHead as string
    expect(a.repo.rev(EPIC)).toBe(newHead)
    expect(a.repo.git('rev-list', '--parents', '-n', '1', newHead).split(' ')).toEqual([newHead, oldHead, a.manifest.commit])
    expect(a.repo.git('reflog', 'show', '--format=%gs', `refs/heads/${EPIC}`).split('\n').filter((line) => line.startsWith('learning integration'))).toHaveLength(1)
    expect(a.repo.git('for-each-ref', 'refs/darkmechanicus/learning-prep')).toBe('')
    expect(a.repo.git('symbolic-ref', 'HEAD')).toBe(`refs/heads/${EPIC}`)
    expect(a.repo.git('ls-files', '--stage')).toBe(a.repo.git('ls-tree', '-r', '--format=%(objectmode) %(objectname) 0\t%(path)', newHead))
    expect(a.repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(`?? ${recordPath(id)}`)
    expect(readRecord(a, id)).toMatchObject({ id, state: 'integrated', revision: 3 })
    expect(owned.started()).toBeGreaterThan(0)
    expect(owned.live()).toBe(0)

    a.workspace.close()
    harness.cleanup()
    a.repo.cleanup()
    expect([existsSync(a.repo.root), existsSync(harness.root), existsSync(harness.homeDir)]).toEqual([false, false, false])
  })
})

describe('db-mode approval', () => {
  it('keeps the strict clean checkout: no allowance, and a file at the record path is refused', async () => {
    const a = await approvedCard('db')
    expect(a.repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('')
    const id = await prepare(a)
    expect(a.repo.git('status', '--porcelain=v1', '--untracked-files=all')).toBe('')
    const requirement = await learningOperationRecord(a.workspace, id)
    expect(requirement).toEqual({ record: null })
    put(a.repo.root, recordPath(id), '{}\n')
    const oldHead = a.repo.rev(EPIC)
    const error = await applyLearningIntegration(deps(), applyRequest(a, requirement)).catch((caught: unknown) => caught)
    expect((error as LearningIntegrationError).code).toBe('dirty_worktree')
    expect(a.repo.rev(EPIC)).toBe(oldHead)
  })
})
