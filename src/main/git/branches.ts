/**
 * Branch operations: list, create, switch (stashing or bringing changes), rename, delete (with the upstream on
 * its remote) and merge into the current branch. Every name from the renderer passes `refArg` and git's own
 * `check-ref-format --branch` before any other git runs, and reaches git only as a full ref or after `--`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  BranchInfo,
  BranchList,
  CreateBranchRequest,
  DeleteBranchRequest,
  MergeBranchRequest,
  RenameBranchRequest,
  SwitchBranchRequest
} from '../../shared/git/branches'
import type { RepoState, RepoStatus } from '../../shared/git/status'
import { checkBranchName, refArg } from './args'
import { GitError, GitInputError } from './errors'
import { currentBranch, repositoryRoot } from './refs'
import { listRemotes } from './remotes'
import type { GitRunner } from './runner'
import { popStash, stashChanges } from './stash'
import { readRepository, readRepoState } from './status'
import { networkAuth, type NetworkDeps } from './sync'

const HEADS = 'refs/heads/'
const REMOTES = 'refs/remotes/'
const REF_FIELDS = ['%(refname)', '%(upstream)', '%(upstream:remotename)', '%(upstream:track,nobracket)', '%(committerdate:iso-strict)', '%(symref)']
/** Deleting a remote branch has no cancel button, so it gets a bound instead. */
const REMOTE_DELETE_TIMEOUT_MS = 120_000

interface RefRow {
  refname: string
  upstream: string
  upstreamRemote: string
  track: string
  committedAt: string
}

interface Refs {
  rows: RefRow[]
  names: Set<string>
  remotes: string[]
  current: string | null
}

/** Refuses `name` unless it is a safe argument and a valid branch name exactly as written. */
async function requireBranchName(runner: GitRunner, cwd: string, name: string): Promise<void> {
  try {
    refArg(name)
  } catch {
    throw new GitInputError('That is not a valid branch name.')
  }
  if (!(await checkBranchName(runner, cwd, name)).valid) {
    throw new GitInputError('That is not a valid branch name.')
  }
}

/** The NUL-separated fields of one output line; a missing field is ''. */
function fieldsOf(line: string): (index: number) => string {
  const fields = line.split('\u0000')
  return (index) => fields[index] ?? ''
}

/** One `for-each-ref` line; null for a symbolic ref such as `refs/remotes/origin/HEAD`. */
function parseRefRow(line: string): RefRow | null {
  const field = fieldsOf(line)
  const refname = field(0)
  const remoteHead = refname.startsWith(REMOTES) && refname.endsWith('/HEAD')
  if (refname === '' || field(5) !== '' || remoteHead) {
    return null
  }
  return { refname, upstream: field(1), upstreamRemote: field(2), track: field(3), committedAt: field(4) }
}

async function readRefs(runner: GitRunner, root: string): Promise<Refs> {
  const { stdout } = await runner.run({ cwd: root, args: ['for-each-ref', `--format=${REF_FIELDS.join('%00')}`, 'refs/heads', 'refs/remotes'], kind: 'read' })
  const rows = stdout.split('\n').flatMap((line) => parseRefRow(line) ?? [])
  const remotes = (await listRemotes(runner, root)).map((remote) => remote.name)
  return { rows, names: new Set(rows.map((row) => row.refname)), remotes, current: await currentBranch(runner, root) }
}

/** The remote a remote-tracking ref belongs to: the longest remote name that prefixes it (names may hold `/`). */
function remoteOf(refname: string, remotes: readonly string[]): string {
  const rest = refname.slice(REMOTES.length)
  const owner = remotes.filter((remote) => rest.startsWith(`${remote}/`)).sort((a, b) => b.length - a.length)[0]
  return owner ?? rest.split('/')[0]
}

/** `ahead 1, behind 2`, `ahead 1`, `behind 2`, `gone` or nothing. */
function parseTrack(track: string): { ahead: number; behind: number } {
  return { ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0) }
}

