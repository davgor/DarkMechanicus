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

type OperationInProgress = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

export interface RepoStatus {
  root: string
  branch: BranchState
  files: FileChange[]
  inProgress: OperationInProgress
}

export type RepoState = { kind: 'repository'; status: RepoStatus } | { kind: 'not_repository' } | { kind: 'git_missing' }
