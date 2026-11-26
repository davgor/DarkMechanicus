/** DM-948: prepare-only guardrail integration; DM-949: canonical apply and recovery; on real temporary repositories. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VerifiedLearningManifest } from '../../shared/domain/kanban'
import type {
  ApplyLearningIntegrationRequest,
  LearningIntegrationPlan,
  LearningIntegrationReceipt,
  LearningIntegrationTargetInput,
  PreparedLearningIntegration
} from '../../shared/git/learningIntegration'
import { createGitRepo, type GitRepo, openGitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import type { GitRunResult } from './errors'
import { applyLearningIntegration, recoverLearningIntegration } from './learningApply'
import { createLearningIntegrationLocks, LearningIntegrationError, type LearningIntegrationDeps, prepareLearningIntegration } from './learningIntegration'
import { createOperationLocks } from './operationLock'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
const CARD = 'kc_01card'
const ATTEMPT = 'ka_01attempt'

beforeEach(() => isolateGitConfig(cleanups))

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) cleanups.pop()?.()
})

function deps(): LearningIntegrationDeps {
  return { runner, operations: createOperationLocks(runner), cards: createLearningIntegrationLocks() }
}

/** Commits `file` with `content` on the current branch and returns the commit. */
function write(r: GitRepo, file: string, content: string): string {
  put(r.root, file, content)
  r.git('add', '--', file)
  r.git('commit', '-q', '-m', `write ${file}`)
  return r.rev('HEAD')
}

interface Fixture {
  repo: GitRepo
  base: string
  branch: string
  source: string
}

/**
 * A repository whose `sprint` target and `learnings/<card>/<repo|root>` guardrail branch both start at the completed
 * increment `base`; the guardrails add `GUARDRAILS.md`. The canonical checkout stays on `main` with local changes.
 */
function fixture(repository: string | null): Fixture {
  const repo = createGitRepo()
  cleanups.push(repo.cleanup)
  write(repo, 'shared.txt', 'one\n')
  const base = repo.rev('HEAD')
  const branch = `learnings/DM-1/${repository ?? 'root'}`
  repo.git('branch', 'sprint', base)
  repo.branch(branch)
  const source = write(repo, 'GUARDRAILS.md', 'never guess\n')
  repo.switchTo('main')
  put(repo.root, 'shared.txt', 'local edit\n')
  put(repo.root, 'untracked.txt', 'mine\n')
  return { repo, base, branch, source }
}

function manifest(f: Fixture, repository: string | null): VerifiedLearningManifest {
  return { repo: repository, base: f.base, branch: f.branch, commit: f.source, passed: true, checks: [] }
}

function target(f: Fixture, repository: string | null): LearningIntegrationTargetInput {
  return { repository, checkout: f.repo.root, branch: 'sprint' }
}

/** Advances `sprint` with a commit made outside the canonical checkout (so canonical HEAD, index and files stay put). */
function advanceTarget(f: Fixture, file: string, content: string): string {
  const scratch = scratchDir('dm-learning-adv-')
  cleanups.push(scratch.cleanup)
  const at = join(scratch.path, 'wt')
  f.repo.git('worktree', 'add', '-q', at, 'sprint')
  put(at, file, content)
  f.repo.git('-C', at, 'add', '--', file)
  f.repo.git('-C', at, 'commit', '-q', '-m', `advance ${file}`)
  const head = f.repo.rev('sprint')
  f.repo.git('worktree', 'remove', '--force', at)
  return head
}

/** Everything canonical: HEAD, every branch/tag/remote ref, the index bytes, worktrees and the working files. */
function snapshot(r: GitRepo): string {
  const digest = (path: string): string => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent')
  return JSON.stringify({
    head: readFileSync(join(r.root, '.git', 'HEAD'), 'utf8'),
    refs: r.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes'),
    index: digest(join(r.root, '.git', 'index')),
    worktrees: r.git('worktree', 'list', '--porcelain'),
    files: ['shared.txt', 'untracked.txt', 'GUARDRAILS.md'].map((file) => digest(join(r.root, file)))
  })
}

function preparedRefs(r: GitRepo): string {
  return r.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/darkmechanicus')
}

function ownedFolder(r: GitRepo): string {
  return join(r.root, '.git', 'darkmechanicus', 'learning-prep', CARD)
}

async function refused(promise: Promise<unknown>): Promise<LearningIntegrationError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(LearningIntegrationError)
  return error as LearningIntegrationError
}

