import type { TrackedFolderView } from '../../../shared/desktop/api'

/**
 * Folders whose epics are on screen or selected: initialized, reachable, and either selected or
 * expanded in the sidebar. Only these are fetched and polled.
 */
export function activeFolderPaths(
  folders: readonly TrackedFolderView[],
  selectedPath: string | null,
  isExpanded: (path: string) => boolean,
  sectionOpen: (forge: boolean) => boolean = () => true
): string[] {
  return folders
    .filter((folder) => folder.initialized && folder.available && !folder.forgeWorld)
    .filter((folder) => folder.path === selectedPath || sectionOpen(Boolean(folder.forgeParent)) && isExpanded(folder.path) && (!folder.forgeParent || isExpanded(folder.forgeParent)))
    .map((folder) => folder.path)
}

/** Chats also belong to Forge roots, which have no project database to poll. */
export function activeChatPaths(folders: readonly TrackedFolderView[], selectedPath: string | null, isExpanded: (path: string) => boolean): string[] {
  const projects = new Set(activeFolderPaths(folders, selectedPath, isExpanded))
  return folders.filter(folder => projects.has(folder.path) || (folder.forgeWorld && folder.available && (folder.path === selectedPath || isExpanded(folder.path)))).map(folder => folder.path)
}
