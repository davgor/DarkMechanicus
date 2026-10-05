/**
 * Maps the Claude Agent SDK's message stream onto the chat contract's events.
 *
 * Text. With partial messages on, the CLI streams `stream_event`s; text deltas become
 * `assistant_delta` events. The finished text arrives as an `assistant` message holding one content
 * block, and becomes the `assistant_text` item with the same id as its deltas: the API message id
 * plus the block's index in that message (the n-th block of one API message is the n-th block the
 * adapter sees for that message id, in either stream).
 *
 * Tools. A `tool_use` block becomes a `tool_call` item with status `running`; the `tool_result`
 * block that answers it (in a `user` message) re-emits the same item, by the same id, with the
 * outcome. Thinking and anything else the transcript has no place for is dropped.
 *
 * Subagent threads. The `Agent` tool (`Task` in older CLIs) starts a subagent. Its call becomes a
 * `thread` item right after the `tool_call` item, labelled with the call's description, and every
 * message the subagent sends (`parent_tool_use_id` is the id of that call) maps like the main
 * agent's, into that thread (`threadId`); a subagent that starts one of its own opens a thread inside
 * its own. A thread is `running` until it ends. A subagent the call waits for ends with the call's
 * result: `done`, or `failed` when the result is an error. One the CLI starts in the background
 * answers the call at once (`tool_use_result.status` is `async_launched`) and ends with a
 * `task_notification` (`completed`, or `failed`/`stopped` as `failed`). A foreground thread whose call
 * never got an answer ends as `failed` with the turn; `endThreads` fails the rest when the process is
 * gone. The CLI names the subagent behind a permission request by the id of its `task_started` message,
 * so `threadOfRequest` finds a request's thread by that id, or else by the tool call it is about.
 * Recorded from a real session in `__mocks__/claudeSubagents.ts`.
 *
 * Sign-in. A rejected login (expired, revoked, never done) arrives as a synthetic `assistant`
 * message with `error: 'authentication_failed'` and the CLI's words as its text, followed by an error
 * `result` (recorded from a real signed-out Claude Code in `__mocks__/claudeSignedOut.ts`). It becomes
 * one `auth_required` item, and the result that follows ends the turn without an error
 * (`authRequired`), so the turn is not also reported as a failure. A rejection inside a subagent is
 * not the chat's own and is dropped like any error message in a thread.
 *
 * Account problems. The same message with `error: 'oauth_org_not_allowed'`, `'account_on_hold'` or
 * `'verification_required'` (the SDK's names; see `claudeAccountProblems.ts`) is a state of the person's
 * account that signing in cannot fix. It becomes one `error` item that names the problem and carries the
 * CLI's words, never an `auth_required` item, and the result that follows ends the turn without an error.
 */
import type { SDKAssistantMessageError, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatAdapterEvent, ChatItem } from '../../../shared/agents/chat'
import { clipMasked } from '../claimTokenMask'
import { accountProblemOf, accountWords } from './claudeAccountProblems'

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>
type ThreadItem = Extract<ChatItem, { kind: 'thread' }>
type ToolInput = ToolCallItem['input']
type ResetReason = Extract<ChatItem, { kind: 'context_reset' }>['reason']

/** How the adapter tells a turn is over, and how. */
export interface TurnResult {
  /** Why the turn failed; null when it finished or was interrupted. */
  error: string | null
  /** The CLI named a startup failure (sign-in, policy, working folder) as the reason. */
  startupFailure: boolean
  /** The turn ended because the sign-in was rejected; an `auth_required` item was emitted for it and `error` is null. */
  authRequired: boolean
}

interface MappedMessage {
  events: ChatAdapterEvent[]
  /** Set on the result message that ends a turn. */
  result: TurnResult | null
}

