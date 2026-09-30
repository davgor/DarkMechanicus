import { useCallback, useEffect, useState } from 'react'
import type { FolderPickResult, TrackedFolderView } from '../../../shared/desktop/api'
import { upsertFolder } from './folderList'
import { useLatest } from './useLatest'

export interface FoldersModel {
  folders: TrackedFolderView[]
  /** False until the first list arrives (or fails). */
  loaded: boolean
  reload(): Promise<void>
  /** Opens the native picker; adds or selects the chosen folder. `folder` is null when canceled. */
  pick(): Promise<FolderPickResult>
  /** Stops tracking a folder; repository data is untouched. */
  untrack(path: string): Promise<void>
}

interface FolderState {
  folders: TrackedFolderView[]
  loaded: boolean
}

/** The machine-local list of tracked folders. Rejections from pick/untrack are the caller's to handle. */
export function useFolders(onError: (error: unknown) => void): FoldersModel {
  const [state, setState] = useState<FolderState>({ folders: [], loaded: false })
  const report = useLatest(onError)

  const reload = useCallback(async () => {
    try {
      const folders = await window.dm.listFolders()
      setState({ folders, loaded: true })
    } catch (error) {
      setState((previous) => ({ ...previous, loaded: true }))
      report.current(error)
    }
  }, [report])

  useEffect(() => {
    void reload()
  }, [reload])

  const pick = useCallback(async () => {
    const result = await window.dm.pickFolder()
    const picked = result.folder
    if (picked !== null) {
      setState((previous) => ({ ...previous, folders: upsertFolder(previous.folders, picked) }))
    }
    return result
  }, [])

  const untrack = useCallback(async (path: string) => {
    const folders = await window.dm.untrackFolder(path)
    setState({ folders, loaded: true })
  }, [])

  return { folders: state.folders, loaded: state.loaded, reload, pick, untrack }
}
