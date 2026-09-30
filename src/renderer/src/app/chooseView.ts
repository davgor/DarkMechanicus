import type { TrackedFolderView } from '../../../shared/desktop/api'

/** What the main area renders; variants that need a folder carry it, so rendering needs no null checks. */
export type MainView =
  | { kind: 'loading' }
  | { kind: 'welcome' }
  | { kind: 'unavailable'; folder: TrackedFolderView }
  | { kind: 'onboarding'; folder: TrackedFolderView }
  | { kind: 'home'; folder: TrackedFolderView }
  | { kind: 'epic'; folder: TrackedFolderView; epicId: string }

interface ViewInput {
  loaded: boolean
  folder: TrackedFolderView | null
  epicId: string | null
}

/** Decides what the main area shows for the current selection. */
export function chooseView(input: ViewInput): MainView {
  const { folder, epicId } = input
  if (!input.loaded) {
    return { kind: 'loading' }
  }
  if (folder === null) {
    return { kind: 'welcome' }
  }
  if (!folder.available) {
    return { kind: 'unavailable', folder }
  }
  if (!folder.initialized) {
    return { kind: 'onboarding', folder }
  }
  return epicId === null ? { kind: 'home', folder } : { kind: 'epic', folder, epicId }
}
