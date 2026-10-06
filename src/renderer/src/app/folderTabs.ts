/** The pages of a folder: its Source control, and its Epics. */
export type FolderTab = 'source' | 'epics'

export const FOLDER_TABS: readonly FolderTab[] = ['source', 'epics']

const DEFAULT_FOLDER_TAB: FolderTab = 'source'

/** The tab each folder was last left on, by folder path. Values are only trusted through `folderTabOf`. */
export type FolderTabs = Record<string, unknown>

/** Guards the remembered tabs read back from localStorage: a map; an unknown tab in it is dropped by `folderTabOf`. */
export function isFolderTabs(value: unknown): value is FolderTabs {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isFolderTab = (value: unknown): value is FolderTab => FOLDER_TABS.some((tab) => tab === value)

/** The folder's remembered tab; Source control when nothing (or something unknown) is stored. */
export function folderTabOf(tabs: FolderTabs, folderPath: string | null): FolderTab {
  const stored = folderPath === null || !Object.hasOwn(tabs, folderPath) ? undefined : tabs[folderPath]
  return isFolderTab(stored) ? stored : DEFAULT_FOLDER_TAB
}
