import { chatIdSchema, type ChatRecord } from '../../../shared/agents/chat'
import { agentIdSchema } from '../../../shared/desktop/agentKinds'
import type { AgentId, AgentView, TrackedFolderView } from '../../../shared/desktop/api'

/**
 * The agents screens that take over the main area: the add-agent pane, one agent's page by its id, a project-less
 * chat (summoned from an agent's row, tied to no folder) by its id, or the app Settings screen.
 */
export type AgentPane = { kind: 'add' } | { kind: 'agent'; agent: AgentId } | { kind: 'chat'; chatId: string } | { kind: 'settings' }

/** What the main area shows: a tracked folder and, optionally, one of its epics or an agents screen. */
export interface Selection {
  folderPath: string | null
  epicId: string | null
  /** An agents screen shown instead of the folder; absent (as in selections stored before agents) means the folder. */
  agentPane?: AgentPane
  /** One of the folder's chats, shown in place of its home; absent means no chat. Only set with `epicId` null. */
  chatId?: string
  /** The folder's Kanban board, shown in place of its home; absent means no board. Only set with `epicId` null and no chat. */
  kanban?: true
  /** The card selected on this folder's board. */
  kanbanCardId?: string
  /** The folder's Metrics dashboard, shown in place of its home; absent means no dashboard. Only set with `epicId` null, no chat and no board. */
  metrics?: true
}

export const EMPTY_SELECTION: Selection = { folderPath: null, epicId: null }

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'


function isAgentPane(value: unknown): value is AgentPane {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { kind?: unknown; agent?: unknown; chatId?: unknown }
  return (
    candidate.kind === 'add' ||
    candidate.kind === 'settings' ||
    (candidate.kind === 'agent' && agentIdSchema.safeParse(candidate.agent).success) ||
    (candidate.kind === 'chat' && chatIdSchema.safeParse(candidate.chatId).success)
  )
}

type StoredShape = { folderPath?: unknown; epicId?: unknown; agentPane?: unknown; chatId?: unknown; kanban?: unknown; kanbanCardId?: unknown; metrics?: unknown }

function hasValidCard(candidate: StoredShape): boolean {
  return candidate.kanbanCardId === undefined || (candidate.kanban === true && typeof candidate.kanbanCardId === 'string')
}

/** The screens a stored selection may name over its folder are well formed: an agents screen, a chat, the board, the dashboard. */
function hasValidScreens(candidate: StoredShape): boolean {
  return (
    (candidate.agentPane === undefined || isAgentPane(candidate.agentPane)) &&
    (candidate.chatId === undefined || typeof candidate.chatId === 'string') &&
    (candidate.kanban === undefined || candidate.kanban === true) &&
    hasValidCard(candidate) &&
    (candidate.metrics === undefined || candidate.metrics === true)
  )
}

/** Guards a selection read back from localStorage. */
export function isSelection(value: unknown): value is Selection {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as StoredShape
  return isNullableString(candidate.folderPath) && isNullableString(candidate.epicId) && hasValidScreens(candidate)
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
  if (!folder.available || (!folder.initialized && !folder.forgeWorld)) {
    return { folderPath: folder.path, epicId: null }
  }
  return keptFolderScreens(stored, folder, keptChatId(stored, chats))
}

function keptFolderScreens(stored: Selection, folder: TrackedFolderView, chatId: string | undefined): Selection {
  const base: Selection = { folderPath: folder.path, epicId: null, ...(chatId === undefined ? {} : { chatId }) }
  if (folder.forgeWorld) return base
  return {
    ...base,
    epicId: stored.epicId,
    ...(stored.kanban === true ? { kanban: true as const, ...(stored.kanbanCardId === undefined ? {} : { kanbanCardId: stored.kanbanCardId }) } : {}),
    ...(stored.metrics === true ? { metrics: true as const } : {})
  }
}

/**
 * The pane to keep: the add-agent pane and Settings always, an agent's page only while that agent is still connected, a
 * project-less chat only while it is not deleted.
 */
function resolvePane(pane: AgentPane | undefined, known: KnownData): AgentPane | undefined {
  if (pane === undefined || pane.kind === 'add' || pane.kind === 'settings') return pane
  return resolveLivePane(pane, known)
}

/** An agent's page or a project-less chat, kept only while what it shows still exists (or has not loaded yet). */
function resolveLivePane(pane: Extract<AgentPane, { kind: 'agent' | 'chat' }>, known: KnownData): AgentPane | undefined {
  if (pane.kind === 'chat') {
    const projectless = known.projectless ?? null
    return projectless === null || projectless.some((chat) => chat.id === pane.chatId) ? pane : undefined
  }
  const agents = known.agents ?? null
  return agents === null || agents.some((agent) => agent.id === pane.agent) ? pane : undefined
}

/** What a stored selection is checked against besides the folders; each is null (or absent) until it has loaded. */
interface KnownData {
  /** The connected agents. */
  agents?: readonly AgentView[] | null
  /** The chats of the stored selection's folder. */
  chats?: readonly ChatRecord[] | null
  /** The project-less chats. */
  projectless?: readonly ChatRecord[] | null
}

/**
 * Reconciles a stored selection with the folders and agents that exist now: a vanished folder falls
 * back to the first tracked one, an epic is only kept while its folder can actually show epics, and
 * the page of an agent that is no longer connected falls back to the folder view. `agents` is null
 * until they have loaded, which keeps an agent pane as stored. A chat that is no longer in its
 * folder's chat list (deleted) falls back to the folder home; `chats` is the stored folder's chats,
 * null until they have loaded, which keeps the chat as stored. A project-less chat that is deleted falls back the same
 * way; `projectless` is null until they have loaded.
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
  const agentPane = resolvePane(stored.agentPane, known)
  return agentPane === undefined ? base : { ...base, agentPane }
}
