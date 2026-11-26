/** DM-949: apply and recovery refusals of corrupt plans, foreign checkouts and lost prepared refs, on real repositories. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedLearningManifest } from '../../shared/domain/kanban'
import type { ApplyLearningIntegrationRequest, LearningIntegrationPlan, LearningIntegrationReceipt, PlannedLearningTarget } from '../../shared/git/learningIntegration'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put, scratchDir } from '../../test/gitScratch'
import { applyLearningIntegration, recoverLearningIntegration } from './learningApply'
import { createLearningIntegrationLocks, LearningIntegrationError, type LearningIntegrationDeps } from './learningIntegration'
import { createOperationLocks } from './operationLock'
import { createGitRunner, type GitRunner } from './runner'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
const CARD = 'kc_01card'
const ATTEMPT = 'ka_01attempt'

beforeEach(() => isolateGitConfig(cleanups))

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) cleanups.pop()?.()
})

function deps(run: GitRunner = runner): LearningIntegrationDeps {
  return { runner: run, operations: createOperationLocks(run), cards: createLearningIntegrationLocks() }
}

/** Deps whose runner records every git command it is asked to run. */
function watched(): { d: LearningIntegrationDeps; calls: string[] } {
  const calls: string[] = []
  return { d: deps({ run: (request) => (calls.push(request.args.join(' ')), runner.run(request)) }), calls }
}

interface Fixture {
  repo: GitRepo
  base: string
  branch: string
  source: string
}

function write(r: GitRepo, file: string, content: string): string {
  put(r.root, file, content)
  r.git('add', '--', file)
  r.git('commit', '-q', '-m', `write ${file}`)
  return r.rev('HEAD')
}

/** `sprint` and the guardrail branch start at `base`; the guardrails add `GUARDRAILS.md`; the checkout stays on `main`. */
function fixture(): Fixture {
  const repo = createGitRepo()
  cleanups.push(repo.cleanup)
  const base = write(repo, 'shared.txt', 'one\n')
  const branch = 'learnings/DM-1/root'
  repo.git('branch', 'sprint', base)
  repo.branch(branch)
  const source = write(repo, 'GUARDRAILS.md', 'never guess\n')
  repo.switchTo('main')
  return { repo, base, branch, source }
}

function applyRequest(f: Fixture, overrides: Partial<ApplyLearningIntegrationRequest> = {}): ApplyLearningIntegrationRequest {
  const manifest: VerifiedLearningManifest = { repo: null, base: f.base, branch: f.branch, commit: f.source, passed: true, checks: [] }
  return {
    cardId: CARD,
    attemptId: ATTEMPT,
    manifests: [manifest],
    targets: [{ repository: null, checkout: f.repo.root, branch: 'sprint' }],
    persistPrepared: async () => undefined,
    onApplied: async () => undefined,
    ...overrides
  }
}

/** Persists the plan, then dies before the first canonical change; returns the persisted plan. */
async function persistedPlan(f: Fixture): Promise<LearningIntegrationPlan> {
  let saved: LearningIntegrationPlan | null = null
  const died = new Error('died after persisting')
  const persistPrepared = async (plan: LearningIntegrationPlan): Promise<void> => {
    saved = plan
    throw died
  }
  await expect(applyLearningIntegration(deps(), applyRequest(f, { persistPrepared }))).rejects.toBe(died)
  return saved as unknown as LearningIntegrationPlan
}

function recover(d: LearningIntegrationDeps, plan: LearningIntegrationPlan, receipts: LearningIntegrationReceipt[] = [], attemptId = 'ka_01recovery') {
  return recoverLearningIntegration(d, { attemptId, plan, onApplied: async (receipt) => void receipts.push(receipt) })
}

async function refused(promise: Promise<unknown>): Promise<LearningIntegrationError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(LearningIntegrationError)
  return error as LearningIntegrationError
}

const preparedRefs = (r: GitRepo): string => r.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/darkmechanicus')

