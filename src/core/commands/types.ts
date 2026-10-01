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
import type { ProjectRecord } from '../repo/portable'
import type { FsAdapter, GitAdapter, RepoLayout } from '../repo/types'
import type { z } from 'zod'

/** What command specs may use from the open workspace. */
export interface WorkspaceCore {
  readonly repoRoot: string
  readonly layout: RepoLayout
  readonly fs: FsAdapter
  readonly git: GitAdapter
  readonly clock: Clock
  readonly role: SessionRole
  readonly options: { serverInfo?: { name: string; version: string } }
  roleCapabilities(): Capability[]
  isInitialized(): boolean
  sessionId(): string | null
  project(): ProjectRecord
  db(): Db | null
  ctx(): Ctx
  initialize(input: { name?: string; keyPrefix?: string }): InitializeResultView
  reconcile(): ReconcileResultView
  flush(): FlushResultView
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
