/**
 * The chats as records: listing, creating, renaming and deleting them, and reading stored transcripts.
 * Nothing here runs an agent; terminal and GUI session owners manage their processes separately.
 *
 * Reading is read-only (`readChat`): it writes nothing. By default, an unfinished stored approval request
 * is shown cancelled, a running call cancelled and a running thread failed, in the returned items only.
 * Callers with a live GUI process pass `live: true` to preserve pending requests and running items.
 *
 * Mailboxes (`chatMailboxes.ts`). Listing a folder's chats provisions the OMP chats' mailboxes and stores their ids;
 * creating an OMP chat provisions its mailbox at once; renaming one renames its mailbox, never its id. A project-less
 * chat has no mailbox: none is provisioned, renamed or deleted for it.
 *
 * Deleting a chat first deletes its mailbox durably (closed, its received mail purged, its sent mail showing a deleted
 * sender), then forgets its item-based activity bindings (`activityBindings.ts`, kept for old chats), removes OMP's own
 * folder of it (and a project-less chat's scratch folder), and only then the chat itself. When storage cannot record
 * the mailbox deletion the chat stays and the error is thrown, so the person sees it and can delete again. A chat whose
 * mailbox is already deleting (a deletion a crash or a failure cut short) is never provisioned again: listing leaves it
 * out and finishes its deletion, and `recoverFolder` does the same for every such chat of a folder at startup.
 */
import { DomainError } from '../../core/errors'
import { GUI_PROTOCOL_KINDS } from '../../shared/agents/agentChat'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import type { ChatReadView, CreateChatRequest } from '../../shared/agents/chatApi'
import { AGENT_DEFINITIONS, isBuiltInAgentKind } from '../../shared/desktop/agentKinds'
import type { AgentId, AgentView } from '../../shared/desktop/api'
import type { ActivityBindings } from './activityBindings'
import type { ChatRef, ChatStore, NewChat } from './chatStore'
import type { ChatMailboxes } from './chatMailboxes'
import { hasForgeManifest } from '../desktop/forgeContext'

interface ChatRecordsDeps {
  store: ChatStore
  /** The connected agent with this id (agent registry); null when it is not connected. */
  agentFor: (id: AgentId) => AgentView | null
  /** The item-based bindings of old chats; a deleted chat's are forgotten. Without it there are none. */
  activity?: Pick<ActivityBindings, 'forgetChat'>
  /** Removes an OMP chat's own folder when the chat is deleted (`ompSession.ts`); without it nothing is removed. */
  removeOmpFolder?: (chatId: string) => Promise<void>
  /** The chats' mailboxes; without it no chat has one. A project-less chat never has one. */
  mailboxes?: ChatMailboxes
  /** Told of a deletion listing found unfinished and could not finish; it is tried again at the next list. */
  onError?: (error: unknown) => void
  /** Removes a project-less chat's scratch folder when the chat is deleted (`scratchFolder.ts`); without it nothing is removed. */
  removeScratch?: (chatId: string) => Promise<void>
  /** Human deletion retires scoped workflow holds before removing the identity; failures keep deletion recoverable. */
  beforeDelete?: (chat: ChatRecord) => void | Promise<void>
}

/**
 * A request to create a chat, in a tracked folder or project-less (`folder` null), with the run it orchestrates, the
 * epic it transfers, the Kanban card it carries or the board conversation it answers when there is one.
 */
type NewChatRequest = Omit<CreateChatRequest, 'folder'> & Pick<ChatRecord, 'folder' | 'epicId' | 'runId' | 'transferEpicId' | 'cardId' | 'conversation' | 'forgeSetup' | 'cultRunId' | 'cultRole'>

type ChatResult<T> = T | Promise<T>

export interface ChatRecords {
  /** A folder's chats (null: the project-less chats), most recently updated first. */
  listChats(folder: string | null): ChatResult<ChatRecord[]>
  /**
   * `runId` links the chat to the run it orchestrates, `transferEpicId` to the epic it moves to Linear, `cardId` to the
   * Kanban card it carries, and `conversation` to the board conversation it answers; only main sets them (the
   * `chats:create` request cannot).
   */
  createChat(request: NewChatRequest): ChatResult<ChatRecord>
  /** Changes the chat's title. */
  renameChat(ref: ChatRef, title: string): ChatResult<ChatRecord>
  /**
   * Deletes the chat's mailbox, removes its activity bindings (and a project-less chat's scratch folder), then the chat
   * and its transcript; throws `not_found` for an unknown chat.
   */
  deleteChat(ref: ChatRef): Promise<void>
  /** Startup: provisions the folder's OMP chats' mailboxes and finishes every deletion a crash cut short (see the module comment). */
  recoverFolder(folder: string): Promise<void>
  /** The chat and its stored transcript; live reads skip settling. Writes nothing. Throws `not_found` for an unknown chat. */
  readChat(ref: ChatRef, options?: { live?: boolean }): ChatReadView
  /** The agent's display name: the connected agent's, else the built-in kind's, else a generic one. */
  agentName(id: AgentId): string
}

function requireChat(store: ChatStore, ref: ChatRef): ChatRecord {
  const chat = store.getChat(ref)
  if (chat === null) {
    throw new DomainError('not_found', `Chat not found: ${ref.id}`)
  }
  return chat
}

