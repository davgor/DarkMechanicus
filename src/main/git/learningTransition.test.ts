/** DM-949: the held target transition's refusals, cancellations and index alignment, driven through recovery on real repositories. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedLearningManifest } from '../../shared/domain/kanban'
import type { LearningIntegrationPlan, LearningIntegrationReceipt } from '../../shared/git/learningIntegration'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { GitError, type GitRunResult } from './errors'
import { applyLearningIntegration, recoverLearningIntegration } from './learningApply'
import { createLearningIntegrationLocks, LearningIntegrationError, type LearningIntegrationDeps } from './learningIntegration'
import { createOperationLocks } from './operationLock'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
const CARD = 'kc_01card'

beforeEach(() => isolateGitConfig(cleanups))

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) cleanups.pop()?.()
})

function deps(run: GitRunner = runner): LearningIntegrationDeps {
  return { runner: run, operations: createOperationLocks(run), cards: createLearningIntegrationLocks() }
}

/** A runner that lets `intercept` see (and replace) each request before the real runner runs it. */
function intercepting(intercept: (request: GitRunRequest) => Promise<GitRunResult> | null): LearningIntegrationDeps {
  return deps({ run: (request) => intercept(request) ?? runner.run(request) })
}

const isTransaction = (request: GitRunRequest): boolean => request.args[0] === 'update-ref' && request.args.includes('--stdin')

interface Fixture {
  repo: GitRepo
  base: string
  source: string
  plan: LearningIntegrationPlan
}

/**
 * `sprint` at `base`, the guardrail branch one commit on adding `GUARDRAILS.md`, and a persisted plan to fast-forward
 * `sprint` to it whose apply died before the first canonical change. With `checkedOut`, the canonical checkout has `sprint`.
 */
async function fixture(checkedOut: boolean): Promise<Fixture> {
  const repo = createGitRepo()
  cleanups.push(repo.cleanup)
  put(repo.root, 'shared.txt', 'one\n')
  repo.git('add', '--', 'shared.txt')
  repo.git('commit', '-q', '-m', 'base')
  const base = repo.rev('HEAD')
  repo.git('branch', 'sprint', base)
  repo.branch('learnings/DM-1/root')
  put(repo.root, 'GUARDRAILS.md', 'never guess\n')
  repo.git('add', '--', 'GUARDRAILS.md')
  repo.git('commit', '-q', '-m', 'guardrails')
  const source = repo.rev('HEAD')
  repo.switchTo(checkedOut ? 'sprint' : 'main')
  const manifest: VerifiedLearningManifest = { repo: null, base, branch: 'learnings/DM-1/root', commit: source, passed: true, checks: [] }
  const saved: { plan: LearningIntegrationPlan | null } = { plan: null }
  const died = new Error('died after persisting')
  const persisting = applyLearningIntegration(deps(), {
    cardId: CARD,
    attemptId: 'ka_01attempt',
    manifests: [manifest],
    targets: [{ repository: null, checkout: repo.root, branch: 'sprint' }],
    persistPrepared: async (plan) => {
      saved.plan = plan
      throw died
    },
    onApplied: async () => undefined
  })
  await expect(persisting).rejects.toBe(died)
  return { repo, base, source, plan: saved.plan as LearningIntegrationPlan }
}

function recover(d: LearningIntegrationDeps, f: Fixture, receipts: LearningIntegrationReceipt[] = [], signal?: AbortSignal) {
  return recoverLearningIntegration(d, { attemptId: 'ka_01recovery', plan: f.plan, signal, onApplied: async (receipt) => void receipts.push(receipt) })
}

async function refused(promise: Promise<unknown>): Promise<LearningIntegrationError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(LearningIntegrationError)
  return error as LearningIntegrationError
}

const integrationMoves = (r: GitRepo): number =>
  r.git('reflog', 'show', '--format=%gs', 'refs/heads/sprint').split('\n').filter((line) => line.startsWith('learning integration')).length

