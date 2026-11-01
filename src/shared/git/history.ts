/** Commit history types shared by main and the renderer. Renderer-safe: no Node imports. */
import type { FileChangeKind } from './status'

export interface CommitSummary {
  oid: string
  shortOid: string
  parents: string[]
  authorName: string
  authorEmail: string
  /** ISO 8601. */
  authoredAt: string
  summary: string
  body: string
  /** The commit is reachable from HEAD but from no remote-tracking branch. */
  unpushed: boolean
}

export interface CommitFile {
  path: string
  oldPath: string | null
  kind: FileChangeKind
}

export interface HistoryRequest {
  skip: number
  limit: number
}

export interface HistoryPage {
  commits: CommitSummary[]
  hasMore: boolean
}

export interface CommitDiffRequest {
  oid: string
  path: string
  oldPath: string | null
  force?: boolean
}