/** A well-formed planned target that names no real repository: plan checks run before Git. */
function offlineTarget(repository: string | null): PlannedLearningTarget {
  const folder = scratchDir('dm-learning-offline-')
  cleanups.push(folder.cleanup)
  return {
    repository,
    checkout: join(folder.path, 'checkout'),
    targetRef: 'refs/heads/sprint',
    oldHead: 'a'.repeat(40),
    newHead: 'b'.repeat(40),
    outcome: 'fastForward',
    source: { branch: 'learnings/x', commit: 'b'.repeat(40), base: 'a'.repeat(40) },
    preparedRef: `refs/darkmechanicus/learning-prep/${CARD}/${repository ?? 'root'}`,
    identity: { commonDir: join(folder.path, 'checkout', '.git'), token: 'c'.repeat(32) }
  }
}

describe('recoverLearningIntegration: corrupt or foreign plans', () => {
  it('refuses every malformed plan field before running Git', async () => {
    const root = offlineTarget(null)
    const base: LearningIntegrationPlan = { cardId: CARD, attemptId: ATTEMPT, targets: [root] }
    const what = 'The plan of the root repository'
    const cases: Array<[LearningIntegrationPlan, string, string]> = [
      [{ ...base, cardId: 'card-1' }, 'unsafe_path', 'The card id "card-1" is not a learning card id.'],
      [{ ...base, attemptId: 'attempt-1' }, 'invalid_request', 'The attempt id "attempt-1" is not a card attempt id.'],
      [{ ...base, targets: [] }, 'invalid_request', 'The plan names no target repository.'],
      [{ ...base, targets: [root, root] }, 'invalid_request', 'the root repository is named as a target more than once.'],
      [{ ...base, targets: [{ ...root, oldHead: 'a'.repeat(7) }] }, 'invalid_request', `${what} does not name full commit ids.`],
      [{ ...base, targets: [{ ...root, newHead: 'HEAD' }] }, 'invalid_request', `${what} does not name full commit ids.`],
      [{ ...base, targets: [{ ...root, preparedRef: 'refs/darkmechanicus/learning-prep/kc_02other/root' }] }, 'unsafe_path', `${what} names a prepared ref this card does not own.`],
      [{ ...base, targets: [{ ...root, targetRef: 'refs/tags/sprint' }] }, 'unsafe_path', `${what} names refs/tags/sprint, which is not a branch.`],
      [{ ...base, targets: [{ ...root, targetRef: 'refs/heads/two words' }] }, 'unsafe_path', `${what} names refs/heads/two words, which is not a branch.`],
      [{ ...base, targets: [{ ...root, checkout: 'relative/checkout' }] }, 'unsafe_path', `${what} does not name an absolute checkout and owned identity.`],
      [{ ...base, targets: [{ ...root, identity: { ...root.identity, commonDir: '.git' } }] }, 'unsafe_path', `${what} does not name an absolute checkout and owned identity.`],
      [{ ...base, targets: [{ ...root, identity: { ...root.identity, token: 'not-a-token' } }] }, 'unsafe_path', `${what} does not name an absolute checkout and owned identity.`]
    ]
    const { d, calls } = watched()
    for (const [plan, code, message] of cases) {
      const error = await refused(recover(d, plan))
      expect([error.code, error.message]).toEqual([code, message])
    }
    expect(calls).toEqual([])
  })

  it('refuses a recovering attempt id that is not a card attempt id before running Git', async () => {
    const plan: LearningIntegrationPlan = { cardId: CARD, attemptId: ATTEMPT, targets: [offlineTarget(null)] }
    const { d, calls } = watched()
    const error = await refused(recover(d, plan, [], 'recovery'))
    expect([error.code, error.message]).toEqual(['invalid_request', 'The attempt id "recovery" is not a card attempt id.'])
    expect(calls).toEqual([])
  })
})

