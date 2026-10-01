import type { TrackedFolderView } from '../../../shared/desktop/api'

/**
 * Folders whose epics are on screen or selected: initialized, reachable, and either selected or
 * expanded in the sidebar. Only these are fetched and polled.
 */
export function activeFolderPaths(
  folders: readonly TrackedFolderView[],
  selectedPath: string | null,
  isExpanded: (path: string) => boolean
): string[] {
  return folders
    .filter((folder) => folder.initialized && folder.available)
    .filter((folder) => folder.path === selectedPath || isExpanded(folder.path))
    .map((folder) => folder.path)
}
