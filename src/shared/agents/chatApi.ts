/**
 * The chat surface of the desktop bridge (`window.dm.chats`): one `chats:*` IPC channel per request
 * and one push channel for what running chats report. The renderer names folders, chats, agent
 * kinds, models, roles, text and decisions only; which executable runs and the Dark Mechanicus MCP
 * arguments are decided in the main process.
 */
import type { AgentKind, CommandResult } from '../desktop/api'
import type { RunView } from '../domain/views'
import type { ApprovalDecision, ApprovalRequestItem, ChatItem, ChatRecord, ChatRole, ModelOption } from './chat'

/** Main pushes every `ChatPushEvent` to the window on this channel. */
export const CHAT_EVENT_CHANNEL = 'chats:event'

/** Names one chat: the tracked folder it belongs to and its id. */
export interface ChatRequestRef {
  folder: string
  chatId: string
}

export interface CreateChatRequest {
  folder: string
  agent: AgentKind
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
  agent: AgentKind
  /** Null (or left out) lets the agent use its default model. */
  model?: string | null
}

/** What starting an orchestrator left behind. The run is queued either way; the chat exists only when its agent was started. */
export interface StartOrchestratorResult {
  run: RunView
  /** The orchestrator chat, with its kickoff message already sent; null when no agent is running the run. */
  chat: ChatRecord | null
  /** Why `chat` is null (or what went wrong with a chat that was kept); the run waits for an orchestrator. Null when it started. */
  problem: string | null
}

export interface SendChatRequest extends ChatRequestRef {
  text: string
}

export interface SetChatModelRequest extends ChatRequestRef {
  model: string
}

interface RenameChatRequest extends ChatRequestRef {
  /** The new title; trimmed, and never empty. */
  title: string
}

export interface AnswerApprovalRequest extends ChatRequestRef {
  requestId: string
  decision: ApprovalDecision
}

/** A chat as listed: its record and how many approval requests it is waiting on (none once answered or cancelled). */
export interface ChatSummary extends ChatRecord {
  pending: number
}

/** An opened chat: its transcript and what is live in the main process right now. */
export interface ChatOpenView {
  chat: ChatRecord
  items: ChatItem[]
  /** Approval requests still waiting for an answer, oldest first. */
  pending: ApprovalRequestItem[]
  /** True while a turn is running. */
  running: boolean
}

export type ChatPushEvent =
  /** A stored transcript item (masked), in the order it was stored; approval requests arrive this way. */
  | { type: 'item'; chatId: string; item: ChatItem }
  /** More of an assistant text that is still being written (masked); the whole text follows as an item. */
  | { type: 'assistant_delta'; chatId: string; itemId: string; delta: string; threadId?: string }
  /** A turn started or ended. */
  | { type: 'turn'; chatId: string; running: boolean }
  /**
   * The sign-in of the chat's agent changed: a chat found it gone (`signed_out`, with an `auth_required`
   * item in the chat that found it), or the person signed in again and the CLI says so (`signed_in`).
   * Sent for every chat of that agent that was opened since the app started, so they all agree.
   */
  | { type: 'agent_auth'; chatId: string; agent: AgentKind; state: 'signed_out' | 'signed_in' }

export interface ChatsApi {
  /** A tracked folder's chats, most recently updated first, each with its waiting requests. */
  list(folder: string): Promise<CommandResult<ChatSummary[]>>
  create(request: CreateChatRequest): Promise<CommandResult<ChatRecord>>
  /**
   * Queues a run of the epic, creates an orchestrator chat for it with Allow save off, records the run's
   * id on the chat and sends the kickoff message. A failure after the run is queued is reported in the
   * result (the run is still queued); a failure before it is an error and nothing was created.
   */
  startOrchestrator(request: StartOrchestratorRequest): Promise<CommandResult<StartOrchestratorResult>>
  /** The transcript and pending approvals; starts the agent when its vendor needs it running. */
  open(request: ChatRequestRef): Promise<CommandResult<ChatOpenView>>
  /** Stores the message and starts a turn (and the agent, on the first message); returns the stored message. */
  send(request: SendChatRequest): Promise<CommandResult<ChatItem>>
  /** Ends the running turn; pending approvals are cancelled. */
  stop(request: ChatRequestRef): Promise<CommandResult<null>>
  /**
   * Sends the message a sign-in cut short, once, and returns it. Refused while the agent is still signed
   * out, and when no turn is waiting to be retried. Nothing is ever sent again without this call.
   */
  retryTurn(request: ChatRequestRef): Promise<CommandResult<ChatItem>>
  /** Switches the model from the next turn on and records the change. */
  setModel(request: SetChatModelRequest): Promise<CommandResult<ChatRecord>>
  /** Changes the chat's title and returns the updated chat. */
  rename(request: RenameChatRequest): Promise<CommandResult<ChatRecord>>
  /** Ends the chat's agent and removes the chat and its transcript from the app-wide store. */
  delete(request: ChatRequestRef): Promise<CommandResult<null>>
  answerApproval(request: AnswerApprovalRequest): Promise<CommandResult<null>>
  /** The models a connected agent offers. */
  models(kind: AgentKind): Promise<CommandResult<ModelOption[]>>
  /** Subscribes to pushed chat events; returns the unsubscribe function. */
  onEvent(listener: (event: ChatPushEvent) => void): () => void
}
