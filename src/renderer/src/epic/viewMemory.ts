import { createContext, useContext } from 'react'
import type { PlanViewKind } from './workspaceState'

/**
 * The Draft or Saved view the person last picked for each epic, kept for the app session (not
 * persisted). The workspace remounts per epic, so without it every visit would reopen on the default.
 */
interface ViewMemory {
  recall(folderPath: string, epicId: string): PlanViewKind | null
  /** Remembers a choice; null forgets it. */
  remember(folderPath: string, epicId: string, view: PlanViewKind | null): void
}

export function createViewMemory(): ViewMemory {
  const views = new Map<string, PlanViewKind>()
  const keyOf = (folderPath: string, epicId: string): string => `${folderPath}\n${epicId}`
  return {
    recall: (folderPath, epicId) => views.get(keyOf(folderPath, epicId)) ?? null,
    remember(folderPath, epicId, view) {
      if (view === null) {
        views.delete(keyOf(folderPath, epicId))
      } else {
        views.set(keyOf(folderPath, epicId), view)
      }
    }
  }
}

/** One memory for the whole app session; tests provide a fresh one per render. */
export const ViewMemoryContext = createContext<ViewMemory>(createViewMemory())

export function useViewMemory(): ViewMemory {
  return useContext(ViewMemoryContext)
}
