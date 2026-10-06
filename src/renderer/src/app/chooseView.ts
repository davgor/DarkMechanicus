import type { ChatRecord } from '../../../shared/agents/chat'
import type { AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import type { FolderTab } from './folderTabs'
import type { AgentPane } from './selection'

/** What a loading view is waiting for: the tracked folders, the folder's chat list (for a stored chat), the connected agents. */
export type LoadingWhat = 'folders' | 'chat' | 'agents'

/** What the main area renders; variants that need a folder carry it, so rendering needs no null checks. */
export type MainView =
  /** `what` is what is still being fetched, so the view can say so. */
  | { kind: 'loading'; what: LoadingWhat }
  | { kind: 'welcome' }
  | { kind: 'unavailable'; folder: TrackedFolderView }
  /** The folder's page: its Source control or Epics tab. */
  | { kind: 'folder'; folder: TrackedFolderView; tab: FolderTab }
  | { kind: 'epic'; folder: TrackedFolderView; epicId: string }
  /** One of the folder's agent chats. */
  | { kind: 'chat'; folder: TrackedFolderView; chat: ChatRecord }
  /** Pressing + in the AGENTS section: the cards to find or download an agent. */
  | { kind: 'add-agent' }
  /** One connected agent's page. */
  | { kind: 'agent'; agent: AgentView }

interface ViewInput {
  loaded: boolean
  folder: TrackedFolderView | null
  epicId: string | null
  /** The chat chosen in the folder, if any. */
  chatId?: string | null
  /** The folder's chats, or null until they have loaded. */
  chats?: readonly ChatRecord[] | null
  /** An agents screen chosen over the folder view. */
  agentPane?: AgentPane
  /** The connected agents, or null until they have loaded. */
  agents?: readonly AgentView[] | null
  /** The folder's remembered tab; Source control when absent. */
  folderTab?: FolderTab
}

/** The agents screen the selection asks for, or null when the folder view applies (also for an agent that is gone). */
function chooseAgentView(pane: AgentPane | undefined, agents: readonly AgentView[] | null): MainView | null {
  if (pane === undefined) {
    return null
  }
  if (pane.kind === 'add') {
    return { kind: 'add-agent' }
  }
  if (agents === null) {
    return { kind: 'loading', what: 'agents' }
  }
  const agent = agents.find((candidate) => candidate.kind === pane.agent)
  return agent ? { kind: 'agent', agent } : null
}

/** Decides what the main area shows for the current selection. */
export function chooseView(input: ViewInput): MainView {
  const { folder } = input
  if (!input.loaded) {
    return { kind: 'loading', what: 'folders' }
  }
  const agentView = chooseAgentView(input.agentPane, input.agents ?? null)
  if (agentView !== null) {
    return agentView
  }
  if (folder === null) {
    return { kind: 'welcome' }
  }
  if (!folder.available) {
    return { kind: 'unavailable', folder }
  }
  return chooseFolderView(input, folder)
}

/** The selected folder's page, its epic, or its chat. */
function chooseFolderView(input: ViewInput, folder: TrackedFolderView): MainView {
  const tab = input.folderTab ?? 'source'
  if (!folder.initialized) {
    return { kind: 'folder', folder, tab }
  }
  if (input.epicId !== null) {
    return { kind: 'epic', folder, epicId: input.epicId }
  }
  return chooseChatView(folder, tab, input.chatId ?? null, input.chats ?? null)
}

/** The chat view for the selected chat, loading while the chats are listed, or the folder page when the chat is gone. */
function chooseChatView(folder: TrackedFolderView, tab: FolderTab, chatId: string | null, chats: readonly ChatRecord[] | null): MainView {
  if (chatId === null) {
    return { kind: 'folder', folder, tab }
  }
  if (chats === null) {
    return { kind: 'loading', what: 'chat' }
  }
  const chat = chats.find((candidate) => candidate.id === chatId)
  return chat ? { kind: 'chat', folder, chat } : { kind: 'folder', folder, tab }
}
