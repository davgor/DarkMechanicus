import type { CommandApi } from '../shared/domain/api'
import type { SessionRole } from '../shared/domain/views'
import type { Clock } from './clock'
import { DomainError } from './errors'
import type { IdGenerator } from './ids'
import type { FsAdapter, GitAdapter } from './repo/types'

export interface OpenWorkspaceOptions {
  /** Repository root (already resolved/canonical). */
  repoRoot: string
  role: SessionRole
  label: string
  transport: 'stdio' | 'desktop' | 'in_process'
  /** Explicit user authorization for an agent session to save plans. */
  allowSave?: boolean
  pid?: number | null
  clock?: Clock
  ids?: IdGenerator
  fs?: FsAdapter
  git?: GitAdapter
  /** Reconcile tracked records on open (default true). */
  autoReconcile?: boolean
  serverInfo?: { name: string; version: string }
}

/** One repository opened by one session. Implements the full command contract. */
export interface Workspace extends CommandApi {
  readonly repoRoot: string
  sessionId(): string | null
  isInitialized(): boolean
  /** Marks the session alive (MCP heartbeat / desktop poll). */
  heartbeat(): void
  close(): void
}

export function openWorkspace(options: OpenWorkspaceOptions): Workspace {
  throw new DomainError('internal', `Workspace for ${options.repoRoot} is not wired yet.`)
}
