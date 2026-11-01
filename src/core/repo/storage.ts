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
import type { FsAdapter, GitAdapter, RepoLayout } from './types'

interface StorageDeps {
  db: Db | null
  layout: RepoLayout
  fs: FsAdapter
  git: GitAdapter
  clock: Clock
}

type DatabaseStatus = Pick<
  StorageStatusView,
  'schemaVersion' | 'outbox' | 'lastFlushAt' | 'branch' | 'conflicts' | 'profileConflicts' | 'kanbanConflicts' | 'sessions'
>

/** Status must render for broken folders too: an unreadable project reads as "not initialized". */
function projectOrNull(deps: StorageDeps): ProjectRecord | null {
  try {
    return readProject(deps.layout, deps.fs)
  } catch {
    return null
  }
}

function outboxStatus(db: Db): StorageStatusView['outbox'] {
  const counts = db.all<{ state: string; count: number }>(
    "SELECT state, COUNT(*) AS count FROM outbox WHERE state IN ('pending', 'failed') GROUP BY state"
  )
  const countOf = (state: string): number => counts.find((row) => row.state === state)?.count ?? 0
  const latest = db.get<{ last_error: string }>(
    "SELECT last_error FROM outbox WHERE state <> 'done' AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1"
  )
  return { pending: countOf('pending'), failed: countOf('failed'), lastError: latest?.last_error ?? null }
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
  lastFlushAt: null,
  conflicts: [],
  profileConflicts: [],
  kanbanConflicts: [],
  sessions: { active: 0, byRole: {} }
}

/** Where this project's records and database live, for the footer and `get_storage_status`. */
function storageLocation(layout: RepoLayout): StorageStatusView['storage'] {
  return { mode: layout.mode, projectDir: layout.dmDir, databasePath: layout.dbFile }
}

/** Storage health for the desktop footer and `get_storage_status`; works before initialization. */
export async function getStorageStatus(deps: StorageDeps): Promise<StorageStatusView> {
  const project = projectOrNull(deps)
  const gitHead = deps.git.head()
  const head = { current: gitHead?.branch ?? null, repository: gitHead !== null }
  // A db project has no record file in the checkout, so there is never one waiting to be committed.
  const uncommittedRecordFiles =
    deps.layout.mode === 'db' ? null : await deps.git.countUncommitted('.darkmechanicus')
  const database =
    deps.db === null
      ? { ...NO_DATABASE, branch: { current: head.current, recorded: null, changed: false, repository: head.repository } }
      : databaseStatus({ db: deps.db, layout: deps.layout, fs: deps.fs, clock: deps.clock }, head)
  return {
    initialized: project !== null,
    repoRoot: deps.layout.root,
    storage: storageLocation(deps.layout),
    projectId: project?.projectId ?? null,
    projectName: project?.name ?? null,
    uncommittedRecordFiles,
    ...database
  }
}
