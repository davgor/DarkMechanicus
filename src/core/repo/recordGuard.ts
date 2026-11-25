/**
 * Per-record freshness for a reconcile prepared outside the writer lock.
 *
 * Prepare reads, in one read snapshot, what each planned record's apply depends on in this database (`recordStamp`).
 * Under the lock the reconcile checks those stamps instead of the whole database's revision: a commit by another
 * connection (a sync lane, a finalizer, a command) to an unrelated row leaves the prepared plan valid.
 */
import type { Db } from '../db/database'
import { findOpenTransfer } from '../services/transferGuard'

export type GuardedKind = 'epic' | 'run' | 'comment' | 'profile' | 'kanban_card'

/** A record the reconcile applies (or whose conflict it stores), and the folder a re-prepare reads it from. */
export interface GuardedRecord {
  kind: GuardedKind
  id: string
  /** Event ids of a Kanban card: their sync records and exports belong to the card's stamp. */
  related?: string[]
  folder: 'epics' | 'runs' | 'kanbanCards' | 'profiles'
  folderId: string
}

/** Which `outbox` column names the record's exports. */
const OUTBOX_COLUMN: Record<GuardedKind, string> = {
  epic: 'epic_id', run: 'run_id', comment: 'entity_id', profile: 'entity_id', kanban_card: 'entity_id'
}

/**
 * What the record's planning read from this database: its sync record (hashes, generation, conflict), its exports still
 * waiting, and for an epic its open transfer and pending plan revisions.
 */
export function recordStamp(db: Db, record: GuardedRecord): string {
  const related = JSON.stringify(record.related ?? [])
  const sync = db.all(
    `SELECT kind, entity_id, exported_hash, imported_hash, generation, conflict FROM sync_state
     WHERE (kind = ? AND entity_id = ?) OR (kind = 'kanban_event' AND entity_id IN (SELECT value FROM json_each(?)))
     ORDER BY kind, entity_id`,
    record.kind, record.id, related
  )
  const outbox = db.all(
    `SELECT id, state FROM outbox WHERE state IN ('pending', 'failed')
       AND (${OUTBOX_COLUMN[record.kind]} = ? OR entity_id IN (SELECT value FROM json_each(?))) ORDER BY id`,
    record.id, related
  )
  const epic = record.kind === 'epic'
    ? [findOpenTransfer(db, record.id), db.get("SELECT count(*) AS pending FROM plan_revisions WHERE epic_id = ? AND state = 'pending'", record.id)]
    : []
  return JSON.stringify([sync, outbox, epic])
}

/** The records' stamps, read in the caller's snapshot (the one prepare planned in). */
export function stampRecords(db: Db, records: GuardedRecord[]): string[] {
  return records.map((record) => recordStamp(db, record))
}

/** Under the lock: whether every record still has the stamp prepare read. */
export function stampsHold(db: Db, records: GuardedRecord[], stamps: string[]): boolean {
  return records.every((record, index) => recordStamp(db, record) === stamps[index])
}
