/**
 * The provider-neutral chat contract: what a chat is, what its transcript holds, and the interface
 * every vendor adapter implements. The renderer, the session manager and the store share it, so it
 * stays free of Node imports.
 *
 * Stored transcripts are append-only JSON lines of `ChatItem`. A later line with the same item `id`
 * replaces the earlier one (a tool call going from `running` to `completed`). Items carry an
 * optional `threadId`; absent means the chat's own thread, so subagent threads can be added later
 * without migrating stored chats.
 */
import { z } from 'zod'
import { AGENT_KINDS } from '../desktop/agentKinds'
import type { AgentKind } from '../desktop/api'

/** Dark Mechanicus roles a chat can run as: the four roles the app's MCP server serves. */
export const CHAT_ROLES = ['planner', 'orchestrator', 'worker', 'reviewer'] as const

export type ChatRole = (typeof CHAT_ROLES)[number]

/** Only these roles may save plans, so `--allow-save` is only ever passed to them. */
const SAVING_ROLES: ReadonlySet<ChatRole> = new Set(['planner', 'orchestrator'])

export function canSavePlans(role: ChatRole): boolean {
  return SAVING_ROLES.has(role)
}

/** Chat ids name files on disk, so they are restricted to filesystem-safe characters. */
export const chatIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)

const timestampSchema = z.string().min(1)

export const chatRecordSchema = z.object({
  id: chatIdSchema,
  /** Canonical path of the folder the chat belongs to. */
  folder: z.string().min(1),
  agent: z.enum(AGENT_KINDS),
  /** The model the chat currently runs on; null until one is chosen. */
  model: z.string().min(1).nullable(),
  role: z.enum(CHAT_ROLES),
  allowSave: z.boolean(),
  title: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** The vendor's own session id, once the agent has reported it. */
  sessionId: z.string().min(1).nullable(),
  /** The run this chat orchestrates, when Dark Mechanicus started it for one; absent for every other chat and for chats stored before runs were recorded. */
  runId: z.string().min(1).optional(),
  /**
   * The id of the user message whose turn an expired sign-in cut short, so it can be sent again once
   * the agent is signed in (`chats:retryTurn`). Null or absent when no turn is waiting to be retried.
   */
  cutShortMessageId: z.string().min(1).nullable().optional()
})

export type ChatRecord = z.infer<typeof chatRecordSchema>

const toolInputSchema = z.record(z.string(), z.json())

const itemBase = {
  id: z.string().min(1),
  at: timestampSchema,
  /** The nested thread the item belongs to; absent for the chat's own thread. */
  threadId: z.string().min(1).optional()
}

const TOOL_CALL_STATUSES = ['running', 'completed', 'failed', 'denied'] as const

/** What an approval request asks to do. Reads and searches inside the folder never ask. */
const APPROVAL_CATEGORIES = ['file_edit', 'command', 'other'] as const

/**
 * The person's answers; each reaches the adapter as a distinct outcome. `allow_chat` also answers
 * later requests of the same category and tool in the same chat, until the app quits.
 */
export const APPROVAL_DECISIONS = ['allow_once', 'allow_chat', 'deny'] as const

/** A stored decision: an answer, or `cancelled` when no answer can reach the agent any more. */
const APPROVAL_OUTCOMES = [...APPROVAL_DECISIONS, 'cancelled'] as const

const CONTEXT_RESET_REASONS = ['model_change', 'compact', 'clear', 'session_lost'] as const