/** A subagent's thread, kept from the moment its spawning call is seen. */
interface Thread {
  /** The id of the call that spawned it: what the subagent's messages name as `parent_tool_use_id`. */
  spawnId: string
  /** The thread item as last sent. */
  item: ThreadItem
  /** The subagent runs in the background: the call's answer only says it started, and its notification says how it ended. */
  background: boolean
}

/** The answer to one tool call, from a `tool_result` block. */
interface ToolAnswer {
  toolUseId: string
  isError: boolean
  content: unknown
}

const MAX_INPUT_STRING = 1000
const MAX_RESULT_CHARS = 500
const MAX_LABEL_CHARS = 120
/** Said when the CLI rejected the sign-in without giving words of its own. */
const SIGN_IN_AGAIN = 'Claude Code needs you to sign in again.'
/** What a thread is called when neither the call nor the CLI says. */
const FALLBACK_LABEL = 'Subagent'
/** The tools that start a subagent. */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The tool call that started the subagent this message comes from; null for the main agent's own messages. */
function parentOf(message: SDKMessage): string | null {
  return ('parent_tool_use_id' in message ? message.parent_tool_use_id : null) ?? null
}

/** A thread's name: the first of the candidates that says something, trimmed and cut to a short line. */
function labelOf(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const label = typeof candidate === 'string' ? candidate.trim() : ''
    if (label !== '') {
      return clipMasked(label, MAX_LABEL_CHARS)
    }
  }
  return FALLBACK_LABEL
}

/** The id of the thread an item belongs to; undefined for the chat's own. */
function idOf(thread: Thread | null): string | undefined {
  return thread === null ? undefined : thread.item.id
}

/** A tool's input as plain JSON with long strings cut (claim tokens masked first, so a cut cannot leave part of one), which is what the transcript stores. */
export function plainInput(input: unknown): ToolInput {
  try {
    const json = JSON.stringify(input, (_key, value: unknown) => (typeof value === 'string' ? clipMasked(value, MAX_INPUT_STRING) : value))
    return JSON.parse(json) as ToolInput
  } catch {
    return {}
  }
}

/** The text of a tool result, which the API sends as a string or as content blocks. */
function resultText(content: unknown): string | null {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? textBlocks(content) : ''
  if (text === '') {
    return null
  }
  return clipMasked(text, MAX_RESULT_CHARS)
}

function textBlocks(blocks: unknown[]): string {
  return blocks
    .flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
}

/**
 * What an Agent call's structured result holds: the subagent's own report, which reads better than the
 * hand-back text the model gets around it. Undefined when it has none.
 */
function reportOf(structured: unknown): unknown[] | undefined {
  const content = isRecord(structured) ? structured.content : undefined
  return Array.isArray(content) && textBlocks(content) !== '' ? content : undefined
}

/** The call only started a subagent in the background; how it ends comes later. */
function isLaunch(structured: unknown): boolean {
  return isRecord(structured) && (structured.isAsync === true || structured.status === 'async_launched')
}

interface TranscriptDeps {
  now: () => string
  newId: () => string
}

export class TranscriptMapper {
  private session: string | null = null
  /** Content blocks seen so far per API message id, so each block gets its index. */
  private readonly blocks = new Map<string, number>()
  /** The API message each stream's events currently describe, by thread (null for the main agent's own). */
  private readonly streaming = new Map<string | null, string>()
  private readonly calls = new Map<string, ToolCallItem>()
  private readonly denied = new Set<string>()
  /** Threads by the id of their spawning call. */
  private readonly threads = new Map<string, Thread>()
  /** The spawning call each subagent tool call ran under, by tool call id. */
  private readonly callSpawns = new Map<string, string>()
  /** The spawning call each subagent belongs to, by the id the CLI gave the subagent. */
  private readonly agentSpawns = new Map<string, string>()
  /** The CLI rejected the sign-in during the turn that is running. */
  private authReported = false
  /** The CLI reported a problem with the account during the turn that is running. */
  private problemReported = false

  constructor(private readonly deps: TranscriptDeps) {}

