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

export function folderIdentity(folder: TrackedFolderView): string {
  return JSON.stringify([folder.path, folder.projectIdentity, folder.attachmentKey, folder.addedAt, folder.storageMode, folder.forgeParent])
}

function sameFolder(a: TrackedFolderView, b: TrackedFolderView): boolean {
  return (
    folderIdentity(a) === folderIdentity(b) &&
    a.forgeIssue === b.forgeIssue &&
    a.name === b.name &&
    JSON.stringify(a.forgeWorld) === JSON.stringify(b.forgeWorld) &&
    a.displayPath === b.displayPath &&
    a.initialized === b.initialized &&
    a.available === b.available &&
    JSON.stringify(a.childRepositories) === JSON.stringify(b.childRepositories)
  )
}

function identityWhileUnavailable(folder: TrackedFolderView, previous: TrackedFolderView | undefined): TrackedFolderView {
  if (folder.available || folder.projectIdentity !== undefined || previous?.projectIdentity === undefined) return folder
  const sameEntry = previous.addedAt === folder.addedAt && previous.attachmentKey === folder.attachmentKey
  return sameEntry ? { ...folder, projectIdentity: previous.projectIdentity } : folder
}

/**
 * The refreshed list, reusing the previous object for every folder that did not change (and the
 * previous array when nothing did), so a routine reload does not look like new data to views.
 */
export function reconcileFolders(
  previous: TrackedFolderView[],
  next: TrackedFolderView[]
): TrackedFolderView[] {
  const byPath = new Map(previous.map(folder => [folder.path, folder]))
  const reused = next.map(folder => {
    const old = byPath.get(folder.path)
    const current = identityWhileUnavailable(folder, old)
    return old !== undefined && sameFolder(old, current) ? old : current
  })
  const unchanged =
    reused.length === previous.length && reused.every((folder, index) => folder === previous[index])
  return unchanged ? previous : reused
}
