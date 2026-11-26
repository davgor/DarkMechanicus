/**
 * DM-948: the prepare-only phase of integrating a learning card's guardrail branches onto their target branches.
 *
 * For every affected repository it computes, without touching the canonical checkout, what the target branch would
 * become: unchanged (the guardrail commit is already contained), fast-forwarded to the guardrail commit, or a merge
 * commit made in an owned isolated worktree under the repository's common Git folder. Each result is kept reachable
 * by an owned ref `refs/darkmechanicus/learning-prep/<cardId>/<repo|root>`, so a later apply can compare-and-set the
 * target from the recorded `oldHead` to `newHead`.
 *
 * Preparation never switches HEAD or a branch, never writes a target or source ref, never touches the canonical
 * index or working tree and never publishes. Conflicts are collected for every repository first; when any repository
 * conflicts, no prepared ref is kept. Applying a prepared result is a separate, later operation.
 */
import { existsSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { VerifiedLearningManifest } from '../../shared/domain/kanban'
import type {
  LearningIntegrationConflict,
  LearningIntegrationErrorCode,
  LearningIntegrationTargetInput,
  PreparedLearningIntegration,
  PreparedTarget,
  PrepareLearningIntegrationRequest
} from '../../shared/git/learningIntegration'
import type { OperationLocks } from './operationLock'
import { canonical, type GitRunner } from './runner'

/** A refusal with a precise reason; nothing canonical has changed when one is thrown. */
export class LearningIntegrationError extends Error {
  readonly code: LearningIntegrationErrorCode

  constructor(code: LearningIntegrationErrorCode, message: string) {
    super(message)
    this.name = 'LearningIntegrationError'
    this.code = code
  }
}

/** One preparation per learning card at a time, owned by the attempt that started it. */
interface LearningIntegrationLocks {
  /** Holds the card's lock for `attemptId` while `work` runs; `locked` when another preparation of the card holds it. */
  run<T>(cardId: string, attemptId: string, work: () => Promise<T>): Promise<T>
}

export function createLearningIntegrationLocks(): LearningIntegrationLocks {
  const owners = new Map<string, string>()
  return {
    async run(cardId, attemptId, work) {
      const owner = owners.get(cardId)
      if (owner !== undefined) {
        throw new LearningIntegrationError(
          'locked',
          owner === attemptId
            ? `Attempt ${attemptId} is already preparing the integration of ${cardId}.`
            : `Attempt ${owner} holds the integration lock of ${cardId}; ${attemptId} cannot prepare it now.`
        )
      }
      owners.set(cardId, attemptId)
      try {
        return await work()
      } finally {
        owners.delete(cardId)
      }
    }
  }
}

export interface LearningIntegrationDeps {
  runner: GitRunner
  /** The Source control per-repository operation locks, so no other operation interleaves with preparation. */
  operations: OperationLocks
  cards: LearningIntegrationLocks
  platform?: NodeJS.Platform
}

export const PREP_NAMESPACE = 'refs/darkmechanicus/learning-prep'
export const PREP_FOLDER = ['darkmechanicus', 'learning-prep'] as const
export const CARD_ID = /^kc_[0-9a-z]+$/
export const ATTEMPT_ID = /^ka_[0-9a-z]+$/
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/

export const label = (repo: string | null): string => (repo === null ? 'the root repository' : `repository ${repo}`)
export const short = (commit: string): string => commit.slice(0, 7)
export const fail = (code: LearningIntegrationErrorCode, message: string): never => {
  throw new LearningIntegrationError(code, message)
}

/** The owned path and ref segment of a repository; refuses names that could leave the owned folder or namespace. */
export function segment(repo: string | null): string {
  if (repo === null) return 'root'
  if (repo === 'root' || !REPOSITORY.test(repo) || repo.includes('..') || /\.lock$/i.test(repo)) {
    fail('unsafe_path', `The repository name "${repo}" is not safe for an owned worktree or ref.`)
  }
  return repo
}

/** Everything read and checked before any owned write; the canonical checkout is only read. */
interface Plan {
  input: LearningIntegrationTargetInput
  manifest: VerifiedLearningManifest
  root: string
  targetRef: string
  oldHead: string
  preparedRef: string
  /** The owned isolated worktree, inside `<common git dir>/darkmechanicus/learning-prep/<cardId>/`. */
  worktree: string
}

type Prepared = { kind: 'prepared'; target: PreparedTarget } | { kind: 'conflict'; conflict: LearningIntegrationConflict }

/** The target's manifest, when it is a passed verification naming full commit ids. */
function verifiedManifest(manifests: ReadonlyMap<string | null, VerifiedLearningManifest>, repo: string | null): VerifiedLearningManifest {
  const manifest = manifests.get(repo)
  if (manifest === undefined) return fail('invalid_request', `No verified manifest covers ${label(repo)}.`)
  if (!manifest.passed) fail('invalid_request', `The manifest of ${label(repo)} did not pass verification.`)
  if (!COMMIT.test(manifest.commit) || !COMMIT.test(manifest.base)) fail('invalid_request', `The manifest of ${label(repo)} does not name full commit ids.`)
  return manifest
}

/** Every check that needs no Git: ids, repository names, and exactly one passed manifest per target. */
export function validateRequest(request: PrepareLearningIntegrationRequest): Map<string | null, VerifiedLearningManifest> {
  if (!CARD_ID.test(request.cardId)) fail('unsafe_path', `The card id "${request.cardId}" is not a learning card id.`)
  if (!ATTEMPT_ID.test(request.attemptId)) fail('invalid_request', `The attempt id "${request.attemptId}" is not a card attempt id.`)
  if (request.targets.length === 0) fail('invalid_request', 'Name at least one target repository to prepare.')
  const manifests = new Map<string | null, VerifiedLearningManifest>()
  for (const manifest of request.manifests) {
    if (manifests.has(manifest.repo)) fail('invalid_request', `More than one manifest names ${label(manifest.repo)}.`)
    manifests.set(manifest.repo, manifest)
  }
  const byTarget = new Map<string | null, VerifiedLearningManifest>()
  for (const target of request.targets) {
    segment(target.repository)
    if (byTarget.has(target.repository)) fail('invalid_request', `${label(target.repository)} is named as a target more than once.`)
    byTarget.set(target.repository, verifiedManifest(manifests, target.repository))
  }
  for (const repo of manifests.keys()) {
    if (!byTarget.has(repo)) fail('invalid_request', `The manifest of ${label(repo)} names no target repository.`)
  }
  return byTarget
}

export async function read(runner: GitRunner, cwd: string, args: string[], accept: readonly number[] = [0]) {
  const result = await runner.run({ cwd, args, kind: 'read', acceptExitCodes: accept })
  return { code: result.code, out: result.stdout.replace(/\r?\n$/, '') }
}

export async function resolveCommit(runner: GitRunner, root: string, ref: string): Promise<string | null> {
  const result = await read(runner, root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], [0, 1])
  return result.code === 0 ? result.out : null
}

