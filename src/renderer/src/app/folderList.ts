import type { TrackedFolderView } from '../../../shared/desktop/api'

/** Adds a folder or replaces the entry with the same canonical path, keeping list order. */
export function upsertFolder(
  list: readonly TrackedFolderView[],
  folder: TrackedFolderView
): TrackedFolderView[] {
  const listed = list.some((entry) => entry.path === folder.path)
  return listed
    ? list.map((entry) => (entry.path === folder.path ? folder : entry))
    : [...list, folder]
}
