import type { SessionContext } from './authz'
import type { Clock } from './clock'
import type { Db } from './db/database'
import type { IdGenerator } from './ids'

/**
 * Everything a service function needs. Services never reach for globals (time, randomness,
 * filesystem), so tests can drive them deterministically.
 */
export interface Ctx {
  db: Db
  clock: Clock
  ids: IdGenerator
  session: SessionContext
  machineId: string
  projectId: string
  /** Throws `branch_changed` when the coordinating checkout moved since the last reconcile. */
  assertBranch(): void
  /** The coordinating checkout's current branch and HEAD commit (nulls outside Git). */
  checkout(): { branch: string | null; commit: string | null }
}
