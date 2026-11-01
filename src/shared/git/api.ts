/** The `window.git` contract between the renderer and main. Renderer-safe: no Node imports. */
import type {
  BranchList,
  BranchNameCheck,
  CreateBranchRequest,
  DeleteBranchRequest,
  MergeBranchRequest,
  RenameBranchRequest,
  StashInfo,
  SwitchBranchRequest
} from './branches'
import type { CommitMergeRequest, ConflictState, MarkResolvedRequest, ResolveRequest } from './conflicts'
import type { FileDiff } from './diff'
import type { GitErrorCode } from './errors'
import type { CommitDiffRequest, CommitFile, HistoryPage, HistoryRequest } from './history'
import type { FileChange, FileChangeKind, RepoState } from './status'
import type { GithubErrorCode } from '../github/errors'
import type { CheckoutPullRequestRequest, CompareUrl, PullRequestInfo, PullRequestsRequest } from '../github/pullRequests'
import type { TrackedFolderView } from '../desktop/api'

type GitResultErrorCode = GitErrorCode | GithubErrorCode | 'invalid_input' | 'unauthorized'

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

/** Names a network operation, so the renderer can match its progress events and cancel it. */
interface SyncRequest {
  operationId: string
}

/**
 * A clone: the URL (`https://…`, `ssh://…`, `git@host:path` or GitHub's `owner/repo`) and the new folder's name.
 * The folder it goes into is always the one chosen with `chooseCloneParent`; the renderer cannot name another.
 */
export interface CloneRequest extends SyncRequest {
  url: string
  name: string
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
  /**
   * Each file is committed whole, or only the changed `lines` (`changedLineIndices` numbering) of the diff whose
   * hash is `diffHash`; a file whose diff changed since fails `stale_selection` and nothing is committed.
   */
  files: Array<{ path: string; oldPath: string | null; lines?: number[]; diffHash?: string }>
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
  /** Fetches (with prune) from the sync remote: the upstream's remote, else `origin`. Returns the new state. */
  fetch(folder: string, request: SyncRequest): Promise<GitResult<RepoState>>
  /** Merges (never rebases) the upstream branch into the current one. A conflict fails `merge_conflicts`. */
  pull(folder: string, request: SyncRequest): Promise<GitResult<RepoState>>
  /** Pushes the current branch, publishing it with an upstream when it has none. Never forces. */
  push(folder: string, request: SyncRequest): Promise<GitResult<RepoState>>
  /** Stops the running operation with this id, which then fails `cancelled`; false when none was running. */
  cancelOperation(folder: string, operationId: string): Promise<GitResult<{ cancelled: boolean }>>
  /** The folder clones go into, as `chooseCloneParent` stored it; null until one is chosen. */
  getCloneParent(): Promise<GitResult<string | null>>
  /** Asks for the folder clones go into with the native folder dialog and keeps it; null (and no change) when dismissed. */
  chooseCloneParent(): Promise<GitResult<string | null>>
  /**
   * Clones into `<clone parent>/<name>`, which must not exist or be an empty folder (`target_exists` otherwise), and
   * tracks the new folder. Progress events carry the clone parent as their folder, and `cancelOperation(parent,
   * operationId)` stops it. On cancel or failure, a folder the clone made is removed; one that was there is kept.
   */
  clone(request: CloneRequest): Promise<GitResult<TrackedFolderView>>
  /** Local and remote-tracking branches, the current one and the default one. */
  listBranches(folder: string): Promise<GitResult<BranchList>>
  /** Whether git accepts `name` as a branch name as written, for validating while the person types. */
  checkBranchName(folder: string, name: string): Promise<GitResult<BranchNameCheck>>
  /** Creates a branch at HEAD or at the default branch and switches to it; changes come along. `branch_exists` if taken. */
  createBranch(folder: string, request: CreateBranchRequest): Promise<GitResult<RepoState>>
  /**
   * Switches branch, stashing changes as `dm-stash:<branch>` or bringing them along (`local_changes_would_be_overwritten`
   * when git refuses, and nothing changes). A remote-only branch becomes a local tracking branch. Never pops a stash.
   */
  switchBranch(folder: string, request: SwitchBranchRequest): Promise<GitResult<RepoState>>
  renameBranch(folder: string, request: RenameBranchRequest): Promise<GitResult<RepoState>>
  /** Deletes a branch other than the current one, and optionally its upstream on its remote. `branch_not_fully_merged` unless forced. */
  deleteBranch(folder: string, request: DeleteBranchRequest): Promise<GitResult<RepoState>>
  /** Merges a branch into the current one; a conflict fails `merge_conflicts` and leaves the merge in progress. */
  mergeIntoCurrent(folder: string, request: MergeBranchRequest): Promise<GitResult<RepoState>>
  /** The current branch's `dm-stash:` stashes, newest first, with their files. */
  listStashes(folder: string): Promise<GitResult<StashInfo[]>>
  /** Pops a DM stash; a conflict fails `merge_conflicts` and the stash is kept. */
  restoreStash(folder: string, ref: string): Promise<GitResult<RepoState>>
  discardStash(folder: string, ref: string): Promise<GitResult<RepoState>>
  /** The unmerged files (with their kind and conflict marker count) and the names of both sides. */
  getConflicts(folder: string): Promise<GitResult<ConflictState>>
  /** Takes our or their version of a conflicted file and stages it, deleting it when that side deleted it. */
  resolveWith(folder: string, request: ResolveRequest): Promise<GitResult<RepoState>>
  /** Stages a conflicted file resolved by hand; `conflict_markers_remain` while it still has markers. */
  markResolved(folder: string, request: MarkResolvedRequest): Promise<GitResult<RepoState>>
  /** `git merge --abort`: back to the state from before the merge. */
  abortMerge(folder: string): Promise<GitResult<RepoState>>
  /** Makes the merge commit (git's message unless a summary is given); `merge_conflicts` while a file is unresolved. */
  commitMerge(folder: string, request: CommitMergeRequest): Promise<GitResult<{ oid: string }>>
  /** Aborts a rebase, `git am`, cherry-pick or revert in progress. */
  abortOperation(folder: string): Promise<GitResult<RepoState>>
  /** Opens a conflicted file of the repository in the default app. */
  openInEditor(folder: string, path: string): Promise<GitResult<null>>
  /**
   * The open pull requests (up to 300) of the GitHub repository of the upstream's remote, else `origin`, and the
   * current branch's one; none for a repository not on GitHub, `auth_required` signed out. Cached 60 s per folder.
   */
  getPullRequests(folder: string, request?: PullRequestsRequest): Promise<GitResult<PullRequestInfo>>
  /**
   * Checks out a pull request with the switch rules for uncommitted changes: one from this repository as the local
   * branch tracking its head, any other as `pr/<n>` (fast-forwarded; `rejected_non_fast_forward` when rewritten).
   */
  checkoutPullRequest(folder: string, request: CheckoutPullRequestRequest): Promise<GitResult<RepoState>>
  /** GitHub's Create pull request page for the current branch against the default one, or `needs_push`. */
  getCompareUrl(folder: string): Promise<GitResult<CompareUrl>>
  /** `https://github.com/<owner>/<repo>/commit/<oid>`; `invalid_input` for a repository not on GitHub. */
  getCommitUrl(folder: string, oid: string): Promise<GitResult<string>>
  /** Subscribes to progress of long operations; returns the unsubscribe function. */
  onProgress(listener: (event: GitProgressEvent) => void): () => void
}