function prepared(result: PreparedLearningIntegration) {
  if (result.state !== 'prepared') throw new Error(`expected prepared, got ${JSON.stringify(result)}`)
  return result.targets
}

describe('prepareLearningIntegration: fast-forward and merge', () => {
  it('prepares a fast-forward in a single repository and holds it by the owned ref', async () => {
    const f = fixture(null)
    const before = snapshot(f.repo)
    const result = await prepareLearningIntegration(deps(), { cardId: CARD, attemptId: ATTEMPT, manifests: [manifest(f, null)], targets: [target(f, null)] })
    expect(prepared(result)).toEqual([
      {
        repository: null,
        checkout: f.repo.root,
        targetRef: 'refs/heads/sprint',
        oldHead: f.base,
        newHead: f.source,
        outcome: 'fastForward',
        source: { branch: f.branch, commit: f.source, base: f.base },
        preparedRef: `refs/darkmechanicus/learning-prep/${CARD}/root`
      }
    ])
    expect(preparedRefs(f.repo)).toBe(`refs/darkmechanicus/learning-prep/${CARD}/root ${f.source}`)
    expect(snapshot(f.repo)).toBe(before)
  })

  it('prepares a non-fast-forward as a merge commit made only in an owned worktree', async () => {
    const f = fixture(null)
    const oldHead = advanceTarget(f, 'sprint.txt', 'more work\n')
    const before = snapshot(f.repo)
    const [one] = prepared(
      await prepareLearningIntegration(deps(), { cardId: CARD, attemptId: ATTEMPT, manifests: [manifest(f, null)], targets: [target(f, null)] })
    )
    expect(one?.outcome).toBe('merge')
    expect(one?.oldHead).toBe(oldHead)
    const newHead = one?.newHead as string
    expect(f.repo.git('rev-list', '--parents', '-n', '1', newHead).split(' ')).toEqual([newHead, oldHead, f.source])
    expect(f.repo.git('show', `${newHead}:GUARDRAILS.md`)).toBe('never guess')
    expect(f.repo.git('show', `${newHead}:sprint.txt`)).toBe('more work')
    expect(preparedRefs(f.repo)).toBe(`refs/darkmechanicus/learning-prep/${CARD}/root ${newHead}`)
    expect(existsSync(join(ownedFolder(f.repo), 'root'))).toBe(false)
    expect(snapshot(f.repo)).toBe(before)
  })
})

describe('prepareLearningIntegration: no change and several repositories', () => {
  it('prepares no change when the target already contains the guardrails, and repeats deterministically', async () => {
    const f = fixture(null)
    f.repo.git('branch', '-f', 'sprint', f.source)
    const before = snapshot(f.repo)
    const request = { cardId: CARD, attemptId: ATTEMPT, manifests: [manifest(f, null)], targets: [target(f, null)] }
    const first = await prepareLearningIntegration(deps(), request)
    expect(prepared(first)[0]).toMatchObject({ outcome: 'noChange', oldHead: f.source, newHead: f.source })
    expect(await prepareLearningIntegration(deps(), request)).toEqual(first)
    expect(snapshot(f.repo)).toBe(before)
  })

  it('prepares FF, non-FF and no-change across several repositories under one call', async () => {
    const ff = fixture('alpha')
    const merge = fixture('beta')
    const same = fixture('gamma')
    advanceTarget(merge, 'beta.txt', 'beta work\n')
    same.repo.git('branch', '-f', 'sprint', same.source)
    const all = [ff, merge, same]
    const names = ['alpha', 'beta', 'gamma']
    const before = all.map((f) => snapshot(f.repo))
    const result = await prepareLearningIntegration(deps(), {
      cardId: CARD,
      attemptId: ATTEMPT,
      manifests: all.map((f, index) => manifest(f, names[index] as string)).reverse(),
      targets: all.map((f, index) => target(f, names[index] as string))
    })
    expect(prepared(result).map((one) => [one.repository, one.outcome, one.preparedRef])).toEqual([
      ['alpha', 'fastForward', `refs/darkmechanicus/learning-prep/${CARD}/alpha`],
      ['beta', 'merge', `refs/darkmechanicus/learning-prep/${CARD}/beta`],
      ['gamma', 'noChange', `refs/darkmechanicus/learning-prep/${CARD}/gamma`]
    ])
    for (const one of prepared(result)) {
      const f = all[names.indexOf(one.repository as string)] as Fixture
      expect(f.repo.rev(one.preparedRef)).toBe(one.newHead)
      expect(f.repo.rev(f.branch)).toBe(one.source.commit)
    }
    expect(all.map((f) => snapshot(f.repo))).toEqual(before)
  })
})

