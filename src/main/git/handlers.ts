/**
 * The behavior behind the `git:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). Every argument arrives from the renderer and is untrusted: it is validated
 * here, the folder must be tracked (a clone goes only into the folder chosen in main's dialog), and
 * paths must stay inside the repository. Nothing throws.
 */
import { posix } from 'node:path'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import type { CommitMessage, CommitRequest, DiscardRequest, GitErrorShape, GitProgressEvent, GitResult, WorkingDiffRequest } from '../../shared/git/api'
import type { FileDiff } from '../../shared/git/diff'
import type { CommitDiffRequest, CommitFile, HistoryPage, HistoryRequest } from '../../shared/git/history'
import type { BranchList, BranchNameCheck, StashInfo } from '../../shared/git/branches'
import type { ConflictState } from '../../shared/git/conflicts'
import type { TrackedFolderView } from '../../shared/desktop/api'
import type { FileChange, RepoState } from '../../shared/git/status'
import type { FolderRegistry } from '../desktop/folderRegistry'
import type { CompareUrl, PullRequestInfo } from '../../shared/github/pullRequests'
import type { GithubClient } from '../github/client'
import { GithubError } from '../github/errors'
import { createPullRequests } from '../github/pullRequests'
import { checkBranchName, pathArgs } from './args'
import { createBranch, deleteBranch, listBranches, mergeIntoCurrent, renameBranch, switchBranch } from './branches'
import type { Cloner } from './clone'
import { commitFiles, findInStatus, requireStatus, undoLastCommit } from './commit'
import { abortMerge, abortOperation, commitMerge, getConflicts, locate, markResolved, openInEditor, resolveWith, type OpenPath } from './conflicts'
import type { CredentialSession } from './credentials'
import { discardFiles, type TrashItem } from './discard'
import { readWorkingDiff } from './diff'
import { GitError, GitInputError } from './errors'
import { getCommitDiff, getCommitFiles, getHistory, MAX_HISTORY_LIMIT } from './history'
import { createOperationLocks, type OperationLocks } from './operationLock'
import type { GitRunner } from './runner'
import { discardStash, listStashes, restoreStash } from './stash'
import { readRepository, readRepoState } from './status'
import { createSync, type SyncOperation } from './sync'

/** Windows long-path maximum; bounds path strings from the renderer. */
const MAX_PATH_LENGTH = 32_767

const folderSchema = z.string().min(1).max(MAX_PATH_LENGTH)
const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH)
const diffRequestSchema = z.strictObject({
  path: pathSchema,
  oldPath: pathSchema.nullable(),
  kind: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'typechange', 'untracked', 'conflicted']),
  force: z.boolean().optional()
})

const FILE_KINDS = ['added', 'modified', 'deleted', 'renamed', 'copied', 'typechange', 'untracked', 'conflicted'] as const
const commitRequestSchema = z.strictObject({
  summary: z.string().max(MAX_PATH_LENGTH),
  description: z.string().max(1_000_000),
  files: z
    .array(
      z.strictObject({
        path: pathSchema,
        oldPath: pathSchema.nullable(),
        lines: z.array(z.number().int().min(0)).max(10_000_000).optional(),
        diffHash: z.string().max(100).optional()
      })
    )
    .max(100_000)
})
const discardRequestSchema = z.strictObject({
  files: z.array(z.strictObject({ path: pathSchema, oldPath: pathSchema.nullable(), kind: z.enum(FILE_KINDS) })).max(100_000)
})

