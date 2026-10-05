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
 * outcome. Subagent traffic (`parent_tool_use_id` set), thinking and anything else the transcript
 * has no place for is dropped.
 *
 * Sign-in. A rejected login (expired, revoked, never done) arrives as a synthetic `assistant`
 * message with `error: 'authentication_failed'` and the CLI's words as its text, followed by an error
 * `result` (recorded from a real signed-out Claude Code in `__mocks__/claudeSignedOut.ts`). It becomes
 * one `auth_required` item, and the result that follows ends the turn without an error
 * (`authRequired`), so the turn is not also reported as a failure.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatAdapterEvent, ChatItem } from '../../../shared/agents/chat'

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>
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

const MAX_INPUT_STRING = 1000
const MAX_RESULT_CHARS = 500
/** Said when the CLI rejected the sign-in without giving words of its own. */
const SIGN_IN_AGAIN = 'Claude Code needs you to sign in again.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Messages from inside a subagent: the chat shows the call that started it, not its inner workings. */
function isSubagentTraffic(message: SDKMessage): boolean {
  const parent = 'parent_tool_use_id' in message ? message.parent_tool_use_id : null
  return parent !== null && parent !== undefined
}

/** A tool's input as plain JSON with long strings cut, which is what the transcript stores. */
export function plainInput(input: unknown): ToolInput {
  try {
    const json = JSON.stringify(input, (_key, value: unknown) =>
      typeof value === 'string' && value.length > MAX_INPUT_STRING ? `${value.slice(0, MAX_INPUT_STRING)}…` : value
    )
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
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text
}

function textBlocks(blocks: unknown[]): string {
  return blocks
    .flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
}

interface TranscriptDeps {
  now: () => string
  newId: () => string
}

export class TranscriptMapper {
  private session: string | null = null
  /** Content blocks seen so far per API message id, so each block gets its index. */
  private readonly blocks = new Map<string, number>()
  /** The API message the stream events currently describe. */
  private streaming: string | null = null
  private readonly calls = new Map<string, ToolCallItem>()
  private readonly denied = new Set<string>()
  /** The CLI rejected the sign-in during the turn that is running. */
  private authReported = false

  constructor(private readonly deps: TranscriptDeps) {}

  /** Marks a tool call as turned down by the person, so its result reads `denied`, not `failed`. */
  deny(toolUseId: string): void {
    this.denied.add(toolUseId)
  }

  /** A context reset the adapter itself noticed (a session that could not be resumed). */
  reset(reason: ResetReason, message: string): ChatAdapterEvent {
    return this.resetItem(`claude_reset_${this.deps.newId()}`, reason, message)
  }

  map(message: SDKMessage): MappedMessage {
    const events: ChatAdapterEvent[] = []
    this.noteSession(message, events)
    if (isSubagentTraffic(message)) {
      return { events, result: null }
    }
    return { events, result: this.dispatch(message, events) }
  }

  private dispatch(message: SDKMessage, events: ChatAdapterEvent[]): TurnResult | null {
    switch (message.type) {
      case 'assistant':
        this.assistant(message, events)
        return null
      case 'user':
        this.user(message, events)
        return null
      case 'stream_event':
        this.stream(message, events)
        return null
      case 'system':
        this.system(message, events)
        return null
      case 'conversation_reset':
        events.push(this.resetItem(`claude_reset_${message.uuid}`, 'clear', 'The conversation was cleared.'))
        return null
      case 'result':
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

  private assistant(message: Extract<SDKMessage, { type: 'assistant' }>, events: ChatAdapterEvent[]): void {
    if (message.error !== undefined) {
      // The CLI's own notice of an API failure: the failed result reports it once, except a rejected sign-in, which has an item of its own.
      if (message.error === 'authentication_failed') {
        this.rejectedSignIn(message, events)
      }
      return
    }
    const id = message.message.id
    const first = this.blocks.get(id) ?? 0
    const content = message.message.content
    this.blocks.set(id, first + content.length)
    content.forEach((block, offset) => {
      if (block.type === 'text' && block.text.trim() !== '') {
        events.push(this.item({ id: `claude_${id}_${first + offset}`, kind: 'assistant_text', text: block.text }))
      } else if (block.type === 'tool_use') {
        events.push(this.startCall(block.id, block.name, block.input))
      }
    })
  }

  private rejectedSignIn(message: Extract<SDKMessage, { type: 'assistant' }>, events: ChatAdapterEvent[]): void {
    if (this.authReported) {
      return
    }
    this.authReported = true
    const words = textBlocks(message.message.content as unknown[]).trim()
    events.push(this.item({ id: `claude_auth_${message.uuid}`, kind: 'auth_required', agent: 'claude', message: words === '' ? SIGN_IN_AGAIN : words }))
  }

  private startCall(toolUseId: string, name: string, input: unknown): ChatAdapterEvent {
    const item = this.item({
      id: `claude_tool_${toolUseId}`,
      kind: 'tool_call',
      name,
      input: plainInput(input),
      status: 'running',
      resultSummary: null
    }) as { type: 'item'; item: ToolCallItem }
    this.calls.set(toolUseId, item.item)
    return item
  }

  private user(message: Extract<SDKMessage, { type: 'user' }>, events: ChatAdapterEvent[]): void {
    const content: unknown = message.message.content
    if (!Array.isArray(content)) {
      return
    }
    for (const block of content as unknown[]) {
      if (isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const done = this.finishCall(block.tool_use_id, block.is_error === true, block.content)
        if (done !== null) {
          events.push(done)
        }
      }
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

  private stream(message: Extract<SDKMessage, { type: 'stream_event' }>, events: ChatAdapterEvent[]): void {
    const event = message.event
    if (event.type === 'message_start') {
      this.streaming = event.message.id
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && this.streaming !== null) {
      events.push({ type: 'assistant_delta', itemId: `claude_${this.streaming}_${event.index}`, delta: event.delta.text })
    }
  }

  private system(message: Extract<SDKMessage, { type: 'system' }>, events: ChatAdapterEvent[]): void {
    if (message.subtype === 'compact_boundary') {
      events.push(this.resetItem(`claude_reset_${message.uuid}`, 'compact', 'The conversation was compacted to free up room.'))
    }
  }

  private result(message: Extract<SDKMessage, { type: 'result' }>): TurnResult {
    if (this.authReported) {
      // The turn failed because the sign-in was rejected, which the item already says.
      this.authReported = false
      return { error: null, startupFailure: false, authRequired: true }
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

  private item(item: DistributiveOmit<ChatItem, 'at'>): ChatAdapterEvent {
    return { type: 'item', item: { ...item, at: this.deps.now() } as ChatItem }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
