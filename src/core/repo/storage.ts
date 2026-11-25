import { isForgeMember } from './forgeBinding'
import type { StorageStatusView } from '../../shared/domain/views'
import type { Clock } from '../clock'
import type { Db } from '../db/database'
import { readSchemaVersion } from '../db/migrations'
import { getMeta, META_KEYS } from '../meta'
import { summarizeActiveSessions } from '../services/sessions'
import { unimportedEpicRecords } from './finalizer'
import { branchState, EPIC_RECORDS_CONFLICT_PREFIX } from './importer'
import { readProject } from './initialize'
import type { ProjectRecord } from './portable'
import { hasPendingEpicChanges } from './syncState'
import type { FsAdapter, GitAdapter, GitHead, RepoLayout } from './types'

interface StorageDeps {
  db: Db | null
  layout: RepoLayout
  fs: FsAdapter
  git: GitAdapter
  clock: Clock
  /** The workspace's cached record-file status; without one, every call asks git. */
  recordStatus?: RecordStatusCache
}

/** Where the record files a repository-backed project tracks live, relative to the repository root. */
const RECORDS_PATHSPEC = '.darkmechanicus'

interface RecordStatusEntry {
  /** The index stamp, HEAD and last flush the count was taken at. */
  key: string
  count: number | null
}

/**
 * One workspace's last `git status` count of uncommitted record files. The footer polls the storage status often,
 * and each `git status` would otherwise hold the project's command queue, so a call serves this count and refreshes
 * it in the background only once the index, HEAD or the database's last flush changed: idle calls never run git.
 * A flush is how this app writes record files without touching the index, so it is part of the key; an edit made
 * outside the app that leaves the index and HEAD alone shows up at the next stamp change.
 */
export interface RecordStatusCache {
  last: RecordStatusEntry | null
  /** The refresh running now, if any: at most one runs at a time. */
  refreshing: Promise<RecordStatusEntry> | null
}

export function createRecordStatusCache(): RecordStatusCache {
  return { last: null, refreshing: null }
}

function refreshRecordStatus(cache: RecordStatusCache, deps: StorageDeps, key: string): Promise<RecordStatusEntry> {
  if (cache.refreshing !== null) return cache.refreshing
  // Keyed before git runs: a stamp change while it runs makes the next call refresh again.
  const refreshing = Promise.resolve()
    .then(() => deps.git.countUncommitted(RECORDS_PATHSPEC))
    .then((count) => (cache.last = { key, count }))
    .finally(() => {
      cache.refreshing = null
    })
  cache.refreshing = refreshing
  return refreshing
}

async function uncommittedRecordFiles(deps: StorageDeps, head: GitHead | null): Promise<number | null> {
  // A db project has no record file in the checkout, so there is never one waiting to be committed.
  if (deps.layout.mode === 'db') return null
  const cache = deps.recordStatus
  if (cache === undefined) return deps.git.countUncommitted(RECORDS_PATHSPEC)
  const lastFlushAt = deps.db === null ? null : getMeta(deps.db, META_KEYS.lastFlushAt)
  const key = JSON.stringify([deps.git.indexStamp(), head, lastFlushAt])
  const last = cache.last
  // The first call has nothing to serve, so it waits for git once.
  if (last === null) return (await refreshRecordStatus(cache, deps, key)).count
  if (last.key !== key) {
    // A failed refresh keeps the last count, and the next call tries again.
    refreshRecordStatus(cache, deps, key).catch(() => undefined)
  }
  return last.count
}

type DatabaseStatus = Pick<
  StorageStatusView,
  'schemaVersion' | 'outbox' | 'attachments' | 'lastFlushAt' | 'branch' | 'conflicts' | 'profileConflicts' | 'kanbanConflicts' | 'sessions'
>

/** Status must render for broken folders too: an unreadable project reads as "not initialized". */
function projectOrNull(deps: StorageDeps): ProjectRecord | null {
  try {
    return readProject(deps.layout, deps.fs)
  } catch {
    return null
  }
}

const FAILED_ENTRY_LIMIT = 20

function outboxStatus(db: Db): StorageStatusView['outbox'] {
  const counts = db.all<{ state: string; count: number }>(
    "SELECT state, COUNT(*) AS count FROM outbox WHERE state IN ('pending', 'failed') GROUP BY state"
  )
  const countOf = (state: string): number => counts.find((row) => row.state === state)?.count ?? 0
  const latest = db.get<{ last_error: string }>(
    "SELECT last_error FROM outbox WHERE state <> 'done' AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1"
  )
  const outbox: StorageStatusView['outbox'] = { pending: countOf('pending'), failed: countOf('failed'), lastError: latest?.last_error ?? null }
  const failedEntries = db
    .all<{ kind: string; entity_id: string; attempts: number; last_error: string | null }>(
      `SELECT kind, COALESCE(entity_id, revision_id, run_id, epic_id, '') AS entity_id, attempts, last_error
       FROM outbox WHERE state = 'failed' ORDER BY id LIMIT ${FAILED_ENTRY_LIMIT}`
    )
    .map((row) => ({ kind: row.kind, entityId: row.entity_id, attempts: row.attempts, lastError: row.last_error }))
  return failedEntries.length === 0 ? outbox : { ...outbox, failedEntries }
}

/** Images attached to a record: staged ones that nothing owns yet do not count. */
function attachmentsStatus(db: Db): NonNullable<StorageStatusView['attachments']> {
  const row = db.get<{ count: number; bytes: number | null; missing: number | null }>(
    'SELECT COUNT(*) AS count, SUM(bytes) AS bytes, SUM(missing) AS missing FROM attachments WHERE owner_id IS NOT NULL'
  )
  return { count: row?.count ?? 0, bytes: row?.bytes ?? 0, missing: row?.missing ?? 0 }
}

