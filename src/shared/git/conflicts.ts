/** Merge conflicts as the Conflicts view shows them. Renderer-safe: no Node imports. */
export type ConflictKind =
  | 'both_modified'
  | 'both_added'
  | 'deleted_by_us'
  | 'deleted_by_them'
  | 'both_deleted'
  | 'added_by_us'
  | 'added_by_them'

export interface ConflictFile {
  path: string
  kind: ConflictKind
  /** Lines starting with `<<<<<<< ` in the working file; 0 when the file is missing. */
  markers: number
}

export interface ConflictState {
  /** The current branch; null when HEAD is detached. */
  ourBranch: string | null
  /** What is being merged in, from the first line of MERGE_MSG; null when there is none (a stash restore). */
  theirLabel: string | null
  /** The unmerged files, by path. */
  files: ConflictFile[]
}

export interface ResolveRequest {
  path: string
  side: 'ours' | 'theirs'
}

export interface MarkResolvedRequest {
  path: string
}

/** Without a summary the merge commit takes git's prepared message (MERGE_MSG). */
export interface CommitMergeRequest {
  summary?: string
  description?: string
}
