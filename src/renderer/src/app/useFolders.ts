import { useCallback, useEffect, useRef, useState } from 'react'
import type { FolderPickResult, TrackedFolderView } from '../../../shared/desktop/api'
import { reconcileFolders, upsertFolder } from './folderList'
import { useLatest } from './useLatest'

export interface FoldersModel {
  folders: TrackedFolderView[]
  /** False until the first list arrives (or fails). */
  loaded: boolean
  reload(): Promise<void>
  /** Opens the native picker; adds or selects the chosen folder. `folder` is null when canceled. */
  pick(mode?: 'forge-world'): Promise<FolderPickResult>
  /** Stops tracking a folder; repository data is untouched. */
  untrack(path: string): Promise<void>
}

interface FolderState {
  folders: TrackedFolderView[]
  loaded: boolean
}

/** Refresh after explicit registry changes and when the window notices external changes on refocus. */
function refreshOnFolderChanges(reload: () => Promise<void>, invalidate: () => void): () => void {
  const refresh = (): void => { void reload() }
  refresh()
  window.addEventListener('focus', refresh)
  const unsubscribe = window.dm.onFoldersChanged?.(refresh)
  return () => {
    invalidate()
    window.removeEventListener('focus', refresh)
    unsubscribe?.()
  }
}

/** The machine-local list of tracked folders. Rejections from pick/untrack are the caller's to handle. */
export function useFolders(onError: (error: unknown) => void): FoldersModel {
  const [state, setState] = useState<FolderState>({ folders: [], loaded: false })
  const report = useLatest(onError)
  const generation = useRef(0)

  const reload = useCallback(async () => {
    const request = ++generation.current
    try {
      const folders = await window.dm.listFolders()
      if (generation.current !== request) return
      setState((previous) => ({ folders: reconcileFolders(previous.folders, folders), loaded: true }))
    } catch (error) {
      if (generation.current !== request) return
      setState((previous) => ({ ...previous, loaded: true }))
      report.current(error)
    }
  }, [report])

  useEffect(() => refreshOnFolderChanges(reload, () => { generation.current += 1 }), [reload])

  const pick = useCallback(async (mode?: 'forge-world') => {
    const result = await (mode === undefined ? window.dm.pickFolder() : window.dm.pickFolder(mode))
    const picked = result.folder
    if (picked?.forgeWorld || picked?.forgeParent) {
      await reload()
      return result
    }
    if (picked !== null) {
      generation.current += 1
      setState((previous) => ({
        ...previous,
        folders: reconcileFolders(previous.folders, upsertFolder(previous.folders, picked))
      }))
    }
    return result
  }, [reload])

  const untrack = useCallback(async (path: string) => {
    const folders = await window.dm.untrackFolder(path)
    generation.current += 1
    setState((previous) => ({ folders: reconcileFolders(previous.folders, folders), loaded: true }))
  }, [])

  return { folders: state.folders, loaded: state.loaded, reload, pick, untrack }
}
