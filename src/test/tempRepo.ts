/** Unique on-disk temp repositories for repository-layer tests. Not shipped. */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLayout } from '../core/repo/layout'
import type { RepoLayout } from '../core/repo/types'
import { removeScratch } from './removeScratch'

export interface TempRepo {
  /** Canonical base directory holding `repo/` and `outside/`. */
  base: string
  root: string
  /** A sibling directory outside the repository, for escape attempts. */
  outside: string
  layout: RepoLayout
  /** Removes `base`, retrying while a process the test killed still holds it (`removeScratch`). */
  cleanup(): void
}

export function createTempRepo(): TempRepo {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-repo-')))
  const root = join(base, 'repo')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  return {
    base,
    root,
    outside,
    layout: resolveLayout(root),
    cleanup: () => {
      removeScratch(base)
    }
  }
}

/** Directory link that needs no privileges: a junction on Windows, a symlink elsewhere. */
export function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, 'junction')
}
