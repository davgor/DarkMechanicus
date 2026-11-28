/**
 * DM-952: the clean-checkout preflight of a learning approval, and the owned untracked files it keeps.
 *
 * With a `CleanCheckoutRequirement`, apply and recovery refuse (`dirty_worktree`, nothing changed) any staged,
 * modified, conflicting or untracked path in a target's canonical checkout before its canonical change. In repo storage
 * mode the core writes the current operation's portable record into the registered root checkout before native
 * apply runs, so the requirement may carry an `OwnedRecordAllowance` for exactly that one path. DM-982: repo storage
 * commits none of the records it writes, so the card records of the approval and, for each approval this machine
 * already published, its integration record, published learnings and card records stay uncommitted there too. The
 * allowance also names those this machine exported and still holds unchanged; each is kept only while it is
 * untracked, so consecutive approvals proceed without a manual commit. Only
 * `mintOwnedRecordAllowance` (called by main's operation-record binding) creates one, held in a module-private set:
 * a copy that went through JSON, IPC or a persisted plan grants nothing and is refused. The allowance keeps a path
 * only while it is untracked and unstaged, and only when the prepared tree has no entry at that path or a non-folder
 * entry at one of its folders (case-folded on Windows), so the integration can never own or overwrite a record.
 */
import { isAbsolute } from 'node:path'
import type { CleanCheckoutRequirement, OwnedRecordAllowance, PreparedTarget } from '../../shared/git/learningIntegration'
import { fail, label, type LearningIntegrationDeps, read, short } from './learningIntegration'
import { canonical } from './runner'

const minted = new WeakSet<OwnedRecordAllowance>()

/** Refuses a path that is not repository-relative with forward slashes and plain segments. */
function assertRecordPath(checkout: string, path: string): void {
  const segments = path.split('/')
  if (segments.some((part) => part === '' || part === '.' || part === '..' || /[\\:\0]/.test(part))) {
    fail('unsafe_path', `"${path}" in ${checkout} cannot be an owned record path.`)
  }
}

/**
 * Issues the allowance for the current operation's record `path` and the other owned `records` of this machine's
 * learning approvals, each repository-relative (forward-slash), in one absolute checkout. Main-only.
 */
export function mintOwnedRecordAllowance(checkout: string, path: string, records: readonly string[] = []): OwnedRecordAllowance {
  if (!isAbsolute(checkout)) fail('unsafe_path', `"${path}" in ${checkout} cannot be an owned record path.`)
  for (const one of [path, ...records]) assertRecordPath(checkout, one)
  const allowance = Object.freeze({ checkout, path, records: Object.freeze([...records]) })
  minted.add(allowance)
  return allowance
}

/** Refuses a requirement whose allowance this process did not issue; called before any lock or Git command. */
export function assertTrustedRequirement(requirement: CleanCheckoutRequirement | undefined): void {
  if (requirement?.record != null && !minted.has(requirement.record)) {
    fail('invalid_request', 'The owned record allowance was not issued for the current operation by this process; nothing was changed.')
  }
}

interface Owned {
  path: string
  /** The folded paths of the other owned records. */
  records: ReadonlySet<string>
  fold: (path: string) => string
}

/** The allowed paths when the requirement's allowance names this target's checkout; otherwise every path is strict. */
function ownedIn(deps: LearningIntegrationDeps, target: PreparedTarget, requirement: CleanCheckoutRequirement): Owned | null {
  const platform = deps.platform ?? process.platform
  const record = requirement.record
  if (record === null || canonical(record.checkout, platform) !== canonical(target.checkout, platform)) return null
  const fold = (path: string): string => (platform === 'win32' ? path.toLowerCase() : path)
  return { path: record.path, records: new Set(record.records.map(fold)), fold }
}

/** `git status` entries (`XY path`) of the checkout, untracked files listed one by one, renames split. */
async function statusEntries(deps: LearningIntegrationDeps, checkout: string): Promise<string[]> {
  const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none']
  return (await read(deps.runner, checkout, args)).out.split('\0').filter((entry) => entry !== '')
}

