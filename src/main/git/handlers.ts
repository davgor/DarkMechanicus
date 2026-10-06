/**
 * The behavior behind the `git:*` IPC channels, as a pure factory over injected dependencies (no
 * Electron imports). Every argument arrives from the renderer and is untrusted: it is validated
 * here, the folder must be tracked, and paths must stay inside the repository. Nothing throws.
 */
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import type { CommitMessage, CommitRequest, DiscardRequest, GitErrorShape, GitResult, WorkingDiffRequest } from '../../shared/git/api'
import type { FileDiff } from '../../shared/git/diff'
import type { CommitDiffRequest, CommitFile, HistoryPage, HistoryRequest } from '../../shared/git/history'
import type { RepoState } from '../../shared/git/status'
import type { FolderRegistry } from '../desktop/folderRegistry'
import { pathArgs } from './args'
import { commitFiles, undoLastCommit } from './commit'
import { discardFiles, type TrashItem } from './discard'
import { readWorkingDiff } from './diff'
import { GitError, GitInputError } from './errors'
import { getCommitDiff, getCommitFiles, getHistory, MAX_HISTORY_LIMIT } from './history'
import type { GitRunner } from './runner'
import { readRepoState } from './status'

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
  files: z.array(z.strictObject({ path: pathSchema, oldPath: pathSchema.nullable() })).max(100_000)
})
const discardRequestSchema = z.strictObject({
  files: z.array(z.strictObject({ path: pathSchema, oldPath: pathSchema.nullable(), kind: z.enum(FILE_KINDS) })).max(100_000)
})

const oidSchema = z.string().regex(/^[0-9a-fA-F]{4,64}$/, 'A commit id is 4 to 64 hexadecimal characters.')
const historyRequestSchema = z.strictObject({ skip: z.number().int().min(0), limit: z.number().int().min(1).max(MAX_HISTORY_LIMIT) })
const commitDiffRequestSchema = z.strictObject({ oid: oidSchema, path: pathSchema, oldPath: pathSchema.nullable(), force: z.boolean().optional() })

interface GitHandlerDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  runner: GitRunner
  /** Told about failures that are not GitErrors (bugs, I/O), so main can log the stack. */
  /** Moves a file to the OS trash (Electron's shell.trashItem). */
  trashItem: TrashItem
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
  try {
    onUnexpectedError(error)
  } catch {
    // A failing logger must not turn a result into a thrown error.
  }
  return { ok: false, error: { code: 'git_failed', message: 'Git failed unexpectedly.' } }
}

/** The repository root of a tracked folder, or the GitError that says why it has none. */
async function requireRepository(runner: GitRunner, folder: string): Promise<string> {
  const state = await readRepoState(runner, folder)
  if (state.kind === 'git_missing') {
    throw new GitError('git_not_found', '')
  }
  if (state.kind === 'not_repository') {
    throw new GitError('not_repository', '', 'That folder is not a Git repository.')
  }
  return state.status.root
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

export function createGitHandlers(deps: GitHandlerDeps): GitHandlers {
  const { registry, runner } = deps

  async function guarded<T>(work: () => Promise<T>): Promise<GitResult<T>> {
    try {
      return { ok: true, data: await work() }
    } catch (error) {
      return report(error, deps.onUnexpectedError)
    }
  }

  return {
    getState: (folder) => guarded(() => readRepoState(runner, requireTracked(registry, folder))),
    getWorkingDiff: (folder, request) =>
      guarded(async () => {
        const tracked = requireTracked(registry, folder)
        const parsed = parseDiffRequest(request)
        const root = await requireRepository(runner, tracked)
        const change = { path: parsed.path, oldPath: parsed.oldPath, kind: parsed.kind }
        return readWorkingDiff(runner, root, change, parsed.force === undefined ? {} : { force: parsed.force })
      }),
    initRepository: (folder) => guarded(() => initFolder(runner, requireTracked(registry, folder))),
    commit: (folder, request) =>
      guarded(async () => {
        const tracked = requireTracked(registry, folder)
        const parsed: CommitRequest = invalid(commitRequestSchema, request, 'request')
        return commitFiles(runner, tracked, parsed)
      }),
    undoLastCommit: (folder) => guarded(() => undoLastCommit(runner, requireTracked(registry, folder))),
    discardChanges: (folder, request) =>
      guarded(async () => {
        const tracked = requireTracked(registry, folder)
        const parsed: DiscardRequest = invalid(discardRequestSchema, request, 'request')
        return discardFiles(runner, tracked, parsed, deps.trashItem)
      }),
    ...createHistoryHandlers(registry, runner, guarded)
  }
}
