/**
 * Per-record freshness for a reconcile prepared outside the writer lock.
 *
 * Prepare reads, in one read snapshot, what each planned record's apply depends on in this database (`recordStamp`).
 * Each record's own write transaction checks its stamp, the files prepare read for it and HEAD; a commit by another
 * connection (a sync lane, a finalizer, a command) to anything else leaves the record's plan valid.
 */
import { join } from 'node:path'
import type { Db } from '../db/database'
import { findOpenTransfer } from '../services/transferGuard'
import type { TrackedRecords } from './gitChanges'
import type { RepoLayout } from './types'

export type GuardedKind = 'epic' | 'run' | 'comment' | 'profile' | 'kanban_card'

/** A record the reconcile applies (or whose conflict it stores), the folder a re-prepare reads it from, and its files. */
export interface GuardedRecord {
  kind: GuardedKind
  id: string
  /** Event ids of a Kanban card: their sync records and exports belong to the card's stamp. */
  related: string[]
  folder: keyof Pick<TrackedRecords, 'epics' | 'runs' | 'kanbanCards' | 'profiles'>
  folderId: string
  /** Every file of the record starts with this path. */
  path: string
}

/** The guarded record of `kind`; a comment names its epic (`owner`), a Kanban card its event ids (`related`). */
export function guardedRecord(layout: RepoLayout, kind: GuardedKind, id: string, more: { owner?: string; related?: string[] } = {}): GuardedRecord {
  const related = more.related ?? []
  if (kind === 'run') return { kind, id, related, folder: 'runs', folderId: id, path: join(layout.historyDir, id) }
  if (kind === 'profile') return { kind, id, related, folder: 'profiles', folderId: id, path: join(layout.profilesDir, `${id}.json`) }
  if (kind === 'kanban_card') return { kind, id, related, folder: 'kanbanCards', folderId: id, path: join(layout.kanbanDir, id) }
  const epicId = more.owner ?? id
  return { kind, id, related, folder: 'epics', folderId: epicId, path: join(layout.epicsDir, epicId) }
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
  const related = JSON.stringify(record.related)
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

export function recordKey(record: GuardedRecord): string {
  return `${record.kind}:${record.id}`
}

/** The records' stamps, read in the caller's snapshot (the one prepare planned in). */
export function stampRecords(db: Db, records: GuardedRecord[]): Map<string, string> {
  return new Map(records.map((record) => [recordKey(record), recordStamp(db, record)]))
}

/** Whether the record still has the stamp prepare read. */
export function stampHolds(db: Db, record: GuardedRecord, stamps: ReadonlyMap<string, string>): boolean {
  return recordStamp(db, record) === stamps.get(recordKey(record))
}

/** The records a targeted re-prepare reads: the folders of the stale ones. */
export function retryRecords(stale: GuardedRecord[]): TrackedRecords {
  const records: TrackedRecords = {
    epics: new Set(), runs: new Set(), kanbanCards: new Set(), profiles: new Set(), projectObservations: false, recoveredAttachments: false
  }
  for (const record of stale) records[record.folder].add(record.folderId)
  return records
}
