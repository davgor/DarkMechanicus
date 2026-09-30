import type { StorageStatusView } from '../../shared/domain/views'
import type { Clock } from '../clock'
import type { Db } from '../db/database'
import { readSchemaVersion } from '../db/migrations'
import { getMeta, META_KEYS } from '../meta'
import { summarizeActiveSessions } from '../services/sessions'
import { branchState } from './importer'
import { readProject } from './initialize'
import type { ProjectRecord } from './portable'
import type { FsAdapter, GitAdapter, RepoLayout } from './types'

interface StorageDeps {
  db: Db | null
  layout: RepoLayout
  fs: FsAdapter
  git: GitAdapter
  clock: Clock
}

type DatabaseStatus = Pick<StorageStatusView, 'schemaVersion' | 'outbox' | 'lastFlushAt' | 'branch' | 'conflicts' | 'sessions'>

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

function conflictsOf(db: Db): StorageStatusView['conflicts'] {
  const rows = db.all<{ entity_id: string; conflict: string; run_epic: string | null }>(
    `SELECT s.entity_id, s.conflict, r.epic_id AS run_epic
     FROM sync_state s LEFT JOIN runs r ON s.kind = 'run' AND r.id = s.entity_id
     WHERE s.conflict IS NOT NULL ORDER BY s.kind, s.entity_id`
  )
  return rows.map((row) => ({ epicId: row.run_epic ?? row.entity_id, message: row.conflict }))
}

function databaseStatus(db: Db, clock: Clock, current: string | null): DatabaseStatus {
  const branch = branchState(db, current)
  return {
    schemaVersion: readSchemaVersion(db),
    outbox: outboxStatus(db),
    lastFlushAt: getMeta(db, META_KEYS.lastFlushAt),
    branch: { current, recorded: branch.recorded, changed: branch.changed },
    conflicts: conflictsOf(db),
    sessions: summarizeActiveSessions({ db, clock })
  }
}

const NO_DATABASE: Omit<DatabaseStatus, 'branch'> = {
  schemaVersion: null,
  outbox: { pending: 0, failed: 0, lastError: null },
  lastFlushAt: null,
  conflicts: [],
  sessions: { active: 0, byRole: {} }
}

/** Storage health for the desktop footer and `get_storage_status`; works before initialization. */
export async function getStorageStatus(deps: StorageDeps): Promise<StorageStatusView> {
  const project = projectOrNull(deps)
  const current = deps.git.head()?.branch ?? null
  const uncommittedRecordFiles = await deps.git.countUncommitted('.darkmechanicus')
  const database =
    deps.db === null
      ? { ...NO_DATABASE, branch: { current, recorded: null, changed: false } }
      : databaseStatus(deps.db, deps.clock, current)
  return {
    initialized: project !== null,
    repoRoot: deps.layout.root,
    projectId: project?.projectId ?? null,
    projectName: project?.name ?? null,
    uncommittedRecordFiles,
    ...database
  }
}
