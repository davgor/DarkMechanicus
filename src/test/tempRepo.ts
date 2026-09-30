/** Unique on-disk temp repositories for repository-layer tests. Not shipped. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLayout } from '../core/repo/layout'
import type { RepoLayout } from '../core/repo/types'

export interface TempRepo {
  /** Canonical base directory holding `repo/` and `outside/`. */
  base: string
  root: string
  /** A sibling directory outside the repository, for escape attempts. */
  outside: string
  layout: RepoLayout
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
    cleanup: () => rmSync(base, { recursive: true, force: true })
  }
}

/** Directory link that needs no privileges: a junction on Windows, a symlink elsewhere. */
export function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, 'junction')
}
