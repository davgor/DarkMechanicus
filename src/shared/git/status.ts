/** Repository state as Source control shows it. Renderer-safe: no Node imports. */
export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted'

export interface FileChange {
  path: string
  oldPath: string | null
  kind: FileChangeKind
}

interface BranchState {
  /** Null when HEAD is detached. */
  name: string | null
  /** Null on an unborn branch. */
  headOid: string | null
  upstream: string | null
  ahead: number
  behind: number
}

type OperationInProgress = 'merge' | 'rebase' | 'am' | 'cherry-pick' | 'revert' | null

export interface RepoStatus {
  root: string
  branch: BranchState
  files: FileChange[]
  inProgress: OperationInProgress
  /** When the repository last fetched (the modification time of FETCH_HEAD, ISO 8601), or null if it never has. */
  lastFetchedAt: string | null
  /** The remote fetch and pull use (the upstream's, else `origin`), or null when there is neither. */
  remote: SyncRemoteView | null
}

interface SyncRemoteView {
  name: string
  /** Its fetch URL is `https://github.com/…`, so the signed-in account's credentials apply and nothing else prompts. */
  githubHttps: boolean
}

export type RepoState = { kind: 'repository'; status: RepoStatus } | { kind: 'not_repository' } | { kind: 'git_missing' }
