import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { StorageStatusView } from '../../../shared/domain/views'
import { bucketOfEpic } from '../sidebar/buckets'
import { useExpansion } from '../sidebar/useExpansion'
import type { Expansion } from '../sidebar/useExpansion'
import { activeFolderPaths } from './activePaths'
import { chooseView } from './chooseView'
import type { MainView } from './chooseView'
import { epicToken, folderToken } from './eventRouting'
import { EMPTY_SELECTION, findFolder, isSelection, resolveSelection } from './selection'
import type { Selection } from './selection'
import type { Scheduler } from './scheduler'
import { createShellActions } from './shellActions'
import type { BusyKey, ShellActions } from './shellActions'
import { useToasts } from './toasts'
import { useEpicLists, listFor } from './useEpicLists'
import type { EpicListState } from './useEpicLists'
import { useEventFeed } from './useEventFeed'
import { useFolders } from './useFolders'
import { usePersistentState } from './usePersistentState'
import { useStorageStatus } from './useStorageStatus'

const SELECTION_STORAGE_KEY = 'dm.selection'

export interface ShellModel {
  folders: TrackedFolderView[]
  selection: Selection
  view: MainView
  lists: Record<string, EpicListState>
  /** Storage/MCP status of the selected folder, once it is initialized and loaded. */
  status: StorageStatusView | null
  expansion: Expansion
  busy: Record<BusyKey, boolean>
  actions: ShellActions
  /** Refresh token for an epic view: changes whenever events touch that epic. */
  epicToken(folderPath: string, epicId: string): number
}

const IDLE: Record<BusyKey, boolean> = { initialize: false, flush: false, reconcile: false }

/** The folder whose storage status the footer shows, if it can have one. */
function statusPathOf(folder: TrackedFolderView | null): string | null {
  return folder !== null && folder.initialized && folder.available ? folder.path : null
}

/**
 * All shell state in one place: tracked folders, the persisted selection and collapse state, epic
 * lists and storage status kept fresh by the event feed, and the actions the UI can take.
 */
export function useShell(scheduler: Scheduler): ShellModel {
  const toasts = useToasts()
  const folders = useFolders(toasts.reportError)
  const [stored, setStored] = usePersistentState(SELECTION_STORAGE_KEY, EMPTY_SELECTION, isSelection)
  const expansion = useExpansion()
  const [busy, setBusy] = useState(IDLE)

  const selection = resolveSelection(stored, folders.folders, folders.loaded)
  const selected = findFolder(folders.folders, selection.folderPath)
  const paths = activeFolderPaths(folders.folders, selection.folderPath, expansion.isFolderExpanded)
  const feed = useEventFeed({ paths, selectedPath: selection.folderPath, scheduler, onError: toasts.reportError })
  const lists = useEpicLists({ paths, tokens: feed.tokens, onError: toasts.reportError })
  const statusPath = statusPathOf(selected)
  const status = useStorageStatus({
    path: statusPath,
    token: statusPath === null ? 0 : folderToken(feed.tokens, statusPath),
    onError: toasts.reportError
  })

  const actions = createShellActions({
    toasts,
    folders,
    select: setStored,
    reveal: expansion.reveal,
    bucketOf: (path, epicId) => bucketOfEpic(listFor(lists, path).epics, epicId),
    refresh: feed.bumpFolder,
    setBusy: (key, value) => setBusy((previous) => ({ ...previous, [key]: value })),
    selectedPath: selection.folderPath
  })

  return {
    folders: folders.folders,
    selection,
    view: chooseView({ loaded: folders.loaded, folder: selected, epicId: selection.epicId }),
    lists,
    status,
    expansion,
    busy,
    actions,
    epicToken: (path, epicId) => epicToken(feed.tokens, path, epicId)
  }
}
