/**
 * A `Workspace` stand-in for tests of the MCP entry point: canned command results plus counters
 * for the session lifecycle calls (`heartbeat`, `close`). Not shipped.
 */
import type { Workspace } from '../core/workspace'
import type { CommandName } from '../shared/domain/api'
import { createCannedApi } from './stubApi'

export interface StubWorkspaceOptions {
  repoRoot?: string
  sessionId?: string | null
  initialized?: boolean
  /** Thrown by the next and every later `heartbeat()` call. */
  heartbeatError?: Error
  /** Thrown by `close()` (after it is counted). */
  closeError?: Error
  /** Values that the listed commands resolve to. */
  canned?: Partial<Record<CommandName, unknown>>
}

type StubWorkspace = Workspace & {
  calls: { name: string; input: unknown }[]
  heartbeats: number
  closes: number
}

export function createStubWorkspace(options: StubWorkspaceOptions = {}): StubWorkspace {
  const workspace = Object.assign(createCannedApi(options.canned ?? {}), {
    repoRoot: options.repoRoot ?? '/repo',
    heartbeats: 0,
    closes: 0,
    sessionId: (): string | null => (options.sessionId === undefined ? 'ss_stub' : options.sessionId),
    isInitialized: (): boolean => options.initialized ?? true,
    heartbeat: (): void => {
      workspace.heartbeats += 1
      if (options.heartbeatError !== undefined) {
        throw options.heartbeatError
      }
    },
    close: (): void => {
      workspace.closes += 1
      if (options.closeError !== undefined) {
        throw options.closeError
      }
    }
  })
  return workspace
}