function shortUpstream(upstream: string): string | null {
  if (upstream.startsWith(REMOTES)) {
    return upstream.slice(REMOTES.length)
  }
  return upstream.startsWith(HEADS) ? upstream.slice(HEADS.length) : null
}

function toBranchInfo(row: RefRow, refs: Refs): BranchInfo {
  const local = row.refname.startsWith(HEADS)
  const name = row.refname.slice(local ? HEADS.length : REMOTES.length)
  // A ref git keeps at something other than a commit has no committer date.
  const committed = new Date(row.committedAt)
  return {
    name,
    kind: local ? 'local' : 'remote',
    remote: local ? null : remoteOf(row.refname, refs.remotes),
    upstream: local ? shortUpstream(row.upstream) : null,
    ...(local ? parseTrack(row.track) : { ahead: 0, behind: 0 }),
    lastCommitAt: Number.isNaN(committed.getTime()) ? '' : committed.toISOString(),
    isCurrent: local && name === refs.current
  }
}

interface DefaultBranch {
  name: string
  /** The full ref a branch made from the default starts at: the local branch, else the remote one. */
  ref: string
}

/** The remote whose default branch counts: the current branch's upstream remote, else `origin`, else the first. */
function defaultRemote(refs: Refs): string | null {
  const upstreamRemote = refs.rows.find((row) => row.refname === `${HEADS}${refs.current}`)?.upstreamRemote
  return [upstreamRemote, 'origin', refs.remotes[0]].find((remote) => remote !== undefined && refs.remotes.includes(remote)) ?? null
}

function startOf(name: string, remote: string | null, refs: Refs): DefaultBranch | null {
  if (refs.names.has(`${HEADS}${name}`)) {
    return { name, ref: `${HEADS}${name}` }
  }
  const remoteRef = remote === null ? null : `${REMOTES}${remote}/${name}`
  return remoteRef !== null && refs.names.has(remoteRef) ? { name, ref: remoteRef } : null
}

/** `refs/remotes/<remote>/HEAD`'s branch, else `main` or `master` when one exists. */
async function readDefaultBranch(runner: GitRunner, root: string, refs: Refs): Promise<DefaultBranch | null> {
  const remote = defaultRemote(refs)
  if (remote !== null) {
    const prefix = `${REMOTES}${remote}/`
    const head = await runner.run({ cwd: root, args: ['symbolic-ref', '--quiet', `${prefix}HEAD`], kind: 'read', acceptExitCodes: [0, 1, 128] })
    const target = head.stdout.replace(/\r?\n$/, '')
    const found = head.code === 0 && target.startsWith(prefix) ? startOf(target.slice(prefix.length), remote, refs) : null
    if (found !== null) {
      return found
    }
  }
  return startOf('main', remote, refs) ?? startOf('master', remote, refs)
}

export async function listBranches(runner: GitRunner, folder: string): Promise<BranchList> {
  const root = await repositoryRoot(runner, folder)
  const refs = await readRefs(runner, root)
  return {
    current: refs.current,
    defaultBranch: (await readDefaultBranch(runner, root, refs))?.name ?? null,
    branches: refs.rows.map((row) => toBranchInfo(row, refs))
  }
}

/** `git switch -c <name> [<default>]`: uncommitted changes come along; a name in use fails `branch_exists`. */
export async function createBranch(runner: GitRunner, folder: string, request: CreateBranchRequest): Promise<RepoState> {
  await requireBranchName(runner, folder, request.name)
  const root = await repositoryRoot(runner, folder)
  const args = ['switch', '--no-track', '-c', request.name]
  if (request.startPoint === 'default') {
    const start = await readDefaultBranch(runner, root, await readRefs(runner, root))
    if (start === null) {
      throw new GitInputError('This repository has no default branch to start from.')
    }
    args.push(start.ref)
  }
  await runner.run({ cwd: root, args, kind: 'write' })
  return readRepoState(runner, root)
}

