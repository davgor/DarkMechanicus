/** One file's working-tree diff against HEAD. Renderer-safe: no Node imports. */
export interface DiffLine {
  kind: 'context' | 'add' | 'delete'
  /** The line as git printed it, without the marker and the newline; a trailing `\r` stays. */
  text: string
  oldNumber: number | null
  newNumber: number | null
  noNewlineAtEnd: boolean
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

interface DiffBase {
  path: string
  oldPath: string | null
  oldMode: string | null
  newMode: string | null
  /** SHA-1 of the raw diff output; lets a later line selection check that the file still matches. */
  hash: string
}

export type FileDiff =
  | (DiffBase & { kind: 'text'; hunks: DiffHunk[] })
  | (DiffBase & { kind: 'binary' })
  | (DiffBase & { kind: 'too_large'; bytes: number })
  /** A mode-only or rename-only change. */
  | (DiffBase & { kind: 'empty' })