/**
 * The items with what no agent can finish any more shown as ended: an undecided request gets a `cancelled` decision
 * right after it, a running call is `cancelled` and a running thread `failed`.
 */
function settledItems(items: readonly ChatItem[]): ChatItem[] {
  const decided = new Set(items.flatMap((item) => (item.kind === 'approval_decision' ? [item.requestId] : [])))
  return items.flatMap((item): ChatItem[] => {
    if (item.kind === 'approval_request' && !decided.has(item.requestId)) {
      decided.add(item.requestId)
      return [item, { id: `${item.id}:cancelled`, at: item.at, kind: 'approval_decision', requestId: item.requestId, decision: 'cancelled' }]
    }
    if (item.kind === 'tool_call' && item.status === 'running') {
      return [{ ...item, status: 'cancelled' }]
    }
    return item.kind === 'thread' && item.state === 'running' ? [{ ...item, state: 'failed' }] : [item]
  })
}

/** Deletes chats (see the module comment); a second delete, or a list, of a chat being deleted joins the deletion under way. */
function createDeletions(deps: ChatRecordsDeps): (chat: ChatRecord) => Promise<void> {
  const finishing = new Map<string, Promise<void>>()
  return (chat) => {
    const key = JSON.stringify([chat.folder, chat.id])
    const under = finishing.get(key)
    if (under !== undefined) return under
    const deletion = (async () => {
      // First, and durably: a crash from here on finishes the deletion instead of provisioning the chat again.
      await deps.mailboxes?.delete(chat)
      await deps.beforeDelete?.(chat)
      deps.activity?.forgetChat(chat)
      if (chat.agent === 'omp') {
        await deps.removeOmpFolder?.(chat.id)
      }
      // Multi-project chats keep their private reach tokens here even when their cwd is a Forge World.
      if (chat.folder === null || hasForgeManifest(chat.folder)) await deps.removeScratch?.(chat.id)
      deps.store.deleteChat(chat)
    })().finally(() => finishing.delete(key))
    finishing.set(key, deletion)
    return deletion
  }
}

/** What the store creates for a request: the defaults filled in, and a pending title for a chat named from its first prompt. */
function newChat(request: NewChatRequest): NewChat {
  const input = {
    ...request,
    model: request.model ?? null,
    allowSave: request.allowSave ?? true,
    ...(request.firstPrompt === undefined ? {} : { firstPromptDelivery: 'pending' as const })
  }
  const naming =
    request.title === undefined &&
    request.firstPrompt !== undefined &&
    request.runId === undefined &&
    request.transferEpicId === undefined &&
    request.cardId === undefined &&
    request.conversation === undefined
  return naming ? { ...input, title: 'Naming chat…', titleStatus: 'pending' } : input
}

export interface LocalChatRecords extends ChatRecords {
  listChats(folder: string | null): ChatRecord[]
  createChat(request: NewChatRequest): ChatRecord
  renameChat(ref: ChatRef, title: string): ChatRecord
}

export function createChatRecords(deps: ChatRecordsDeps & { mailboxes?: undefined }): LocalChatRecords
export function createChatRecords(deps: ChatRecordsDeps): ChatRecords
export function createChatRecords(deps: ChatRecordsDeps): ChatRecords {
  const { store, mailboxes } = deps
  const finishDeletion = createDeletions(deps)
  const local: LocalChatRecords = {
    listChats: folder => store.listChats(folder).filter(chat => !chat.archived),
    createChat: request => {
      const agent = deps.agentFor(request.agent)
      // Forge setup runs only on the guarded terminal path, whatever the agent kind.
      const gui = request.forgeSetup === undefined && GUI_PROTOCOL_KINDS.some(kind => kind === agent?.kind)
      return store.createChat({ ...newChat(request), surface: gui ? 'gui' : 'terminal' })
    },
    renameChat: (ref, title) => store.updateChat(requireChat(store, ref), { title, titleStatus: 'manual' }),
    deleteChat: async (ref) => finishDeletion(requireChat(store, ref)),
    recoverFolder: async () => {},
    readChat: (ref, options) => {
      const chat = requireChat(store, ref)
      const transcript = store.readTranscript(chat)
      const items = transcript?.items ?? []
      return { chat: transcript?.chat ?? chat, items: options?.live ? items : settledItems(items) }
    },
    agentName: (id) => deps.agentFor(id)?.displayName ?? (isBuiltInAgentKind(id) ? AGENT_DEFINITIONS[id].displayName : 'This agent')
  }
  if (mailboxes === undefined) return local
  return {
    ...local,
    async listChats(folder) {
      const chats = local.listChats(folder)
      if (folder === null) return chats
      const reconciled = await mailboxes.recover(folder, chats)
      for (const chat of reconciled.deleting) {
        finishDeletion(chat).catch((error: unknown) => deps.onError?.(error))
      }
      return reconciled.chats
    },
    async createChat(request) {
      const chat = local.createChat(request)
      return chat.folder === null ? chat : (await mailboxes.reconcile(chat.folder, [chat])).chats[0] ?? chat
    },
    async renameChat(ref, title) {
      const chat = local.renameChat(ref, title)
      await mailboxes.rename(chat)
      return chat
    },
    async recoverFolder(folder) {
      const { deleting } = await mailboxes.recover(folder, store.listChats(folder))
      await Promise.all(deleting.map(finishDeletion))
    }
  }
}