export const chatItemSchema = z.discriminatedUnion('kind', [
  z.object({ ...itemBase, kind: z.literal('user_message'), text: z.string() }),
  /** Streamed as deltas while the agent writes; stored once, whole. */
  z.object({ ...itemBase, kind: z.literal('assistant_text'), text: z.string() }),
  z.object({
    ...itemBase,
    kind: z.literal('tool_call'),
    name: z.string().min(1),
    /** The call's input, summarized by the adapter to what is worth showing. */
    input: toolInputSchema,
    status: z.enum(TOOL_CALL_STATUSES),
    resultSummary: z.string().nullable()
  }),
  z.object({
    ...itemBase,
    kind: z.literal('approval_request'),
    requestId: z.string().min(1),
    category: z.enum(APPROVAL_CATEGORIES),
    tool: z.string().min(1),
    summary: z.string(),
    /** The raw detail the vendor sent (the command, the edit), as the adapter passes it on. */
    input: toolInputSchema.optional()
  }),
  z.object({
    ...itemBase,
    kind: z.literal('approval_decision'),
    requestId: z.string().min(1),
    decision: z.enum(APPROVAL_OUTCOMES),
    /** True when an earlier Allow for this chat answered it without asking. */
    automatic: z.boolean().optional()
  }),
  z.object({ ...itemBase, kind: z.literal('model_change'), from: z.string().nullable(), to: z.string().min(1) }),
  z.object({ ...itemBase, kind: z.literal('error'), message: z.string(), code: z.string().optional() }),
  z.object({
    ...itemBase,
    kind: z.literal('context_reset'),
    reason: z.enum(CONTEXT_RESET_REASONS),
    message: z.string().optional()
  }),
  /**
   * The agent's CLI said its sign-in is gone (expired, revoked, never done) and ended the turn. `message`
   * is the CLI's own words, with claim tokens masked when stored; `at` is when it said so. The message
   * that was cut short is recorded on the chat (`cutShortMessageId`).
   */
  z.object({ ...itemBase, kind: z.literal('auth_required'), agent: z.enum(AGENT_KINDS), message: z.string() })
])

export type ChatItem = z.infer<typeof chatItemSchema>

export type ApprovalRequestItem = Extract<ChatItem, { kind: 'approval_request' }>

export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number]

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number]

/** A model an agent offers, as shown in the model picker. */
export interface ModelOption {
  id: string
  label: string
}

/** A ready-made MCP server entry: the command to launch and its arguments. */
export interface McpServerSpec {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** What an adapter needs to start (or resume) a chat's agent session. */
export interface ChatAdapterStartOptions {
  chatId: string
  /** Canonical folder the agent works in: the process runs with it as its working directory. */
  folder: string
  model: string | null
  role: ChatRole
  allowSave: boolean
  /** The vendor session to resume; null starts a new one. */
  sessionId: string | null
  /**
   * The chat's Dark Mechanicus MCP server, with role, label and save permission already in its
   * arguments. The adapter hands it to the vendor as the `darkmechanicus` server.
   */
  darkMechanicus: McpServerSpec
}

/** Everything an adapter reports while it runs. */
export type ChatAdapterEvent =
  /** A finished transcript item (or a status update of an earlier one, by the same id). */
  | { type: 'item'; item: ChatItem }
  /** A piece of the assistant text `itemId` that is still being written; the whole text follows as an item. */
  | { type: 'assistant_delta'; itemId: string; delta: string; threadId?: string }
  /**
   * The agent needs a decision; the adapter holds the vendor until `respond` is called. The manager
   * records the request and the decision items.
   */
  | { type: 'approval_request'; request: ApprovalRequestItem; respond: (decision: ApprovalDecision) => void }
  /** The vendor's session id, as soon as it is known. */
  | { type: 'session'; sessionId: string }

export type ChatAdapterEmit = (event: ChatAdapterEvent) => void

/**
 * One live agent session for one chat. Vendor adapters implement it; the session manager drives it.
 * Reads and searches inside the folder never raise an approval request (the adapter configures the
 * vendor that way); file edits, commands and anything else do.
 */
export interface ChatAdapter {
  readonly kind: AgentKind
  /** Starts or resumes the session; events flow to `emit` until `dispose`. */
  start(options: ChatAdapterStartOptions, emit: ChatAdapterEmit): Promise<void>
  /** Sends a user message and runs one turn: resolves when the turn has ended (finished or stopped), rejects when it failed. */
  send(text: string): Promise<void>
  /** Switches the model for the following turns. */
  setModel(model: string): Promise<void>
  /** Interrupts the current turn, so the pending `send` settles; the session stays usable. */
  stop(): Promise<void>
  /** The models this agent offers. */
  listModels(): Promise<ModelOption[]>
  /** Ends the session and kills its whole process tree (no orphans on Windows or macOS); no events follow. */
  dispose(): Promise<void>
}
