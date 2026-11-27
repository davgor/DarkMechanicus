/**
 * Verifies a sprint's structured delivery: the commit the recorder names is on the delivery target, carries the sprint's
 * increment (directly, or squash-merged), is contained in the named release, and the installed app runs that release
 * or later. Like `incrementVerify.ts` it asks the Git adapter read-only questions only and never trusts the claim.
 * Unlike an increment, a delivery is fail-closed: a check git could not make fails, and the delivery passes only when
 * every check made passed.
 *
 * `Installed app version` trusts the build the recording process reports about itself. A process that controls its own
 * install location and package.json can report any version, so that check is evidence, not a security boundary.
 */
import type { SprintDelivery } from '../../shared/domain/bundle'
import type { CheckResult, CheckStatus } from '../../shared/domain/views'
import type { GitAdapter } from '../repo/types'

export interface DeliveryContext {
  /** The sprint's delivery declaration, from the pinned plan. */
  delivery: SprintDelivery
  /** The sprint's passing increment on the epic branch. */
  increment: { commit: string }
  /** The recording session's own build (serverInfo); null when unknown. */
  installed: { version: string; packaged: boolean } | null
}

/** What the recorder says was delivered; every part is checked against the repository. */
export interface DeliveryClaim {
  commit: string
  releaseTag?: string
  observedInstalledVersion?: string
}

export interface DeliveryVerdict {
  passed: boolean
  checks: CheckResult[]
  reasons: string[]
  /** The release's package.json version, once `Release version` passed; else null. */
  releaseVersion: string | null
  installedVersion: string | null
  verifiedAt: string
}

const NAME = {
  exists: 'Delivered commit exists',
  target: 'On the target branch',
  carries: 'Carries the increment',
  tag: 'Release tag',
  version: 'Release version',
  installed: 'Installed app version'
} as const

const COMMIT_HASH = /^[0-9a-fA-F]{7,64}$/
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/
const VERSION = /^\d+\.\d+\.\d+$/
const LISTED = 5

function check(name: string, status: CheckStatus, detail: string): CheckResult {
  return { name, status, detail }
}

function short(commit: string): string {
  return commit.slice(0, 7)
}

function listed(paths: string[]): string {
  const shown = paths.slice(0, LISTED).join(', ')
  return paths.length > LISTED ? `${shown} and ${paths.length - LISTED} more` : shown
}