describe('prepareLearningIntegration: conflicts', () => {
  it('collects every conflict before any update and keeps no prepared ref in any repository', async () => {
    const clean = fixture('alpha')
    const bad = fixture('beta')
    const worse = fixture('gamma')
    advanceTarget(bad, 'GUARDRAILS.md', 'target text\n')
    advanceTarget(worse, 'GUARDRAILS.md', 'other text\n')
    const all = [clean, bad, worse]
    const names = ['alpha', 'beta', 'gamma']
    const before = all.map((f) => snapshot(f.repo))
    const result = await prepareLearningIntegration(deps(), {
      cardId: CARD,
      attemptId: ATTEMPT,
      manifests: all.map((f, index) => manifest(f, names[index] as string)),
      targets: all.map((f, index) => target(f, names[index] as string))
    })
    expect(result.state).toBe('conflicted')
    const conflicts = result.state === 'conflicted' ? result.conflicts : []
    expect(conflicts.map((one) => [one.repository, one.files, one.oldHead, one.sourceCommit])).toEqual([
      ['beta', ['GUARDRAILS.md'], bad.repo.rev('sprint'), bad.source],
      ['gamma', ['GUARDRAILS.md'], worse.repo.rev('sprint'), worse.source]
    ])
    expect(conflicts[0]?.detail).toBe('Conflicts in GUARDRAILS.md.')
    for (const f of all) {
      expect(preparedRefs(f.repo)).toBe('')
      expect(existsSync(ownedFolder(f.repo)) ? f.repo.git('worktree', 'list', '--porcelain').includes('learning-prep') : false).toBe(false)
      expect(f.repo.rev(f.branch)).toBe(f.source)
    }
    expect(all.map((f) => snapshot(f.repo))).toEqual(before)
  })
})

describe('prepareLearningIntegration: unsafe paths and owned worktrees', () => {
  it('refuses unsafe repository names, card ids, checkouts and branch names before any write', async () => {
    const f = fixture(null)
    const sub = join(f.repo.root, 'nested')
    put(sub, 'keep.txt', 'x\n')
    const before = snapshot(f.repo)
    const base = { cardId: CARD, attemptId: ATTEMPT, manifests: [manifest(f, null)], targets: [target(f, null)] }
    const cases: Array<[typeof base, string]> = [
      [{ ...base, manifests: [manifest(f, '../escape')], targets: [target(f, '../escape')] }, 'The repository name "../escape" is not safe for an owned worktree or ref.'],
      [{ ...base, manifests: [manifest(f, 'root')], targets: [target(f, 'root')] }, 'The repository name "root" is not safe for an owned worktree or ref.'],
      [{ ...base, cardId: 'kc_../x' }, 'The card id "kc_../x" is not a learning card id.'],
      [{ ...base, targets: [{ ...target(f, null), checkout: 'relative/path' }] }, 'The checkout of the root repository must be an absolute path.'],
      [{ ...base, targets: [{ ...target(f, null), checkout: sub }] }, `${sub} is inside a repository but is not its top level (the root repository).`],
      [{ ...base, targets: [{ ...target(f, null), branch: '-x' }] }, 'The target branch "-x" is not a valid branch name.'],
      [{ ...base, targets: [{ ...target(f, null), branch: 'a..b' }] }, 'The target branch "a..b" is not a valid branch name.'],
      [{ ...base, manifests: [{ ...manifest(f, null), branch: 'bad..name' }] }, 'The guardrail branch "bad..name" is not a valid branch name.']
    ]
    for (const [request, message] of cases) {
      const error = await refused(prepareLearningIntegration(deps(), request))
      expect([error.code, error.message]).toEqual(['unsafe_path', message])
    }
    expect(preparedRefs(f.repo)).toBe('')
    expect(snapshot(f.repo)).toBe(before)
  })

  it('refuses an owned worktree path that has a branch checked out and leaves it as it was', async () => {
    const f = fixture(null)
    advanceTarget(f, 'sprint.txt', 'more\n')
    const owned = join(ownedFolder(f.repo), 'root')
    f.repo.git('worktree', 'add', '-q', '-b', 'someone', owned, 'main')
    const before = snapshot(f.repo)
    const error = await refused(
      prepareLearningIntegration(deps(), { cardId: CARD, attemptId: ATTEMPT, manifests: [manifest(f, null)], targets: [target(f, null)] })
    )
    expect(error.code).toBe('unsafe_path')
    expect(error.message).toContain('is a worktree with a branch checked out; preparation only owns detached worktrees there.')
    expect(f.repo.git('-C', owned, 'symbolic-ref', 'HEAD')).toBe('refs/heads/someone')
    expect(preparedRefs(f.repo)).toBe('')
    expect(snapshot(f.repo)).toBe(before)
  })
})

