/**
 * DM-952: the clean-checkout preflight of a learning approval, and the one owned untracked file it keeps.
 *
 * With a `CleanCheckoutRequirement`, apply and recovery refuse (`dirty_worktree`, nothing changed) any staged,
 * modified, conflicting or untracked path in a target's canonical checkout before its canonical change. In repo storage
 * mode the core writes the current operation's portable record into the registered root checkout before native
 * apply runs, so the requirement may carry an `OwnedRecordAllowance` for exactly that one path. Only
 * `mintOwnedRecordAllowance` (called by main's operation-record binding) creates one, held in a module-private set:
 * a copy that went through JSON, IPC or a persisted plan grants nothing and is refused. The allowance keeps the path
 * only while it is untracked and unstaged, and only when the prepared tree has no entry at that path or a non-folder
 * entry at one of its folders (case-folded on Windows), so the integration can never own or overwrite the record.
 */
import { isAbsolute } from 'node:path'
import type { CleanCheckoutRequirement, OwnedRecordAllowance, PreparedTarget } from '../../shared/git/learningIntegration'
import { fail, label, type LearningIntegrationDeps, read, short } from './learningIntegration'
import { canonical } from './runner'

const minted = new WeakSet<OwnedRecordAllowance>()

/** Issues the allowance for one repository-relative (forward-slash) path in one absolute checkout. Main-only. */
export function mintOwnedRecordAllowance(checkout: string, path: string): OwnedRecordAllowance {
  const segments = path.split('/')
  if (!isAbsolute(checkout) || segments.some((part) => part === '' || part === '.' || part === '..' || /[\\:\0]/.test(part))) {
    fail('unsafe_path', `"${path}" in ${checkout} cannot be an owned record path.`)
  }
  const allowance = Object.freeze({ checkout, path })
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
  fold: (path: string) => string
}

/** The allowed path when the requirement's allowance names this target's checkout; otherwise every path is strict. */
function ownedIn(deps: LearningIntegrationDeps, target: PreparedTarget, requirement: CleanCheckoutRequirement): Owned | null {
  const platform = deps.platform ?? process.platform
  const record = requirement.record
  if (record === null || canonical(record.checkout, platform) !== canonical(target.checkout, platform)) return null
  return { path: record.path, fold: (path) => (platform === 'win32' ? path.toLowerCase() : path) }
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

/** The prepared tree has no entry at the record path and only folders at its ancestors, under every case alias. */
async function assertTreeLeavesRecord(deps: LearningIntegrationDeps, target: PreparedTarget, owned: Owned): Promise<void> {
  const segments = owned.path.split('/')
  let trees: TreeEntry[] = [{ oid: target.newHead, path: '' }]
  for (const [depth, name] of segments.entries()) {
    const wanted = (entry: string): boolean => owned.fold(entry) === owned.fold(name)
    const found = (await Promise.all(trees.map((tree) => matching(deps, target, tree, wanted)))).flat()
    const owner = found.find((entry) => depth === segments.length - 1 || entry.type !== 'tree')
    if (owner !== undefined) {
      fail(
        'unsafe_path',
        `The prepared ${short(target.newHead)} of ${label(target.repository)} has ${owner.path}, which would own or replace the current operation record ${owned.path}. Nothing was changed.`
      )
    }
    trees = found
  }
}

/**
 * Refuses, before the target's canonical change, every staged, modified, conflicting or untracked path in its
 * checkout except the allowed untracked record, and a prepared tree that would own or replace that record.
 */
export async function assertCleanCheckout(deps: LearningIntegrationDeps, target: PreparedTarget, requirement: CleanCheckoutRequirement): Promise<void> {
  const owned = ownedIn(deps, target, requirement)
  if (owned !== null) {
    await assertUntracked(deps, target, owned)
    await assertTreeLeavesRecord(deps, target, owned)
  }
  const kept = (entry: string): boolean => owned !== null && entry.startsWith('?? ') && owned.fold(entry.slice(3)) === owned.fold(owned.path)
  const dirty = (await statusEntries(deps, target.checkout)).filter((entry) => !kept(entry))
  if (dirty.length > 0) {
    fail(
      'dirty_worktree',
      `${target.checkout} (${label(target.repository)}) is not clean: ${dirty.map((entry) => entry.slice(3)).join(', ')}. Nothing was changed; commit, stash or discard them yourself, then approve again.`
    )
  }
}