/** Numeric major.minor.patch order of `a` against `b` (-1, 0 or 1); null when either is not exactly `N.N.N`. */
export function compareVersions(a: string, b: string): number | null {
  if (!VERSION.test(a) || !VERSION.test(b)) {
    return null
  }
  const left = a.split('.').map(BigInt)
  const right = b.split('.').map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    const [x = 0n, y = 0n] = [left[index], right[index]]
    if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

interface Commit {
  commit: string
  parents: string[]
}

async function existsCheck(git: GitAdapter, claim: DeliveryClaim): Promise<{ result: CheckResult; found: Commit | null }> {
  if (!COMMIT_HASH.test(claim.commit)) {
    return { result: check(NAME.exists, 'failed', `${JSON.stringify(claim.commit)} is not a commit id.`), found: null }
  }
  const found = await git.commitParents(claim.commit)
  return found === null
    ? { result: check(NAME.exists, 'failed', `Commit ${short(claim.commit)} is not in this repository.`), found }
    : { result: check(NAME.exists, 'passed', `Commit ${short(found.commit)} exists.`), found }
}

async function targetCheck(git: GitAdapter, found: Commit | null, target: string): Promise<CheckResult> {
  if (found === null) {
    return check(NAME.target, 'failed', 'The delivered commit is not in this repository.')
  }
  const on = await git.isAncestor(found.commit, `refs/remotes/origin/${target}`)
  if (on === null) {
    return check(NAME.target, 'failed', `origin/${target} is unknown here: run git fetch origin first`)
  }
  return on
    ? check(NAME.target, 'passed', `Commit ${short(found.commit)} is on origin/${target}.`)
    : check(NAME.target, 'failed', `Commit ${short(found.commit)} is not on origin/${target}.`)
}

/** A git answer that could not be made. */
const UNKNOWN = Symbol('unknown')
type Content = string | null | typeof UNKNOWN

/**
 * The file at `ref`, null when the commit does not have it. `showFile` answers null for a failure too, so a null is
 * only taken as absence when `listFiles` does not list the path.
 */
async function contentAt(git: GitAdapter, ref: string, path: string): Promise<Content> {
  const text = await git.showFile(ref, path)
  if (text !== null) {
    return text
  }
  return (await git.listFiles(ref, path)).length === 0 ? null : UNKNOWN
}

/** The commits the squash comparison reads: the increment, the merge commit M, M's first parent T and B = merge-base(I, T). */
interface Squash {
  increment: string
  merged: string
  target: string
  base: string
}

type PathVerdict = 'match' | 'target' | 'differs' | 'unknown'

async function comparePath(git: GitAdapter, squash: Squash, path: string): Promise<PathVerdict> {
  const [mine, theirs] = await Promise.all([contentAt(git, squash.increment, path), contentAt(git, squash.merged, path)])
  if (mine === UNKNOWN || theirs === UNKNOWN) {
    return 'unknown'
  }
  if (mine === theirs) {
    return 'match'
  }
  const [target, base] = await Promise.all([contentAt(git, squash.target, path), contentAt(git, squash.base, path)])
  if (target === UNKNOWN || base === UNKNOWN) {
    return 'unknown'
  }
  return target === base ? 'differs' : 'target'
}

/** Resolves the commits the squash comparison needs, or the reason it cannot be made. */
async function squashOf(git: GitAdapter, increment: string, merged: Commit): Promise<{ squash: Squash; paths: string[] } | string> {
  const own = await git.commitParents(increment)
  const parent = own?.parents[0]
  const target = merged.parents[0]
  if (own === null || parent === undefined || target === undefined) {
    return own === null ? `The increment ${short(increment)} is not in this repository.` : 'The increment or the delivered commit has no parent to compare against.'
  }
  const [paths, base] = await Promise.all([git.changedPaths(parent, own.commit), git.mergeBase(own.commit, target)])
  if (paths === null || base === null) {
    return `Git could not compare the increment ${short(own.commit)} with ${short(merged.commit)}.`
  }
  return { squash: { increment: own.commit, merged: merged.commit, target, base }, paths }
}

async function squashCheck(git: GitAdapter, increment: string, merged: Commit): Promise<CheckResult> {
  const resolved = await squashOf(git, increment, merged)
  if (typeof resolved === 'string') {
    return check(NAME.carries, 'failed', resolved)
  }
  const verdicts = await Promise.all(resolved.paths.map((path) => comparePath(git, resolved.squash, path)))
  const having = (wanted: PathVerdict): string[] => resolved.paths.filter((_, index) => verdicts[index] === wanted)
  const [unknown, differs, target] = [having('unknown'), having('differs'), having('target')]
  if (unknown.length > 0) {
    return check(NAME.carries, 'failed', `Git could not read these paths: ${listed(unknown)}.`)
  }
  if (differs.length > 0) {
    return check(NAME.carries, 'failed', `${short(merged.commit)} does not match the increment at: ${listed(differs)}.`)
  }
  const matched = resolved.paths.length - target.length
  const merges = target.length > 0 ? `; merged with target changes: ${listed(target)}` : ''
  return check(NAME.carries, 'passed', `squash-merged: ${matched} files match${merges}`)
}

async function carriesCheck(git: GitAdapter, found: Commit | null, increment: string): Promise<CheckResult> {
  if (found === null) {
    return check(NAME.carries, 'failed', 'The delivered commit is not in this repository.')
  }
  const contains = await git.isAncestor(increment, found.commit)
  if (contains === null) {
    return check(NAME.carries, 'failed', `Git could not tell whether ${short(found.commit)} contains the increment ${short(increment)}.`)
  }
  return contains
    ? check(NAME.carries, 'passed', `The increment ${short(increment)} is an ancestor of ${short(found.commit)}.`)
    : squashCheck(git, increment, found)
}

async function tagCheck(git: GitAdapter, found: Commit | null, tag: string | undefined): Promise<CheckResult> {
  if (tag === undefined || !RELEASE_TAG.test(tag)) {
    return check(NAME.tag, 'failed', tag === undefined ? 'No release tag was named.' : `${JSON.stringify(tag)} is not a release tag (vN.N.N).`)
  }
  const ref = `refs/tags/${tag}`
  const tagged = await git.commitParents(ref)
  if (tagged === null) {
    return check(NAME.tag, 'failed', `The tag ${tag} is not in this repository.`)
  }
  const contains = found === null ? null : await git.isAncestor(found.commit, ref)
  if (contains !== true) {
    return check(NAME.tag, 'failed', contains === null ? `Git could not tell whether ${tag} contains the delivered commit.` : `The tag ${tag} does not contain the delivered commit.`)
  }
  return check(NAME.tag, 'passed', `The tag ${tag} (${short(tagged.commit)}) contains the delivered commit.`)
}

function versionOf(text: string | null): string | null {
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text)
    const version = typeof parsed === 'object' && parsed !== null && 'version' in parsed ? parsed.version : undefined
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

async function versionCheck(git: GitAdapter, tag: string | undefined): Promise<{ result: CheckResult; version: string | null }> {
  if (tag === undefined || !RELEASE_TAG.test(tag)) {
    return { result: check(NAME.version, 'failed', 'There is no release tag to read package.json from.'), version: null }
  }
  const version = versionOf(await git.showFile(`refs/tags/${tag}`, 'package.json'))
  if (version === null) {
    return { result: check(NAME.version, 'failed', `package.json at ${tag} has no readable version.`), version: null }
  }
  return version === tag.slice(1)
    ? { result: check(NAME.version, 'passed', `package.json at ${tag} says ${version}.`), version }
    : { result: check(NAME.version, 'failed', `package.json at ${tag} says ${version}, not ${tag.slice(1)}.`), version: null }
}

function installedCheck(installed: DeliveryContext['installed'], releaseVersion: string | null, observed: string | undefined): CheckResult {
  if (installed === null || !installed.packaged) {
    return check(NAME.installed, 'failed', 'record from a session started by the installed app (get_capabilities server.packaged)')
  }
  const order = releaseVersion === null ? null : compareVersions(installed.version, releaseVersion)
  if (order === null || order < 0) {
    const release = releaseVersion ?? 'an unverified release'
    return check(NAME.installed, 'failed', `The installed app runs ${installed.version}, not ${release} or later.`)
  }
  if (observed !== undefined && observed !== installed.version) {
    return check(NAME.installed, 'failed', `installed versions disagree: observed ${observed}, the recording app runs ${installed.version}`)
  }
  return check(NAME.installed, 'passed', `The installed app runs ${installed.version}, release ${releaseVersion} or later.`)
}

async function releaseChecks(git: GitAdapter, found: Commit | null, claim: DeliveryClaim): Promise<{ checks: CheckResult[]; version: string | null }> {
  const tag = await tagCheck(git, found, claim.releaseTag)
  const version = await versionCheck(git, claim.releaseTag)
  return { checks: [tag, version.result], version: version.version }
}

/**
 * Checks a sprint delivery and returns the verdict, its checks in order. Never throws for a commit, branch or tag git
 * does not know: those are failed checks with a reason.
 */
export async function verifyDelivery(git: GitAdapter, context: DeliveryContext, claim: DeliveryClaim, verifiedAt: string): Promise<DeliveryVerdict> {
  const { delivery } = context
  const exists = await existsCheck(git, claim)
  const checks = [exists.result, await targetCheck(git, exists.found, delivery.target), await carriesCheck(git, exists.found, context.increment.commit)]
  const release = delivery.release ? await releaseChecks(git, exists.found, claim) : { checks: [], version: null }
  checks.push(...release.checks)
  if (delivery.verifyInstalled) {
    checks.push(installedCheck(context.installed, release.version, claim.observedInstalledVersion))
  }
  return {
    passed: checks.every((item) => item.status === 'passed'),
    checks,
    reasons: checks.filter((item) => item.status === 'failed').map((item) => item.detail),
    releaseVersion: release.version,
    installedVersion: context.installed?.version ?? null,
    verifiedAt
  }
}
