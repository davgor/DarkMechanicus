import type { TrackedFolderView } from '../../../shared/desktop/api'

export type MainView = 'loading' | 'welcome' | 'unavailable' | 'onboarding' | 'epic' | 'home'

interface ViewInput {
  loaded: boolean
  folder: TrackedFolderView | null
  epicId: string | null
}

/** Decides what the main area renders for the current selection. */
export function chooseView(input: ViewInput): MainView {
  if (!input.loaded) {
    return 'loading'
  }
  const { folder } = input
  if (folder === null) {
    return 'welcome'
  }
  if (!folder.available) {
    return 'unavailable'
  }
  if (!folder.initialized) {
    return 'onboarding'
  }
  return input.epicId === null ? 'home' : 'epic'
}
