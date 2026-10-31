import { join, resolve } from 'node:path'
import { ancestorsOf, canonical } from './discovery'
import type { FsAdapter } from './types'

/** Orders strings by Unicode code point (not UTF-16 code unit, which misorders astral characters). */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a)
  const right = Array.from(b)
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index].codePointAt(0) ?? 0) - (right[index].codePointAt(0) ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return left.length - right.length
}

/**
 * Names of the immediate children of `root` that are real directories (not symlinks) holding a
 * `.git` entry — a directory, or a file for a worktree or submodule checkout. Hidden names (a
 * leading `.`) are skipped and nothing below one level is examined. Sorted by code point.
 */
export function detectChildRepos(
  root: string,
  fs: Pick<FsAdapter, 'readdir' | 'isSymlink' | 'isDirectory' | 'exists'>
): string[] {
  return fs
    .readdir(root)
    .filter((name) => {
      if (name.startsWith('.')) {
        return false
      }
      const child = join(root, name)
      return !fs.isSymlink(child) && fs.isDirectory(child) && fs.exists(join(child, '.git'))
    })
    .sort(compareCodePoints)
}

/** Whether `root` or any ancestor (bounded walk, as in `findRepositoryRoot`) holds a `.git` entry. */
export function isInsideGitRepository(root: string, fs: Pick<FsAdapter, 'exists' | 'realpath'>): boolean {
  return ancestorsOf(canonical(fs, resolve(root))).some((dir) => fs.exists(join(dir, '.git')))
}
