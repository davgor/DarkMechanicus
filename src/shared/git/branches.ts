/** Branch and stash types shared by main and the renderer. Renderer-safe: no Node imports. */
import type { CommitFile } from './history'

export interface BranchInfo {
  /** `feature/x` for a local branch, `origin/feature/x` for a remote-tracking one. */
  name: string
  kind: 'local' | 'remote'
  /** The remote of a remote-tracking branch; null for a local one. */
  remote: string | null
  /** A local branch's upstream (`origin/main`); null without one, and for a remote-tracking branch. */
  upstream: string | null
  ahead: number
  behind: number
  /** The committer date of the branch's tip, ISO 8601. */
  lastCommitAt: string
  isCurrent: boolean
}

export interface BranchList {
  /** Null when HEAD is detached. */
  current: string | null
  /** The remote's default branch (`refs/remotes/<remote>/HEAD`), else `main` or `master` when one exists. */
  defaultBranch: string | null
  branches: BranchInfo[]
}

export interface StashInfo {
  /** `stash@{n}`. */
  ref: string
  /** The branch it was stashed from. */
  branch: string
  /** ISO 8601. */
  createdAt: string
  files: CommitFile[]
}

export interface BranchNameCheck {
  valid: boolean
  /** The name git would use; null when it is not valid. */
  normalized: string | null
}

export interface CreateBranchRequest {
  name: string
  /** `current`: at HEAD. `default`: at the default branch. Uncommitted changes come along either way. */
  startPoint: 'current' | 'default'
}

export interface SwitchBranchRequest {
  /** A local branch, or a remote-tracking one (`origin/x`, or `x` when only a remote has it), checked out as a tracking branch. */
  name: string
  /** `stash`: put the changes in a `dm-stash:<current branch>` stash first. `bring`: take them along, or change nothing if git refuses. */
  uncommitted: 'stash' | 'bring'
}

export interface RenameBranchRequest {
  from: string
  to: string
}

export interface DeleteBranchRequest {
  name: string
  /** Also delete the branch's upstream on its remote, with the account's credentials. */
  deleteRemote: boolean
  /** Delete even if it is not merged. */
  force: boolean
}

export interface MergeBranchRequest {
  /** A local or remote-tracking branch to merge into the current one. */
  branch: string
}
