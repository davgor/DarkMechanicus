/**
 * DM-949: applying a prepared learning integration to the canonical target branches, and recovering one.
 *
 * `applyLearningIntegration` prepares (DM-948), stamps each repository with an owned identity, awaits
 * `persistPrepared(plan)` before the first canonical change, then moves each target in plan order from its prepared
 * `oldHead` to `newHead` with an exact expected-old compare-and-set (see `learningTransition.ts`), awaiting
 * `onApplied(receipt)` after each. `recoverLearningIntegration` resumes a persisted plan from Git's actual state:
 * a target already containing `newHead` is never rewritten and only has its receipt replayed; a target still at
 * `oldHead` is moved; anything else fails visibly with the exact safe action. The owned prepared refs and identity
 * are removed only once every target is complete. Nothing here publishes or claims cross-repository atomicity.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type {
  AppliedLearningIntegration,
  ApplyLearningIntegrationRequest,
  LearningIntegrationPlan,
  LearningIntegrationReceipt,
  PlannedLearningTarget,
  PreparedTarget,
  RecoverLearningIntegrationRequest
} from '../../shared/git/learningIntegration'
import {
  ATTEMPT_ID,
  CARD_ID,
  COMMIT,
  fail,
  holdingRepositories,
  label,
  type LearningIntegrationDeps,
  lockOrder,
  PREP_FOLDER,
  PREP_NAMESPACE,
  prepareHeld,
  read,
  resolveCommit,
  segment,
  short,
  validateRequest
} from './learningIntegration'
import { assertCleanCheckout, assertTrustedRequirement } from './learningCheckout'
import { interrupted, targetState, transition } from './learningTransition'
import { canonical } from './runner'

type Callbacks = Pick<ApplyLearningIntegrationRequest, 'onApplied' | 'signal' | 'cleanCheckout'>

/** The owned identity file of a card's integration in one repository's common Git folder. */
const identityFile = (commonDir: string, cardId: string): string => join(commonDir, ...PREP_FOLDER, `${cardId}.identity`)

/** Stamps the repository with the card's owned identity token (reused when an earlier preparation left one). */
async function stamp(deps: LearningIntegrationDeps, cardId: string, target: PreparedTarget): Promise<PlannedLearningTarget> {
  const commonDir = (await read(deps.runner, target.checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).out
  const file = identityFile(commonDir, cardId)
  let token = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  if (!/^[0-9a-f]{32}$/.test(token)) {
    token = randomBytes(16).toString('hex')
    mkdirSync(join(commonDir, ...PREP_FOLDER), { recursive: true })
    writeFileSync(file, `${token}\n`)
  }
  return { ...target, identity: { commonDir, token } }
}

const foreign = (target: PlannedLearningTarget, why: string): never =>
  fail('foreign_repository', `${target.checkout} is no longer the prepared ${label(target.repository)}: ${why}. Nothing there was changed; prepare the integration again.`)

/** The recorded checkout still exists as the top level of a repository whose live common Git folder is the recorded one; returns that folder. */
async function locateLive(deps: LearningIntegrationDeps, target: PlannedLearningTarget): Promise<string> {
  const platform = deps.platform ?? process.platform
  if (!existsSync(target.checkout)) foreign(target, 'the path no longer exists')
  const live = await read(deps.runner, target.checkout, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], [0, 128]).catch(() => ({ code: 128, out: '' }))
  const [top, common] = live.out.split(/\r?\n/)
  if (live.code !== 0 || top === undefined || common === undefined) return foreign(target, 'it is not a Git repository')
  if (canonical(top, platform) !== canonical(target.checkout, platform)) foreign(target, 'it is not the top level of its repository')
  if (canonical(common, platform) !== canonical(target.identity.commonDir, platform)) foreign(target, `its Git folder is ${common}, not ${target.identity.commonDir}`)
  return common
}

/**
 * Before any canonical write: the recorded checkout is still the prepared repository, live (see `locateLive`), and
 * its common Git folder holds the card's owned identity token. A removed path, a path rebound to another repository,
 * or a clone holding the same objects and refs fails `foreign_repository`.
 */
async function verifyIdentity(deps: LearningIntegrationDeps, cardId: string, target: PlannedLearningTarget): Promise<void> {
  const file = identityFile(await locateLive(deps, target), cardId)
  const token = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  if (token !== target.identity.token) foreign(target, 'its Git folder does not hold the identity this integration was prepared with')
}

/** One planned target's Git-free checks: full commits, the owned prepared ref, a branch target, an absolute owned identity. */
function validatePlannedTarget(cardId: string, target: PlannedLearningTarget): void {
  const what = `The plan of ${label(target.repository)}`
  if (!COMMIT.test(target.oldHead) || !COMMIT.test(target.newHead)) fail('invalid_request', `${what} does not name full commit ids.`)
  if (target.preparedRef !== `${PREP_NAMESPACE}/${cardId}/${segment(target.repository)}`) fail('unsafe_path', `${what} names a prepared ref this card does not own.`)
  if (!target.targetRef.startsWith('refs/heads/') || /\s/.test(target.targetRef)) fail('unsafe_path', `${what} names ${target.targetRef}, which is not a branch.`)
  if (!isAbsolute(target.checkout) || !isAbsolute(target.identity.commonDir) || !/^[0-9a-f]{32}$/.test(target.identity.token)) {
    fail('unsafe_path', `${what} does not name an absolute checkout and owned identity.`)
  }
}

