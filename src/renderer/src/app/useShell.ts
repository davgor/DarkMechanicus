import { useState } from 'react'
import type { AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import type { StorageStatusView } from '../../../shared/domain/views'
import type { ChatRecord } from '../../../shared/agents/chat'
import { useAgents } from '../agents/useAgents'
import type { AgentsModel } from '../agents/useAgents'
import { chatsFor, useChats } from '../agents/useChats'
import type { ChatsModel } from '../agents/useChats'
import { bucketOfEpic } from '../sidebar/buckets'
import { useExpansion } from '../sidebar/useExpansion'
import type { Expansion } from '../sidebar/useExpansion'
import { activeFolderPaths } from './activePaths'
import { chooseView } from './chooseView'
import type { MainView } from './chooseView'
import { epicToken, folderToken } from './eventRouting'
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

export interface ShellModel {
  folders: TrackedFolderView[]
  selection: Selection
  view: MainView
  lists: Record<string, EpicListState>
  /** Storage/MCP status of the selected folder, once it is initialized and loaded. */
  status: StorageStatusView | null
  expansion: Expansion
  /** Connected agents with their sign-in states and what is in flight for each. */
  agents: AgentsModel
  /** The chats of every active folder, and rename and delete. */
  chats: ChatsModel
  busy: Record<BusyKey, boolean>
  actions: ShellActions
  /**
   * What a link from another screen (`actions.openTicket`, `actions.openThread`) asked the screen it opened to
   * show, until that screen took it (`actions.landed`) or the person went somewhere else.
   */
  landing: Landing | null
  /** Refresh token for an epic view: changes whenever events touch that epic. */
  epicToken(folderPath: string, epicId: string): number
}

/** Agent sessions and Git state change without events, so the footer status also refreshes on a timer. */
const STATUS_REFRESH_MS = 10_000

const IDLE: Record<BusyKey, boolean> = { initialize: false, flush: false, reconcile: false }

/** The folder whose storage status the footer shows, if it can have one. */
function statusPathOf(folder: TrackedFolderView | null): string | null {
  return folder !== null && folder.initialized && folder.available ? folder.path : null
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
  connected: readonly AgentView[] | null,
  expansion: Expansion,
  onError: (error: unknown) => void
): { selection: Selection; select(selection: Selection): void; paths: string[]; chats: ChatsModel } {
  const [stored, select] = usePersistentState(SELECTION_STORAGE_KEY, EMPTY_SELECTION, isSelection)
  const folderPath = resolveSelection(stored, folders.folders, folders.loaded, { agents: connected }).folderPath
  const paths = activeFolderPaths(folders.folders, folderPath, expansion.isFolderExpanded)
  const chats = useChats({ paths, onError })
  const known = { agents: connected, chats: knownChats(chats, stored.folderPath) }
  return { selection: resolveSelection(stored, folders.folders, folders.loaded, known), select, paths, chats }
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
  const { selection, select, paths, chats } = useSelection(folders, connected, expansion, toasts.reportError)
  const selected = findFolder(folders.folders, selection.folderPath)
  const feed = useEventFeed({ paths, selectedPath: selection.folderPath, scheduler, onError: toasts.reportError })
  const lists = useEpicLists({ paths, tokens: feed.tokens, onError: toasts.reportError })
  const status = useFooterStatus(statusPathOf(selected), feed.tokens, scheduler, toasts.reportError)

  const actions = createShellActions({
    toasts,
    folders,
    select,
    land: setLanding,
    reveal: expansion.reveal,
    revealAgents: expansion.revealAgents,
    chats: { create: chats.create },
    bucketOf: (path, epicId) => bucketOfEpic(listFor(lists, path).epics, epicId),
    refresh: feed.bumpFolder,
    setBusy: (key, value) => setBusy((previous) => ({ ...previous, [key]: value })),
    selectedPath: selection.folderPath
  })

  return {
    folders: folders.folders,
    selection,
    view: chooseView({
      loaded: folders.loaded,
      folder: selected,
      epicId: selection.epicId,
      chatId: selection.chatId,
      chats: knownChats(chats, selection.folderPath),
      agentPane: selection.agentPane,
      agents: connected
    }),
    lists,
    status,
    expansion,
    agents,
    chats,
    busy,
    actions,
    landing,
    epicToken: (path, epicId) => epicToken(feed.tokens, path, epicId)
  }
}