const oidSchema = z.string().regex(/^[0-9a-fA-F]{4,64}$/, 'A commit id is 4 to 64 hexadecimal characters.')
const historyRequestSchema = z.strictObject({ skip: z.number().int().min(0), limit: z.number().int().min(1).max(MAX_HISTORY_LIMIT) })
const commitDiffRequestSchema = z.strictObject({ oid: oidSchema, path: pathSchema, oldPath: pathSchema.nullable(), force: z.boolean().optional() })
const operationIdSchema = z.string().min(1).max(200)
const syncRequestSchema = z.strictObject({ operationId: operationIdSchema })
/** A clone: the renderer names the URL and the new folder's name, never the folder it goes into. */
const cloneRequestSchema = z.strictObject({ operationId: operationIdSchema, url: z.string().max(4096), name: z.string().max(1024) })
/** Generous for a branch name (git and `checkBranchName` set the real limits); it only bounds the payload. */
const branchNameSchema = z.string().max(1024)
const createBranchSchema = z.strictObject({ name: branchNameSchema, startPoint: z.enum(['current', 'default']) })
const switchBranchSchema = z.strictObject({ name: branchNameSchema, uncommitted: z.enum(['stash', 'bring']) })
const renameBranchSchema = z.strictObject({ from: branchNameSchema, to: branchNameSchema })
const deleteBranchSchema = z.strictObject({ name: branchNameSchema, deleteRemote: z.boolean(), force: z.boolean() })
const mergeBranchSchema = z.strictObject({ branch: branchNameSchema })
const stashRefSchema = z.string().max(64)
const resolveSchema = z.strictObject({ path: pathSchema, side: z.enum(['ours', 'theirs']) })
const markResolvedSchema = z.strictObject({ path: pathSchema })
const commitMergeSchema = z.strictObject({ summary: z.string().max(MAX_PATH_LENGTH).optional(), description: z.string().max(1_000_000).optional() })
const pullRequestsSchema = z.strictObject({ refresh: z.boolean().optional() }).optional()
const checkoutPullRequestSchema = z.strictObject({ number: z.number().int().min(1).max(2_147_483_647), uncommitted: z.enum(['stash', 'bring']) })