describe('prepareLearningIntegration: locks and moved inputs', () => {
  it('holds one deterministic lock per card and reports who owns it', async () => {
    const f = fixture(null)
    const shared = deps()
    const request = { cardId: CARD, attemptId: ATTEMPT, manifests: [manifest(f, null)], targets: [target(f, null)] }
    // The project's lib target predates Promise.withResolvers.
    let release: () => void = () => undefined
    const holding = shared.cards.run(CARD, 'ka_01other', () => new Promise<void>((resolve) => (release = resolve)))
    const before = snapshot(f.repo)
    const other = await refused(prepareLearningIntegration(shared, request))
    expect([other.code, other.message]).toEqual(['locked', `Attempt ka_01other holds the integration lock of ${CARD}; ${ATTEMPT} cannot prepare it now.`])
    expect(preparedRefs(f.repo)).toBe('')
    expect(snapshot(f.repo)).toBe(before)
    release()
    await holding
    expect(prepared(await prepareLearningIntegration(shared, request))[0]?.outcome).toBe('fastForward')
    const again = shared.cards.run(CARD, ATTEMPT, () => prepareLearningIntegration(shared, request))
    const same = await refused(again)
    expect([same.code, same.message]).toEqual(['locked', `Attempt ${ATTEMPT} is already preparing the integration of ${CARD}.`])
  })

  it('refuses a moved guardrail branch, a missing target and an unverified manifest with precise errors', async () => {
    const f = fixture(null)
    const base = { cardId: CARD, attemptId: ATTEMPT, manifests: [manifest(f, null)], targets: [target(f, null)] }
    const unverified = await refused(prepareLearningIntegration(deps(), { ...base, manifests: [{ ...manifest(f, null), passed: false }] }))
    expect([unverified.code, unverified.message]).toEqual(['invalid_request', 'The manifest of the root repository did not pass verification.'])
    const missing = await refused(prepareLearningIntegration(deps(), { ...base, targets: [{ ...target(f, null), branch: 'nowhere' }] }))
    expect([missing.code, missing.message]).toEqual(['target_missing', 'The target branch nowhere does not exist in the root repository.'])
    f.repo.git('branch', '-f', f.branch, f.base)
    const before = snapshot(f.repo)
    const moved = await refused(prepareLearningIntegration(deps(), base))
    expect([moved.code, moved.message]).toEqual([
      'source_moved',
      `The guardrail branch ${f.branch} moved to ${f.base.slice(0, 7)} in the root repository; the verified commit was ${f.source.slice(0, 7)}.`
    ])
    expect(preparedRefs(f.repo)).toBe('')
    expect(snapshot(f.repo)).toBe(before)
  })
})

// ─── DM-949: canonical apply and recovery ─────────────────────────────────────────────────────────────────────────

type Plan = LearningIntegrationPlan
type Receipt = LearningIntegrationReceipt

/** Thrown by a test callback to stand for the process dying at that point. */
class Crash extends Error {}

/** A runner that lets `intercept` see (and replace) each request before the real runner runs it. */
function intercepting(intercept: (request: GitRunRequest, real: GitRunner) => Promise<GitRunResult> | null): LearningIntegrationDeps {
  const wrapped: GitRunner = { run: (request) => intercept(request, runner) ?? runner.run(request) }
  return { runner: wrapped, operations: createOperationLocks(wrapped), cards: createLearningIntegrationLocks() }
}

/** The fixture with `sprint` checked out in the canonical checkout (local edit reverted, the untracked file kept). */
function checkedOut(f: Fixture): Fixture {
  f.repo.git('checkout', '-q', '--', 'shared.txt')
  f.repo.switchTo('sprint')
  return f
}

