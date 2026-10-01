import { dirname, join, resolve } from 'node:path'
import type { Clock } from '../clock'
import type { Db } from '../db/database'
import { fail } from '../errors'
import type { FsAdapter, RepoLayout } from './types'

/**
 * Consistent backup of the live database with `VACUUM INTO` (never a raw copy of a WAL database).
 * Defaults to `.darkmechanicus/local/backups/state-<timestamp>.sqlite`; never overwrites a file.
 */
export function backupDatabase(
  deps: { db: Db; layout: RepoLayout; fs: FsAdapter; clock: Clock },
  targetPath?: string
): { path: string } {
  const stamp = deps.clock.nowIso().replace(/:/g, '-')
  const target = resolve(targetPath ?? join(deps.layout.localDir, 'backups', `state-${stamp}.sqlite`))
  if (deps.db.inTransaction()) {
    fail('internal', 'A backup cannot run inside a transaction.')
  }
  if (deps.fs.exists(target) || deps.fs.isSymlink(target)) {
    fail('conflict', `Backup target ${target} already exists; choose another path.`, { path: target })
  }
  deps.fs.mkdirp(dirname(target))
  deps.db.run('VACUUM INTO ?', target)
  return { path: target }
}
