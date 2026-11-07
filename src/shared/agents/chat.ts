/**
 * The chat contract: what a chat is and what the transcript a chat stored before chats became terminals
 * holds. Main, the renderer and the store share it, so it stays free of Node imports.
 *
 * Stored transcripts are JSON lines of `ChatItem`, read-only since chats run in terminals. A later line with
 * the same item `id` replaces the earlier one (a tool call going from `running` to `completed`). Items carry an
 * optional `threadId`; absent means the chat's own thread, so chats stored before nested threads existed need
 * no migration.
 *
 * Nested threads. The work a subagent did is a thread: a `thread` item (in the thread of whoever
 * started it, the chat's own or another subagent's) names the tool call that spawned it
 * (`parentItemId`), a `label` and a `state`, and every item of the subagent carries that thread
 * item's `id` as its `threadId`. The thread item was written again, by the same id, when its state
 * changed. An approval request raised inside a thread carries its `threadId` and `threadLabel`.
 *
 * Ended work. A turn the person stopped left a `turn_stopped` item. A tool call or thread that could not
 * finish because its agent ended was written again, by the same id, as `cancelled` (a call) or `failed`
 * (a thread).
 */
import { z } from 'zod'
import { agentIdSchema } from '../desktop/agentKinds'

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
  /** The agent's id. Built-in ids equal the kind names stored before agents had ids, so old lines load unchanged. */
  agent: agentIdSchema,
  /** The model the chat currently runs on; null until one is chosen. */
  model: z.string().min(1).nullable(),
  role: z.enum(CHAT_ROLES),
  allowSave: z.boolean(),
  title: z.string(),
  /** Only new, implicitly titled chats may take a title from the first app-composer prompt. Absent on older chats. */
  autoTitlePending: z.boolean().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** The vendor's own session id, once the agent has reported it. */
  sessionId: z.string().min(1).nullable(),
  /** The run this chat orchestrates, when Dark Mechanicus started it for one; absent for every other chat and for chats stored before runs were recorded. */
  runId: z.string().min(1).optional(),
  /** The epic this chat moves to Linear, when Dark Mechanicus started it as a transfer chat; absent for every other chat and for chats stored before transfers. */
  transferEpicId: z.string().min(1).optional(),
  /** The Kanban card this chat carries, when Play started it; absent for every other chat and for chats stored before Kanban. */
  cardId: z.string().min(1).optional(),
  /**
   * The id of the user message whose turn an expired sign-in cut short, as chats stored it before they became
   * terminals. Null or absent when no turn was waiting to be retried; nothing sets it any more.
   */
  cutShortMessageId: z.string().min(1).nullable().optional(),
  /**
   * The ids of the grants issued to the chat's terminal, oldest first, each stored before the process it went to
   * started; absent for a chat whose terminal never started.
   */
  grantIds: z.array(z.string().min(1)).optional(),
  /**
   * Whether the chat's CLI has a session a later start resumes (`a8s resume`, Codex and Cursor by their stored id):
   * set once the person first types into the chat's terminal, cleared by New session; absent until then. Not used
   * for Claude Code, whose session is known to exist by its session file (`claudeSession.ts`).
   */
  sessionStarted: z.boolean().optional(),
  /**
   * Whether the kickoff went with the terminal of the chat Start run (or Transfer with agent) opened: set when it went on the
   * command line (Claude Code's prompt, stored before the spawn) or was pasted; absent until then. A start of a
   * chat that has it set never sends the kickoff again.
   */
  kickoffSent: z.boolean().optional()
})

export type ChatRecord = z.infer<typeof chatRecordSchema>

const toolInputSchema = z.record(z.string(), z.json())

const itemBase = {
  id: z.string().min(1),
  at: timestampSchema,
  /** The nested thread the item belongs to; absent for the chat's own thread. */
  threadId: z.string().min(1).optional()
}

/** `cancelled`: the call can no longer finish, because its turn was stopped or its agent ended (quit, idle stop, a failed turn). */
const TOOL_CALL_STATUSES = ['running', 'completed', 'failed', 'denied', 'cancelled'] as const

/** What an approval request asks to do. Reads and searches inside the folder never ask. */
const APPROVAL_CATEGORIES = ['file_edit', 'command', 'other'] as const