/** Applies with a persist callback that records the plan and the target branch as it was at that moment. */
function applyRequest(fixtures: ReadonlyArray<[Fixture, string | null]>, overrides: Partial<ApplyLearningIntegrationRequest> = {}) {
  const log: string[] = []
  const saved: { plan: Plan | null } = { plan: null }
  const request: ApplyLearningIntegrationRequest = {
    cardId: CARD,
    attemptId: ATTEMPT,
    manifests: fixtures.map(([f, name]) => manifest(f, name)),
    targets: fixtures.map(([f, name]) => target(f, name)),
    persistPrepared: async (plan) => {
      saved.plan = plan
      log.push(`persist ${fixtures.map(([f]) => f.repo.rev('sprint')).join(',')}`)
    },
    onApplied: async (receipt) => {
      log.push(`applied ${receipt.repository ?? 'root'} ${receipt.oldHead}..${receipt.newHead}`)
    },
    ...overrides
  }
  return { request, log, saved }
}

/** Persists the plan, then dies before the first canonical change; returns the persisted plan. */
async function crashAfterPersist(d: LearningIntegrationDeps, fixtures: ReadonlyArray<[Fixture, string | null]>): Promise<Plan> {
  const { request, saved } = applyRequest(fixtures)
  const persist = request.persistPrepared
  await expect(
    applyLearningIntegration(d, {
      ...request,
      persistPrepared: async (plan) => {
        await persist(plan)
        throw new Crash('died after persisting')
      }
    })
  ).rejects.toBeInstanceOf(Crash)
  return saved.plan as Plan
}

function recover(d: LearningIntegrationDeps, plan: Plan, onApplied: (receipt: Receipt) => Promise<void> = async () => undefined, signal?: AbortSignal) {
  return recoverLearningIntegration(d, { attemptId: 'ka_01recovery', plan, onApplied, signal })
}

/** HEAD, refs, the index bytes and every working file the fixtures touch: what "nothing changed" compares. */
function canonicalState(r: GitRepo): string {
  return JSON.stringify({ snapshot: snapshot(r), sprint: r.git('for-each-ref', '--format=%(objectname)', 'refs/heads/sprint'), prep: preparedRefs(r), files: ['sprint.txt'].map((file) => (existsSync(join(r.root, file)) ? readFileSync(join(r.root, file), 'utf8') : null)) })
}

/** Integration entries in the target branch's reflog: one per Git change the engine made. */
function integrationMoves(r: GitRepo): number {
  return r.git('reflog', 'show', '--format=%gs', 'refs/heads/sprint').split('\n').filter((line) => line.startsWith('learning integration')).length
}

function identityFile(r: GitRepo): string {
  return join(r.root, '.git', 'darkmechanicus', 'learning-prep', `${CARD}.identity`)
}

