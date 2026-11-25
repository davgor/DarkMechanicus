import { z } from 'zod'
import type { ChatItem } from '../../shared/agents/chat'
import type { OmpCommand, OmpEvent, OmpState } from './ompProtocol'
import { maskAgentChatSecretsDeep } from './secretMask'
import { ompTodoPhases } from './todoLists'
import { ompAnswerPrompt, ompHoldPrompt } from './ompPrompts'
import { threadClaim, type ThreadClaimEvent } from './translatorEvents'

type ObjectValue = Record<string, unknown>
type ToolItem = Extract<ChatItem, { kind: 'tool_call' }>
type Message = NonNullable<OmpState['message']>
type ToolUpdate = { id: string; name: string; args?: unknown; status: ToolItem['status']; result?: unknown; threadId?: string }
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const inputSchema = z.record(z.string(), z.json())
const quietFrames: Record<string, true> = { turn_start: true, agent_end: true, compaction_end: true, auto_retry_end: true, session_info_update: true, available_commands_update: true, command_output: true, config_update: true }
function contentText(value: unknown): string {
  if (typeof value === 'string') return maskAgentChatSecretsDeep(value)
  return maskAgentChatSecretsDeep(array(value).map(object).filter(block => block.type === 'text').map(block => string(block.text)).join('\n'))
}
function input(value: unknown): ToolItem['input'] {
  const result = inputSchema.parse(maskAgentChatSecretsDeep(object(value)))
  for (const key of ['path', 'file_path', 'notebook_path']) if (typeof result[key] === 'string') result[key] = result[key].slice(0, 4096)
  return result
}
function threadLabel(progress: ObjectValue, payload: ObjectValue): string {
  const label = maskAgentChatSecretsDeep(string(progress.description) || string(payload.agent) || 'Subagent')
  return [...label].filter(char => { const code = char.charCodeAt(0); return code >= 32 && (code < 127 || code > 159) }).join('').slice(0, 120) || 'Subagent'
}
function threadStatus(value: unknown): 'done' | 'failed' | 'running' {
  if (value === 'completed') return 'done'
  return ['failed', 'error', 'aborted', 'stopped'].includes(string(value)) ? 'failed' : 'running'
}

/** One reduction transaction; never retained by the session or exposed over IPC. */
export class OmpReducer {
  readonly events: OmpEvent[] = []
  readonly internalEvents: ThreadClaimEvent[] = []
  constructor(readonly state: OmpState, readonly at: string) {}