interface GitHandlerDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  /** Clones into the folder chosen with main's dialog; without it, the clone channels answer that cloning is unavailable. */
  clones?: Cloner
  runner: GitRunner
  /** Told about failures that are not GitErrors (bugs, I/O), so main can log the stack. */
  /** Moves a file to the OS trash (Electron's shell.trashItem). */
  trashItem: TrashItem
  /** Opens a file in the default app (Electron's shell.openPath). */
  openPath: OpenPath
  /** The GitHub account fetch, pull and push authenticate with; its token never leaves main. */
  session: CredentialSession
  /** The session-bound GitHub API client pull requests are read with; a 401 through it signs the account out. */
  client: Pick<GithubClient, 'listOpenPullRequests'>
  /** Sends a progress event of a fetch, pull or push to the windows. */
  onProgress(event: GitProgressEvent): void
  onUnexpectedError(error: unknown): void
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface GitHandlers {
  getState(folder: unknown): Promise<GitResult<RepoState>>
  getWorkingDiff(folder: unknown, request: unknown): Promise<GitResult<FileDiff>>
  initRepository(folder: unknown): Promise<GitResult<RepoState>>
  commit(folder: unknown, request: unknown): Promise<GitResult<{ oid: string }>>
  undoLastCommit(folder: unknown): Promise<GitResult<CommitMessage>>
  discardChanges(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  getHistory(folder: unknown, request: unknown): Promise<GitResult<HistoryPage>>
  getCommitFiles(folder: unknown, oid: unknown): Promise<GitResult<CommitFile[]>>
  getCommitDiff(folder: unknown, request: unknown): Promise<GitResult<FileDiff>>
  fetch(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  pull(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  push(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  cancelOperation(folder: unknown, operationId: unknown): Promise<GitResult<{ cancelled: boolean }>>
  getCloneParent(): Promise<GitResult<string | null>>
  chooseCloneParent(): Promise<GitResult<string | null>>
  clone(request: unknown): Promise<GitResult<TrackedFolderView>>
  listBranches(folder: unknown): Promise<GitResult<BranchList>>
  checkBranchName(folder: unknown, name: unknown): Promise<GitResult<BranchNameCheck>>
  createBranch(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  switchBranch(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  renameBranch(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  deleteBranch(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  mergeIntoCurrent(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  listStashes(folder: unknown): Promise<GitResult<StashInfo[]>>
  restoreStash(folder: unknown, ref: unknown): Promise<GitResult<RepoState>>
  discardStash(folder: unknown, ref: unknown): Promise<GitResult<RepoState>>
  getConflicts(folder: unknown): Promise<GitResult<ConflictState>>
  resolveWith(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  markResolved(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  abortMerge(folder: unknown): Promise<GitResult<RepoState>>
  commitMerge(folder: unknown, request: unknown): Promise<GitResult<{ oid: string }>>
  abortOperation(folder: unknown): Promise<GitResult<RepoState>>
  openInEditor(folder: unknown, path: unknown): Promise<GitResult<null>>
  getPullRequests(folder: unknown, request: unknown): Promise<GitResult<PullRequestInfo>>
  checkoutPullRequest(folder: unknown, request: unknown): Promise<GitResult<RepoState>>
  getCompareUrl(folder: unknown): Promise<GitResult<CompareUrl>>
  getCommitUrl(folder: unknown, oid: unknown): Promise<GitResult<string>>
}

/** A failure to report as is: bad input, an untracked folder, or an operation git cannot do here. */
class Refusal extends Error {
  constructor(readonly shape: GitErrorShape) {
    super(shape.message)
  }
}

function invalid<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  try {
    return parseInput(schema, value, what)
  } catch (error) {
    throw new Refusal({ code: 'invalid_input', message: error instanceof DomainError ? error.message : `Invalid ${what}.` })
  }
}

function requireTracked(registry: Pick<FolderRegistry, 'resolve'>, folder: unknown): string {
  const requested = invalid(folderSchema, folder, 'folder')
  const tracked = registry.resolve(requested)
  if (tracked === null) {
    throw new Refusal({ code: 'unauthorized', message: 'That folder is not tracked by Dark Mechanicus.' })
  }
  return tracked
}

function parseDiffRequest(request: unknown): WorkingDiffRequest {
  const parsed = invalid(diffRequestSchema, request, 'request')
  try {
    pathArgs(parsed.oldPath === null ? [parsed.path] : [parsed.path, parsed.oldPath])
  } catch {
    throw new Refusal({ code: 'invalid_input', message: 'Paths must be relative and stay inside the repository.' })
  }
  return { path: parsed.path, oldPath: parsed.oldPath, kind: parsed.kind, ...(parsed.force === undefined ? {} : { force: parsed.force }) }
}

/** Turns whatever a handler threw into a result; only unexpected errors reach `onUnexpectedError`. */
function report(error: unknown, onUnexpectedError: (error: unknown) => void): GitResult<never> {
  if (error instanceof Refusal) {
    return { ok: false, error: error.shape }
  }
  if (error instanceof GitInputError) {
    return { ok: false, error: { code: 'invalid_input', message: error.message } }
  }
  if (error instanceof GitError) {
    return { ok: false, error: { code: error.code, message: error.message, ...(error.detail === '' ? {} : { detail: error.detail }) } }
  }
  if (error instanceof GithubError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  try {
    onUnexpectedError(error)
  } catch {
    // A failing logger must not turn a result into a thrown error.
  }
  return { ok: false, error: { code: 'git_failed', message: 'Git failed unexpectedly.' } }
}

/** The repository root of a tracked folder, or the GitError that says why it has none. */
async function requireRepository(runner: GitRunner, folder: string): Promise<string> {
  return (await readRepository(runner, folder)).root
}

/**
 * The status entry for a requested path: its kind and old path come from git, not the renderer. An untracked file
 * whose folder really lies outside the repository is refused, since `git diff --no-index` follows symlinked
 * directories; a symlink itself is diffed as a link (its target path), so the file's own name may be one.
 */
async function requireChange(runner: GitRunner, folder: string, path: string): Promise<{ root: string; change: FileChange }> {
  const status = await requireStatus(runner, folder)
  const change = findInStatus(status, path)
  const parent = posix.dirname(change.path)
  if (change.kind === 'untracked' && parent !== '.' && locate(status.root, parent).kind === 'outside') {
    throw new GitInputError(`${path} is outside the repository.`)
  }
  return { root: status.root, change }
}

async function initFolder(runner: GitRunner, folder: string): Promise<RepoState> {
  const before = await readRepoState(runner, folder)
  if (before.kind === 'git_missing') {
    throw new GitError('git_not_found', '')
  }
  if (before.kind === 'repository') {
    throw new Refusal({ code: 'invalid_input', message: 'That folder is already inside a Git repository.' })
  }
  await runner.run({ cwd: folder, args: ['init'], kind: 'write' })
  return readRepoState(runner, folder)
}

type Guarded = <T>(work: () => Promise<T>) => Promise<GitResult<T>>
type Locked = OperationLocks['run']

function createHistoryHandlers(
  registry: Pick<FolderRegistry, 'resolve'>,
  runner: GitRunner,
  guarded: Guarded
): Pick<GitHandlers, 'getHistory' | 'getCommitFiles' | 'getCommitDiff'> {
  return {
    getHistory: (folder, request) =>
      guarded(async () => {
        const tracked = requireTracked(registry, folder)
        const parsed: HistoryRequest = invalid(historyRequestSchema, request, 'request')
        return getHistory(runner, await requireRepository(runner, tracked), parsed)
      }),
    getCommitFiles: (folder, oid) =>
      guarded(async () => {
        const tracked = requireTracked(registry, folder)
        const parsed = invalid(oidSchema, oid, 'commit id')
        return getCommitFiles(runner, await requireRepository(runner, tracked), parsed)
      }),
    getCommitDiff: (folder, request) =>
      guarded(async () => {
        const tracked = requireTracked(registry, folder)
        const parsed = invalid(commitDiffRequestSchema, request, 'request')
        try {
          pathArgs(parsed.oldPath === null ? [parsed.path] : [parsed.path, parsed.oldPath])
        } catch {
          throw new Refusal({ code: 'invalid_input', message: 'Paths must be relative and stay inside the repository.' })
        }
        const wanted: CommitDiffRequest = { oid: parsed.oid, path: parsed.path, oldPath: parsed.oldPath, ...(parsed.force === undefined ? {} : { force: parsed.force }) }
        return getCommitDiff(runner, await requireRepository(runner, tracked), wanted)
      })
  }
}

function createSyncHandlers(deps: GitHandlerDeps, guarded: Guarded, writes: Writes): Pick<GitHandlers, 'fetch' | 'pull' | 'push' | 'cancelOperation'> {
  const { registry, clones } = deps
  const sync = createSync({ runner: deps.runner, session: deps.session, onProgress: deps.onProgress })
  const operation = (name: SyncOperation): GitHandlers['fetch'] => (folder, request) =>
    guarded(async () => {
      const tracked = requireTracked(registry, folder)
      const { operationId } = invalid(syncRequestSchema, request, 'request')
      return writes.locked(tracked, () => sync.run(name, tracked, operationId))
    })
  return {
    fetch: operation('fetch'),
    pull: operation('pull'),
    push: operation('push'),
    cancelOperation: (folder, operationId) =>
      guarded(async () => {
        const clone = cancelClone(clones, registry, folder, operationId)
        if (clone !== null) {
          return clone
        }
        const tracked = requireTracked(registry, folder)
        return { cancelled: sync.cancel(tracked, invalid(operationIdSchema, operationId, 'operation id')) }
      })
  }
}

/**
 * A cancel aimed at a clone, which runs in its parent folder and need not be tracked: true once one is stopped, false
 * for an untracked clone parent with nothing left running; null when this is not about a clone.
 */
function cancelClone(clones: Cloner | undefined, registry: Pick<FolderRegistry, 'resolve'>, folder: unknown, operationId: unknown): { cancelled: boolean } | null {
  if (clones === undefined || typeof folder !== 'string') {
    return null
  }
  if (typeof operationId === 'string' && clones.cancel(folder, operationId)) {
    return { cancelled: true }
  }
  if (folder === clones.getParent() && registry.resolve(folder) === null) {
    invalid(operationIdSchema, operationId, 'operation id')
    return { cancelled: false }
  }
  return null
}

function createCloneHandlers(clones: Cloner | undefined, guarded: Guarded): Pick<GitHandlers, 'getCloneParent' | 'chooseCloneParent' | 'clone'> {
  const cloner = (): Cloner => {
    if (clones === undefined) {
      throw new Refusal({ code: 'git_failed', message: 'Cloning is not available here.' })
    }
    return clones
  }
  return {
    getCloneParent: () => guarded(async () => cloner().getParent()),
    chooseCloneParent: () => guarded(() => cloner().chooseParent()),
    clone: (request) => guarded(() => cloner().clone(invalid(cloneRequestSchema, request, 'request')))
  }
}

type BranchMethod =
  | 'listBranches'
  | 'checkBranchName'
  | 'createBranch'
  | 'switchBranch'
  | 'renameBranch'
  | 'deleteBranch'
  | 'mergeIntoCurrent'
  | 'listStashes'
  | 'restoreStash'
  | 'discardStash'

type WithRequest = <R, T>(
  schema: z.ZodType<R>,
  what: string,
  work: (tracked: string, request: R) => Promise<T>
) => (folder: unknown, request: unknown) => Promise<GitResult<T>>

/** A handler of a tracked folder and one request, validated against `schema`. */
function requestHandlers(registry: Pick<FolderRegistry, 'resolve'>, guarded: Guarded): WithRequest {
  return (schema, what, work) => (folder, request) =>
    guarded(async () => {
      const tracked = requireTracked(registry, folder)
      return work(tracked, invalid(schema, request, what))
    })
}

type WithFolder = <T>(work: (tracked: string) => Promise<T>) => (folder: unknown) => Promise<GitResult<T>>

/** For the handlers that change a repository: each one's work holds its operation lock, from its first read to its last write. */
interface Writes {
  locked: Locked
  /** `requestHandlers`, locked. */
  request: WithRequest
  /** A handler of a tracked folder alone, locked. */
  folder: WithFolder
}

function createWrites(registry: Pick<FolderRegistry, 'resolve'>, runner: GitRunner, guarded: Guarded): Writes {
  const locks = createOperationLocks(runner)
  const locked: Locked = (folder, work) => locks.run(folder, work)
  const withRequest = requestHandlers(registry, guarded)
  return {
    locked,
    request: (schema, what, work) => withRequest(schema, what, (tracked, request) => locked(tracked, () => work(tracked, request))),
    folder: (work) => (folder) =>
      guarded(() => {
        const tracked = requireTracked(registry, folder)
        return locked(tracked, () => work(tracked))
      })
  }
}

function createBranchHandlers(deps: GitHandlerDeps, guarded: Guarded, writes: Writes): Pick<GitHandlers, BranchMethod> {
  const { registry, runner, session } = deps
  const withRequest = requestHandlers(registry, guarded)
  return {
    listBranches: (folder) => guarded(() => listBranches(runner, requireTracked(registry, folder))),
    checkBranchName: withRequest(branchNameSchema, 'branch name', (tracked, name) => checkBranchName(runner, tracked, name)),
    createBranch: writes.request(createBranchSchema, 'request', (tracked, request) => createBranch(runner, tracked, request)),
    switchBranch: writes.request(switchBranchSchema, 'request', (tracked, request) => switchBranch(runner, tracked, request)),
    renameBranch: writes.request(renameBranchSchema, 'request', (tracked, request) => renameBranch(runner, tracked, request)),
    deleteBranch: writes.request(deleteBranchSchema, 'request', (tracked, request) => deleteBranch({ runner, session }, tracked, request)),
    mergeIntoCurrent: writes.request(mergeBranchSchema, 'request', (tracked, request) => mergeIntoCurrent(runner, tracked, request)),
    listStashes: (folder) => guarded(() => listStashes(runner, requireTracked(registry, folder))),
    restoreStash: writes.request(stashRefSchema, 'stash', (tracked, ref) => restoreStash(runner, tracked, ref)),
    discardStash: writes.request(stashRefSchema, 'stash', (tracked, ref) => discardStash(runner, tracked, ref))
  }
}

type ConflictMethod = 'getConflicts' | 'resolveWith' | 'markResolved' | 'abortMerge' | 'commitMerge' | 'abortOperation' | 'openInEditor'

function createConflictHandlers(deps: GitHandlerDeps, guarded: Guarded, writes: Writes): Pick<GitHandlers, ConflictMethod> {
  const { registry, runner } = deps
  const withRequest = requestHandlers(registry, guarded)
  return {
    getConflicts: (folder) => guarded(() => getConflicts(runner, requireTracked(registry, folder))),
    resolveWith: writes.request(resolveSchema, 'request', (tracked, request) => resolveWith(runner, tracked, request)),
    markResolved: writes.request(markResolvedSchema, 'request', (tracked, request) => markResolved(runner, tracked, request)),
    abortMerge: writes.folder((tracked) => abortMerge(runner, tracked)),
    commitMerge: writes.request(commitMergeSchema, 'request', (tracked, request) => commitMerge(runner, tracked, request)),
    abortOperation: writes.folder((tracked) => abortOperation(runner, tracked)),
    openInEditor: withRequest(pathSchema, 'path', (tracked, path) => openInEditor(runner, tracked, path, { openPath: deps.openPath }))
  }
}

type PullRequestMethod = 'getPullRequests' | 'checkoutPullRequest' | 'getCompareUrl' | 'getCommitUrl'

function createPullRequestHandlers(deps: GitHandlerDeps, guarded: Guarded, writes: Writes): Pick<GitHandlers, PullRequestMethod> {
  const { registry, runner } = deps
  const pullRequests = createPullRequests({ runner, session: deps.session, client: deps.client })
  const withRequest = requestHandlers(registry, guarded)
  return {
    getPullRequests: withRequest(pullRequestsSchema, 'request', (tracked, request) => pullRequests.get(tracked, request?.refresh === true)),
    checkoutPullRequest: writes.request(checkoutPullRequestSchema, 'request', (tracked, request) => pullRequests.checkout(tracked, request)),
    getCompareUrl: (folder) => guarded(() => pullRequests.compareUrl(requireTracked(registry, folder))),
    getCommitUrl: withRequest(oidSchema, 'commit id', (tracked, oid) => pullRequests.commitUrl(tracked, oid))
  }
}

export function createGitHandlers(deps: GitHandlerDeps): GitHandlers {
  const { registry, runner } = deps

  async function guarded<T>(work: () => Promise<T>): Promise<GitResult<T>> {
    try {
      return { ok: true, data: await work() }
    } catch (error) {
      return report(error, deps.onUnexpectedError)
    }
  }
  const writes = createWrites(registry, runner, guarded)

  return {
    getState: (folder) => guarded(() => readRepoState(runner, requireTracked(registry, folder))),
    getWorkingDiff: (folder, request) =>
      guarded(async () => {
        const tracked = requireTracked(registry, folder)
        const parsed = parseDiffRequest(request)
        const { root, change } = await requireChange(runner, tracked, parsed.path)
        return readWorkingDiff(runner, root, change, parsed.force === undefined ? {} : { force: parsed.force })
      }),
    initRepository: (folder) => guarded(() => initFolder(runner, requireTracked(registry, folder))),
    commit: (folder, request) =>
      guarded(async () => {
        const tracked = requireTracked(registry, folder)
        const parsed: CommitRequest = invalid(commitRequestSchema, request, 'request')
        return writes.locked(tracked, () => commitFiles(runner, tracked, parsed))
      }),
    undoLastCommit: writes.folder((tracked) => undoLastCommit(runner, tracked)),
    discardChanges: (folder, request) =>
      guarded(async () => {
        const tracked = requireTracked(registry, folder)
        const parsed: DiscardRequest = invalid(discardRequestSchema, request, 'request')
        return writes.locked(tracked, () => discardFiles(runner, tracked, parsed, deps.trashItem))
      }),
    ...createHistoryHandlers(registry, runner, guarded),
    ...createSyncHandlers(deps, guarded, writes),
    ...createCloneHandlers(deps.clones, guarded),
    ...createBranchHandlers(deps, guarded, writes),
    ...createConflictHandlers(deps, guarded, writes),
    ...createPullRequestHandlers(deps, guarded, writes)
  }
}
