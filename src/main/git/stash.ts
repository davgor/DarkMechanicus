/**
 * Dark Mechanicus stashes: what switching branches with `stash` puts aside, as `dm-stash:<branch>`. Only the
 * current branch's DM stashes are listed, restored or discarded; the person's own stashes are left alone.
 */
import type { StashInfo } from '../../shared/git/branches'
import type { RepoState } from '../../shared/git/status'
import { GitError, GitInputError } from './errors'
import { parseNameStatus } from './history'
import { currentBranch, repositoryRoot } from './refs'
import type { GitRunner } from './runner'
import { readRepository, readRepoState } from './status'

const DM_STASH_PREFIX = 'dm-stash:'
/**
 * `stash@{n}`, nothing else: no `@{-n}`, dates, suffixes or options. Git gets it as `refs/stash@{n}`, which still
 * works when a branch, tag or remote is also called `stash`.
 */
const STASH_REF = /^stash@\{(?:0|[1-9][0-9]{0,5})\}$/
/** The reflog subject of `git stash push -m dm-stash:<branch>` made on `<branch>`. */
const DM_SUBJECT = /^On [^:]*: dm-stash:(.+)$/

type DmStash = Omit<StashInfo, 'files'>

async function stashTop(runner: GitRunner, root: string): Promise<string> {
  const result = await runner.run({ cwd: root, args: ['rev-parse', '--verify', '--quiet', 'refs/stash'], kind: 'read', acceptExitCodes: [0, 1] })
  return result.stdout.trim()
}

/**
 * Stashes everything uncommitted, untracked files included, as this branch's DM stash. Returns the new stash's
 * commit id, or null when git made none (when only, say, a submodule differs), so a caller never pops someone else's.
 */
export async function stashChanges(runner: GitRunner, root: string, branch: string): Promise<string | null> {
  const before = await stashTop(runner, root)
  await runner.run({ cwd: root, args: ['stash', 'push', '--include-untracked', '-m', `${DM_STASH_PREFIX}${branch}`], kind: 'write' })
  const after = await stashTop(runner, root)
  return after !== '' && after !== before ? after : null
}

/**
 * Puts back the stash whose commit id is `oid`, staged changes staged again, wherever it now is in the list
 * (another stash may have come since).
 */
export async function popStash(runner: GitRunner, root: string, oid: string): Promise<void> {
  const { stdout } = await runner.run({ cwd: root, args: ['stash', 'list', '-z', '--format=%gd%x1f%H'], kind: 'read' })
  const ref = stdout
    .split('\u0000')
    .map((record) => record.replace(/^\n/, '').split('\u001f'))
    .find(([, hash]) => hash === oid)?.[0]
  if (ref !== undefined && STASH_REF.test(ref)) {
    await runner.run({ cwd: root, args: ['stash', 'pop', '--index', `refs/${ref}`], kind: 'write' })
  }
}

/** The current branch's DM stashes, newest first, without their files. */
async function readDmStashes(runner: GitRunner, root: string): Promise<DmStash[]> {
  const branch = await currentBranch(runner, root)
  if (branch === null) {
    return []
  }
  const { stdout } = await runner.run({ cwd: root, args: ['stash', 'list', '-z', '--format=%gd%x1f%cI%x1f%gs'], kind: 'read' })
  const stashes: DmStash[] = []
  for (const record of stdout.split('\u0000')) {
    const [ref = '', createdAt = '', ...subject] = record.replace(/^\n/, '').split('\u001f')
    const match = DM_SUBJECT.exec(subject.join('\u001f'))
    if (STASH_REF.test(ref) && match !== null && match[1] === branch) {
      stashes.push({ ref, branch, createdAt: new Date(createdAt).toISOString() })
    }
  }
  return stashes
}

/** The current branch's DM stashes, newest first, each with the files it holds (untracked ones as added). */
export async function listStashes(runner: GitRunner, folder: string): Promise<StashInfo[]> {
  const root = await repositoryRoot(runner, folder)
  const stashes = await readDmStashes(runner, root)
  const listed: StashInfo[] = []
  for (const stash of stashes) {
    const { stdout } = await runner.run({ cwd: root, args: ['stash', 'show', '--name-status', '-z', '--include-untracked', `refs/${stash.ref}`], kind: 'read' })
    listed.push({ ...stash, files: parseNameStatus(stdout) })
  }
  return listed
}

/** The repository root, once `ref` is known to name one of the current branch's DM stashes. */
async function requireDmStash(runner: GitRunner, folder: string, ref: string): Promise<string> {
  if (!STASH_REF.test(ref)) {
    throw new GitInputError('A stash is named stash@{n}.')
  }
  const root = await repositoryRoot(runner, folder)
  if (!(await readDmStashes(runner, root)).some((stash) => stash.ref === ref)) {
    throw new GitInputError("That is not one of this branch's Dark Mechanicus stashes. Refresh the list and try again.")
  }
  return root
}

/** Applies the stash and drops it. On a conflict git keeps the stash, and this fails `merge_conflicts`. */
export async function restoreStash(runner: GitRunner, folder: string, ref: string): Promise<RepoState> {
  const root = await requireDmStash(runner, folder, ref)
  const { inProgress } = await readRepository(runner, root)
  if (inProgress !== null) {
    throw new GitError('operation_in_progress', '', `Finish or abort the ${inProgress} before restoring a stash.`)
  }
  await runner.run({ cwd: root, args: ['stash', 'pop', `refs/${ref}`], kind: 'write' })
  return readRepoState(runner, root)
}

export async function discardStash(runner: GitRunner, folder: string, ref: string): Promise<RepoState> {
  const root = await requireDmStash(runner, folder, ref)
  await runner.run({ cwd: root, args: ['stash', 'drop', `refs/${ref}`], kind: 'write' })
  return readRepoState(runner, root)
}
