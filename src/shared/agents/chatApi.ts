/**
 * The chat surface of the desktop bridge (`window.dm.chats`): one `chats:*` IPC channel per request
 * and one push channel that tells every window a folder's chats changed. The renderer names folders,
 * chats, agent ids, models, roles and titles only; which executable runs and the Dark Mechanicus
 * arguments are decided in the main process. Each chat runs in its terminal (`terminalApi.ts`).
 */
import type { AgentId, CommandResult } from '../desktop/api'
import type { RunView } from '../domain/views'
import type { ChatItem, ChatRecord, ChatRole } from './chat'

/** Main pushes every `ChatPushEvent` to the window on this channel. */
export const CHAT_EVENT_CHANNEL = 'chats:event'

/** Names one chat: the tracked folder it belongs to and its id. */
export interface ChatRequestRef {
  folder: string
  chatId: string
}

export interface CreateChatRequest {
  folder: string
  agent: AgentId
  role: ChatRole
  /** Null (or left out) lets the agent use its default model. */
  model?: string | null
  /** Lets the chat save plans (`--allow-save`); on unless turned off. */
  allowSave?: boolean
  title?: string
}

/** Starts a connected agent as the orchestrator of a new run of an epic; the role, Allow save and the chat title are decided in main. */
export interface StartOrchestratorRequest {
  folder: string
  epicId: string
  agent: AgentId
  /** Null (or left out) lets the agent use its default model. */
  model?: string | null
}

/** What starting an orchestrator left behind. The run is queued either way; the chat exists only when its agent was started. */
export interface StartOrchestratorResult {
  run: RunView
  /** The orchestrator chat, whose terminal was started; null when no agent is running the run. */
  chat: ChatRecord | null
  /** Why `chat` is null (or what went wrong with a chat that was kept); the run waits for an orchestrator. Null when it started. */
  problem: string | null
}

interface RenameChatRequest extends ChatRequestRef {
  /** The new title; trimmed, and never empty. */
  title: string
}

/** A chat and the transcript it stored before chats became terminals (empty for a chat that stored none). */
export interface ChatReadView {
  chat: ChatRecord
  items: ChatItem[]
}

/** What to look bound threads up by: an attempt (a worker's thread) or a run (its orchestrator), in a tracked folder. */
export type BoundThreadsRequest = { folder: string; attemptId: string } | { folder: string; runId: string }

/**
 * A thread of an old chat bound to an attempt or a run, as the chat stored the binding before chats became
 * terminals: the chat (`folder`, `chatId`) and the thread in it (a `thread` item's id, or null for the chat's main
 * thread) with what it was to the target. Enough to `read` the chat; the stored items are already masked.
 */
export interface BoundThread {
  folder: string
  chatId: string
  threadId: string | null
  role: 'orchestrator' | 'worker'
}

/** A chat was created, renamed or deleted (`chatId` is that chat): every window lists the folder's chats again, so none shows a stale list. */
export type ChatPushEvent = { type: 'chats_changed'; folder: string; chatId: string }

export interface ChatsApi {
  /** A tracked folder's chats, most recently updated first. */
  list(folder: string): Promise<CommandResult<ChatRecord[]>>
  create(request: CreateChatRequest): Promise<CommandResult<ChatRecord>>
  /**
   * Queues a run of the epic, creates an orchestrator chat for it with Allow save off, records the run's
   * id on the chat and starts its terminal. A failure after the run is queued is reported in the
   * result (the run is still queued); a failure before it is an error and nothing was created.
   */
  startOrchestrator(request: StartOrchestratorRequest): Promise<CommandResult<StartOrchestratorResult>>
  /**
   * The chat and its stored transcript, read-only: nothing is started or written. A stored request no decision
   * was stored for comes back cancelled, and calls and threads left running come back cancelled or failed.
   */
  read(request: ChatRequestRef): Promise<CommandResult<ChatReadView>>
  /**
   * The threads of old chats of that folder bound to one attempt or run, in the order bound: a worker's
   * thread, or the chat that orchestrated. None while nothing is bound.
   */
  boundThreads(request: BoundThreadsRequest): Promise<CommandResult<BoundThread[]>>
  /**
   * The id of the chat of that folder whose terminal the attempt or run is bound to by grant: the chat that was
   * issued the grant of the session that claimed the attempt (or started the run). Null while none is; asking
   * again later may find one, once that session has acted.
   */
  boundTerminal(request: BoundThreadsRequest): Promise<CommandResult<string | null>>
  /** Changes the chat's title and returns the updated chat. */
  rename(request: RenameChatRequest): Promise<CommandResult<ChatRecord>>
  /** Ends the chat's terminal and removes the chat and its transcript from the app-wide store. */
  delete(request: ChatRequestRef): Promise<CommandResult<null>>
  /** Subscribes to pushed chat events; returns the unsubscribe function. */
  onEvent(listener: (event: ChatPushEvent) => void): () => void
}
