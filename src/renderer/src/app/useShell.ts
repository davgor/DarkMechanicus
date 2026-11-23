import { useMemo, useState } from 'react'
import type { AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import type { StorageStatusView } from '../../../shared/domain/views'
import type { ChatRecord } from '../../../shared/agents/chat'
import { useAgents } from '../agents/useAgents'
import type { AgentsModel } from '../agents/useAgents'
import { useAgentMail } from '../agents/useAgentMail'
import type { AgentMailStore } from '../agents/useAgentMail'
import { chatsFor, useAllChats, useChats } from '../agents/useChats'
import type { ChatListState, ChatsModel } from '../agents/useChats'
import { useKanbanCounts } from '../kanban/useKanbanCounts'
import type { KanbanCounts } from '../kanban/useKanbanCounts'
import { bucketOfEpic } from '../sidebar/buckets'
import { useExpansion } from '../sidebar/useExpansion'
import type { Expansion } from '../sidebar/useExpansion'
import { activeChatPaths, activeFolderPaths } from './activePaths'
import { chooseView } from './chooseView'
import type { MainView } from './chooseView'
import { folderTabOf, isFolderTabs } from './folderTabs'
import type { FolderTab, FolderTabs } from './folderTabs'
import { folderIdentity } from './folderList'
import { epicToken, folderToken, kanbanToken } from './eventRouting'
import type { Landing } from './landing'
import type { Tokens } from './eventRouting'
import { EMPTY_SELECTION, findFolder, isSelection, resolveSelection } from './selection'
import type { Selection } from './selection'
import type { Scheduler } from './scheduler'
import { createShellActions } from './shellActions'
import type { BusyKey, ShellActions } from './shellActions'
import { useToasts } from './toasts'
import { useEpicLists, listFor } from './useEpicLists'
import type { EpicListState } from './useEpicLists'
import { useEventFeed } from './useEventFeed'
import { useFolders } from './useFolders'
import { usePersistentState } from './usePersistentState'
import { useRefreshTick } from './useRefreshTick'
import { useStorageStatus } from './useStorageStatus'

const SELECTION_STORAGE_KEY = 'dm.selection'
const FOLDER_TABS_STORAGE_KEY = 'dm.folderTabs'

export interface ShellModel {
  reloadFolders(): Promise<void>
  folders: TrackedFolderView[]
  selection: Selection
  view: MainView
  lists: Record<string, EpicListState>
  /** Open Kanban cards of every active folder, for the sidebar. */
  kanbanCounts: KanbanCounts
  /** Storage/MCP status of the selected folder, once it is initialized and loaded. */
  status: StorageStatusView | null
  expansion: Expansion
  /** Connected agents with their sign-in states and what is in flight for each. */
  agents: AgentsModel
  /** The chats of every active folder, and rename and delete. */
  chats: ChatsModel
  /** OMP chats' mailboxes in every active folder, as the person sees them: one store for header and sidebar. */
  mail: AgentMailStore
  /** Every chat that is not deleted, of every tracked folder and project-less, for the AGENTS section. */
  allChats: ChatListState
  busy: Record<BusyKey, boolean>
  actions: ShellActions
  /**
   * What a link from another screen (`actions.openTicket`, `actions.openThread`) asked the screen it opened to
   * show, until that screen took it (`actions.landed`) or the person went somewhere else.
   */
  landing: Landing | null
  /** Remembers which tab the folder page opens on for a folder. */
  setFolderTab(folderPath: string, tab: FolderTab): void
  /** Refresh token for an epic view: changes whenever events touch that epic. */
  epicToken(folderPath: string, epicId: string): number
  /** Refresh token for a folder's views: changes whenever events touch the folder. */
  kanbanToken(folderPath: string): number
  refreshKanban(folderPath: string): void
  sections: { forge: boolean; folders: boolean }
  setSection(section: 'forge' | 'folders', expanded: boolean): void
}

/** Agent sessions and Git state change without events, so the footer status also refreshes on a timer. */
const STATUS_REFRESH_MS = 10_000

const IDLE: Record<BusyKey, boolean> = { initialize: false, flush: false, reconcile: false }

/** The folder whose storage status the footer shows, if it can have one. */
function statusPathOf(folder: TrackedFolderView | null): string | null {
  return folder !== null && folder.initialized && folder.available && !folder.forgeWorld ? folder.path : null
}

/** The chats of the folder a stored selection names, or null while they are still loading (so the chat is kept as stored). */
function knownChats(chats: ChatsModel, folderPath: string | null): readonly ChatRecord[] | null {
  if (folderPath === null) {
    return null
  }
  const list = chatsFor(chats.lists, folderPath)
  return list.status === 'loading' ? null : list.chats
}

/**
 * The persisted selection, reconciled with what exists now. The folder is settled first, because
 * which chats to ask for depends on it, and whether the selected chat still exists depends on them.
 */
function useSelection(
  folders: ReturnType<typeof useFolders>,
  loaded: { agents: readonly AgentView[] | null; projectless: readonly ChatRecord[] | null },
  expansion: Expansion,
  onError: (error: unknown) => void
): { selection: Selection; select(selection: Selection): void; chats: ChatsModel } {
  const [stored, select] = usePersistentState(SELECTION_STORAGE_KEY, EMPTY_SELECTION, isSelection)
  const folderPath = resolveSelection(stored, folders.folders, folders.loaded, loaded).folderPath
  const chats = useChats({ paths: activeChatPaths(folders.folders, folderPath, expansion.isFolderExpanded), onError })
  const known = { ...loaded, chats: knownChats(chats, stored.folderPath) }
  return { selection: resolveSelection(stored, folders.folders, folders.loaded, known), select, chats }
}

/** What the main area shows for the selection, with the data it was reconciled against. */
function shellView(input: {
  folders: ReturnType<typeof useFolders>
  selected: TrackedFolderView | null
  selection: Selection
  chats: readonly ChatRecord[] | null
  projectless: readonly ChatRecord[] | null
  agents: readonly AgentView[] | null
  folderTabs: FolderTabs
}): MainView {
  const { folders, selected, selection, chats, projectless, agents, folderTabs } = input
  return chooseView({
    loaded: folders.loaded,
    folder: selected,
    epicId: selection.epicId,
    chatId: selection.chatId,
    kanban: selection.kanban,
    metrics: selection.metrics,
    chats,
    agentPane: selection.agentPane,
    agents,
    projectless,
    folderTab: selected?.forgeWorld && folderTabs[selected.path] === undefined ? 'tickets' : folderTabOf(folderTabs, selection.folderPath)
  })
}

/** The tab each folder page was left on, and a setter that remembers one. */
function useFolderTabs(): [FolderTabs, (folderPath: string, tab: FolderTab) => void] {
  const [tabs, setTabs] = usePersistentState<FolderTabs>(FOLDER_TABS_STORAGE_KEY, {}, isFolderTabs)
  return [tabs, (folderPath, tab) => setTabs((previous) => ({ ...previous, [folderPath]: tab }))]
}

/** The storage status of the folder the footer describes, refreshed by its events and on a timer. */
function useFooterStatus(
  path: string | null,
  tokens: Tokens,
  scheduler: Scheduler,
  onError: (error: unknown) => void
): StorageStatusView | null {
  const tick = useRefreshTick({ scheduler, everyMs: STATUS_REFRESH_MS, enabled: path !== null })
  return useStorageStatus({ path, token: path === null ? 0 : folderToken(tokens, path), tick, onError })
}

/** Every chat of every tracked folder and project-less (the AGENTS section), and the project-less ones once loaded. */
function useEveryChat(folders: readonly TrackedFolderView[], onError: (error: unknown) => void): { allChats: ChatListState; projectless: ChatRecord[] | null } {
  const allChats = useAllChats({ tracked: folders.map((folder) => folder.path), onError })
  return { allChats, projectless: allChats.status === 'loading' ? null : allChats.chats.filter((chat) => chat.folder === null) }
}

/** Selecting work in a world also reveals its parent, even when opened from the global agent list. */
function navigationExpansion(folders: readonly TrackedFolderView[], expansion: Expansion): Pick<Expansion, 'reveal' | 'revealAgents'> {
  const revealParent = (path: string): void => {
    const parent = folders.find(folder => folder.path === path)?.forgeParent
    if (parent) expansion.reveal(parent, null)
  }
  return {
    reveal: (path, bucket) => { revealParent(path); expansion.reveal(path, bucket) },
    revealAgents: (path) => { revealParent(path); expansion.revealAgents(path) }
  }
}

/** Only the selected project and visible sidebar sections need ticket polling. */
function useFolderData(
  { folders, selection, expansion }: { folders: readonly TrackedFolderView[]; selection: Selection; expansion: Expansion },
  scheduler: Scheduler,
  onError: (error: unknown) => void
) {
  const [sections, setSections] = useState({ forge: true, folders: true })
  const selectedPath = selection.agentPane === undefined ? selection.folderPath : null
  const paths = activeFolderPaths(folders, selectedPath, expansion.isFolderExpanded, forge => forge ? sections.forge : sections.folders)
  const identities = useMemo(() => new Map(folders.map(folder => [folder.path, folderIdentity(folder)])), [folders])
  const feed = useEventFeed({ paths, identities, selectedPath, scheduler, onError })
  const ready = paths.filter(path => feed.tokens.ready[path] === identities.get(path))
  const lists = useEpicLists({ paths: ready, identities, tokens: feed.tokens, onError })
  const kanbanCounts = useKanbanCounts({ paths: ready, identities, tokens: feed.tokens, onError })
  const setSection: ShellModel['setSection'] = (section, expanded) => setSections(previous => ({ ...previous, [section]: expanded }))
  return { feed, lists, kanbanCounts, sections, setSection }
}

/**
 * All shell state in one place: tracked folders, the persisted selection and collapse state, epic
 * lists and storage status kept fresh by the event feed, and the actions the UI can take.
 */
export function useShell(scheduler: Scheduler): ShellModel {
  const toasts = useToasts()
  const folders = useFolders(toasts.reportError)
  const agents = useAgents(toasts.reportError)
  const connected = agents.loaded ? agents.agents : null
  const expansion = useExpansion()
  const [busy, setBusy] = useState(IDLE)
  const [landing, setLanding] = useState<Landing | null>(null)
  const [folderTabs, setFolderTab] = useFolderTabs()
  const { allChats, projectless } = useEveryChat(folders.folders, toasts.reportError)
  const { selection, select, chats } = useSelection(folders, { agents: connected, projectless }, expansion, toasts.reportError)
  const selected = findFolder(folders.folders, selection.folderPath)
  const { feed, lists, kanbanCounts, sections, setSection } = useFolderData({ folders: folders.folders, selection, expansion }, scheduler, toasts.reportError)
  const mail = useAgentMail(activeFolderPaths(folders.folders, selection.folderPath, expansion.isFolderExpanded))
  const status = useFooterStatus(statusPathOf(selected), feed.tokens, scheduler, toasts.reportError)

  const actions = createShellActions({
    toasts,
    folders,
    select,
    land: setLanding,
    ...navigationExpansion(folders.folders, expansion),
    chats: { create: chats.create },
    bucketOf: (path, epicId) => bucketOfEpic(listFor(lists, path).epics, epicId),
    refresh: feed.bumpFolder,
    setBusy: (key, value) => setBusy((previous) => ({ ...previous, [key]: value })),
    selectedPath: selection.folderPath
  })

  return {
    folders: folders.folders, reloadFolders: folders.reload,
    selection,
    view: shellView({ folders, selected, selection, chats: knownChats(chats, selection.folderPath), projectless, agents: connected, folderTabs }),
    lists,
    kanbanCounts,
    status,
    expansion,
    agents,
    chats,
    mail,
    allChats,
    busy,
    actions,
    landing,
    setFolderTab,
    epicToken: (path, epicId) => epicToken(feed.tokens, path, epicId),
    kanbanToken: (path) => kanbanToken(feed.tokens, path),
    refreshKanban: feed.pollNow,
    sections,
    setSection
  }
}
