/** The `window.git` contract between the renderer and main. Renderer-safe: no Node imports. */
import type { FileDiff } from './diff'
import type { GitErrorCode } from './errors'
import type { CommitDiffRequest, CommitFile, HistoryPage, HistoryRequest } from './history'
import type { FileChange, FileChangeKind, RepoState } from './status'

type GitResultErrorCode = GitErrorCode | 'invalid_input' | 'unauthorized'

export interface GitErrorShape {
  code: GitResultErrorCode
  message: string
  detail?: string
}

export type GitResult<T> = { ok: true; data: T } | { ok: false; error: GitErrorShape }

export interface GitProgressEvent {
  folder: string
  operationId: string
  operation: string
  phase: string
  percent: number | null
}

export interface WorkingDiffRequest {
  path: string
  oldPath: string | null
  kind: FileChangeKind
  force?: boolean
}

export interface CommitRequest {
  summary: string
  description: string
  files: Array<{ path: string; oldPath: string | null }>
}

export interface DiscardRequest {
  files: FileChange[]
}

export interface CommitMessage {
  summary: string
  description: string
}

export const GIT_PROGRESS_CHANNEL = 'git:progress'

export interface GitApi {
  getState(folder: string): Promise<GitResult<RepoState>>
  getWorkingDiff(folder: string, request: WorkingDiffRequest): Promise<GitResult<FileDiff>>
  initRepository(folder: string): Promise<GitResult<RepoState>>
  /** Commits exactly the chosen files (whatever else is staged is left out). */
  commit(folder: string, request: CommitRequest): Promise<GitResult<{ oid: string }>>
  /** Undoes the last commit if it is unpushed and not a merge; the changes return to the working tree. */
  undoLastCommit(folder: string): Promise<GitResult<CommitMessage>>
  /** Moves the discarded content to the OS trash, then restores each file to HEAD (or removes it when new). */
  discardChanges(folder: string, request: DiscardRequest): Promise<GitResult<RepoState>>
  /** The current branch's commits, newest first, `limit` (at most 200) at a time. */
  getHistory(folder: string, request: HistoryRequest): Promise<GitResult<HistoryPage>>
  /** The files a commit changed (against its first parent for a merge). */
  getCommitFiles(folder: string, oid: string): Promise<GitResult<CommitFile[]>>
  /** One file's diff in a commit. */
  getCommitDiff(folder: string, request: CommitDiffRequest): Promise<GitResult<FileDiff>>
  /** Subscribes to progress of long operations; returns the unsubscribe function. */
  onProgress(listener: (event: GitProgressEvent) => void): () => void
}
