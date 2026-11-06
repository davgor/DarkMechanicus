import type { CommandApi, CommandName } from '../../shared/domain/api'
import type {
  FlushResultView,
  InitializeResultView,
  ReconcileResultView,
  SessionRole
} from '../../shared/domain/views'
import type { Capability } from '../authz'
import type { Clock } from '../clock'
import type { Ctx } from '../context'
import type { Db } from '../db/database'
import type { FlushScope } from '../repo/finalizer'
import type { ProjectLayout } from '../repo/initialize'
import type { ProjectRecord } from '../repo/portable'
import type { StorageMode } from '../repo/storageMode'
import type { FsAdapter, GitAdapter, RepoLayout } from '../repo/types'
import type { z } from 'zod'

/** What command specs may use from the open workspace. */
export interface WorkspaceCore {
  readonly repoRoot: string
  readonly layout: RepoLayout
  readonly fs: FsAdapter
  readonly git: GitAdapter
  /** How this session reaches the workspace; some commands refuse one transport (the desktop app, for attachments). */
  readonly transport: 'stdio' | 'desktop' | 'in_process' | 'cli'
  /**
   * The adapter for child repository `repo` of a folder of repositories (cached per name), or `git` for null.
   * Throws `invalid_input` for a name the project does not list or records as missing, and `unsafe_path` for a
   * child that is a link or resolves outside the folder, before any Git command runs.
   */
  gitFor(repo: string | null): GitAdapter
  readonly clock: Clock
  readonly role: SessionRole
  readonly options: { serverInfo?: { name: string; version: string } }
  roleCapabilities(): Capability[]
  isInitialized(): boolean
  sessionId(): string | null
  project(): ProjectRecord
  db(): Db | null
  ctx(): Ctx
  initialize(input: { name?: string; keyPrefix?: string; mode?: StorageMode; layout?: ProjectLayout }): InitializeResultView
  reconcile(): ReconcileResultView
  /** Flushes every waiting entry, or only those in `scope`. */
  flush(scope?: FlushScope): FlushResultView
  safeFlush(): void
}

type Input<K extends CommandName> = Parameters<CommandApi[K]> extends [infer I] ? I : undefined
type Output<K extends CommandName> = Awaited<ReturnType<CommandApi[K]>>

interface CommandSpec<K extends CommandName> {
  /** Parses the raw payload; omitted for commands without input. */
  schema?: z.ZodType
  /** Mutating commands flush portable records after they commit. */
  mutates: boolean
  /** Allowed before the repository is initialized. */
  beforeInit?: boolean
  run(core: WorkspaceCore, input: Input<K>): Output<K> | Promise<Output<K>>
}

export type CommandTable = { [K in CommandName]: CommandSpec<K> }
