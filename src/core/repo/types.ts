/**
 * Injectable boundaries for repository files and Git. Production implementations live in
 * `nodeFs.ts` and `git.ts`; tests inject fakes (including fault injection) through these types.
 */

/** Synchronous filesystem operations used for repository-owned records. */
export interface FsAdapter {
  exists(path: string): boolean
  readFile(path: string): string
  /** Size in bytes, or -1 when the path does not exist. */
  fileSize(path: string): number
  /**
   * An opaque version of a regular file (size, modification and change times, inode), compared
   * only for equality; null when the path is missing or not a regular file (a link is not followed).
   */
  fileStamp(path: string): string | null
  writeFile(path: string, data: string): void
  fsyncFile(path: string): void
  rename(from: string, to: string): void
  mkdirp(path: string): void
  readdir(path: string): string[]
  realpath(path: string): string
  isSymlink(path: string): boolean
  isDirectory(path: string): boolean
  remove(path: string): void
  /** Removes an empty directory; throws when it is missing or not empty. */
  removeDir(path: string): void
}

export interface GitHead {
  /** Branch name, or null when detached. */
  branch: string | null
  commit: string | null
  detached: boolean
}

export interface GitAdapter {
  /** Reads HEAD without spawning git; null when the root is not a Git checkout. */
  head(): GitHead | null
  /** Uncommitted (modified, added, deleted, untracked) files under `pathspec`; null if git is unavailable. */
  countUncommitted(pathspec: string): Promise<number | null>
  listLocalBranches(): Promise<string[]>
  /** Paths tracked at `ref` under `pathspec` (no checkout switch). */
  listFiles(ref: string, pathspec: string): Promise<string[]>
  /** File contents at `ref`, or null when absent. */
  showFile(ref: string, path: string): Promise<string | null>
  /**
   * Whether `ancestor` is reachable from `descendant` (`git merge-base --is-ancestor`; a commit is its own
   * ancestor). Null when git cannot say: either name is unknown to the repository, or git is unavailable.
   * Read-only.
   */
  isAncestor(ancestor: string, descendant: string): Promise<boolean | null>
  /**
   * The full id of the commit `ref` names and its parents, first parent first (none for a root commit).
   * Null when `ref` names no commit. Read-only.
   */
  commitParents(ref: string): Promise<{ commit: string; parents: string[] } | null>
}

export interface RepoLayout {
  root: string
  dmDir: string
  projectFile: string
  gitignoreFile: string
  epicsDir: string
  historyDir: string
  profilesDir: string
  localDir: string
  dbFile: string
  machineFile: string
}
