import { runCommand } from '../api/dm'
import type { StorageStatusView } from '../../../shared/domain/views'
import { useResource } from './useResource'

interface StatusOptions {
  /** The folder to describe, or null when none applies (nothing selected, not initialized). */
  path: string | null
  /** Refetch whenever this changes (the folder's event token). */
  token: number
  /** Refetch whenever this changes (the periodic and on-focus refresh). */
  tick: number
  onError(error: unknown): void
}

/** Storage and MCP status of one folder. Never shows another folder's numbers. */
export function useStorageStatus({ path, token, tick, onError }: StatusOptions): StorageStatusView | null {
  const resource = useResource({
    key: path,
    version: `${token}:${tick}`,
    // Not called while `path` is null.
    load: () => runCommand(path ?? '', 'getStorageStatus', undefined),
    onError
  })
  return resource.status === 'ready' ? resource.value : null
}
