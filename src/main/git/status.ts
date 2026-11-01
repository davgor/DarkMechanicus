/** Reads what Source control shows: the repository root, the branch, the changed files, any operation in progress and the last fetch. */
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FileChange, FileChangeKind, RepoState, RepoStatus } from '../../shared/git/status'
import { isGithubHttps } from './credentials'
import { GitError } from './errors'
import { resolveSyncRemote } from './remotes'
import type { GitRunner } from './runner'

type BranchState = RepoStatus['branch']
type OperationInProgress = RepoStatus['inProgress']

interface ParsedStatus {
  branch: BranchState
  files: FileChange[]
}

/** The first `count` space-separated fields, then the rest of the entry untouched (a path may hold spaces). */
function splitFields(entry: string, count: number): string[] {
  const fields: string[] = []
  let from = 0
  for (let i = 0; i < count; i += 1) {
    const at = entry.indexOf(' ', from)
    fields.push(entry.slice(from, at))
    from = at + 1
  }
  fields.push(entry.slice(from))
  return fields
}

function byPath(a: FileChange, b: FileChange): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/**
 * The change set is the working tree compared with HEAD, so the staged and unstaged columns of `XY` are
 * folded into one kind. Returns null for a file that was added and deleted again (HEAD and tree agree).
 */
function classify(xy: string, renameOrCopy: boolean, path: string, oldPath: string | null): FileChange | null {
  const [x, y] = [xy[0], xy[1]]
  const has = (letter: string): boolean => x === letter || y === letter
  if (x === 'A' || y === 'A') {
    return y === 'D' ? null : { path, oldPath: null, kind: 'added' }
  }
  if (renameOrCopy) {
    if (y === 'D') {
      return { path: oldPath ?? path, oldPath: null, kind: 'deleted' }
    }
    return { path, oldPath, kind: has('C') ? 'copied' : 'renamed' }
  }
  const kind: FileChangeKind = has('D') ? 'deleted' : has('T') ? 'typechange' : 'modified'
  return { path, oldPath: null, kind }
}

function readBranchHeader(line: string, branch: BranchState): void {
  const value = (prefix: string): string | null => (line.startsWith(prefix) ? line.slice(prefix.length) : null)
  const oid = value('# branch.oid ')
  const head = value('# branch.head ')
  const upstream = value('# branch.upstream ')
  const ab = value('# branch.ab ')
  if (oid !== null) {
    branch.headOid = oid === '(initial)' ? null : oid
  } else if (head !== null) {
    branch.name = head === '(detached)' ? null : head
  } else if (upstream !== null) {
    branch.upstream = upstream
  } else if (ab !== null) {
    const match = /^\+(\d+) -(\d+)$/.exec(ab)
    branch.ahead = match === null ? 0 : Number(match[1])
    branch.behind = match === null ? 0 : Number(match[2])
  }
}

/** Parses `git status --porcelain=v2 --branch -z`. Pure. */
export function parseStatusV2(output: string): ParsedStatus {
  const branch: BranchState = { name: null, headOid: null, upstream: null, ahead: 0, behind: 0 }
  const files: FileChange[] = []
  const entries = output.split('\0')
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (entry.startsWith('# ')) {
      readBranchHeader(entry, branch)
    } else if (entry.startsWith('1 ')) {
      const fields = splitFields(entry, 8)
      const change = classify(fields[1], false, fields[8], null)
      if (change !== null) {
        files.push(change)
      }
    } else if (entry.startsWith('2 ')) {
      const fields = splitFields(entry, 9)
      i += 1
      const change = classify(fields[1], true, fields[9], entries[i] ?? null)
      if (change !== null) {
        files.push(change)
      }
    } else if (entry.startsWith('u ')) {
      files.push({ path: splitFields(entry, 10)[10], oldPath: null, kind: 'conflicted' })
    } else if (entry.startsWith('? ')) {
      files.push({ path: entry.slice(2), oldPath: null, kind: 'untracked' })
    }
  }
  files.sort(byPath)
  return { branch, files }
}

const OPERATION_MARKERS: ReadonlyArray<readonly [string, Exclude<OperationInProgress, null>]> = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert']
]

interface GitPathState {
  inProgress: OperationInProgress
  lastFetchedAt: string | null
}

function modifiedAt(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return null
  }
}

/** The operation in progress (from its marker files) and the last fetch (FETCH_HEAD's modification time), from one rev-parse. */
async function readGitPaths(runner: GitRunner, root: string): Promise<GitPathState> {
  const args = [...OPERATION_MARKERS.map(([name]) => name), 'FETCH_HEAD'].flatMap((name) => ['--git-path', name])
  const result = await runner.run({ cwd: root, args: ['rev-parse', ...args], kind: 'read' })
  const paths = result.stdout.split(/\r?\n/)
  const index = OPERATION_MARKERS.findIndex((_marker, at) => paths[at] !== undefined && paths[at] !== '' && existsSync(resolve(root, paths[at])))
  const fetchHead = paths[OPERATION_MARKERS.length]
  return {
    inProgress: index === -1 ? null : OPERATION_MARKERS[index][1],
    lastFetchedAt: fetchHead === undefined || fetchHead === '' ? null : modifiedAt(resolve(root, fetchHead))
  }
}

export async function readRepoState(runner: GitRunner, folder: string): Promise<RepoState> {
  let root: string
  try {
    const top = await runner.run({ cwd: folder, args: ['rev-parse', '--show-toplevel'], kind: 'read' })
    root = top.stdout.replace(/\r?\n$/, '')
  } catch (error) {
    if (error instanceof GitError && error.code === 'git_not_found') {
      return { kind: 'git_missing' }
    }
    if (error instanceof GitError && error.code === 'not_repository') {
      return { kind: 'not_repository' }
    }
    throw error
  }
  const status = await runner.run({
    cwd: root,
    args: ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--find-renames'],
    kind: 'read'
  })
  const { branch, files } = parseStatusV2(status.stdout)
  const remote = await readSyncRemote(runner, root, branch.name)
  return { kind: 'repository', status: { root, branch, files, ...(await readGitPaths(runner, root)), remote } }
}

/** The remote fetch and pull would use, or null when there is no upstream remote and no origin. */
async function readSyncRemote(runner: GitRunner, root: string, branch: string | null): Promise<RepoStatus['remote']> {
  try {
    const { remote } = await resolveSyncRemote(runner, root, branch)
    return { name: remote.name, githubHttps: isGithubHttps(remote.fetchUrl) }
  } catch (error) {
    if (error instanceof GitError && error.code === 'remote_not_found') {
      return null
    }
    throw error
  }
}

/** The status of the repository `folder` is in, or the GitError that says why it has none. */
export async function readRepository(runner: GitRunner, folder: string): Promise<RepoStatus> {
  const state = await readRepoState(runner, folder)
  if (state.kind === 'git_missing') {
    throw new GitError('git_not_found', '')
  }
  if (state.kind === 'not_repository') {
    throw new GitError('not_repository', '', 'That folder is not a Git repository.')
  }
  return state.status
}
