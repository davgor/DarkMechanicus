import type { StorageMode } from '../../shared/domain/views'

/**
 * Injectable boundaries for repository files and Git. Production implementations live in
 * `nodeFs.ts` and `git.ts`; tests inject fakes (including fault injection) through these types.
 */

/** Synchronous filesystem operations used for repository-owned records. */
export interface FsAdapter {
  exists(path: string): boolean
  readFile(path: string): string
  /** The file's bytes exactly as stored (attachment images; `readFile` decodes text). */
  readFileBytes(path: string): Uint8Array
  /** Size in bytes, or -1 when the path does not exist. */
  fileSize(path: string): number
  /**
   * An opaque version of a regular file (size, modification and change times, device, inode), compared
   * only for equality; null when the path is missing or not a regular file (a link is not followed).
   */
  fileStamp(path: string): string | null
  writeFile(path: string, data: string): void
  writeFileBytes(path: string, data: Uint8Array): void
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

/** One path below `.darkmechanicus/` that git reports as changed. */
export interface GitPathChange {
  /**
   * Git's status code: a `git diff --name-status` letter (`M`, `A`, `D`, `T`), or a `git status --porcelain=v2`
   * code: the `XY` pair of a tracked entry (`.M`, `A.`, `D.`, `UU`, ...), `?` for untracked, `!` for ignored.
   */
  status: string
  /** Relative to `.darkmechanicus/`, with forward slashes; a directory git reports whole ends with `/`. */
  path: string
}

/** Why git could not list changed paths: the folder is in no work tree, or git failed or is unavailable. */
export type GitPathsFailure = 'not_work_tree' | 'git_failed'

export type GitDiffPaths = { ok: true; paths: GitPathChange[] } | { ok: false; reason: GitPathsFailure }

/**
 * `head` is the commit HEAD named when the status was taken (null while HEAD is unborn); `branch` the branch it was on
 * (null when detached). Both come from the same `git status`, so they describe the same moment as `paths`.
 */
export type GitStatusPaths =
  | { ok: true; head: string | null; branch: string | null; paths: GitPathChange[] }
  | { ok: false; reason: GitPathsFailure }

export interface GitAdapter {
  /** A routed checkout can recheck its local mapping before a Git verdict is stored. */
  assertCurrent?(): void
  /** Reads HEAD without spawning git; null when the root is not a Git checkout. */
  head(): GitHead | null
  /**
   * Identity (size, times, file id) of this checkout's index file, read without spawning git; null when the root
   * is not a Git checkout or has no index. Changes whenever git writes the index (stage, commit, checkout, reset).
   */
  indexStamp(): string | null
  /** Uncommitted (modified, added, deleted, untracked) files under `pathspec`; null if git is unavailable. */
  countUncommitted(pathspec: string): Promise<number | null>
  listLocalBranches(): Promise<string[]>
  /** Absolute paths of this repository's worktrees, main checkout first (`git worktree list --porcelain`); empty when git is unavailable. */
  listWorktrees(): Promise<string[]>
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
  /**
   * Paths below `.darkmechanicus/` that differ between commits `from` and `to` (`git diff --name-status --no-renames
   * --relative`, run in that folder, so a project nested in a larger repository works). A rename is a delete plus an add.
   * A typed failure, never a throw, when git fails; throws `unsafe_path` for an option-like ref. Read-only.
   */
  diffPaths(from: string, to: string): Promise<GitDiffPaths>
  /**
   * Paths below `.darkmechanicus/` whose working tree or index differs from HEAD, untracked and ignored files included,
   * with the commit HEAD names at that moment (`git status --porcelain=v2 --branch -uall --ignored=matching`).
   * A typed failure, never a throw. Takes no optional locks, so the index is never written.
   */
  statusPaths(): Promise<GitStatusPaths>
  /**
   * The commit local branch `name` (`refs/heads/<name>`) points at, or null when the repository has no such branch.
   * Asks `git rev-parse`; when git cannot run, reads the ref from the files under `.git` like `head()`. Synchronous,
   * so a database transaction can read it. Throws `unsafe_path` for a name git could read as an option. Read-only.
   */
  branchCommit(name: string): string | null
}

export interface RepoLayout {
  root: string
  /** How this project stores its records (`repo`: in the repository; `db`: in the home directory). */
  mode: StorageMode
  /** What `displayPath` shows owned paths relative to: the repository root, or the project directory. */
  displayBase: string
  dmDir: string
  projectFile: string
  gitignoreFile: string
  epicsDir: string
  historyDir: string
  profilesDir: string
  /** Kanban cards: `kanban/<cardId>/card.json` and one immutable `events/<eventId>.json` per transition. */
  kanbanDir: string
  /** Repository-layer knowledge facts (`**\/*.md`); tracked by Git in `repo` mode (`.gitignore` ignores only `local/`). */
  knowledgeDir: string
  localDir: string
  dbFile: string
  machineFile: string
}