/** The remote-tracking branch `name` means: `origin/x` itself, else the one remote branch called `x`. */
function remoteBranchFor(name: string, refs: Refs): { ref: string; local: string } {
  if (refs.names.has(`${REMOTES}${name}`)) {
    const remote = remoteOf(`${REMOTES}${name}`, refs.remotes)
    return { ref: `${REMOTES}${name}`, local: name.slice(remote.length + 1) }
  }
  const matches = refs.remotes.filter((remote) => refs.names.has(`${REMOTES}${remote}/${name}`))
  if (matches.length !== 1) {
    throw new GitInputError(matches.length === 0 ? 'There is no branch with that name.' : 'More than one remote has a branch with that name; pick one.')
  }
  return { ref: `${REMOTES}${matches[0]}/${name}`, local: name }
}

/** The `git switch` arguments for `name`: a local branch, or a new local branch tracking a remote one. */
async function switchArgs(runner: GitRunner, root: string, name: string): Promise<{ args: string[]; local: string }> {
  const refs = await readRefs(runner, root)
  if (refs.names.has(`${HEADS}${name}`)) {
    return { args: ['switch', '--', name], local: name }
  }
  const remote = remoteBranchFor(name, refs)
  await requireBranchName(runner, root, remote.local)
  if (refs.names.has(`${HEADS}${remote.local}`)) {
    return { args: ['switch', '--', remote.local], local: remote.local }
  }
  return { args: ['switch', '-c', remote.local, '--track', remote.ref], local: remote.local }
}

/** Stashes the changes for a `stash` switch; the stash's commit id, or null when there was nothing to stash. */
async function stashForSwitch(runner: GitRunner, status: RepoStatus, uncommitted: SwitchBranchRequest['uncommitted']): Promise<string | null> {
  if (uncommitted !== 'stash' || status.files.length === 0) {
    return null
  }
  if (status.branch.name === null) {
    throw new GitInputError('Changes on a detached HEAD cannot be stashed for a branch. Bring them along or commit them first.')
  }
  return stashChanges(runner, status.root, status.branch.name)
}

/**
 * Switches to `name`. With `stash`, uncommitted changes first go into a `dm-stash:<branch>` stash (put back if
 * git then refuses to switch); with `bring`, git takes them along or refuses (`local_changes_would_be_overwritten`)
 * and nothing changes. Never pops a stash otherwise, and never runs during a merge, rebase or the like, which
 * stashing would silently end.
 */
export async function switchBranch(runner: GitRunner, folder: string, request: SwitchBranchRequest): Promise<RepoState> {
  await requireBranchName(runner, folder, request.name)
  const status = await readRepository(runner, folder)
  if (status.inProgress !== null) {
    throw new GitError('operation_in_progress', '', `Finish or abort the ${status.inProgress} before switching branches.`)
  }
  const target = await switchArgs(runner, status.root, request.name)
  if (target.local === status.branch.name) {
    return readRepoState(runner, status.root)
  }
  const stashed = await stashForSwitch(runner, status, request.uncommitted)
  try {
    await runner.run({ cwd: status.root, args: target.args, kind: 'write' })
  } catch (error) {
    // A failing post-checkout hook fails the switch after it happened; the stash then stays where it belongs.
    if (stashed !== null && (await currentBranch(runner, status.root)) === status.branch.name) {
      await popStash(runner, status.root, stashed)
    }
    throw error
  }
  return readRepoState(runner, status.root)
}

export async function renameBranch(runner: GitRunner, folder: string, request: RenameBranchRequest): Promise<RepoState> {
  await requireBranchName(runner, folder, request.from)
  await requireBranchName(runner, folder, request.to)
  const root = await repositoryRoot(runner, folder)
  await runner.run({ cwd: root, args: ['branch', '-m', '--', request.from, request.to], kind: 'write' })
  return readRepoState(runner, root)
}

