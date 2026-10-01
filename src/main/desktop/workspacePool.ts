/**
 * One desktop Workspace (session) per tracked folder, opened lazily and cached by canonical path.
 * Callers pass canonical paths (the folder registry resolves them); the pool keys by exact string.
 */
import type { Workspace } from '../../core/workspace'

export interface WorkspacePool {
  /** The cached workspace for `path`, opening it on first use. A failed open is not cached. */
  get(path: string): Workspace
  /** Marks every open workspace's session alive; one failure never stops the others. */
  heartbeatAll(): void
  /** Closes and forgets one workspace. Never throws; failures go to the error sink. */
  close(path: string): void
  closeAll(): void
}

type ErrorSink = (path: string, error: unknown) => void

function attempt(path: string, onError: ErrorSink, action: () => void): void {
  try {
    action()
  } catch (error) {
    onError(path, error)
  }
}

export function createWorkspacePool(
  open: (repoRoot: string) => Workspace,
  onError: ErrorSink = () => undefined
): WorkspacePool {
  const workspaces = new Map<string, Workspace>()

  function close(path: string): void {
    const workspace = workspaces.get(path)
    if (workspace === undefined) {
      return
    }
    workspaces.delete(path)
    attempt(path, onError, () => workspace.close())
  }

  return {
    get(path) {
      const cached = workspaces.get(path)
      if (cached !== undefined) {
        return cached
      }
      const opened = open(path)
      workspaces.set(path, opened)
      return opened
    },
    heartbeatAll() {
      for (const [path, workspace] of workspaces) {
        attempt(path, onError, () => workspace.heartbeat())
      }
    },
    close,
    closeAll() {
      // close() deletes the current key, which is safe while iterating a Map.
      for (const path of workspaces.keys()) {
        close(path)
      }
    }
  }
}
