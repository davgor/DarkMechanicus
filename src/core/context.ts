import type { SessionContext } from './authz'
import type { GitAdapter } from './repo/types'
import type { Clock } from './clock'
import type { DefinitionOfDoneCheck } from '../shared/domain/views'
import type { Db } from './db/database'
import type { IdGenerator } from './ids'
import type { RepositoryEntry } from './repo/portable'

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
  /** The absolute path of the project root: the repository, or the folder that holds a folder of repositories. */
  projectRoot: string
  /** Throws `branch_changed` when the coordinating checkout moved since the last reconcile. */
  assertBranch(): void
  /** The coordinating checkout's current branch and HEAD commit (nulls outside Git). */
  checkout(): { branch: string | null; commit: string | null }
  /** The Git adapter for child repository `repo` of a folder of repositories, or the root's for null (`WorkspaceCore.gitFor`). */
  gitFor(repo: string | null): GitAdapter
  /**
   * The project's Definition of Done as `.darkmechanicus/project.json` holds it right now (empty when it has none).
   * Read from the file on every call, so a change made by another session or by hand applies immediately.
   */
  definitionOfDone(): DefinitionOfDoneCheck[]
  /**
   * The names of the project's repositories as `project.json` holds them right now when the project is a folder
   * of repositories (missing ones included), or `null` for a single repository. Read from the file on every call.
   */
  repositories(): string[] | null
  /** The same repositories as entries, each flagged `missing` when a rescan did not find it, or `null` for a single repository. */
  repositoryEntries(): RepositoryEntry[] | null
}