interface RemoteDeletion {
  remote: string
  /** The branch on the remote, `refs/heads/<name>`. */
  ref: string
  /** Where the remote-tracking ref says it is; the push only deletes it if the remote still agrees. */
  expected: string
  pushUrl: string
}

async function revParse(runner: GitRunner, root: string, ref: string): Promise<string | null> {
  const result = await runner.run({ cwd: root, args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], kind: 'read', acceptExitCodes: [0, 1] })
  return result.code === 0 ? result.stdout.trim() : null
}

async function isMergedIntoHead(runner: GitRunner, root: string, oid: string): Promise<boolean> {
  const result = await runner.run({ cwd: root, args: ['merge-base', '--is-ancestor', oid, 'HEAD'], kind: 'read', acceptExitCodes: [0, 1] })
  return result.code === 0
}

interface Upstream {
  remote: string
  /** `refs/heads/<name>` on the remote. */
  ref: string
  /** The remote-tracking ref, `refs/remotes/<remote>/<name>`. */
  tracking: string
  /** The local branch's tip. */
  local: string
}

/** Refuses an upstream the deletion must not touch: none, one under another name (a base branch), or a dash remote. */
function refuseUpstream(upstream: Upstream, name: string): void {
  if (upstream.remote === '' || !upstream.tracking.startsWith(REMOTES)) {
    throw new GitInputError('That branch has no upstream branch on a remote to delete.')
  }
  if (upstream.ref !== `${HEADS}${name}`) {
    throw new GitInputError('That branch tracks a remote branch with another name, which may be shared. Delete only the local branch.')
  }
  if (upstream.remote.startsWith('-')) {
    throw new GitInputError('A remote whose name starts with "-" cannot be used here. Rename it first.')
  }
}

/** The local branch `name`'s upstream (`for-each-ref` also lists `name/…`, so only the exact ref counts). */
async function readUpstream(runner: GitRunner, root: string, name: string): Promise<Upstream> {
  const format = '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)%00%(objectname)'
  const { stdout } = await runner.run({ cwd: root, args: ['for-each-ref', format, '--', `${HEADS}${name}`], kind: 'read' })
  const field = stdout
    .split('\n')
    .map(fieldsOf)
    .find((fields) => fields(0) === `${HEADS}${name}`)
  if (field === undefined) {
    throw new GitInputError('There is no local branch with that name.')
  }
  const upstream: Upstream = { remote: field(1), ref: field(2), tracking: field(3), local: field(4) }
  refuseUpstream(upstream, name)
  return upstream
}