describe('applyLearningIntegration: persist first, exact CAS, branch identity', () => {
  it('awaits persistPrepared before the first canonical change and each receipt after its target', async () => {
    const f = fixture(null)
    const { request, log } = applyRequest([[f, null]])
    const result = await applyLearningIntegration(deps(), request)
    expect(log).toEqual([`persist ${f.base}`, `applied root ${f.base}..${f.source}`])
    expect(result.state === 'applied' ? result.receipts : null).toEqual([{ repository: null, oldHead: f.base, newHead: f.source }])
    expect(f.repo.rev('sprint')).toBe(f.source)
    expect(f.repo.git('symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    expect(preparedRefs(f.repo)).toBe('')
    expect(existsSync(identityFile(f.repo))).toBe(false)
    expect(integrationMoves(f.repo)).toBe(1)

    const g = fixture(null)
    const before = canonicalState(g.repo)
    const refused = applyLearningIntegration(deps(), applyRequest([[g, null]], { persistPrepared: () => Promise.reject(new Crash('store unavailable')) }).request)
    await expect(refused).rejects.toBeInstanceOf(Crash)
    expect(g.repo.rev('sprint')).toBe(g.base)
    expect(JSON.parse(canonicalState(g.repo)).snapshot).toBe(JSON.parse(before).snapshot)
  })

  it('moves a checked-out target with its index and files while HEAD keeps naming the branch', async () => {
    const f = fixture(null)
    const oldHead = advanceTarget(f, 'sprint.txt', 'more work\n')
    checkedOut(f)
    const headFile = join(f.repo.root, '.git', 'HEAD')
    const result = await applyLearningIntegration(deps(), applyRequest([[f, null]]).request)
    const [receipt] = result.state === 'applied' ? result.receipts : []
    expect(receipt?.oldHead).toBe(oldHead)
    expect(f.repo.rev('sprint')).toBe(receipt?.newHead)
    expect(readFileSync(headFile, 'utf8')).toBe('ref: refs/heads/sprint\n')
    expect(f.repo.git('status', '--porcelain=v1')).toBe('?? untracked.txt')
    expect(readFileSync(join(f.repo.root, 'GUARDRAILS.md'), 'utf8')).toBe('never guess\n')
    expect(readFileSync(join(f.repo.root, 'untracked.txt'), 'utf8')).toBe('mine\n')
    expect(f.repo.git('reflog', '-1', '--format=%gs', 'HEAD')).toMatch(/^learning integration kc_01card /)
  })
})

describe('applyLearningIntegration: concurrent target movement', () => {
  it('holds the exact expected-old CAS when another Git process moves the checked-out target between preflight and update', async () => {
    const f = fixture(null)
    checkedOut(f)
    const elsewhere = f.repo.git('commit-tree', '-p', f.base, '-m', 'someone else', `${f.base}^{tree}`)
    let moved = false
    const d = intercepting((request) => {
      if (!moved && request.args.includes('--stdin') && request.args[0] === 'update-ref') {
        moved = true
        gitIn(f.repo.root, 'update-ref', 'refs/heads/sprint', elsewhere, f.base)
      }
      return null
    })
    const before = snapshot(f.repo)
    const error = await refused(applyLearningIntegration(d, applyRequest([[f, null]]).request))
    expect(error.code).toBe('target_moved')
    expect(error.message).toContain(`is at ${elsewhere.slice(0, 7)}, neither the prepared ${f.base.slice(0, 7)}`)
    expect(f.repo.rev('sprint')).toBe(elsewhere)
    expect(f.repo.git('symbolic-ref', 'HEAD')).toBe('refs/heads/sprint')
    expect(existsSync(join(f.repo.root, 'GUARDRAILS.md'))).toBe(false)
    expect(JSON.parse(snapshot(f.repo)).index).toBe(JSON.parse(before).index)
    expect(integrationMoves(f.repo)).toBe(0)
  })
})

/** Delays reporting the worktree write's exit until `open()`; hands `onReadTree` the request git was started with. */
function delayedExit(onReadTree: (request: GitRunRequest) => void) {
  let open: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (open = resolve))
  const d = intercepting((request, real) => {
    if (request.args[0] !== 'read-tree') return null
    const result = real.run({ ...request, onExit: () => void gate.then(() => request.onExit?.()) })
    onReadTree(request)
    return result
  })
  return { d, open }
}

/** What a competing Git process gets when it tries to move the target branch or switch HEAD right now. */
function competing(f: Fixture): string[] {
  const outcomes: string[] = []
  for (const args of [
    ['update-ref', 'refs/heads/sprint', f.base],
    ['symbolic-ref', 'HEAD', 'refs/heads/main']
  ]) {
    try {
      gitIn(f.repo.root, ...args)
      outcomes.push(`${args[0]} succeeded`)
    } catch {
      outcomes.push(`${args[0]} blocked`)
    }
  }
  return outcomes
}

describe('applyLearningIntegration: held branch and HEAD until the owned write exits', () => {
  it('blocks competing ref and HEAD writes until the worktree write has exited, then commits', async () => {
    const f = checkedOut(fixture(null))
    let reached: () => void = () => undefined
    const atReadTree = new Promise<void>((resolve) => (reached = resolve))
    const { d, open } = delayedExit(() => reached())
    let settled = false
    const applying = applyLearningIntegration(d, applyRequest([[f, null]]).request).finally(() => (settled = true))
    await atReadTree
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(settled).toBe(false)
    expect(competing(f)).toEqual(['update-ref blocked', 'symbolic-ref blocked'])
    open()
    await applying
    expect(f.repo.rev('sprint')).toBe(f.source)
    expect(f.repo.git('symbolic-ref', 'HEAD')).toBe('refs/heads/sprint')
  })

  it('on cancellation lets git finish, keeps both held until it exits, starts nothing new, and leaves a state recovery completes', async () => {
    const f = checkedOut(fixture(null))
    const controller = new AbortController()
    let reached: (request: GitRunRequest) => void = () => undefined
    const atReadTree = new Promise<GitRunRequest>((resolve) => (reached = resolve))
    const { d, open } = delayedExit((request) => reached(request))
    const { request, saved } = applyRequest([[f, null]], { signal: controller.signal })
    const calls: string[] = []
    const watched: LearningIntegrationDeps = { ...d, runner: { run: (r) => (calls.push(r.args.join(' ')), d.runner.run(r)) } }
    let settled = false
    const applying = applyLearningIntegration(watched, request).finally(() => (settled = true))
    const readTree = await atReadTree
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 300))
    // A killed read-tree can leave a truncated file or a stale index.lock that recovery cannot prove it caused.
    expect(readTree.signal?.aborted).toBe(false)
    expect(settled).toBe(false)
    expect(competing(f)).toEqual(['update-ref blocked', 'symbolic-ref blocked'])
    const started = calls.length
    open()
    const error = await refused(applying)
    expect(error.code).toBe('interrupted')
    expect(calls.length).toBe(started)
    expect(f.repo.rev('sprint')).toBe(f.base)
    expect(f.repo.git('symbolic-ref', 'HEAD')).toBe('refs/heads/sprint')
    expect(f.repo.git('status', '--porcelain=v1')).toBe('A  GUARDRAILS.md\n?? untracked.txt')
    expect(readFileSync(join(f.repo.root, 'GUARDRAILS.md'), 'utf8')).toBe('never guess\n')
    const receipts: Receipt[] = []
    await recover(deps(), saved.plan as Plan, async (receipt) => void receipts.push(receipt))
    expect(receipts).toEqual([{ repository: null, oldHead: f.base, newHead: f.source }])
    expect(f.repo.git('status', '--porcelain=v1')).toBe('?? untracked.txt')
  })
})

