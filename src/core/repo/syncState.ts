/**
 * What this machine knows about its tracked records, from `sync_state` and the outbox: whether a tracked file holds
 * exactly what it last exported or imported, and whether local changes to an epic still wait to be exported. The
 * importer and the finalizer both decide on these, so neither writes over what the other has not seen.
 */
import type { Db } from '../db/database'

/** The tracked hash is the one this machine last exported or imported for the entity. */
export function matchesSync(db: Db, kind: 'epic' | 'run' | 'kanban_card', entityId: string, hash: string): boolean {
  const row = db.get<{ exported_hash: string | null; imported_hash: string | null }>(
    'SELECT exported_hash, imported_hash FROM sync_state WHERE kind = ? AND entity_id = ?',
    kind,
    entityId
  )
  return row !== undefined && (row.exported_hash === hash || row.imported_hash === hash)
}

/** Unexported plan or state changes; a comment or a Kanban record waiting for export never touches those files. */
export function hasPendingEpicChanges(db: Db, epicId: string): boolean {
  const row = db.get<{ pending: number }>(
    `SELECT EXISTS (SELECT 1 FROM outbox WHERE epic_id = ? AND kind NOT IN ('comment', 'kanban_card', 'kanban_event')
           AND state IN ('pending', 'failed'))
         OR EXISTS (SELECT 1 FROM plan_revisions WHERE epic_id = ? AND state = 'pending') AS pending`,
    epicId,
    epicId
  )
  return row?.pending === 1
}