/** A tracked or staged record is not the allowed untracked case. */
async function assertUntracked(deps: LearningIntegrationDeps, target: PreparedTarget, owned: Owned): Promise<void> {
  const magic = (deps.platform ?? process.platform) === 'win32' ? 'icase,literal' : 'literal'
  const indexed = (await read(deps.runner, target.checkout, ['ls-files', '-z', '--stage', '--', `:(${magic})${owned.path}`])).out
  if (indexed !== '') {
    fail('dirty_worktree', `${owned.path} is tracked or staged in ${target.checkout}; only an untracked current operation record is kept. Nothing was changed.`)
  }
}

interface TreeEntry {
  oid: string
  path: string
}

/** The entries of `tree` whose name `wanted` accepts, with their type. */
async function matching(deps: LearningIntegrationDeps, target: PreparedTarget, tree: TreeEntry, wanted: (name: string) => boolean) {
  const listed = (await read(deps.runner, target.checkout, ['ls-tree', '-z', tree.oid])).out
  return listed.split('\0').flatMap((line) => {
    const tab = line.indexOf('\t')
    const entry = line.slice(tab + 1)
    if (tab < 0 || !wanted(entry)) return []
    const [, type = '', oid = ''] = line.slice(0, tab).split(' ')
    return [{ type, oid, path: tree.path === '' ? entry : `${tree.path}/${entry}` }]
  })
}

/**
 * The prepared tree has no entry at the record `path` and only folders at its ancestors, under every case alias.
 * `what` names the record in the refusal: the current operation record or a published record.
 */
async function assertTreeLeavesRecord(deps: LearningIntegrationDeps, target: PreparedTarget, owned: Owned, record: { path: string; what: string }): Promise<void> {
  const { path, what } = record
  const segments = path.split('/')
  let trees: TreeEntry[] = [{ oid: target.newHead, path: '' }]
  for (const [depth, name] of segments.entries()) {
    const wanted = (entry: string): boolean => owned.fold(entry) === owned.fold(name)
    const found = (await Promise.all(trees.map((tree) => matching(deps, target, tree, wanted)))).flat()
    const owner = found.find((entry) => depth === segments.length - 1 || entry.type !== 'tree')
    if (owner !== undefined) {
      fail(
        'unsafe_path',
        `The prepared ${short(target.newHead)} of ${label(target.repository)} has ${owner.path}, which would own or replace the ${what} ${path}. Nothing was changed.`
      )
    }
    trees = found
  }
}

/**
 * Refuses, before the target's canonical change, every staged, modified, conflicting or untracked path in its
 * checkout except the allowed untracked records, and a prepared tree that would own or replace one of them.
 */
export async function assertCleanCheckout(deps: LearningIntegrationDeps, target: PreparedTarget, requirement: CleanCheckoutRequirement): Promise<void> {
  const owned = ownedIn(deps, target, requirement)
  if (owned !== null) {
    await assertUntracked(deps, target, owned)
    await assertTreeLeavesRecord(deps, target, owned, { path: owned.path, what: 'current operation record' })
  }
  const untracked = (entry: string): string | null => (entry.startsWith('?? ') ? owned?.fold(entry.slice(3)) ?? null : null)
  const current = (entry: string): boolean => owned !== null && untracked(entry) === owned.fold(owned.path)
  const kept = (entry: string): boolean => owned !== null && owned.records.has(untracked(entry) ?? '')
  const entries = await statusEntries(deps, target.checkout)
  const dirty = entries.filter((entry) => !current(entry) && !kept(entry))
  if (dirty.length > 0) {
    fail(
      'dirty_worktree',
      `${target.checkout} (${label(target.repository)}) is not clean: ${dirty.map((entry) => entry.slice(3)).join(', ')}. Nothing was changed; commit, stash or discard them yourself, then approve again.`
    )
  }
  for (const entry of entries.filter((one) => kept(one) && !current(one))) {
    await assertTreeLeavesRecord(deps, target, owned as Owned, { path: entry.slice(3), what: 'owned record' })
  }
}