describe('recoverLearningIntegration: interrupted worktrees and foreign paths', () => {
  it('accepts files restored to their exact integration bytes, and rejects real dirty, staged or partial changes', async () => {
    const f = checkedOut(fixture(null))
    advanceTargetCheckedOut(f, 'sprint.txt', 'sprint work\n')
    const plan = await crashAfterPersist(deps(), [[f, null]])
    const newHead = plan.targets[0]?.newHead as string
    // Git had restored one file of the range when the process died: exact bytes, index and ref still at oldHead.
    put(f.repo.root, 'GUARDRAILS.md', 'never guess\n')
    const cases: Array<[string, () => void, () => void]> = [
      ['partial bytes', () => put(f.repo.root, 'GUARDRAILS.md', 'never gu'), () => put(f.repo.root, 'GUARDRAILS.md', 'never guess\n')],
      ['modified tracked file', () => put(f.repo.root, 'shared.txt', 'theirs\n'), () => f.repo.git('checkout', '-q', '--', 'shared.txt')],
      ['staged change', () => (put(f.repo.root, 'staged.txt', 'staged\n'), f.repo.git('add', 'staged.txt')), () => f.repo.git('rm', '-q', '--cached', 'staged.txt')]
    ]
    for (const [name, make, undo] of cases) {
      make()
      const before = canonicalState(f.repo)
      const error = await refused(recover(deps(), plan))
      expect([name, error.code]).toEqual([name, 'dirty_worktree'])
      expect(error.message).toContain('Nothing was changed; commit, stash or discard them yourself, then run recovery.')
      expect(canonicalState(f.repo)).toBe(before)
      undo()
    }
    const receipts: Receipt[] = []
    await recover(deps(), plan, async (receipt) => void receipts.push(receipt))
    expect(receipts).toEqual([{ repository: null, oldHead: plan.targets[0]?.oldHead, newHead }])
    expect(f.repo.rev('sprint')).toBe(newHead)
    expect(f.repo.git('status', '--porcelain=v1')).toBe('?? staged.txt\n?? untracked.txt')
    expect(readFileSync(join(f.repo.root, 'staged.txt'), 'utf8')).toBe('staged\n')
  })

  it('refuses a removed path and a path rebound to a clone with the same objects, never writing there', async () => {
    const f = fixture(null)
    const plan = await crashAfterPersist(deps(), [[f, null]])
    const moved = scratchDir('dm-learning-moved-')
    cleanups.push(moved.cleanup)
    renameSync(f.repo.root, join(moved.path, 'original'))
    const removed = await refused(recover(deps(), plan))
    expect([removed.code, removed.message]).toEqual(['foreign_repository', `${f.repo.root} is no longer the prepared the root repository: the path no longer exists. Nothing there was changed; prepare the integration again.`])
    gitIn(moved.path, 'clone', '-q', '--no-local', join(moved.path, 'original'), f.repo.root)
    gitIn(f.repo.root, 'branch', 'sprint', f.base)
    gitIn(f.repo.root, 'update-ref', plan.targets[0]?.preparedRef as string, f.source)
    const clone = openGitRepo(f.repo.root, 0, () => undefined)
    const before = canonicalState(clone)
    const rebound = await refused(recover(deps(), plan))
    expect(rebound.code).toBe('foreign_repository')
    expect(rebound.message).toContain('its Git folder does not hold the identity this integration was prepared with')
    expect(canonicalState(clone)).toBe(before)
    expect(clone.rev('sprint')).toBe(f.base)
  })
})