export async function isAncestor(runner: GitRunner, root: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await read(runner, root, ['merge-base', '--is-ancestor', ancestor, descendant], [0, 1])
  return result.code === 0
}

/** A full branch ref Git accepts, or `unsafe_path`. */
async function branchRef(runner: GitRunner, root: string, branch: string, what: string): Promise<string> {
  const ref = `refs/heads/${branch}`
  const checked = branch === '' || branch.startsWith('-') ? null : await read(runner, root, ['check-ref-format', ref], [0, 1])
  if (checked === null || checked.code !== 0) fail('unsafe_path', `The ${what} "${branch}" is not a valid branch name.`)
  return ref
}

/** The checkout must be the absolute top level of a repository; the owned worktree must stay in the owned folder. */
async function locate(runner: GitRunner, platform: NodeJS.Platform, cardId: string, input: LearningIntegrationTargetInput) {
  if (!isAbsolute(input.checkout)) fail('unsafe_path', `The checkout of ${label(input.repository)} must be an absolute path.`)
  const top = await read(runner, input.checkout, ['rev-parse', '--show-toplevel'], [0, 128]).catch(() => ({ code: 128, out: '' }))
  if (top.code !== 0) fail('not_repository', `${input.checkout} is not a Git repository (${label(input.repository)}).`)
  if (canonical(top.out, platform) !== canonical(input.checkout, platform)) {
    fail('unsafe_path', `${input.checkout} is inside a repository but is not its top level (${label(input.repository)}).`)
  }
  const common = (await read(runner, top.out, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).out
  const owned = resolve(common, ...PREP_FOLDER, cardId)
  const worktree = resolve(owned, segment(input.repository))
  const inside = relative(resolve(common, ...PREP_FOLDER), worktree)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    fail('unsafe_path', `The owned worktree for ${label(input.repository)} would leave ${join(common, ...PREP_FOLDER)}.`)
  }
  return { root: top.out, worktree }
}