/** Every check of a persisted plan that needs no Git, so a corrupt or foreign plan never reaches a write. */
function validatePlan(plan: LearningIntegrationPlan): void {
  if (!CARD_ID.test(plan.cardId)) fail('unsafe_path', `The card id "${plan.cardId}" is not a learning card id.`)
  if (!ATTEMPT_ID.test(plan.attemptId)) fail('invalid_request', `The attempt id "${plan.attemptId}" is not a card attempt id.`)
  if (plan.targets.length === 0) fail('invalid_request', 'The plan names no target repository.')
  const seen = new Set<string>()
  for (const target of plan.targets) {
    if (seen.has(segment(target.repository))) fail('invalid_request', `${label(target.repository)} is named as a target more than once.`)
    seen.add(segment(target.repository))
    validatePlannedTarget(plan.cardId, target)
  }
}

/** A target still at `oldHead` may move only while its owned prepared ref still holds the planned `newHead`. */
async function checkPrepared(deps: LearningIntegrationDeps, target: PlannedLearningTarget): Promise<void> {
  const held = await resolveCommit(deps.runner, target.checkout, target.preparedRef)
  if (held !== target.newHead) {
    fail(
      'not_prepared',
      `${target.preparedRef} in ${label(target.repository)} holds ${held === null ? 'nothing' : short(held)}, not the planned ${short(target.newHead)}; ${target.targetRef} was not changed. Prepare the integration again.`
    )
  }
}

/** Moves (or confirms) every target in plan order, awaiting each receipt; removes owned state once all are complete. */
async function run(deps: LearningIntegrationDeps, plan: LearningIntegrationPlan, callbacks: Callbacks): Promise<AppliedLearningIntegration> {
  const receipts: LearningIntegrationReceipt[] = []
  for (const target of plan.targets) {
    await locateLive(deps, target)
    if ((await targetState(deps, target)) === 'old') {
      if (callbacks.signal?.aborted === true) throw interrupted(target, 'before it started')
      await checkPrepared(deps, target)
      if (callbacks.cleanCheckout !== undefined) await assertCleanCheckout(deps, target, callbacks.cleanCheckout)
      await transition({ deps, cardId: plan.cardId, target, signal: callbacks.signal, verify: () => verifyIdentity(deps, plan.cardId, target) })
    }
    const receipt = { repository: target.repository, oldHead: target.oldHead, newHead: target.newHead }
    await callbacks.onApplied(receipt)
    receipts.push(receipt)
  }
  for (const target of plan.targets) await removeOwned(deps, plan.cardId, target)
  return { state: 'applied', plan, receipts }
}

/** Deletes the owned prepared ref only while it still holds the planned commit, then the owned identity file. */
async function removeOwned(deps: LearningIntegrationDeps, cardId: string, target: PlannedLearningTarget): Promise<void> {
  if ((await resolveCommit(deps.runner, target.checkout, target.preparedRef)) === target.newHead) {
    await deps.runner.run({ cwd: target.checkout, args: ['update-ref', '-d', target.preparedRef, target.newHead], kind: 'write' })
  }
  const file = identityFile(target.identity.commonDir, cardId)
  if (existsSync(file) && readFileSync(file, 'utf8').trim() === target.identity.token) rmSync(resolve(file), { force: true })
}

/**
 * Prepares, persists and applies a learning card's integration. A conflicted preparation returns its conflicts and
 * persists nothing. Throws `LearningIntegrationError` when it refuses or stops; what was completed has had its
 * receipt awaited, and `recoverLearningIntegration` with the persisted plan continues from Git's actual state.
 */
export async function applyLearningIntegration(deps: LearningIntegrationDeps, request: ApplyLearningIntegrationRequest): Promise<AppliedLearningIntegration> {
  const manifests = validateRequest(request)
  assertTrustedRequirement(request.cleanCheckout)
  return deps.cards.run(request.cardId, request.attemptId, async () => {
    const platform = deps.platform ?? process.platform
    const roots = lockOrder(
      request.targets.map((target) => target.checkout),
      platform
    )
    return holdingRepositories(deps, roots, async () => {
      const prepared = await prepareHeld(deps, request, manifests)
      if (prepared.state === 'conflicted') return prepared
      const targets: PlannedLearningTarget[] = []
      for (const target of prepared.targets) targets.push(await stamp(deps, request.cardId, target))
      const plan: LearningIntegrationPlan = { cardId: request.cardId, attemptId: request.attemptId, targets }
      await request.persistPrepared(plan)
      return run(deps, plan, request)
    })
  })
}

/**
 * Resumes a persisted plan from each repository's actual refs and worktree: completed targets are never rewritten
 * and have their exact receipt replayed; the rest are moved as `applyLearningIntegration` would.
 */
export async function recoverLearningIntegration(deps: LearningIntegrationDeps, request: RecoverLearningIntegrationRequest): Promise<AppliedLearningIntegration> {
  validatePlan(request.plan)
  if (!ATTEMPT_ID.test(request.attemptId)) fail('invalid_request', `The attempt id "${request.attemptId}" is not a card attempt id.`)
  assertTrustedRequirement(request.cleanCheckout)
  return deps.cards.run(request.plan.cardId, request.attemptId, async () => {
    const roots = lockOrder(
      request.plan.targets.map((target) => target.checkout),
      deps.platform ?? process.platform
    )
    return holdingRepositories(deps, roots, () => run(deps, request.plan, request))
  })
}
