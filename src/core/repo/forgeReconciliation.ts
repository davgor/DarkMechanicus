import { dirname, join } from 'node:path'
import type { Clock } from '../clock'
import type { Db } from '../db/database'
import { exportMigrationRecords } from './migrationExport'
import { assertContained, ownedPaths } from './paths'
import type { FsAdapter, RepoLayout } from './types'

interface SyncRow {
  kind: string; entity_id: string; exported_hash: string | null; imported_hash: string | null
  generation: number; conflict: string | null; updated_at: string
}

/** Build a complete, disposable reconciliation input. Existing source bytes always win,
 * including malformed/conflicting records; only absent files come from the owned database. */
export function prepareForgeReconciliation(env: { db: Db; fs: FsAdapter; source: RepoLayout; staging: RepoLayout; clock: Clock }): void {
  const { db, fs, source, staging, clock } = env
  const prior = db.all<SyncRow>('SELECT * FROM sync_state')
  exportMigrationRecords({ db, fs, layout: staging, clock })
  const paths = ownedPaths(source)
  function existing(row: SyncRow): boolean {
    let files: string[]
    switch (row.kind) {
      case 'epic': files = [paths.epicPointerFile(row.entity_id), paths.epicStateFile(row.entity_id)]; break
      case 'run': files = [paths.runHistoryFile(row.entity_id)]; break
      case 'kanban_card': files = [paths.kanbanCardFile(row.entity_id)]; break
      case 'profile': files = [paths.profileFile(row.entity_id)]; break
      default: return true // Immutable records are compared against their stored payload as well.
    }
    return files.every(file => fs.exists(file) || fs.isSymlink(file))
  }
  for (const row of prior.filter(existing)) {
    db.run(`INSERT OR REPLACE INTO sync_state (kind, entity_id, exported_hash, imported_hash, generation, conflict, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, row.kind, row.entity_id, row.exported_hash, row.imported_hash, row.generation, row.conflict, row.updated_at)
  }
  function copy(from: string, to: string): void {
    assertContained(source, fs, from)
    assertContained(staging, fs, to)
    if (fs.isDirectory(from)) {
      fs.mkdirp(to)
      for (const name of fs.readdir(from)) copy(join(from, name), join(to, name))
    } else {
      fs.mkdirp(dirname(to))
      fs.writeFileBytes(to, fs.readFileBytes(from))
    }
  }
  for (const name of fs.readdir(source.dmDir).filter(name => !['local', '.gitignore', 'project.json'].includes(name))) {
    copy(join(source.dmDir, name), join(staging.dmDir, name))
  }
}