  /** Marks a tool call as turned down by the person, so its result reads `denied`, not `failed`. */
  deny(toolUseId: string): void {
    this.denied.add(toolUseId)
  }

  /** A context reset the adapter itself noticed (a session that could not be resumed). */
  reset(reason: ResetReason, message: string): ChatAdapterEvent {
    return this.resetItem(`claude_reset_${this.deps.newId()}`, reason, message)
  }

  /**
   * The thread a permission request was raised in, or null for the chat's own: found by the subagent's
   * id when the CLI gives one, else by the tool call the request is about.
   */
  threadOfRequest(toolUseId: string, agentId: string | undefined): { id: string; label: string } | null {
    const spawnId = (agentId === undefined ? undefined : this.agentSpawns.get(agentId)) ?? this.callSpawns.get(toolUseId)
    const thread = spawnId === undefined ? undefined : this.threads.get(spawnId)
    return thread === undefined ? null : { id: thread.item.id, label: thread.item.label }
  }

  /** Fails every thread still running, for a process that is gone: its subagents died with it. */
  endThreads(): ChatAdapterEvent[] {
    const events: ChatAdapterEvent[] = []
    for (const thread of this.threads.values()) {
      this.settle(thread, 'failed', events)
    }
    return events
  }

  map(message: SDKMessage): MappedMessage {
    const events: ChatAdapterEvent[] = []
    this.noteSession(message, events)
    const parent = parentOf(message)
    const thread = parent === null ? null : this.threadFor(parent, message, events)
    return { events, result: this.dispatch(message, events, thread) }
  }

  private dispatch(message: SDKMessage, events: ChatAdapterEvent[], thread: Thread | null): TurnResult | null {
    switch (message.type) {
      case 'assistant':
        this.assistant(message, events, thread)
        return null
      case 'user':
        this.user(message, events)
        return null
      case 'stream_event':
        this.stream(message, events, thread)
        return null
      case 'system':
        this.system(message, events)
        return null
      case 'conversation_reset':
        events.push(this.resetItem(`claude_reset_${message.uuid}`, 'clear', 'The conversation was cleared.'))
        return null
      case 'result':
        this.endForegroundThreads(events)
        return this.result(message)
      default:
        return null
    }
  }

  private noteSession(message: SDKMessage, events: ChatAdapterEvent[]): void {
    const sessionId = 'session_id' in message ? message.session_id : undefined
    if (typeof sessionId === 'string' && sessionId !== '' && sessionId !== this.session) {
      this.session = sessionId
      events.push({ type: 'session', sessionId })
    }
  }

  private assistant(message: Extract<SDKMessage, { type: 'assistant' }>, events: ChatAdapterEvent[], thread: Thread | null): void {
    if (message.error !== undefined) {
      // The CLI's own notice of an API failure: the failed result reports it once, except a rejected sign-in
      // and a problem with the account, which have an item of their own.
      if (thread === null) {
        this.rejected(message.error, message, events)
      }
      return
    }
    const id = message.message.id
    const first = this.blocks.get(id) ?? 0
    const content = message.message.content
    this.blocks.set(id, first + content.length)
    content.forEach((block, offset) => {
      if (block.type === 'text' && block.text.trim() !== '') {
        events.push(this.item({ id: `claude_${id}_${first + offset}`, kind: 'assistant_text', text: block.text }, idOf(thread)))
      } else if (block.type === 'tool_use') {
        this.startCall(block, thread, events)
      }
    })
  }

  /** The chat's own assistant message carries an `error`: a lost sign-in or a problem with the account has an item; any other waits for the failed result. */
  private rejected(error: SDKAssistantMessageError, message: Extract<SDKMessage, { type: 'assistant' }>, events: ChatAdapterEvent[]): void {
    if (error === 'authentication_failed') {
      this.rejectedSignIn(message, events)
      return
    }
    const problem = accountProblemOf(error)
    if (problem === undefined || this.problemReported) {
      return
    }
    this.problemReported = true
    const words = textBlocks(message.message.content as unknown[]).trim()
    events.push(this.item({ id: `claude_account_${message.uuid}`, kind: 'error', message: accountWords(problem, words), problem }))
  }