describe('recoverLearningIntegration: receipt replay', () => {
  it('replays a lost receipt with the exact tuple and no second Git change, then resumes idempotently', async () => {
    const f = fixture(null)
    const { request, saved } = applyRequest([[f, null]], { onApplied: () => Promise.reject(new Crash('receipt lost')) })
    await expect(applyLearningIntegration(deps(), request)).rejects.toBeInstanceOf(Crash)
    expect(f.repo.rev('sprint')).toBe(f.source)
    expect(preparedRefs(f.repo)).not.toBe('')
    const receipts: Receipt[] = []
    const plan = saved.plan as Plan
    await recover(deps(), plan, async (receipt) => void receipts.push(receipt))
    await recover(deps(), plan, async (receipt) => void receipts.push(receipt))
    expect(receipts).toEqual([
      { repository: null, oldHead: f.base, newHead: f.source },
      { repository: null, oldHead: f.base, newHead: f.source }
    ])
    expect(integrationMoves(f.repo)).toBe(1)
    expect(preparedRefs(f.repo)).toBe('')
  })
})

describe('recoverLearningIntegration: multi-repository crash and repeated recovery', () => {
  it('recovers a multi-repository crash repeatedly from actual Git truth within 15000ms', { timeout: 15_000 }, async () => {
    const started = performance.now()
    const alpha = fixture('alpha')
    const beta = fixture('beta')
    const gamma = fixture('gamma')
    advanceTarget(beta, 'beta.txt', 'beta work\n')
    checkedOut(beta)
    const linked = join(scratchDir('dm-learning-linked-').path, 'gamma')
    gamma.repo.git('worktree', 'add', '-q', linked, 'sprint')
    put(linked, 'gamma-untracked.txt', 'keep\n')
    const all: Array<[Fixture, string]> = [
      [alpha, 'alpha'],
      [beta, 'beta'],
      [gamma, 'gamma']
    ]
    const { request, saved } = applyRequest(all, { onApplied: () => Promise.reject(new Crash('died after alpha')) })
    await expect(applyLearningIntegration(deps(), request)).rejects.toBeInstanceOf(Crash)
    const plan = saved.plan as Plan
    expect(all.map(([f]) => f.repo.rev('sprint'))).toEqual([alpha.source, beta.repo.rev('sprint'), gamma.base])
    const dieOn = (name: string) => async (receipt: Receipt) => {
      if (receipt.repository === name) throw new Crash(`died after ${name}`)
      receipts.push(receipt)
    }
    const receipts: Receipt[] = []
    await expect(recover(deps(), plan, dieOn('beta'))).rejects.toBeInstanceOf(Crash)
    await recover(deps(), plan, async (receipt) => void receipts.push(receipt))
    await recover(deps(), plan, async (receipt) => void receipts.push(receipt))
    const tuples = plan.targets.map((one) => ({ repository: one.repository, oldHead: one.oldHead, newHead: one.newHead }))
    expect(receipts).toEqual([tuples[0], tuples[0], tuples[1], tuples[2], ...tuples])
    for (const [index, [f]] of all.entries()) {
      expect(f.repo.rev('sprint')).toBe(tuples[index]?.newHead)
      expect(integrationMoves(f.repo)).toBe(1)
      expect(preparedRefs(f.repo)).toBe('')
      expect(f.repo.rev(f.branch)).toBe(f.source)
    }
    expect(alpha.repo.git('status', '--porcelain=v1')).toBe('M shared.txt\n?? untracked.txt')
    expect(beta.repo.git('symbolic-ref', 'HEAD')).toBe('refs/heads/sprint')
    expect(beta.repo.git('status', '--porcelain=v1')).toBe('?? untracked.txt')
    expect(gitIn(linked, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/sprint')
    expect(gitIn(linked, 'status', '--porcelain=v1').trim()).toBe('?? gamma-untracked.txt')
    expect(readFileSync(join(linked, 'GUARDRAILS.md'), 'utf8')).toBe('never guess\n')
    expect(performance.now() - started).toBeLessThan(15_000)
  })
})

/** Advances the checked-out `sprint` with a commit made in the canonical checkout itself. */
function advanceTargetCheckedOut(f: Fixture, file: string, content: string): string {
  put(f.repo.root, file, content)
  f.repo.git('add', '--', file)
  f.repo.git('commit', '-q', '-m', `advance ${file}`)
  return f.repo.rev('sprint')
}