/**
 * The person's answers; each reaches the adapter as a distinct outcome. `allow_chat` also answers
 * later requests of the same category and tool in the same chat, until the app quits. On a call to a
 * tool of the chat's own Dark Mechanicus server it answers later calls to any tool of that server.
 */
const APPROVAL_DECISIONS = ['allow_once', 'allow_chat', 'deny'] as const

/** A stored decision: an answer, or `cancelled` when no answer can reach the agent any more. */
const APPROVAL_OUTCOMES = [...APPROVAL_DECISIONS, 'cancelled'] as const

const CONTEXT_RESET_REASONS = ['model_change', 'compact', 'clear', 'session_lost'] as const

/** How a nested thread is going: its subagent is working, finished, or ended without finishing. */
const THREAD_STATES = ['running', 'done', 'failed'] as const

/**
 * What an `error` item says is wrong with the person's account at the agent's vendor, for the states that
 * signing in again cannot fix: the account's organization does not allow the agent, the account is on hold,
 * or it has to be verified first. Named by what they are, not by any vendor's wording; each adapter maps its
 * own error names onto them.
 */
export const ERROR_PROBLEMS = ['organization_not_allowed', 'account_on_hold', 'verification_required'] as const

export type ErrorProblem = (typeof ERROR_PROBLEMS)[number]

/**
 * The `code` of the `error` item the session manager stores when it stops an agent that sat idle with nothing
 * running. Nothing failed: the transcript shows it as a notice, and the next message starts the agent again.
 */
export const IDLE_STOP_CODE = 'idle_stop'

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
    input: toolInputSchema.optional(),
    /** The label of the thread (`threadId`) the request was raised in; absent in the chat's own thread. */
    threadLabel: z.string().min(1).optional(),
    /**
     * Set by the session manager, never by an adapter: the request is a call to a tool of the chat's own Dark
     * Mechanicus server, so Allow for this chat covers every tool of that server. Absent for any other request.
     */
    ownServer: z.boolean().optional()
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
  z.object({
    ...itemBase,
    kind: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
    /** Set when the error is a state of the person's account (see `ERROR_PROBLEMS`); a plain failure leaves it out, as every error stored before did. */
    problem: z.enum(ERROR_PROBLEMS).optional()
  }),
  /** The person pressed Stop and the turn ended; it sits after whatever the agent had stored by then, so a message with no reply still says why. */
  z.object({ ...itemBase, kind: z.literal('turn_stopped') }),
  z.object({
    ...itemBase,
    kind: z.literal('context_reset'),
    reason: z.enum(CONTEXT_RESET_REASONS),
    message: z.string().optional()
  }),
  /**
   * The agent's CLI said its sign-in is gone (expired, revoked, never done) and ended the turn. `message`
   * is the CLI's own words, with claim tokens masked when stored; `at` is when it said so. The message
   * that was cut short is recorded on the chat (`cutShortMessageId`). `cutShort` says whether a turn was
   * waiting to be sent again when this was stored; it is false for a sign-in lost while no turn ran, and
   * absent on items stored before it existed.
   */
  z.object({ ...itemBase, kind: z.literal('auth_required'), agent: agentIdSchema, message: z.string(), cutShort: z.boolean().optional() }),
  /**
   * A nested thread: the work of a subagent. The items inside carry this item's `id` as their
   * `threadId`; this item is rewritten, by the same id, as `state` changes.
   */
  z.object({
    ...itemBase,
    kind: z.literal('thread'),
    /** The item (a tool call) that spawned the thread. */
    parentItemId: z.string().min(1),
    /** What the subagent was asked to do, in a few words. */
    label: z.string().min(1),
    state: z.enum(THREAD_STATES)
  })
])

export type ChatItem = z.infer<typeof chatItemSchema>

export type ApprovalRequestItem = Extract<ChatItem, { kind: 'approval_request' }>

/** The exact `dm` invocation a chat may make, and the environment that authorizes it. */
export interface DarkMechanicusCli {
  command: string
  /** The script and the repository it is pinned to: `[<cli.js>, '--repo', <folder>]`. */
  args: string[]
  /** Carries `DM_SESSION_TOKEN`, and the runtime switches the packaged app needs. */
  env: Record<string, string>
}