function readTrimmed(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Whether some worktree has `name` checked out, or is rebasing or bisecting it, where `git branch -d` would refuse.
 * Read from each worktree's admin folder, as git does (a rebasing worktree is listed as detached).
 */
async function inUseByAWorktree(runner: GitRunner, root: string, name: string): Promise<boolean> {
  const { stdout } = await runner.run({ cwd: root, args: ['rev-parse', '--git-common-dir'], kind: 'read' })
  const common = resolve(root, stdout.replace(/\r?\n$/, ''))
  let linked: string[] = []
  try {
    linked = readdirSync(join(common, 'worktrees')).map((id) => join(common, 'worktrees', id))
  } catch {
    // No linked worktrees.
  }
  const ref = `${HEADS}${name}`
  return [common, ...linked].some(
    (admin) =>
      readTrimmed(join(admin, 'HEAD')) === `ref: ${ref}` ||
      readTrimmed(join(admin, 'rebase-merge', 'head-name')) === ref ||
      readTrimmed(join(admin, 'rebase-apply', 'head-name')) === ref ||
      readTrimmed(join(admin, 'BISECT_START')) === name
  )
}

/**
 * The branch's upstream on its own remote, under the branch's own name. Unless forced, both tips must already be
 * in HEAD. Refused up front when git would then refuse the local deletion, so the remote branch is not deleted alone.
 */
async function planRemoteDeletion(runner: GitRunner, root: string, name: string, force: boolean): Promise<RemoteDeletion> {
  const { remote, ref, tracking, local } = await readUpstream(runner, root, name)
  if (await inUseByAWorktree(runner, root, name)) {
    throw new GitInputError('That branch is checked out, rebased or bisected in a worktree. Finish there first.')
  }
  const expected = await revParse(runner, root, tracking)
  const pushUrl = (await listRemotes(runner, root)).find((candidate) => candidate.name === remote)?.pushUrl
  if (expected === null || pushUrl === undefined) {
    throw new GitError('remote_not_found', '', 'The remote branch is not known here; it may be deleted already. Delete only the local branch.')
  }
  if (!force && !((await isMergedIntoHead(runner, root, local)) && (await isMergedIntoHead(runner, root, expected)))) {
    throw new GitError('branch_not_fully_merged', '', 'The branch or its remote branch has commits the current branch does not have.')
  }
  return { remote, ref, expected, pushUrl }
}

/** `git push --delete` with the sync credentials, guarded by a lease so commits pushed since the last fetch survive. */
async function deleteOnRemote(deps: NetworkDeps, root: string, target: RemoteDeletion): Promise<void> {
  const auth = await networkAuth(deps, root, target.pushUrl)
  const lease = `--force-with-lease=${target.ref}:${target.expected}`
  try {
    await deps.runner.run({
      cwd: root,
      args: [...auth.args, 'push', lease, '--delete', '--', target.remote, target.ref],
      kind: 'network',
      env: auth.env,
      redact: auth.redact,
      timeoutMs: REMOTE_DELETE_TIMEOUT_MS
    })
  } catch (error) {
    throw auth.failure(error)
  }
}

/**
 * Deletes a branch other than the current one (`-d`, or `-D` with `force`; unmerged fails `branch_not_fully_merged`).
 * With `deleteRemote`, its upstream is deleted on its remote first, so a failed push changes nothing locally.
 */
export async function deleteBranch(deps: NetworkDeps, folder: string, request: DeleteBranchRequest): Promise<RepoState> {
  const { runner } = deps
  await requireBranchName(runner, folder, request.name)
  const status = await readRepository(runner, folder)
  if (status.branch.name === request.name) {
    throw new GitInputError('You cannot delete the current branch. Switch to another branch first.')
  }
  if (request.deleteRemote) {
    await deleteOnRemote(deps, status.root, await planRemoteDeletion(runner, status.root, request.name, request.force))
  }
  await runner.run({ cwd: status.root, args: ['branch', request.force ? '-D' : '-d', '--', request.name], kind: 'write' })
  return readRepoState(runner, status.root)
}

/**
 * `git merge --no-edit <branch>`; a conflict fails `merge_conflicts` and leaves the merge in progress. Git gets the
 * full ref (so a tag of the same name never wins) and git's own wording of the message, which it would otherwise
 * write with the full ref.
 */
export async function mergeIntoCurrent(runner: GitRunner, folder: string, request: MergeBranchRequest): Promise<RepoState> {
  await requireBranchName(runner, folder, request.branch)
  const root = await repositoryRoot(runner, folder)
  const refs = await readRefs(runner, root)
  const ref = [`${HEADS}${request.branch}`, `${REMOTES}${request.branch}`].find((candidate) => refs.names.has(candidate))
  if (ref === undefined) {
    throw new GitInputError('There is no branch with that name.')
  }
  const message = `Merge ${ref.startsWith(HEADS) ? 'branch' : 'remote-tracking branch'} '${request.branch}'`
  await runner.run({ cwd: root, args: ['merge', '--no-edit', '-m', message, ref], kind: 'write' })
  return readRepoState(runner, root)
}