describe('learning transition: the target found elsewhere', () => {
  it('replays the receipt without a Git change when the target already contains newHead', async () => {
    const f = await fixture(false)
    const later = f.repo.git('commit-tree', '-p', f.source, '-m', 'later work', `${f.source}^{tree}`)
    f.repo.git('branch', '-f', 'sprint', later)
    const receipts: LearningIntegrationReceipt[] = []
    await recover(deps(), f, receipts)
    expect(receipts).toEqual([{ repository: null, oldHead: f.base, newHead: f.source }])
    expect(f.repo.rev('sprint')).toBe(later)
    expect(integrationMoves(f.repo)).toBe(0)
  })

  it('refuses a deleted target branch as at no commit', async () => {
    const f = await fixture(false)
    f.repo.git('branch', '-D', 'sprint')
    const error = await refused(recover(deps(), f))
    expect([error.code, error.message]).toEqual([
      'target_moved',
      `refs/heads/sprint in the root repository is at no commit, neither the prepared ${f.base.slice(0, 7)} nor a commit containing ${f.source.slice(0, 7)}. Nothing was changed; prepare the integration again.`
    ])
  })

  it('refuses a target checked out in more than one worktree', async () => {
    const f = await fixture(true)
    const scratch = scratchDir('dm-learning-twice-')
    cleanups.push(scratch.cleanup)
    f.repo.git('worktree', 'add', '-q', '-f', join(scratch.path, 'second'), 'sprint')
    const error = await refused(recover(deps(), f))
    expect([error.code, error.message]).toEqual(['target_moved', 'refs/heads/sprint is checked out in more than one worktree of the root repository.'])
    expect(f.repo.rev('sprint')).toBe(f.base)
  })
})

