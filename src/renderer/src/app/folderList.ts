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

function sameFolder(a: TrackedFolderView, b: TrackedFolderView): boolean {
  return (
    a.path === b.path &&
    a.name === b.name &&
    a.displayPath === b.displayPath &&
    a.initialized === b.initialized &&
    a.available === b.available &&
    a.addedAt === b.addedAt
  )
}

/**
 * The refreshed list, reusing the previous object for every folder that did not change (and the
 * previous array when nothing did), so a routine reload does not look like new data to views.
 */
export function reconcileFolders(
  previous: TrackedFolderView[],
  next: TrackedFolderView[]
): TrackedFolderView[] {
  const reused = next.map((folder) => previous.find((old) => sameFolder(old, folder)) ?? folder)
  const unchanged =
    reused.length === previous.length && reused.every((folder, index) => folder === previous[index])
  return unchanged ? previous : reused
}