  emit(event: OmpEvent): void { this.events.push(maskAgentChatSecretsDeep(event)) }
  error(message: string, terminal = false, threadId?: string): void {
    const safe = maskAgentChatSecretsDeep(message)
    const scope = threadId ?? null
    const seen = this.state.terminalErrors.get(scope) ?? new Set<string>()
    if (terminal && seen.has(safe)) return
    if (terminal) { seen.add(safe); this.state.terminalErrors.set(scope, seen) }
    this.emit({ type: 'item', item: { kind: 'error', id: `omp:${this.state.idNamespace}error:${++this.state.sequence}`, at: this.at, message: safe, ...(threadId ? { threadId } : {}) } })
  }
  newMessage(prefix = 'main'): Message {
    return { id: `omp:${this.state.idNamespace}${prefix}:message:${++this.state.messageSequence}`, at: this.at, blocks: new Map(), tools: new Map(), arguments: new Map(), committed: new Set() }
  }
  tool(update: ToolUpdate): void {
    if (!update.id || !update.name) { this.state.skipped++; return }
    const prior = this.state.tools.get(update.id)
    // Final assistant copies cannot regress a completed execution to running.
    if (prior && prior.status !== 'running' && update.status === 'running') return
    const item = this.toolItem(update, prior)
    this.state.tools.set(update.id, item)
    if (update.name !== 'todo' || update.status === 'failed' || update.status === 'cancelled') this.emit({ type: 'item', item })
  }
  toolItem(update: ToolUpdate, prior?: ToolItem): ToolItem {
    const previous = prior ?? { at: this.at, input: {}, resultSummary: null }
    const item: ToolItem = { kind: 'tool_call', id: maskAgentChatSecretsDeep(update.id), at: previous.at,
      name: maskAgentChatSecretsDeep(update.name), input: previous.input, status: update.status, resultSummary: previous.resultSummary }
    if (update.args !== undefined) item.input = input(update.args)
    if (update.result !== undefined) item.resultSummary = contentText(update.result)
    const threadId = update.threadId ?? prior?.threadId
    if (threadId) item.threadId = maskAgentChatSecretsDeep(threadId)
    return item
  }
  todos(value: unknown, threadId: string | null): void {
    const phases = ompTodoPhases(value)
    if (phases === null) this.state.skipped++
    else this.emit({ type: 'todos', phases, threadId })
  }
  finishMessage(message: ObjectValue, current: Message, threadId?: string): void {
    if (message.role === 'toolResult') {
      this.tool({ id: string(message.toolCallId), name: string(message.toolName), status: message.isError === true ? 'failed' : 'completed', result: message.content, threadId })
      return
    }
    if (message.role !== 'assistant') return
    array(message.content).forEach((value, index) => this.finishBlock(object(value), index, current, threadId))
    if (message.stopReason === 'error') this.error(string(message.errorMessage) || 'OMP turn failed', true, threadId)
  }
  finishBlock(block: ObjectValue, index: number, current: Message, threadId?: string): void {
    if (block.type === 'toolCall') this.tool({ id: string(block.id), name: string(block.name), args: block.arguments, status: 'running', threadId })
    if (block.type !== 'text' || current.committed.has(index)) return
    const text = maskAgentChatSecretsDeep(string(block.text))
    if (text) this.emit({ type: 'item', item: { kind: 'assistant_text', id: `${current.id}:${index}`, at: current.at, text, ...(threadId ? { threadId } : {}) } })
    current.committed.add(index)
  }
  textDelta(change: ObjectValue, index: number, message: Message): void {
    if (typeof change.delta !== 'string') { this.state.skipped++; return }
    const kind = change.type === 'text_delta' ? 'text' : 'thinking'
    const block = message.blocks.get(index) ?? { kind, text: '', held: '' }
    // Conservative suffixes cover core/claimTokenMask's at_/ka_ and storedSecrets' case-insensitive dmg_.
    // Keep every partial prefix/body private; final masking cannot retract an already-pushed fragment.
    const combined = block.held + change.delta
    const suffix = /(?:(?:at|ka)_[A-Za-z0-9_.-]*|dmg_[A-Za-z0-9_-]*|a|at|k|ka|d|dm|dmg)$/i.exec(combined)
    const boundary = suffix?.index ?? combined.length
    const text = maskAgentChatSecretsDeep(combined.slice(0, boundary))
    block.held = combined.slice(boundary)
    block.text += text
    message.blocks.set(index, block)
    if (text) this.emit({ type: 'delta', itemId: `${message.id}:${index}`, kind, text })
  }
  toolDelta(change: ObjectValue, index: number, message: Message): void {
    const block = message.tools.get(index)
    if (!block || typeof change.delta !== 'string') { this.state.skipped++; return }
    const partial = (message.arguments.get(index) ?? '') + change.delta
    if (Buffer.byteLength(partial) > this.state.maxReassembledFrameBytes) {
      message.arguments.delete(index)
      this.error('OMP tool arguments exceed maximum size')
      return
    }
    message.arguments.set(index, partial)
    try {
      const args: unknown = JSON.parse(partial)
      if (args && typeof args === 'object' && !Array.isArray(args)) this.tool({ id: string(block.id), name: string(block.name), args, status: 'running' })
    } catch { /* Incomplete argument JSON stays private until another delta or toolcall_end. */ }
  }
  stream(frame: ObjectValue): void {
    const change = object(frame.assistantMessageEvent)
    const index = change.contentIndex
    if (!Number.isSafeInteger(index) || typeof index !== 'number' || index < 0) { this.state.skipped++; return }
    const message = this.state.message ??= this.newMessage()
    this.streamBlock(change, index, message)
  }
  streamBlock(change: ObjectValue, index: number, message: Message): void {
    switch (change.type) {
      case 'text_delta': case 'thinking_delta': this.textDelta(change, index, message); return
      case 'toolcall_delta': this.toolDelta(change, index, message); return
      case 'thinking_end': this.endThinking(message, index); return
      case 'toolcall_start': case 'toolcall_end': {
        const block = object(change.type === 'toolcall_start' ? change.block : change.toolCall)
        message.tools.set(index, block)
        this.tool({ id: string(block.id), name: string(block.name), args: block.arguments, status: 'running' })
        return
      }
      default: if (!['start', 'text_start', 'text_end', 'thinking_start'].includes(string(change.type))) this.state.skipped++
    }
  }
  flushStreams(message: Message): void {
    for (const [index, block] of message.blocks) if (block.held) {
      const text = maskAgentChatSecretsDeep(block.held)
      this.emit({ type: 'delta', itemId: `${message.id}:${index}`, kind: block.kind, text })
      block.text += text
      block.held = ''
    }
  }
  endThinking(message: Message, index: number): void {
    const block = message.blocks.get(index)
    if (block?.kind !== 'thinking') return
    if (block.held) this.emit({ type: 'delta', itemId: `${message.id}:${index}`, kind: 'thinking', text: maskAgentChatSecretsDeep(block.held) })
    this.emit({ type: 'stream_end', itemId: `${message.id}:${index}` })
    message.blocks.delete(index)
  }
  retireThinking(message: Message): void {
    for (const [index, block] of message.blocks) if (block.kind === 'thinking') this.endThinking(message, index)
  }
  ready(frame: ObjectValue): void {
    for (const key of ['maxFrameBytes', 'maxReassembledFrameBytes'] as const) if (Number.isSafeInteger(frame[key]) && Number(frame[key]) > 0) this.state[key] = Math.min(Number(frame[key]), key === 'maxFrameBytes' ? 1_048_576 : 67_108_864)
    this.emit({ type: 'status', status: 'idle' })
  }
  agentStart(): void {
    this.state.inFlight = true
    this.state.terminalErrors.delete(null)
    this.emit({ type: 'status', status: 'busy' })
  }
  messageStart(frame: ObjectValue): void {
    if (object(frame.message).role === 'assistant') this.state.message = this.newMessage()
  }
  messageEnd(frame: ObjectValue): void {
    const message = this.state.message ??= this.newMessage()
    this.flushStreams(message)
    this.finishMessage(object(frame.message), message)
    for (const result of array(frame.toolResults)) this.finishMessage(object(result), message)
    this.retireThinking(message)
  }
  execution(frame: ObjectValue): void {
    const end = frame.type === 'tool_execution_end'
    const result = object(end ? frame.result : frame.partialResult)
    const id = string(frame.toolCallId)
    const status = end ? frame.isError === true ? 'failed' : 'completed' : 'running'
    this.tool({ id, name: string(frame.toolName), args: frame.args, status, result: result.content })
    if (end && frame.toolName === 'todo' && frame.isError === false) this.todos(object(result.details).phases, this.state.tools.get(id)?.threadId ?? null)
  }
  clearTodos(): void { this.emit({ type: 'todos', threadId: null, phases: [] }) }
  thread(frame: ObjectValue): void {
    const payload = object(frame.payload)
    const progress = frame.type === 'subagent_progress' ? object(payload.progress) : payload
    const id = string(progress.id)
    if (!id) { this.state.skipped++; return }
    const prior = this.state.threads.get(id)
    const item: Extract<ChatItem, { kind: 'thread' }> = { kind: 'thread', id: maskAgentChatSecretsDeep(id), at: prior?.at ?? this.at,
      parentItemId: null, label: threadLabel(progress, payload), state: threadStatus(progress.status) }
    this.state.threads.set(id, item)
    this.emit({ type: 'item', item })
    if (item.state === 'running' && typeof payload.task === 'string' && !this.state.claimTasksSeen.has(id)) {
      this.state.claimTasksSeen.add(id)
      const claim = threadClaim(item.id, payload.task)
      if (claim) this.internalEvents.push(claim)
    }
  }
  pending(): void { this.emit({ type: 'pending', prompt: this.state.pending[0]?.prompt ?? null }) }
  ui(frame: ObjectValue): void {
    if (frame.method === 'cancel') {
      const previous = this.state.pending[0]
      this.state.pending = this.state.pending.filter(held => held.wireId !== frame.targetId)
      if (previous !== this.state.pending[0]) this.pending()
      return
    }
    const held = ompHoldPrompt(frame, ![...this.state.threads.values()].some(thread => thread.state === 'running'))
    if (!held || this.state.pending.some(pending => pending.wireId === held.wireId)) return
    this.state.pending.push(held)
    if (held.prompt.kind === 'approval') this.emit({ type: 'item', item: { kind: 'approval_request', id: `omp:approval:${held.prompt.id}`, at: this.at, requestId: held.prompt.id, category: 'other', tool: 'OMP', summary: held.prompt.title } })
    if (this.state.pending.length === 1) this.pending()
  }
  queue(frame: ObjectValue): void { this.emit({ type: 'queued', count: array(frame.followUp).length + array(frame.steering).length }) }
  stateResponse(data: ObjectValue): void {
    this.state.sessionId = maskAgentChatSecretsDeep(string(data.sessionId)) || null
    this.state.sessionFile = maskAgentChatSecretsDeep(string(data.sessionFile)) || null
    if (data.todoPhases !== undefined) this.todos(data.todoPhases, null)
  }
  tail(data: ObjectValue, threadId: string): void {
    if (data.reset === true) this.state.tailOffsets.set(threadId, 0)
    for (const value of array(data.messages)) this.finishMessage(object(value), this.newMessage(threadId), threadId)
    if (typeof data.nextByte === 'number' && Number.isSafeInteger(data.nextByte) && data.nextByte >= 0) this.state.tailOffsets.set(threadId, data.nextByte)
  }
  response(frame: ObjectValue): void {
    const id = string(frame.id)
    const command = this.state.commands.get(id)
    this.state.commands.delete(id)
    if (frame.success === false) { this.commandError(frame, command?.type); return }
    if (frame.success !== true) { this.state.skipped++; return }
    if (!command || frame.command !== command.type) return
    const data = object(frame.data)
    if (command.type === 'negotiate_protocol') this.state.protocolVersion = 2
    if (command.type === 'get_state') this.stateResponse(data)
    if (command.type === 'get_subagent_messages' && command.threadId) this.tail(data, command.threadId)
  }
  commandError(frame: ObjectValue, type?: string): void {
    this.error(string(frame.error) || string(object(frame.error).message) || 'OMP command failed')
    if (type === 'prompt' || frame.command === 'prompt') {
      this.state.inFlight = false
      this.emit({ type: 'status', status: 'idle' })
    }
  }
  cancelMain(): void {
    for (const [id, item] of this.state.tools) if (item.status === 'running' && !item.threadId) this.tool({ id, name: item.name, status: 'cancelled' })
    if (this.state.pending.length) { this.state.pending = []; this.pending() }
  }
  promptResult(frame: ObjectValue): void {
    if (this.state.message) { this.flushStreams(this.state.message); this.retireThinking(this.state.message) }
    if (frame.status === 'error') this.error(string(object(frame.error).message) || 'OMP turn failed', true)
    if (frame.status === 'aborted') this.emit({ type: 'item', item: { kind: 'turn_stopped', id: `omp:${this.state.idNamespace}stopped:${++this.state.sequence}`, at: this.at } })
    if (frame.status === 'aborted' || frame.status === 'error') this.cancelMain()
    this.state.inFlight = false
    this.emit({ type: 'status', status: 'idle' })
  }
  extensionError(frame: ObjectValue): void { this.error(string(frame.error) || 'OMP extension failed') }
  busy(frame: ObjectValue): void { this.emit({ type: 'status', status: 'busy', detail: string(frame.errorMessage) || string(frame.reason) }) }
  consume(frame: ObjectValue): void {
    const type = string(frame.type)
    if (Object.hasOwn(quietFrames, type)) return
    const handler = Object.hasOwn(handlers, type) ? handlers[type as keyof typeof handlers] : undefined
    if (handler) this[handler](frame)
    else this.state.skipped++
  }
  answer(command: Extract<OmpCommand, { type: 'answer' }>): ObjectValue | null {
    const held = this.state.pending[0]
    if (!held || held.prompt.id !== command.promptId) return null
    const answer = ompAnswerPrompt(held, command.optionId, command.text)
    if (!answer) return null
    if (answer.next) { this.state.pending[0] = answer.next; this.pending(); return null }
    if (!answer.frame) return null
    this.state.pending.shift()
    if (held.prompt.kind === 'approval') this.emit({ type: 'item', item: { kind: 'approval_decision', id: `omp:decision:${held.prompt.id}`, at: this.at, requestId: held.prompt.id, decision: command.optionId as 'allow_once' | 'allow_chat' | 'deny', decidedBy: 'person' } })
    this.pending()
    return answer.frame
  }
  command(command: OmpCommand): ObjectValue | null {
    switch (command.type) {
      case 'send': {
        if (!this.state.initialized) throw new Error('OMP initialization must precede the first prompt')
        const frame = { type: this.state.inFlight ? 'follow_up' : 'prompt', id: command.id, message: command.text }
        this.state.inFlight = true
        this.emit({ type: 'item', item: { kind: 'user_message', id: command.id, at: this.at, text: command.text } })
        return frame
      }
      case 'interrupt': return { type: 'abort', id: command.id }
      case 'get_subagent_messages': return { type: command.type, id: command.id, subagentId: command.subagentId, fromByte: command.fromByte }
      case 'answer': return this.answer(command)
    }
  }
}
const handlers = {
  ready: 'ready', agent_start: 'agentStart', message_start: 'messageStart', message_update: 'stream', message_end: 'messageEnd', turn_end: 'messageEnd',
  tool_execution_start: 'execution', tool_execution_update: 'execution', tool_execution_end: 'execution', todo_auto_clear: 'clearTodos',
  subagent_lifecycle: 'thread', subagent_progress: 'thread', extension_ui_request: 'ui', queue_update: 'queue', response: 'response',
  prompt_result: 'promptResult', extension_error: 'extensionError', compaction_start: 'busy', auto_retry_start: 'busy'
} satisfies Record<string, keyof OmpReducer>