  private rejectedSignIn(message: Extract<SDKMessage, { type: 'assistant' }>, events: ChatAdapterEvent[]): void {
    if (this.authReported) {
      return
    }
    this.authReported = true
    const words = textBlocks(message.message.content as unknown[]).trim()
    events.push(this.item({ id: `claude_auth_${message.uuid}`, kind: 'auth_required', agent: 'claude', message: words === '' ? SIGN_IN_AGAIN : words }))
  }

  private startCall(block: { id: string; name: string; input: unknown }, thread: Thread | null, events: ChatAdapterEvent[]): void {
    const call = this.item(
      { id: `claude_tool_${block.id}`, kind: 'tool_call', name: block.name, input: plainInput(block.input), status: 'running', resultSummary: null },
      idOf(thread)
    ) as { type: 'item'; item: ToolCallItem }
    this.calls.set(block.id, call.item)
    events.push(call)
    if (thread !== null) {
      this.callSpawns.set(block.id, thread.spawnId)
    }
    if (SPAWN_TOOLS.has(block.name) && !this.threads.has(block.id)) {
      const input = isRecord(block.input) ? block.input : {}
      events.push(this.openThread(block.id, labelOf(input.description, input.subagent_type), idOf(thread)))
    }
  }

  /** The thread of a subagent's message; opened here for a subagent whose spawning call this process never saw (a resumed session). */
  private threadFor(parent: string, message: SDKMessage, events: ChatAdapterEvent[]): Thread {
    const known = this.threads.get(parent)
    if (known !== undefined) {
      return known
    }
    const hints = message as unknown as Record<string, unknown>
    const event = this.openThread(parent, labelOf(hints.task_description, hints.subagent_type), undefined)
    events.push(event)
    return this.threads.get(parent) as Thread
  }

  private openThread(spawnId: string, label: string, inThread: string | undefined): ChatAdapterEvent {
    const event = this.item(
      { id: `claude_thread_${spawnId}`, kind: 'thread', parentItemId: `claude_tool_${spawnId}`, label, state: 'running' },
      inThread
    ) as { type: 'item'; item: ThreadItem }
    this.threads.set(spawnId, { spawnId, item: event.item, background: false })
    return event
  }

  /** Ends a thread that is still running; a thread that already ended stays as it is. */
  private settle(thread: Thread, state: ThreadItem['state'], events: ChatAdapterEvent[]): void {
    if (thread.item.state !== 'running') {
      return
    }
    thread.item = { ...thread.item, state }
    events.push({ type: 'item', item: thread.item })
  }

  /** The turn is over, so a subagent its call was still waiting for is not coming back. */
  private endForegroundThreads(events: ChatAdapterEvent[]): void {
    for (const thread of this.threads.values()) {
      if (!thread.background) {
        this.settle(thread, 'failed', events)
      }
    }
  }

  private user(message: Extract<SDKMessage, { type: 'user' }>, events: ChatAdapterEvent[]): void {
    const content: unknown = message.message.content
    if (!Array.isArray(content)) {
      return
    }
    for (const block of content as unknown[]) {
      if (isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        this.answer({ toolUseId: block.tool_use_id, isError: block.is_error === true, content: block.content }, message.tool_use_result, events)
      }
    }
  }

  /** A tool call's answer: it finishes the call and, for a call that started a subagent, decides how its thread ends. */
  private answer(answer: ToolAnswer, structured: unknown, events: ChatAdapterEvent[]): void {
    const thread = this.threads.get(answer.toolUseId)
    const report = thread === undefined || answer.isError ? undefined : reportOf(structured)
    const done = this.finishCall(answer.toolUseId, answer.isError, report ?? answer.content)
    if (done !== null) {
      events.push(done)
    }
    if (thread === undefined) {
      return
    }
    if (isLaunch(structured)) {
      thread.background = true
    } else {
      this.settle(thread, answer.isError ? 'failed' : 'done', events)
    }
  }

