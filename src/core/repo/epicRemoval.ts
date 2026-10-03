import { basename, join } from 'node:path'
import { fail } from '../errors'
import { assertContained, displayPath, ownedPaths } from './paths'
import type { FsAdapter, RepoLayout } from './types'

interface RemovalEnv {
  layout: RepoLayout
  fs: FsAdapter
}

interface RemovalOrder {
  files: string[]
  /** Deepest first, so each folder is empty by the time it is removed. */
  dirs: string[]
}

/** Collects `dir` and everything below it, checking each path before anything is removed. */
function collectTree(env: RemovalEnv, dir: string, order: RemovalOrder): void {
  assertContained(env.layout, env.fs, dir)
  for (const name of env.fs.readdir(dir)) {
    const child = join(dir, name)
    if (basename(child) !== name) {
      const shown = displayPath(env.layout, dir)
      fail('unsafe_path', `Unsafe repository path ${shown}: "${name}" is not a plain entry name.`, { path: shown })
    }
    assertContained(env.layout, env.fs, child)
    if (env.fs.isDirectory(child)) {
      collectTree(env, child, order)
    } else {
      order.files.push(child)
    }
  }
  order.dirs.push(dir)
}

/**
 * Deletes an epic's folder and its runs' history folders from the checkout (never commits). Every
 * path is checked to be inside `.darkmechanicus/` with no links before the first removal, so an
 * unsafe tree is refused whole. Returns the repository-relative folders that existed.
 */
export function removeEpicFiles(env: RemovalEnv, epicId: string, runIds: string[]): string[] {
  const paths = ownedPaths(env.layout)
  const roots = [paths.epicDir(epicId), ...runIds.map((runId) => paths.runDir(runId))].filter(
    (dir) => env.fs.exists(dir) || env.fs.isSymlink(dir)
  )
  const order: RemovalOrder = { files: [], dirs: [] }
  for (const dir of roots) {
    collectTree(env, dir, order)
  }
  for (const file of order.files) {
    env.fs.remove(file)
  }
  for (const dir of order.dirs) {
    env.fs.removeDir(dir)
  }
  return roots.map((dir) => displayPath(env.layout, dir))
}
