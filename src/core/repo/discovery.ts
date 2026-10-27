import { dirname, join, resolve } from 'node:path'
import { DM_DIR } from './layout'
import { dbProjectDir } from './storageMode'
import type { FsAdapter } from './types'

/** Deeper than any real directory tree; bounds the walk even on a pathological path. */
const MAX_ANCESTORS = 256

function ancestorsOf(start: string): string[] {
  const chain: string[] = []
  let current = start
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) {
      return chain
    }
    current = parent
  }
  return chain
}

/** The canonical form of `path`, or `path` itself when it cannot be resolved (it may not exist). */
function canonical(fs: FsAdapter, path: string): string {
  try {
    return fs.realpath(path)
  } catch {
    return path
  }
}

/**
 * Whether `dir` is a Dark Mechanicus project, set up either way: records in the repository, or a
 * database-only project for `dir` in the home directory. Both must count, or a session started
 * inside a database-only folder would walk past it to an enclosing Git repository and set *that*
 * one up instead — writing into a checkout the database-only mode promises to leave alone.
 */
function isProjectRoot(fs: FsAdapter, dir: string, homeDir: string): boolean {
  return fs.exists(join(dir, DM_DIR, 'project.json')) || fs.exists(join(dbProjectDir(dir, homeDir), 'project.json'))
}

/**
 * Repository root for `start`: the nearest ancestor that is already a project (either way),
 * otherwise the nearest holding `.git` (directory, or file for worktrees), otherwise `start`.
 * Returns the canonical real path.
 *
 * The walk starts from the canonical `start`, so every ancestor it tests is canonical too and
 * matches the key a database-only project was created under.
 */
export function findRepositoryRoot(start: string, fs: FsAdapter, homeDir: string): string {
  const origin = canonical(fs, resolve(start))
  const chain = ancestorsOf(origin)
  const project = chain.find((dir) => isProjectRoot(fs, dir, homeDir))
  const found = project ?? chain.find((dir) => fs.exists(join(dir, '.git'))) ?? origin
  return fs.realpath(found)
}
