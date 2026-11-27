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
  /** The folder's Kanban board. */
  | { kind: 'kanban'; folder: TrackedFolderView }
  /** The folder's Metrics dashboard. */
  | { kind: 'metrics'; folder: TrackedFolderView }
  /** The folder's published Learnings (Knowledge → Learnings), with the learning open in its detail pane, if any. */
  | { kind: 'learnings'; folder: TrackedFolderView; learningId: string | null }
  /** Pressing + in the AGENTS section: the cards to find or download an agent. */
  | { kind: 'add-agent' }
  /** One connected agent's page. */
  | { kind: 'agent'; agent: AgentView }
  /** A project-less chat, summoned from an agent's row: tied to no folder. */
  | { kind: 'projectless-chat'; chat: ChatRecord }
  /** The app Settings screen, opened from the sidebar footer. */
  | { kind: 'settings' }
  /** A cult's page, opened from its CULTS row. */
  | { kind: 'cult'; cultId: string }

interface ViewInput {
  loaded: boolean
  folder: TrackedFolderView | null
  epicId: string | null
  /** The chat chosen in the folder, if any. */
  chatId?: string | null
  /** The folder's chats, or null until they have loaded. */
  chats?: readonly ChatRecord[] | null
  /** The folder's Kanban board is chosen. */
  kanban?: boolean
  /** The folder's Metrics dashboard is chosen. */
  metrics?: boolean
  /** The folder's Learnings are chosen. */
  learnings?: boolean
  /** The learning open in the Learnings detail pane. */
  learningId?: string | null
  /** An agents screen chosen over the folder view. */
  agentPane?: AgentPane
  /** The connected agents, or null until they have loaded. */
  agents?: readonly AgentView[] | null
  /** The project-less chats, or null until they have loaded. */
  projectless?: readonly ChatRecord[] | null
  /** The folder's remembered tab; Source control when absent. */
  folderTab?: FolderTab
}

/** The agents screen the selection asks for, or null when the folder view applies (also for an agent or a project-less chat that is gone). */
function chooseAgentView(pane: AgentPane | undefined, agents: readonly AgentView[] | null, projectless: readonly ChatRecord[] | null): MainView | null {
  if (pane === undefined) {
    return null
  }
  if (pane.kind === 'add') {
    return { kind: 'add-agent' }
  }
  if (pane.kind === 'settings') {
    return { kind: 'settings' }
  }
  if (pane.kind === 'cult') {
    return { kind: 'cult', cultId: pane.cultId }
  }
  if (pane.kind === 'chat') {
    if (projectless === null) {
      return { kind: 'loading', what: 'chat' }
    }
    const chat = projectless.find((candidate) => candidate.id === pane.chatId)
    return chat ? { kind: 'projectless-chat', chat } : null
  }
  if (agents === null) {
    return { kind: 'loading', what: 'agents' }
  }
  const agent = agents.find((candidate) => candidate.id === pane.agent)
  return agent ? { kind: 'agent', agent } : null
}

/** Decides what the main area shows for the current selection. */
export function chooseView(input: ViewInput): MainView {
  const { folder } = input
  if (!input.loaded) {
    return { kind: 'loading', what: 'folders' }
  }
  const agentView = chooseAgentView(input.agentPane, input.agents ?? null, input.projectless ?? null)
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

/** The selected folder's page, its epic, its Kanban board, its Metrics dashboard, or its chat. */
function chooseFolderView(input: ViewInput, folder: TrackedFolderView): MainView {
  const tab = input.folderTab ?? 'source'
  if (folder.forgeWorld) return chosenChat(input, folder, tab)
  if (!folder.initialized) {
    return { kind: 'folder', folder, tab }
  }
  if (input.epicId !== null) {
    return { kind: 'epic', folder, epicId: input.epicId }
  }
  if (input.kanban === true) {
    return { kind: 'kanban', folder }
  }
  if (input.metrics === true) {
    return { kind: 'metrics', folder }
  }
  if (input.learnings === true) {
    return { kind: 'learnings', folder, learningId: input.learningId ?? null }
  }
  return chosenChat(input, folder, tab)
}

function chosenChat(input: ViewInput, folder: TrackedFolderView, tab: FolderTab): MainView {
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
