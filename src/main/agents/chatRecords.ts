/**
 * The chats as records: listing, creating, renaming and deleting them, and reading the transcript a chat stored
 * before chats became terminals. Nothing here runs an agent: every chat runs in its terminal (`terminalSessions.ts`).
 *
 * Reading is read-only (`readChat`, for Earlier conversation and the panels that follow an old chat's thread): it
 * writes nothing. No agent can still answer what an old transcript left open, so a stored approval request with no
 * decision is shown cancelled, a call still running is shown cancelled and a thread still running failed, in the
 * returned items only.
 *
 * Deleting a chat forgets its item-based activity bindings (`activityBindings.ts`, kept for old chats) before the
 * chat itself is removed.
 */
import { DomainError } from '../../core/errors'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import type { ChatReadView, CreateChatRequest } from '../../shared/agents/chatApi'
import { AGENT_DEFINITIONS, isBuiltInAgentKind } from '../../shared/desktop/agentKinds'
import type { AgentId, AgentView } from '../../shared/desktop/api'
import type { ActivityBindings } from './activityBindings'
import type { ChatRef, ChatStore } from './chatStore'

interface ChatRecordsDeps {
  store: ChatStore
  /** The connected agent with this id (agent registry); null when it is not connected. */
  agentFor: (id: AgentId) => AgentView | null
  /** The item-based bindings of old chats; a deleted chat's are forgotten. Without it there are none. */
  activity?: Pick<ActivityBindings, 'forgetChat'>
  /** Removes an OMP chat's own folder when the chat is deleted (`ompSession.ts`); without it nothing is removed. */
  removeOmpFolder?: (chatId: string) => Promise<void>
}

/** A request to create a chat, with the run it orchestrates, the epic it transfers or the Kanban card it carries when there is one. */
type NewChatRequest = CreateChatRequest & Pick<ChatRecord, 'runId' | 'transferEpicId' | 'cardId'>

export interface ChatRecords {
  /** A folder's chats, most recently updated first. */
  listChats(folder: string): ChatRecord[]
  /**
   * `runId` links the chat to the run it orchestrates, `transferEpicId` to the epic it moves to Linear, `cardId` to the
   * Kanban card it carries; only main sets them (the `chats:create` request cannot).
   */
  createChat(request: NewChatRequest): ChatRecord
  /** Changes the chat's title. */
  renameChat(ref: ChatRef, title: string): ChatRecord
  /** Names an eligible chat once from an explicitly submitted app prompt; current persisted manual titles always win. */
  nameFromQuestion(ref: ChatRef, question: string): ChatRecord | null
  /** Removes the chat's activity bindings, then the chat and its transcript; throws `not_found` for an unknown chat. */
  deleteChat(ref: ChatRef): Promise<void>
  /** The chat and its stored transcript, settled as described above; writes nothing. Throws `not_found` for an unknown chat. */
  readChat(ref: ChatRef): ChatReadView
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

/** A local, bounded title: no model call, credentials or asynchronous rename race. */
function questionTitle(question: string): string {
  const text = question.replace(/\s+/gu, ' ').trim()
  if (text.length <= 64) return text
  const prefix = text.slice(0, 63)
  const boundary = prefix.lastIndexOf(' ')
  return `${boundary > 0 ? prefix.slice(0, boundary) : prefix}…`
}

export function createChatRecords(deps: ChatRecordsDeps): ChatRecords {
  const { store } = deps
  return {
    listChats: (folder) => store.listChats(folder),
    createChat: (request) =>
      store.createChat({
        folder: request.folder,
        agent: request.agent,
        role: request.role,
        model: request.model ?? null,
        allowSave: request.allowSave ?? true,
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.runId === undefined ? {} : { runId: request.runId }),
        ...(request.transferEpicId === undefined ? {} : { transferEpicId: request.transferEpicId }),
        ...(request.cardId === undefined ? {} : { cardId: request.cardId })
      }),
    renameChat: (ref, title) => store.updateChat(requireChat(store, ref), { title, autoTitlePending: false }),
    nameFromQuestion: (ref, question) => {
      const title = questionTitle(question)
      const chat = requireChat(store, ref)
      if (!title || chat.autoTitlePending !== true || chat.runId !== undefined || chat.transferEpicId !== undefined || chat.cardId !== undefined) return null
      return store.updateChat(chat, { title, autoTitlePending: false })
    },
    deleteChat: async (ref) => {
      const chat = requireChat(store, ref)
      deps.activity?.forgetChat(chat)
      if (chat.agent === 'omp') {
        await deps.removeOmpFolder?.(chat.id)
      }
      store.deleteChat(chat)
    },
    readChat: (ref) => {
      const chat = requireChat(store, ref)
      const transcript = store.readTranscript(chat)
      return { chat: transcript?.chat ?? chat, items: settledItems(transcript?.items ?? []) }
    },
    agentName: (id) => deps.agentFor(id)?.displayName ?? (isBuiltInAgentKind(id) ? AGENT_DEFINITIONS[id].displayName : 'This agent')
  }
}
