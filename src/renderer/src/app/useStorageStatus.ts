import { runCommand } from '../api/dm'
import type { StorageStatusView } from '../../../shared/domain/views'
import { useResource } from './useResource'

interface StatusOptions {
  /** The folder to describe, or null when none applies (nothing selected, not initialized). */
  path: string | null
  /** Refetch whenever this changes. */
  token: number
  onError(error: unknown): void
}

/** Storage and MCP status of one folder. Never shows another folder's numbers. */
export function useStorageStatus({ path, token, onError }: StatusOptions): StorageStatusView | null {
  const resource = useResource({
    key: path,
    version: token,
    // Not called while `path` is null.
    load: () => runCommand(path ?? '', 'getStorageStatus', undefined),
    onError
  })
  return resource.status === 'ready' ? resource.value : null
}
