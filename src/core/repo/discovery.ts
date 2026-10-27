import { dirname, join, resolve } from 'node:path'
import { DM_DIR } from './layout'
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

/**
 * Repository root for `start`: the nearest ancestor holding `.darkmechanicus/project.json`,
 * otherwise the nearest holding `.git` (directory, or file for worktrees), otherwise `start`.
 * Returns the canonical real path.
 */
export function findRepositoryRoot(start: string, fs: FsAdapter): string {
  const origin = resolve(start)
  const chain = ancestorsOf(origin)
  const project = chain.find((dir) => fs.exists(join(dir, DM_DIR, 'project.json')))
  const found = project ?? chain.find((dir) => fs.exists(join(dir, '.git'))) ?? origin
  return fs.realpath(found)
}
