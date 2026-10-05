/**
 * Turns the `session/update` notifications of a prompt turn into chat events. Message chunks stream
 * as deltas of one text item that is stored whole when the message ends (a new message, a tool
 * call, or the end of the turn); a tool call becomes one item per change of state under one id, so
 * the stored line is replaced as the call goes from running to completed.
 *
 * Not shown: the agent's thoughts, plans, the echo of the user's own message, mode and command
 * updates. The history `session/load` replays is never fed to this class.
 */
import type { ChatAdapterEmit, ChatItem } from '../../../shared/agents/chat'
import { clip, objectOf, summarizeInput, toolNameOf, type Json } from './cursorProtocol'

interface UpdateIds {
  newId(): string
  now(): string
}

type ToolStatus = Extract<ChatItem, { kind: 'tool_call' }>['status']

interface ToolState {
  name: string
  input: Record<string, Json>
  status: ToolStatus
  resultSummary: string | null
  at: string
}

interface OpenText {
  id: string
  at: string
  messageId: string | null
  text: string
}

const MAX_SUMMARY_CHARS = 600

const STATUS = new Map<string, ToolStatus>([
  ['completed', 'completed'],
  ['failed', 'failed']
])

function textOf(content: unknown): string | null {
  const block = objectOf(content)
  return block?.type === 'text' && typeof block.text === 'string' && block.text !== '' ? block.text : null
}

/** What a tool call's content says it did: the files an edit changed, or the text it printed. */
function summarizeContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null
  }
  const lines = content.flatMap((entry: unknown) => {
    const block = objectOf(entry)
    if (block?.type === 'diff' && typeof block.path === 'string') {
      return [`Edited ${block.path}`]
    }
    const text = block?.type === 'content' ? textOf(block.content) : null
    return text === null ? [] : [text]
  })
  return lines.length === 0 ? null : clip(lines.join('\n'), MAX_SUMMARY_CHARS)
}

export class UpdateTranslator {
  private text: OpenText | null = null
  private readonly tools = new Map<string, ToolState>()
  /** Calls whose permission the person refused, by item id: their failure is a refusal. */
  private readonly denied = new Set<string>()

  constructor(
    private readonly ids: UpdateIds,
    private readonly emit: ChatAdapterEmit
  ) {}

  apply(sessionId: string, update: unknown): void {
    const body = objectOf(update)
    const kind = body?.sessionUpdate
    if (body === null) {
      return
    }
    if (kind === 'agent_message_chunk') {
      this.onMessage(body)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.onTool(sessionId, body)
    }
  }

  /** Stores the text being written, if any. */
  flush(): void {
    const open = this.text
    this.text = null
    if (open !== null) {
      this.emit({ type: 'item', item: { id: open.id, at: open.at, kind: 'assistant_text', text: open.text } })
    }
  }

  /** The person refused the permission request for this call. */
  markDenied(sessionId: string, toolCallId: string): void {
    this.denied.add(itemIdOf(sessionId, toolCallId))
  }

  private onMessage(body: Record<string, unknown>): void {
    const text = textOf(body.content)
    if (text === null) {
      return
    }
    const messageId = typeof body.messageId === 'string' ? body.messageId : null
    if (this.text !== null && messageId !== null && this.text.messageId !== null && this.text.messageId !== messageId) {
      this.flush()
    }
    const open = this.text ?? { id: this.ids.newId(), at: this.ids.now(), messageId, text: '' }
    open.text += text
    this.text = open
    this.emit({ type: 'assistant_delta', itemId: open.id, delta: text })
  }

  private onTool(sessionId: string, body: Record<string, unknown>): void {
    const toolCallId = body.toolCallId
    if (typeof toolCallId !== 'string' || toolCallId === '') {
      return
    }
    this.flush()
    const id = itemIdOf(sessionId, toolCallId)
    const before = this.tools.get(id)
    const after = this.merge(id, before, body)
    this.tools.set(id, after)
    if (before === undefined || !sameState(before, after)) {
      this.emit({ type: 'item', item: { id, kind: 'tool_call', ...after } })
    }
  }

  private merge(id: string, before: ToolState | undefined, body: Record<string, unknown>): ToolState {
    const state: ToolState = before ?? {
      name: toolNameOf(body),
      input: {},
      status: 'running',
      resultSummary: null,
      at: this.ids.now()
    }
    const status = typeof body.status === 'string' ? this.statusOf(id, body.status) : state.status
    return {
      ...state,
      status,
      input: summarizeInput(body.rawInput) ?? state.input,
      resultSummary: summarizeContent(body.content) ?? state.resultSummary
    }
  }

  private statusOf(id: string, status: string): ToolStatus {
    const mapped = STATUS.get(status) ?? 'running'
    return mapped === 'failed' && this.denied.has(id) ? 'denied' : mapped
  }
}

function itemIdOf(sessionId: string, toolCallId: string): string {
  return `tool_${sessionId}_${toolCallId}`
}

function sameState(left: ToolState, right: ToolState): boolean {
  return (
    left.status === right.status &&
    left.resultSummary === right.resultSummary &&
    JSON.stringify(left.input) === JSON.stringify(right.input)
  )
}