describe('recoverLearningIntegration: foreign checkouts', () => {
  it('refuses a recorded checkout that is not a repository, not its top level, or has another Git folder', async () => {
    const f = fixture()
    const plan = await persistedPlan(f)
    const [planned] = plan.targets as [PlannedLearningTarget]
    const plain = scratchDir('dm-learning-plain-')
    cleanups.push(plain.cleanup)
    const nested = join(f.repo.root, 'nested')
    mkdirSync(nested)
    const elsewhere = join(plain.path, 'elsewhere.git')
    const cases: Array<[PlannedLearningTarget, string]> = [
      [{ ...planned, checkout: plain.path }, 'it is not a Git repository'],
      [{ ...planned, checkout: nested }, 'it is not the top level of its repository'],
      [{ ...planned, identity: { ...planned.identity, commonDir: elsewhere } }, 'its Git folder is ']
    ]
    for (const [moved, why] of cases) {
      const error = await refused(recover(deps(), { ...plan, targets: [moved] }))
      expect(error.code).toBe('foreign_repository')
      expect(error.message).toContain(`${moved.checkout} is no longer the prepared the root repository: ${why}`)
      expect(error.message).toContain('Nothing there was changed; prepare the integration again.')
    }
    expect(f.repo.rev('sprint')).toBe(f.base)
  })
})

describe('recoverLearningIntegration: lost prepared refs and cancellation', () => {
  it('refuses to move a target whose prepared ref was deleted or now holds another commit', async () => {
    const f = fixture()
    const plan = await persistedPlan(f)
    const [planned] = plan.targets as [PlannedLearningTarget]
    const tail = `not the planned ${f.source.slice(0, 7)}; refs/heads/sprint was not changed. Prepare the integration again.`
    f.repo.git('update-ref', '-d', planned.preparedRef)
    const deleted = await refused(recover(deps(), plan))
    expect([deleted.code, deleted.message]).toEqual(['not_prepared', `${planned.preparedRef} in the root repository holds nothing, ${tail}`])
    f.repo.git('update-ref', planned.preparedRef, f.base)
    const other = await refused(recover(deps(), plan))
    expect([other.code, other.message]).toEqual(['not_prepared', `${planned.preparedRef} in the root repository holds ${f.base.slice(0, 7)}, ${tail}`])
    expect(f.repo.rev('sprint')).toBe(f.base)
  })

  it('starts no transition when cancelled before recovery reaches the target', async () => {
    const f = fixture()
    const plan = await persistedPlan(f)
    const controller = new AbortController()
    controller.abort()
    const { d, calls } = watched()
    const receipts: LearningIntegrationReceipt[] = []
    const error = await refused(recoverLearningIntegration(d, { attemptId: 'ka_01recovery', plan, signal: controller.signal, onApplied: async (r) => void receipts.push(r) }))
    expect([error.code, error.message]).toEqual([
      'interrupted',
      'The integration of the root repository was cancelled before it started; refs/heads/sprint was left consistent at its actual commit. Run recovery to continue.'
    ])
    expect(calls.filter((call) => call.startsWith('worktree list') || call.startsWith('update-ref'))).toEqual([])
    expect(receipts).toEqual([])
    expect(f.repo.rev('sprint')).toBe(f.base)
  })
})

describe('applyLearningIntegration: conflicted preparation', () => {
  it('returns the conflicts without persisting a plan or moving the target', async () => {
    const f = fixture()
    const scratch = scratchDir('dm-learning-conflict-')
    cleanups.push(scratch.cleanup)
    const at = join(scratch.path, 'wt')
    f.repo.git('worktree', 'add', '-q', at, 'sprint')
    put(at, 'GUARDRAILS.md', 'target text\n')
    f.repo.git('-C', at, 'add', '--', 'GUARDRAILS.md')
    f.repo.git('-C', at, 'commit', '-q', '-m', 'collide')
    f.repo.git('worktree', 'remove', '--force', at)
    const oldHead = f.repo.rev('sprint')
    const persisted: LearningIntegrationPlan[] = []
    const result = await applyLearningIntegration(deps(), applyRequest(f, { persistPrepared: async (plan) => void persisted.push(plan) }))
    expect(result).toEqual({
      state: 'conflicted',
      cardId: CARD,
      attemptId: ATTEMPT,
      conflicts: [{ repository: null, targetRef: 'refs/heads/sprint', oldHead, sourceCommit: f.source, files: ['GUARDRAILS.md'], detail: 'Conflicts in GUARDRAILS.md.' }]
    })
    expect(persisted).toEqual([])
    expect(f.repo.rev('sprint')).toBe(oldHead)
    expect(preparedRefs(f.repo)).toBe('')
  })
})
