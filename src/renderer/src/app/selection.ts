import type { TrackedFolderView } from '../../../shared/desktop/api'

/** What the main area shows: a tracked folder and, optionally, one of its epics. */
export interface Selection {
  folderPath: string | null
  epicId: string | null
}

export const EMPTY_SELECTION: Selection = { folderPath: null, epicId: null }

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

/** Guards a selection read back from localStorage. */
export function isSelection(value: unknown): value is Selection {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { folderPath?: unknown; epicId?: unknown }
  return isNullableString(candidate.folderPath) && isNullableString(candidate.epicId)
}

export function findFolder(
  folders: readonly TrackedFolderView[],
  path: string | null
): TrackedFolderView | null {
  return folders.find((folder) => folder.path === path) ?? null
}

/**
 * Reconciles a stored selection with the folders that exist now: a vanished folder falls back to
 * the first tracked one, and an epic is only kept while its folder can actually show epics.
 */
export function resolveSelection(
  stored: Selection,
  folders: readonly TrackedFolderView[],
  loaded: boolean
): Selection {
  if (!loaded) {
    return stored
  }
  const folder = findFolder(folders, stored.folderPath)
  if (folder === null) {
    const first = folders[0]
    return first ? { folderPath: first.path, epicId: null } : EMPTY_SELECTION
  }
  const canShowEpics = folder.initialized && folder.available
  return { folderPath: folder.path, epicId: canShowEpics ? stored.epicId : null }
}
