import type { ChatRecord } from '../../../shared/agents/chat'
import { AGENT_KINDS } from '../../../shared/desktop/agentKinds'
import type { AgentKind, AgentView, TrackedFolderView } from '../../../shared/desktop/api'

/** The agents screens that take over the main area: the add-agent pane, or one agent's page. */
export type AgentPane = { kind: 'add' } | { kind: 'agent'; agent: AgentKind }

/** What the main area shows: a tracked folder and, optionally, one of its epics or an agents screen. */
export interface Selection {
  folderPath: string | null
  epicId: string | null
  /** An agents screen shown instead of the folder; absent (as in selections stored before agents) means the folder. */
  agentPane?: AgentPane
  /** One of the folder's chats, shown in place of its home; absent means no chat. Only set with `epicId` null. */
  chatId?: string
}

export const EMPTY_SELECTION: Selection = { folderPath: null, epicId: null }

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const isAgentKind = (value: unknown): value is AgentKind => AGENT_KINDS.some((kind) => kind === value)

function isAgentPane(value: unknown): value is AgentPane {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { kind?: unknown; agent?: unknown }
  return candidate.kind === 'add' || (candidate.kind === 'agent' && isAgentKind(candidate.agent))
}

/** Guards a selection read back from localStorage. */
export function isSelection(value: unknown): value is Selection {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { folderPath?: unknown; epicId?: unknown; agentPane?: unknown; chatId?: unknown }
  return (
    isNullableString(candidate.folderPath) &&
    isNullableString(candidate.epicId) &&
    (candidate.agentPane === undefined || isAgentPane(candidate.agentPane)) &&
    (candidate.chatId === undefined || typeof candidate.chatId === 'string')
  )
}

export function findFolder(
  folders: readonly TrackedFolderView[],
  path: string | null
): TrackedFolderView | null {
  return folders.find((folder) => folder.path === path) ?? null
}

/** The stored chat when it can still be shown; `chats` is the stored folder's chat list, null until it has loaded. */
function keptChatId(stored: Selection, chats: readonly ChatRecord[] | null): string | undefined {
  const known = chats === null || chats.some((chat) => chat.id === stored.chatId)
  return known ? stored.chatId : undefined
}

function resolveFolder(
  stored: Selection,
  folders: readonly TrackedFolderView[],
  chats: readonly ChatRecord[] | null
): Selection {
  const folder = findFolder(folders, stored.folderPath)
  if (folder === null) {
    const first = folders[0]
    return first ? { folderPath: first.path, epicId: null } : EMPTY_SELECTION
  }
  const canShowEpics = folder.initialized && folder.available
  const chatId = canShowEpics ? keptChatId(stored, chats) : undefined
  return {
    folderPath: folder.path,
    epicId: canShowEpics ? stored.epicId : null,
    ...(chatId === undefined ? {} : { chatId })
  }
}

/** The pane to keep: the add-agent pane always, an agent's page only while that agent is still connected. */
function resolvePane(pane: AgentPane | undefined, agents: readonly AgentView[] | null): AgentPane | undefined {
  if (pane === undefined || pane.kind === 'add' || agents === null) {
    return pane
  }
  return agents.some((agent) => agent.kind === pane.agent) ? pane : undefined
}

/** What a stored selection is checked against besides the folders; each is null (or absent) until it has loaded. */
interface KnownData {
  /** The connected agents. */
  agents?: readonly AgentView[] | null
  /** The chats of the stored selection's folder. */
  chats?: readonly ChatRecord[] | null
}

/**
 * Reconciles a stored selection with the folders and agents that exist now: a vanished folder falls
 * back to the first tracked one, an epic is only kept while its folder can actually show epics, and
 * the page of an agent that is no longer connected falls back to the folder view. `agents` is null
 * until they have loaded, which keeps an agent pane as stored. A chat that is no longer in its
 * folder's chat list (deleted) falls back to the folder home; `chats` is the stored folder's chats,
 * null until they have loaded, which keeps the chat as stored.
 */
export function resolveSelection(
  stored: Selection,
  folders: readonly TrackedFolderView[],
  loaded: boolean,
  known: KnownData = {}
): Selection {
  if (!loaded) {
    return stored
  }
  const base = resolveFolder(stored, folders, known.chats ?? null)
  const agentPane = resolvePane(stored.agentPane, known.agents ?? null)
  return agentPane === undefined ? base : { ...base, agentPane }
}