describe('learning transition: the target checked out or switched while held', () => {
  it('refuses when an unheld target is checked out once its transaction is held, and changes nothing', async () => {
    const f = await fixture(false)
    const scratch = scratchDir('dm-learning-late-')
    cleanups.push(scratch.cleanup)
    const late = join(scratch.path, 'late')
    const d = intercepting((request) => {
      if (isTransaction(request) && !existsSync(late)) gitIn(f.repo.root, 'worktree', 'add', '-q', late, 'sprint')
      return null
    })
    const error = await refused(recover(d, f))
    expect([error.code, error.message]).toEqual(['target_moved', 'refs/heads/sprint was checked out while it was being integrated; nothing was changed. Run recovery.'])
    expect(f.repo.rev('sprint')).toBe(f.base)
    expect(integrationMoves(f.repo)).toBe(0)
  })

  it('refuses when the holding worktree switched to another branch before its transaction was held', async () => {
    const f = await fixture(true)
    const d = intercepting((request) => {
      if (isTransaction(request)) gitIn(f.repo.root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
      return null
    })
    const error = await refused(recover(d, f))
    // The holder worktree is named as `git worktree list` prints it.
    const holder = f.repo.git('rev-parse', '--show-toplevel')
    expect([error.code, error.message]).toEqual(['target_moved', `${holder} no longer has refs/heads/sprint checked out; nothing was changed.`])
    expect([f.repo.rev('sprint'), f.repo.rev('main')]).toEqual([f.base, f.base])
    expect(existsSync(join(f.repo.root, 'GUARDRAILS.md'))).toBe(false)
  })
})

describe('learning transition: the transaction refused', () => {
  it('confirms a target another process completed while the transaction was being opened', async () => {
    const f = await fixture(false)
    const d = intercepting((request) => {
      if (isTransaction(request)) gitIn(f.repo.root, 'update-ref', 'refs/heads/sprint', f.source, f.base)
      return null
    })
    const receipts: LearningIntegrationReceipt[] = []
    await recover(d, f, receipts)
    expect(receipts).toEqual([{ repository: null, oldHead: f.base, newHead: f.source }])
    expect(integrationMoves(f.repo)).toBe(0)
  })

  it('reports a held ref lock with Git’s own detail, and a transaction that never prepared by its error', async () => {
    const f = await fixture(false)
    const lock = join(f.repo.root, '.git', 'refs', 'heads', 'sprint.lock')
    writeFileSync(lock, '')
    const locked = await refused(recover(deps(), f))
    expect(locked.code).toBe('locked')
    expect(locked.message).toMatch(/^Another Git process holds refs\/heads\/sprint or HEAD in the root repository \(.*sprint\.lock.*\)\. Nothing was changed;/s)
    rmSync(lock)
    const silent = intercepting((request) => {
      if (!isTransaction(request)) return null
      request.onExit?.()
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    })
    const unprepared = await refused(recover(silent, f))
    expect(unprepared.code).toBe('locked')
    expect(unprepared.message).toContain('(Error: git update-ref did not prepare the transaction: ). Nothing was changed;')
    expect(f.repo.rev('sprint')).toBe(f.base)
  })
})

describe('learning transition: cancellation', () => {
  it('stops before the transaction when cancelled while the transition was starting', async () => {
    const f = await fixture(false)
    const controller = new AbortController()
    const calls: string[] = []
    const d = intercepting((request) => {
      if (request.args[0] === 'worktree') controller.abort()
      calls.push(request.args.join(' '))
      return null
    })
    const error = await refused(recover(d, f, [], controller.signal))
    expect([error.code, error.message]).toEqual([
      'interrupted',
      'The integration of the root repository was cancelled before it started; refs/heads/sprint was left consistent at its actual commit. Run recovery to continue.'
    ])
    expect(calls.filter((call) => call.includes('--stdin'))).toEqual([])
    expect(f.repo.rev('sprint')).toBe(f.base)
  })

  it('stops before the worktree update when cancelled while it was being classified', async () => {
    const f = await fixture(true)
    const controller = new AbortController()
    const calls: string[] = []
    const d = intercepting((request) => {
      if (request.args[0] === 'diff-tree') controller.abort()
      calls.push(request.args[0] as string)
      return null
    })
    const error = await refused(recover(d, f, [], controller.signal))
    expect(error.code).toBe('interrupted')
    expect(error.message).toContain('was cancelled before its worktree was updated;')
    expect(calls).not.toContain('read-tree')
    expect(f.repo.rev('sprint')).toBe(f.base)
    expect(existsSync(join(f.repo.root, 'GUARDRAILS.md'))).toBe(false)
  })
})

/** Fails the worktree's `read-tree` with `failure`, reporting git's exit first as the runner does. */
function failingReadTree(failure: Error): LearningIntegrationDeps {
  return intercepting((request) => {
    if (request.args[0] !== 'read-tree') return null
    request.onExit?.()
    return Promise.reject(failure)
  })
}

describe('learning transition: a failed worktree update', () => {
  it('reports local changes Git refused to overwrite as a dirty worktree, and rethrows any other failure', async () => {
    const f = await fixture(true)
    const overwrite = new GitError('local_changes_would_be_overwritten', 'error: Entry GUARDRAILS.md not uptodate.')
    const dirty = await refused(recover(failingReadTree(overwrite), f))
    expect([dirty.code, dirty.message]).toEqual([
      'dirty_worktree',
      `${f.repo.git('rev-parse', '--show-toplevel')} changed while it was being updated (error: Entry GUARDRAILS.md not uptodate.); nothing was moved. Commit, stash or discard those changes yourself, then run recovery.`
    ])
    for (const failure of [new GitError('git_failed', 'fatal: disk full'), new Error('spawn failed')]) {
      const thrown = await recover(failingReadTree(failure), f).then(
        () => null,
        (caught: unknown) => caught
      )
      expect(thrown).toBe(failure)
    }
    expect(f.repo.rev('sprint')).toBe(f.base)
    expect(integrationMoves(f.repo)).toBe(0)
  })
})

describe('learning transition: classifying the holder worktree', () => {
  it('refuses a range path that is a folder or an unmerged index entry', async () => {
    const f = await fixture(true)
    put(f.repo.root, 'GUARDRAILS.md/inner.txt', 'a folder\n')
    const folder = await refused(recover(deps(), f))
    expect(folder.code).toBe('dirty_worktree')
    expect(folder.message).toContain(`nor the integration's exact ${f.source.slice(0, 7)}: GUARDRAILS.md. Nothing was changed;`)
    rmSync(join(f.repo.root, 'GUARDRAILS.md'), { recursive: true })
    const blob = f.repo.git('rev-parse', `${f.source}:GUARDRAILS.md`)
    const index = `100644 ${blob} 2\tGUARDRAILS.md\n100644 ${blob} 3\tGUARDRAILS.md\n`
    execFileSync('git', ['-C', f.repo.root, 'update-index', '--index-info'], { input: index })
    const unmerged = await refused(recover(deps(), f))
    expect(unmerged.code).toBe('dirty_worktree')
    expect(unmerged.message).toContain(': GUARDRAILS.md. Nothing was changed;')
    expect(f.repo.rev('sprint')).toBe(f.base)
  })

  it('realigns a staged newHead entry whose file is still absent, then moves the worktree', async () => {
    const f = await fixture(true)
    put(f.repo.root, 'GUARDRAILS.md', 'never guess\n')
    f.repo.git('add', '--', 'GUARDRAILS.md')
    rmSync(join(f.repo.root, 'GUARDRAILS.md'))
    const receipts: LearningIntegrationReceipt[] = []
    await recover(deps(), f, receipts)
    expect(receipts).toEqual([{ repository: null, oldHead: f.base, newHead: f.source }])
    expect(f.repo.rev('sprint')).toBe(f.source)
    expect(readFileSync(join(f.repo.root, 'GUARDRAILS.md'), 'utf8')).toBe('never guess\n')
    expect(f.repo.git('status', '--porcelain=v1')).toBe('')
  })
})