  private finishCall(toolUseId: string, isError: boolean, content: unknown): ChatAdapterEvent | null {
    const call = this.calls.get(toolUseId)
    if (call === undefined) {
      return null
    }
    this.calls.delete(toolUseId)
    const status = this.denied.has(toolUseId) ? 'denied' : isError ? 'failed' : 'completed'
    return { type: 'item', item: { ...call, status, resultSummary: resultText(content) } }
  }

  private stream(message: Extract<SDKMessage, { type: 'stream_event' }>, events: ChatAdapterEvent[], thread: Thread | null): void {
    const event = message.event
    const key = thread === null ? null : thread.spawnId
    if (event.type === 'message_start') {
      this.streaming.set(key, event.message.id)
      return
    }
    const streaming = this.streaming.get(key)
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && streaming !== undefined) {
      const threadId = idOf(thread)
      events.push({
        type: 'assistant_delta',
        itemId: `claude_${streaming}_${event.index}`,
        delta: event.delta.text,
        ...(threadId === undefined ? {} : { threadId })
      })
    }
  }

  private system(message: Extract<SDKMessage, { type: 'system' }>, events: ChatAdapterEvent[]): void {
    if (message.subtype === 'compact_boundary') {
      events.push(this.resetItem(`claude_reset_${message.uuid}`, 'compact', 'The conversation was compacted to free up room.'))
    } else if (message.subtype === 'task_started') {
      this.subagentStarted(message)
    } else if (message.subtype === 'task_notification') {
      this.subagentEnded(message, events)
    }
  }

  /** The CLI names a subagent by its task id in permission requests; remember whose it is, and whether it runs in the background. */
  private subagentStarted(message: Extract<SDKMessage, { type: 'system'; subtype: 'task_started' }>): void {
    const thread = message.tool_use_id === undefined ? undefined : this.threads.get(message.tool_use_id)
    if (thread === undefined) {
      return
    }
    this.agentSpawns.set(message.task_id, thread.spawnId)
    if (message.is_backgrounded === true) {
      thread.background = true
    }
  }

  /** How a background subagent ended; the answer to the call of one it waited for says that instead. */
  private subagentEnded(message: Extract<SDKMessage, { type: 'system'; subtype: 'task_notification' }>, events: ChatAdapterEvent[]): void {
    const thread = message.tool_use_id === undefined ? undefined : this.threads.get(message.tool_use_id)
    if (thread?.background === true) {
      this.settle(thread, message.status === 'completed' ? 'done' : 'failed', events)
    }
  }

  private result(message: Extract<SDKMessage, { type: 'result' }>): TurnResult {
    if (this.authReported) {
      // The turn failed because the sign-in was rejected, which the item already says.
      this.authReported = false
      return { error: null, startupFailure: false, authRequired: true }
    }
    if (this.problemReported) {
      // The turn failed because of the account, which the item already says; the process is fine.
      this.problemReported = false
      return { error: null, startupFailure: false, authRequired: false }
    }
    if (message.subtype === 'success') {
      return { error: message.is_error ? message.result || 'The turn failed.' : null, startupFailure: false, authRequired: false }
    }
    const error = message.errors.length > 0 ? message.errors.join('; ') : message.subtype
    return { error, startupFailure: message.startup_failure_reason !== undefined, authRequired: false }
  }

  private resetItem(id: string, reason: ResetReason, message: string): ChatAdapterEvent {
    return this.item({ id, kind: 'context_reset', reason, message })
  }

  private item(item: DistributiveOmit<ChatItem, 'at'>, threadId?: string): ChatAdapterEvent {
    return { type: 'item', item: { ...item, at: this.deps.now(), ...(threadId === undefined ? {} : { threadId }) } as ChatItem }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