async function plan(deps: LearningIntegrationDeps, request: PrepareLearningIntegrationRequest, manifest: VerifiedLearningManifest, input: LearningIntegrationTargetInput): Promise<Plan> {
  const { runner } = deps
  const repo = label(input.repository)
  const { root, worktree } = await locate(runner, deps.platform ?? process.platform, request.cardId, input)
  const targetRef = await branchRef(runner, root, input.branch, 'target branch')
  const sourceRef = await branchRef(runner, root, manifest.branch, 'guardrail branch')
  const oldHead = await resolveCommit(runner, root, targetRef)
  if (oldHead === null) fail('target_missing', `The target branch ${input.branch} does not exist in ${repo}.`)
  const tip = await resolveCommit(runner, root, sourceRef)
  if (tip !== manifest.commit) {
    fail(
      'source_moved',
      tip === null
        ? `The guardrail branch ${manifest.branch} no longer exists in ${repo}.`
        : `The guardrail branch ${manifest.branch} moved to ${short(tip)} in ${repo}; the verified commit was ${short(manifest.commit)}.`
    )
  }
  if (!(await isAncestor(runner, root, manifest.base, manifest.commit))) {
    fail('base_diverged', `The guardrail commit ${short(manifest.commit)} no longer descends from its base ${short(manifest.base)} in ${repo}.`)
  }
  if (!(await isAncestor(runner, root, manifest.base, oldHead as string))) {
    fail('base_diverged', `The target ${input.branch} (${short(oldHead as string)}) does not contain the completed increment ${short(manifest.base)} in ${repo}.`)
  }
  await clearOwnedWorktree(deps, root, worktree, false)
  const preparedRef = `${PREP_NAMESPACE}/${request.cardId}/${segment(input.repository)}`
  return { input, manifest, root, targetRef, oldHead: oldHead as string, preparedRef, worktree }
}

/** The registered worktrees of a repository, by canonical path, with whether each is detached. */
async function worktrees(runner: GitRunner, root: string, platform: NodeJS.Platform): Promise<Map<string, boolean>> {
  const listed = (await read(runner, root, ['worktree', 'list', '--porcelain', '-z'])).out
  const found = new Map<string, boolean>()
  let path: string | null = null
  for (const field of listed.split('\0')) {
    if (field.startsWith('worktree ')) {
      path = canonical(field.slice('worktree '.length), platform)
      found.set(path, false)
    } else if (field === 'detached' && path !== null) {
      found.set(path, true)
    }
  }
  return found
}

/**
 * Refuses an owned worktree path that has a branch checked out (preparation only ever makes detached ones), then,
 * when `remove`, removes a detached one an earlier preparation left behind.
 */
async function clearOwnedWorktree(deps: LearningIntegrationDeps, root: string, worktree: string, remove: boolean): Promise<void> {
  const platform = deps.platform ?? process.platform
  const registered = (await worktrees(deps.runner, root, platform)).get(canonical(worktree, platform))
  if (registered === false) {
    fail('unsafe_path', `${worktree} is a worktree with a branch checked out; preparation only owns detached worktrees there.`)
  }
  if (!remove) return
  if (registered === true) {
    await deps.runner.run({ cwd: root, args: ['worktree', 'remove', '--force', worktree], kind: 'write' })
  }
  if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true })
}

async function setPreparedRef(runner: GitRunner, plan: Plan, commit: string): Promise<void> {
  await runner.run({ cwd: plan.root, args: ['update-ref', '-m', 'learning integration prepared', plan.preparedRef, commit], kind: 'write' })
}

/** Merges the guardrail commit onto `oldHead` in the owned detached worktree; never touches the canonical checkout. */
async function mergeInOwnedWorktree(deps: LearningIntegrationDeps, request: PrepareLearningIntegrationRequest, plan: Plan): Promise<Prepared> {
  const { runner } = deps
  await clearOwnedWorktree(deps, plan.root, plan.worktree, true)
  await runner.run({ cwd: plan.root, args: ['worktree', 'add', '--detach', plan.worktree, plan.oldHead], kind: 'write' })
  try {
    const message = `Integrate learning guardrails ${plan.manifest.branch} (${request.cardId})`
    const merged = await runner.run({
      cwd: plan.worktree,
      args: ['merge', '--no-ff', '--no-verify', '--no-edit', '-m', message, plan.manifest.commit],
      kind: 'write',
      acceptExitCodes: [0, 1]
    })
    const unmerged = (await read(runner, plan.worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])).out
    const files = unmerged.split('\0').filter((file) => file !== '').sort()
    if (merged.code !== 0 || files.length > 0) {
      await runner.run({ cwd: plan.worktree, args: ['merge', '--abort'], kind: 'write', acceptExitCodes: [0, 128] })
      const detail = files.length > 0 ? `Conflicts in ${files.join(', ')}.` : merged.stderr.trim() || merged.stdout.trim()
      return {
        kind: 'conflict',
        conflict: { repository: plan.input.repository, targetRef: plan.targetRef, oldHead: plan.oldHead, sourceCommit: plan.manifest.commit, files, detail }
      }
    }
    const newHead = (await read(runner, plan.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).out
    await setPreparedRef(runner, plan, newHead)
    return { kind: 'prepared', target: preparedTarget(plan, 'merge', newHead) }
  } finally {
    await clearOwnedWorktree(deps, plan.root, plan.worktree, true)
  }
}