type RecordsDeps = Pick<StorageDeps, 'layout' | 'fs'> & { db: Db }

/**
 * The person can choose (`resolveEpicConflict`) for an epic's own tracked-records conflict while it still holds:
 * the tracked records are not imported here and local changes wait. A stored conflict the checkout no longer
 * matches (a later pull, an unreadable file) offers no choice.
 */
function choiceStands(deps: RecordsDeps, epicId: string): boolean {
  if (deps.layout.mode !== 'repo' || !hasPendingEpicChanges(deps.db, epicId)) {
    return false
  }
  try {
    return unimportedEpicRecords(deps, epicId) !== null
  } catch {
    return false
  }
}

function conflictsOf(deps: RecordsDeps): StorageStatusView['conflicts'] {
  const rows = deps.db.all<{ kind: string; entity_id: string; conflict: string; run_epic: string | null; comment_epic: string | null }>(
    `SELECT s.kind, s.entity_id, s.conflict, r.epic_id AS run_epic, c.epic_id AS comment_epic
     FROM sync_state s LEFT JOIN runs r ON s.kind = 'run' AND r.id = s.entity_id
       LEFT JOIN comments c ON s.kind = 'comment' AND c.id = s.entity_id
     WHERE s.conflict IS NOT NULL AND s.kind NOT IN ('profile', 'kanban_card', 'kanban_event') ORDER BY s.kind, s.entity_id`
  )
  return rows.map((row) => ({
    epicId: row.run_epic ?? row.comment_epic ?? row.entity_id,
    message: row.conflict,
    resolvable: row.kind === 'epic' && row.conflict.startsWith(EPIC_RECORDS_CONFLICT_PREFIX) && choiceStands(deps, row.entity_id)
  }))
}

function profileConflictsOf(db: Db): StorageStatusView['profileConflicts'] {
  return db
    .all<{ entity_id: string; conflict: string }>(
      "SELECT entity_id, conflict FROM sync_state WHERE kind = 'profile' AND conflict IS NOT NULL ORDER BY entity_id"
    )
    .map((row) => ({ name: row.entity_id, message: row.conflict }))
}

/** Kanban card and event conflicts, by card: an event's conflict names the card it belongs to. */
function kanbanConflictsOf(db: Db): StorageStatusView['kanbanConflicts'] {
  return db
    .all<{ card_id: string; conflict: string }>(
      `SELECT COALESCE(e.card_id, s.entity_id) AS card_id, s.conflict
       FROM sync_state s LEFT JOIN kanban_events e ON s.kind = 'kanban_event' AND e.id = s.entity_id
       WHERE s.kind IN ('kanban_card', 'kanban_event') AND s.conflict IS NOT NULL
       ORDER BY card_id, s.kind, s.entity_id`
    )
    .map((row) => ({ cardId: row.card_id, message: row.conflict }))
}

function databaseStatus(deps: RecordsDeps & { clock: Clock }, head: { current: string | null; repository: boolean }): DatabaseStatus {
  const { db, clock } = deps
  const branch = branchState(db, head.current)
  return {
    schemaVersion: readSchemaVersion(db),
    outbox: outboxStatus(db),
    attachments: attachmentsStatus(db),
    lastFlushAt: getMeta(db, META_KEYS.lastFlushAt),
    branch: { current: head.current, recorded: branch.recorded, changed: branch.changed, repository: head.repository },
    conflicts: conflictsOf(deps),
    profileConflicts: profileConflictsOf(db),
    kanbanConflicts: kanbanConflictsOf(db),
    sessions: summarizeActiveSessions({ db, clock })
  }
}

const NO_DATABASE: Omit<DatabaseStatus, 'branch'> = {
  schemaVersion: null,
  outbox: { pending: 0, failed: 0, lastError: null },
  attachments: { count: 0, bytes: 0, missing: 0 },
  lastFlushAt: null,
  conflicts: [],
  profileConflicts: [],
  kanbanConflicts: [],
  sessions: { active: 0, byRole: {} }
}

/** Where this project's records and database live, for the footer and `get_storage_status`. */
function storageLocation(layout: RepoLayout, fs: StorageDeps['fs']): StorageStatusView['storage'] {
  return { mode: isForgeMember(fs, layout.root) ? 'forge' : layout.mode, projectDir: layout.dmDir, databasePath: layout.dbFile }
}

/** Storage health for the desktop footer and `get_storage_status`; works before initialization. */
export async function getStorageStatus(deps: StorageDeps): Promise<StorageStatusView> {
  const project = projectOrNull(deps)
  const gitHead = deps.git.head()
  const head = { current: gitHead?.branch ?? null, repository: gitHead !== null }
  const uncommitted = await uncommittedRecordFiles(deps, gitHead)
  const database =
    deps.db === null
      ? { ...NO_DATABASE, branch: { current: head.current, recorded: null, changed: false, repository: head.repository } }
      : databaseStatus({ db: deps.db, layout: deps.layout, fs: deps.fs, clock: deps.clock }, head)
  return {
    initialized: project !== null,
    repoRoot: deps.layout.root,
    storage: storageLocation(deps.layout, deps.fs),
    projectId: project?.projectId ?? null,
    projectName: project?.name ?? null,
    uncommittedRecordFiles: uncommitted,
    ...database
  }
}
