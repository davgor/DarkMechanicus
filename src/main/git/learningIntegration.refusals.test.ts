/** DM-948: preparation refusals of malformed requests, foreign checkouts, diverged bases and failed merges, on real repositories. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedLearningManifest } from '../../shared/domain/kanban'
import type { LearningIntegrationTargetInput, PrepareLearningIntegrationRequest } from '../../shared/git/learningIntegration'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put, scratchDir } from '../../test/gitScratch'
import { GitError, type GitRunResult } from './errors'
import { createLearningIntegrationLocks, LearningIntegrationError, type LearningIntegrationDeps, prepareLearningIntegration } from './learningIntegration'
import { createOperationLocks } from './operationLock'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
const CARD = 'kc_01card'
const ATTEMPT = 'ka_01attempt'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

beforeEach(() => isolateGitConfig(cleanups))

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) cleanups.pop()?.()
})

function deps(run: GitRunner = runner): LearningIntegrationDeps {
  return { runner: run, operations: createOperationLocks(run), cards: createLearningIntegrationLocks() }
}

/** A runner that lets `intercept` replace a request before the real runner runs it. */
function intercepting(intercept: (request: GitRunRequest) => Promise<GitRunResult> | null): LearningIntegrationDeps {
  return deps({ run: (request) => intercept(request) ?? runner.run(request) })
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
function fixture(repository: string | null): Fixture {
  const repo = createGitRepo()
  cleanups.push(repo.cleanup)
  const base = write(repo, 'shared.txt', 'one\n')
  const branch = `learnings/DM-1/${repository ?? 'root'}`
  repo.git('branch', 'sprint', base)
  repo.branch(branch)
  const source = write(repo, 'GUARDRAILS.md', 'never guess\n')
  repo.switchTo('main')
  return { repo, base, branch, source }
}

function manifest(f: Fixture, repo: string | null): VerifiedLearningManifest {
  return { repo, base: f.base, branch: f.branch, commit: f.source, passed: true, checks: [] }
}

function target(f: Fixture, repository: string | null): LearningIntegrationTargetInput {
  return { repository, checkout: f.repo.root, branch: 'sprint' }
}

function request(f: Fixture, overrides: Partial<PrepareLearningIntegrationRequest> = {}): PrepareLearningIntegrationRequest {
  return { cardId: CARD, attemptId: ATTEMPT, manifests: [manifest(f, null)], targets: [target(f, null)], ...overrides }
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

/** A manifest and target that are well formed without any repository: request checks run before Git. */
const offline = (repo: string | null): [VerifiedLearningManifest, LearningIntegrationTargetInput] => [
  { repo, base: A, branch: 'learnings/x', commit: B, passed: true, checks: [] },
  { repository: repo, checkout: join(scratchDir().path, 'nowhere'), branch: 'sprint' }
]

describe('prepareLearningIntegration: malformed requests', () => {
  it('refuses attempt ids, missing, duplicate, orphan and malformed manifests before running Git', async () => {
    const [rootManifest, rootTarget] = offline(null)
    const [alphaManifest, alphaTarget] = offline('alpha')
    const base = { cardId: CARD, attemptId: ATTEMPT, manifests: [rootManifest], targets: [rootTarget] }
    const calls: string[] = []
    const watched = deps({ run: (r) => (calls.push(r.args.join(' ')), runner.run(r)) })
    const cases: Array<[PrepareLearningIntegrationRequest, string]> = [
      [{ ...base, attemptId: 'attempt-1' }, 'The attempt id "attempt-1" is not a card attempt id.'],
      [{ ...base, targets: [] }, 'Name at least one target repository to prepare.'],
      [{ ...base, manifests: [rootManifest, rootManifest] }, 'More than one manifest names the root repository.'],
      [{ ...base, targets: [rootTarget, rootTarget] }, 'the root repository is named as a target more than once.'],
      [{ ...base, targets: [alphaTarget] }, 'No verified manifest covers repository alpha.'],
      [{ ...base, manifests: [rootManifest, alphaManifest] }, 'The manifest of repository alpha names no target repository.'],
      [{ ...base, manifests: [{ ...rootManifest, commit: 'b'.repeat(12) }] }, 'The manifest of the root repository does not name full commit ids.'],
      [{ ...base, manifests: [{ ...rootManifest, base: 'HEAD~1' }] }, 'The manifest of the root repository does not name full commit ids.'],
      [{ ...base, targets: [alphaTarget, { ...rootTarget, checkout: alphaTarget.checkout }], manifests: [rootManifest, alphaManifest] }, 'Two target repositories name the same checkout.']
    ]
    for (const [bad, message] of cases) {
      const error = await refused(prepareLearningIntegration(watched, bad))
      expect([error.code, error.message]).toEqual(['invalid_request', message])
    }
    expect(calls).toEqual([])
  })

  it('refuses a checkout that is not a Git repository', async () => {
    const plain = scratchDir('dm-learning-plain-')
    cleanups.push(plain.cleanup)
    const [rootManifest, rootTarget] = offline(null)
    const checkout = plain.path
    const error = await refused(prepareLearningIntegration(deps(), { cardId: CARD, attemptId: ATTEMPT, manifests: [rootManifest], targets: [{ ...rootTarget, checkout }] }))
    expect([error.code, error.message]).toEqual(['not_repository', `${checkout} is not a Git repository (the root repository).`])
    expect(existsSync(join(checkout, '.git'))).toBe(false)
  })
})

describe('prepareLearningIntegration: moved and diverged history', () => {
  it('refuses a deleted guardrail branch and a base that no longer precedes the guardrails or the target', async () => {
    const f = fixture(null)
    const unrelated = f.repo.git('commit-tree', '-m', 'unrelated', `${f.base}^{tree}`)
    const short = (commit: string): string => commit.slice(0, 7)
    const cases: Array<[Partial<PrepareLearningIntegrationRequest>, string, string]> = [
      [{ manifests: [{ ...manifest(f, null), base: unrelated }] }, 'base_diverged', `The guardrail commit ${short(f.source)} no longer descends from its base ${short(unrelated)} in the root repository.`],
      [{ manifests: [{ ...manifest(f, null), base: f.source }] }, 'base_diverged', `The target sprint (${short(f.base)}) does not contain the completed increment ${short(f.source)} in the root repository.`]
    ]
    for (const [overrides, code, message] of cases) {
      const error = await refused(prepareLearningIntegration(deps(), request(f, overrides)))
      expect([error.code, error.message]).toEqual([code, message])
    }
    f.repo.git('branch', '-D', f.branch)
    const deleted = await refused(prepareLearningIntegration(deps(), request(f)))
    expect([deleted.code, deleted.message]).toEqual(['source_moved', `The guardrail branch ${f.branch} no longer exists in the root repository.`])
    expect(preparedRefs(f.repo)).toBe('')
    expect(f.repo.rev('sprint')).toBe(f.base)
  })
})

/** Advances `sprint` past `base` so preparation needs a merge. */
function advance(f: Fixture): string {
  const head = f.repo.git('commit-tree', '-p', f.base, '-m', 'sprint work', `${f.base}^{tree}`)
  f.repo.git('branch', '-f', 'sprint', head)
  return head
}

describe('prepareLearningIntegration: owned worktree leftovers and failed merges', () => {
  it('removes a leftover owned folder that is not a registered worktree before merging there', async () => {
    const f = fixture(null)
    const oldHead = advance(f)
    const owned = join(f.repo.root, '.git', 'darkmechanicus', 'learning-prep', CARD, 'root')
    put(owned, 'stale.txt', 'left by a crash\n')
    const result = await prepareLearningIntegration(deps(), request(f))
    expect(result.state === 'prepared' ? result.targets.map((one) => [one.outcome, one.oldHead]) : result).toEqual([['merge', oldHead]])
    expect(existsSync(owned)).toBe(false)
    expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain('learning-prep')
  })

  it('reports a merge Git refuses without conflicted files by its stderr, else its stdout', async () => {
    const f = fixture(null)
    const oldHead = advance(f)
    for (const [stderr, stdout, detail] of [
      ['fatal: refusing to merge\n', 'ignored\n', 'fatal: refusing to merge'],
      ['', 'Not possible to merge.\n', 'Not possible to merge.']
    ]) {
      const d = intercepting((r) => (r.args[0] === 'merge' && r.args[1] === '--no-ff' ? Promise.resolve({ code: 1, stdout, stderr }) : null))
      const result = await prepareLearningIntegration(d, request(f))
      expect(result).toEqual({
        state: 'conflicted',
        cardId: CARD,
        attemptId: ATTEMPT,
        conflicts: [{ repository: null, targetRef: 'refs/heads/sprint', oldHead, sourceCommit: f.source, files: [], detail }]
      })
      expect(preparedRefs(f.repo)).toBe('')
    }
  })
})

describe('prepareLearningIntegration: a failure after some repositories were prepared', () => {
  it('rethrows the failure and keeps no prepared ref in any repository', async () => {
    const alpha = fixture('alpha')
    const beta = fixture('beta')
    const failure = new GitError('git_failed', 'disk full', 'git update-ref failed with exit code 128 (git_failed)')
    const d = intercepting((r) => (r.args[0] === 'update-ref' && r.args.at(-2) === `refs/darkmechanicus/learning-prep/${CARD}/beta` ? Promise.reject(failure) : null))
    const error = await prepareLearningIntegration(d, {
      cardId: CARD,
      attemptId: ATTEMPT,
      manifests: [manifest(alpha, 'alpha'), manifest(beta, 'beta')],
      targets: [target(alpha, 'alpha'), target(beta, 'beta')]
    }).then(
      () => null,
      (caught: unknown) => caught
    )
    expect(error).toBe(failure)
    expect([preparedRefs(alpha.repo), preparedRefs(beta.repo)]).toEqual(['', ''])
    expect([alpha.repo.rev('sprint'), beta.repo.rev('sprint')]).toEqual([alpha.base, beta.base])
  })
})