function preparedTarget(plan: Plan, outcome: PreparedTarget['outcome'], newHead: string): PreparedTarget {
  return {
    repository: plan.input.repository,
    checkout: plan.input.checkout,
    targetRef: plan.targetRef,
    oldHead: plan.oldHead,
    newHead,
    outcome,
    source: { branch: plan.manifest.branch, commit: plan.manifest.commit, base: plan.manifest.base },
    preparedRef: plan.preparedRef
  }
}

async function prepareOne(deps: LearningIntegrationDeps, request: PrepareLearningIntegrationRequest, plan: Plan): Promise<Prepared> {
  const source = plan.manifest.commit
  if (await isAncestor(deps.runner, plan.root, source, plan.oldHead)) {
    await setPreparedRef(deps.runner, plan, plan.oldHead)
    return { kind: 'prepared', target: preparedTarget(plan, 'noChange', plan.oldHead) }
  }
  if (await isAncestor(deps.runner, plan.root, plan.oldHead, source)) {
    await setPreparedRef(deps.runner, plan, source)
    return { kind: 'prepared', target: preparedTarget(plan, 'fastForward', source) }
  }
  return mergeInOwnedWorktree(deps, request, plan)
}

/** Runs `work` holding every repository's operation lock, taken in a deterministic (sorted canonical root) order. */
export async function holdingRepositories<T>(deps: LearningIntegrationDeps, roots: readonly string[], work: () => Promise<T>): Promise<T> {
  const [first, ...rest] = roots
  if (first === undefined) return work()
  return deps.operations.run(first, () => holdingRepositories(deps, rest, work))
}

/** Every repository's canonical root, in the deterministic order its operation lock is taken. */
export function lockOrder(checkouts: readonly string[], platform: NodeJS.Platform): string[] {
  const roots = [...new Set(checkouts.map((checkout) => canonical(checkout, platform)))].sort()
  if (roots.length !== checkouts.length) fail('invalid_request', 'Two target repositories name the same checkout.')
  return roots
}

/** Preparation itself, for a caller already holding the card's lock and every repository's operation lock. */
export async function prepareHeld(deps: LearningIntegrationDeps, request: PrepareLearningIntegrationRequest, manifests: ReadonlyMap<string | null, VerifiedLearningManifest>): Promise<PreparedLearningIntegration> {
  const ordered = [...request.targets].sort((a, b) => segment(a.repository).localeCompare(segment(b.repository)))
  const plans: Plan[] = []
  for (const target of ordered) plans.push(await plan(deps, request, manifests.get(target.repository) as VerifiedLearningManifest, target))
  const results: Prepared[] = []
  let failure: unknown = null
  try {
    for (const item of plans) results.push(await prepareOne(deps, request, item))
  } catch (error) {
    failure = error
  }
  const conflicts = results.flatMap((result) => (result.kind === 'conflict' ? [result.conflict] : []))
  if (failure !== null || conflicts.length > 0) {
    // No partial preparation survives: every owned prepared ref of this card is removed (deleting a missing ref is a no-op).
    for (const item of plans) await deps.runner.run({ cwd: item.root, args: ['update-ref', '-d', item.preparedRef], kind: 'write' })
  }
  if (failure !== null) throw failure
  if (conflicts.length > 0) return { state: 'conflicted', cardId: request.cardId, attemptId: request.attemptId, conflicts }
  const targets = results.flatMap((result) => (result.kind === 'prepared' ? [result.target] : []))
  return { state: 'prepared', cardId: request.cardId, attemptId: request.attemptId, targets }
}

/**
 * Prepares the integration of a learning card's verified guardrail branches onto each repository's target branch.
 * Every check runs before any owned write; every repository is prepared before the result is returned; when any
 * repository conflicts, all conflicts are reported and no prepared ref is kept. Throws `LearningIntegrationError`
 * for a request it refuses. The canonical checkouts, their branches, index and worktrees are never changed.
 */
export async function prepareLearningIntegration(deps: LearningIntegrationDeps, request: PrepareLearningIntegrationRequest): Promise<PreparedLearningIntegration> {
  const manifests = validateRequest(request)
  return deps.cards.run(request.cardId, request.attemptId, async () => {
    const roots = lockOrder(
      request.targets.map((target) => target.checkout),
      deps.platform ?? process.platform
    )
    return holdingRepositories(deps, roots, () => prepareHeld(deps, request, manifests))
  })
}
