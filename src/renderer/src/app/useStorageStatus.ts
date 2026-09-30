import { useEffect, useState } from 'react'
import { runCommand } from '../api/dm'
import type { StorageStatusView } from '../../../shared/domain/views'
import { useLatest } from './useLatest'

interface StatusOptions {
  /** The folder to describe, or null when none applies (nothing selected, not initialized). */
  path: string | null
  /** Refetch whenever this changes. */
  token: number
  onError(error: unknown): void
}

interface Loaded {
  path: string
  status: StorageStatusView
}

/** Storage and MCP status of one folder. Never shows another folder's numbers. */
export function useStorageStatus(options: StatusOptions): StorageStatusView | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const onError = useLatest(options.onError)
  const { path, token } = options

  useEffect(() => {
    if (path === null) {
      return undefined
    }
    let current = true
    runCommand(path, 'getStorageStatus', undefined).then(
      (status) => {
        if (current) setLoaded({ path, status })
      },
      (error: unknown) => {
        if (current) onError.current(error)
      }
    )
    return () => {
      current = false
    }
  }, [path, token, onError])

  return loaded !== null && loaded.path === path ? loaded.status : null
}
