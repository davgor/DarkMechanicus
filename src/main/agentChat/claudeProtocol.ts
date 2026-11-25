import type { AgentChatEvent, AgentTodoPhase, PendingPrompt } from '../../shared/agents/agentChat'
import type { ChatItem } from '../../shared/agents/chat'
import { maskAgentChatSecretsDeep as mask } from './secretMask'
import { taskCreateResult, taskCreateStarted, taskPhases, taskUpdate, todoWritePhases, type TaskList } from './todoLists'
import { threadClaim, type ThreadClaimEvent } from './translatorEvents'

type Payload<T> = T extends unknown ? Omit<T, 'folder' | 'chatId'> : never
export type ClaudeProtocolEvent = Payload<AgentChatEvent>
type JsonObject = Record<string, unknown>
type Tool = Extract<ChatItem, { kind: 'tool_call' }>
type Thread = Extract<ChatItem, { kind: 'thread' }>
type Block = { kind: 'text' | 'thinking' | 'tool_use'; text: string; emitted: number; committed: boolean; finalized?: boolean; toolId?: string }
type Message = { id: string; at: string; threadId: string | null; blocks: Map<number, Block> }
/** `inputClipped`: summaryInput cut a value, so the prompt shows less of the input than the CLI runs. */
type HeldPrompt = { requestId: string; prompt: PendingPrompt; input: JsonObject; inputClipped: boolean; suggestions: JsonObject[]; questionIndex: number; answers: Record<string, string> }

/** Main-private reducer state: held inputs must never be serialized to the renderer. */
export type ClaudeProtocolState = {
  skipped: number
  initialized: boolean
  initializeRequest: string | null
  sessionId: string | null
  interruptRequest: string | null
  sequence: number
  messages: Map<string, Message>
  activeMessages: Map<string | null, string>
  tools: Map<string, { item: Tool; input: JsonObject }>
  threads: Map<string, Thread>
  claimedThreads: Set<string>
  // Only pre-final, unobserved spawns are provably unlaunched. Submitted spawns remain uncertain.
  spawnLifecycle: Map<string, 'provisional' | 'submitted' | 'launched'>
  agents: Map<string, string>
  pending: Map<string, HeldPrompt>
  tasks: Map<string | null, TaskList>
  todos: Map<string | null, AgentTodoPhase[]>
  seen: Set<string>
}
export type ClaudeCommand =
  | { type: 'send'; text: string; uuid: string; sessionId?: string }
  | { type: 'interrupt'; requestId: string }
  | { type: 'answer'; promptId: string; optionId: string; text?: string }
type Translation = { state: ClaudeProtocolState; events: ClaudeProtocolEvent[] }
type Encoding = Translation & { lines: string[] }

export function createClaudeProtocolState(): ClaudeProtocolState {
  return { skipped: 0, initialized: false, initializeRequest: null, sessionId: null, interruptRequest: null,
    sequence: 0, messages: new Map(), activeMessages: new Map(), tools: new Map(), threads: new Map(), claimedThreads: new Set(), spawnLifecycle: new Map(),
    agents: new Map(), pending: new Map(), tasks: new Map(), todos: new Map(), seen: new Set() }
}
function object(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null
}
function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function clip(value: string, limit: number): string { return mask(value).slice(0, limit) }
function scope(threadId: string | null): { threadId?: string } { return threadId === null ? {} : { threadId } }
function item(events: ClaudeProtocolEvent[], value: ChatItem): void { events.push({ type: 'item', item: mask(value) }) }
function threadOf(state: ClaudeProtocolState, parent: unknown): string | null {
  return typeof parent === 'string' ? state.threads.get(parent)?.id ?? null : null
}
function listOf(state: ClaudeProtocolState, threadId: string | null): TaskList {
  return state.tasks.get(threadId) ?? { tasks: [], pendingCreates: {} }
}
const inputLimit = (key: string): number => ['file_path', 'notebook_path', 'path'].includes(key) ? 4096 : 1000
/**
 * Masked, display-bounded tool input, and whether any value was cut. Clipping is recorded at the cut: masking the
 * clipped text again can shorten it (a token the cut leaves partial), so its length cannot tell afterwards.
 */
function summaryInput(input: JsonObject): { input: Tool['input']; clipped: boolean } {
  let clipped = false
  const entries = Object.entries(mask(input)).map(([key, value]) => {
    if (typeof value !== 'string') return [key, value]
    clipped ||= value.length > inputLimit(key)
    return [key, value.slice(0, inputLimit(key))]
  })
  return { input: Object.fromEntries(entries) as Tool['input'], clipped }
}
/** Whether a held prompt's tool input was cut for display; an unknown prompt counts as cut. */
export function claudeInputClipped(state: ClaudeProtocolState, promptId: string): boolean {
  return state.pending.get(promptId)?.inputClipped ?? true
}
function resultText(value: unknown): string {
  return typeof value === 'string' ? value : Array.isArray(value)
    ? value.map(part => string(object(part)?.text)).filter(Boolean).join('\n') : ''
}
function settleThread(state: ClaudeProtocolState, events: ClaudeProtocolEvent[], spawn: string, failed: boolean): void {
  const old = state.threads.get(spawn)
  if (!old || old.state !== 'running') return
  const next: Thread = { ...old, state: failed ? 'failed' : 'done' }
  state.threads.set(spawn, next)
  item(events, next)
  commitStreams(state, events, old.id)
}

// Retain a possible token suffix across chunks, so even split credentials never reach IPC.
function flushBlock(events: ClaudeProtocolEvent[], message: Message, index: number, final: boolean): void {
  const block = message.blocks.get(index)
  if (!block || block.committed || block.kind === 'tool_use') return
  let end = block.text.length
  if (!final) {
    const suffix = /(?:at_[^\s]*|ka_[^\s]*|dmg_[^\s]*|at?|ka?|dm?g?)$/i.exec(block.text)
    if (suffix) end = suffix.index
  }
  if (end > block.emitted) {
    events.push({ type: 'delta', itemId: `${message.id}:${index}`, kind: block.kind,
      text: mask(block.text.slice(block.emitted, end)) })
    block.emitted = end
  }
}
function commitBlock(events: ClaudeProtocolEvent[], message: Message, index: number): void {
  const block = message.blocks.get(index)
  if (!block || block.committed || block.kind === 'tool_use') return
  flushBlock(events, message, index, true)
  block.committed = true
  if (block.kind === 'text') item(events, { kind: 'assistant_text', id: `${message.id}:${index}`,
    at: message.at, ...scope(message.threadId), text: block.text })
  else events.push({ type: 'stream_end', itemId: `${message.id}:${index}` })
}
type Reduction = { state: ClaudeProtocolState; events: ClaudeProtocolEvent[]; at: string; internalEvents?: ThreadClaimEvent[] }
type HeldTool = { item: Tool; input: JsonObject }

function startThread({ state, events, at, internalEvents }: Reduction, held: HeldTool): void {
  const { id, threadId } = held.item
  const candidates = [held.input.description, held.input.subagent_type].map(value =>
    [...mask(string(value))].filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').trim())
  const label = (candidates.find(value => value.length > 0) ?? 'Subagent').slice(0, 120)
  const thread: Thread = { kind: 'thread', id: `thread:${id}`, at: state.threads.get(id)?.at ?? at,
    ...scope(threadId ?? null), parentItemId: id, label, state: 'running' }
  state.threads.set(id, thread)
  if (!state.spawnLifecycle.has(id)) state.spawnLifecycle.set(id, 'provisional')
  item(events, thread)
  if (internalEvents && !state.claimedThreads.has(id)) {
    const claim = threadClaim(thread.id, string(held.input.prompt))
    if (claim) {
      state.claimedThreads.add(id)
      internalEvents.push(claim)
    }
  }
}
function toolStart(context: Reduction, block: JsonObject, threadId: string | null): void {
  const { state, events, at } = context
  const id = string(block.id), name = string(block.name), input = object(block.input)
  if (!id || !name || !input) { state.skipped++; return }
  const previous = state.tools.get(id)
  if (previous && (previous.item.status !== 'running' || JSON.stringify(previous.input) === JSON.stringify(input))) return
  const value: Tool = { kind: 'tool_call', id, at: previous ? previous.item.at : at, ...scope(threadId), name,
    input: summaryInput(input).input, status: 'running', resultSummary: null }
  const held = { item: value, input }
  state.tools.set(id, held)
  item(events, value)
  if (name === 'TaskCreate') state.tasks.set(threadId, taskCreateStarted(listOf(state, threadId), id, input))
  if (['Agent', 'Task'].includes(name)) startThread(context, held)
}
function spawnResult(context: Reduction, held: HeldTool, structured: unknown): void {
  const { state, events } = context, { id, status } = held.item
  if (!state.threads.has(id)) return
  const background = object(structured)
  const launched = background?.status === 'async_launched' || background?.isAsync === true
  if (status === 'failed' || !launched) { settleThread(state, events, id, status === 'failed'); return }
  state.spawnLifecycle.set(id, 'launched')
  const agent = string(background?.agentId)
  if (agent) state.agents.set(agent, id)
}
function failedTodo(state: ClaudeProtocolState, held: HeldTool): void {
  if (held.item.name !== 'TaskCreate') return
  const threadId = held.item.threadId ?? null, list = listOf(state, threadId)
  const pendingCreates = { ...list.pendingCreates }
  delete pendingCreates[mask(held.item.id)]
  state.tasks.set(threadId, { ...list, pendingCreates })
}
function successfulTodos(state: ClaudeProtocolState, held: HeldTool, text: string): AgentTodoPhase[] | null | undefined {
  if (held.item.name === 'TodoWrite') return todoWritePhases(held.input)
  const threadId = held.item.threadId ?? null, list = listOf(state, threadId)
  if (held.item.name === 'TaskCreate') {
    const next = taskCreateResult(list, held.item.id, text)
    if (next === list) return null
    state.tasks.set(threadId, next)
    return taskPhases(next)
  }
  if (held.item.name === 'TaskUpdate') {
    const next = taskUpdate(list, held.input)
    if (next.skipped) return null
    state.tasks.set(threadId, next.list)
    return taskPhases(next.list)
  }
  return undefined
}
function toolResult(context: Reduction, block: JsonObject, frame: JsonObject): void {
  const { state, events } = context
  const held = state.tools.get(string(block.tool_use_id))
  if (!held || held.item.status !== 'running') { state.skipped++; return }
  const failed = block.is_error === true, text = resultText(block.content)
  held.item = { ...held.item, status: failed ? 'failed' : 'completed', resultSummary: clip(text, 4000) }
  item(events, held.item)
  spawnResult(context, held, frame.tool_use_result)
  if (failed) { failedTodo(state, held); return }
  const phases = successfulTodos(state, held, text)
  if (phases === null) { state.skipped++; return }
  if (phases === undefined) return
  const threadId = held.item.threadId ?? null
  state.todos.set(threadId, phases)
  events.push({ type: 'todos', threadId, phases })
}
function streamStart({ state, at }: Reduction, event: JsonObject, threadId: string | null): void {
  const id = string(object(event.message)?.id)
  if (!id) { state.skipped++; return }
  state.activeMessages.set(threadId, id)
  if (!state.messages.has(id)) state.messages.set(id, { id, at, threadId, blocks: new Map() })
}
function validToolBlock(block: JsonObject): block is JsonObject & { id: string; name: string; input: JsonObject } {
  return !!string(block.id) && !!string(block.name) && !!object(block.input)
}
function blockStart(context: Reduction, message: Message, event: JsonObject, index: number): void {
  const block = object(event.content_block)
  if (!block) { context.state.skipped++; return }
  const kind = block.type
  if (kind !== 'text' && kind !== 'thinking' && kind !== 'tool_use') { context.state.skipped++; return }
  if (message.blocks.has(index)) return
  const held: Block = { kind, text: string(block[kind]), emitted: 0, committed: false }
  if (kind === 'tool_use') {
    if (!validToolBlock(block)) { context.state.skipped++; return }
    toolStart(context, block, message.threadId)
    held.toolId = string(block.id)
  }
  message.blocks.set(index, held)
  flushBlock(context.events, message, index, false)
}
function toolInputDelta(context: Reduction, message: Message, block: Block, delta: JsonObject): void {
  if (delta.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') { context.state.skipped++; return }
  block.text += delta.partial_json
  let input: JsonObject | null
  try { input = object(JSON.parse(block.text)) } catch { return }
  const held = context.state.tools.get(block.toolId ?? '')
  if (input && held) toolStart(context, { id: held.item.id, name: held.item.name, input }, message.threadId)
}
function blockDelta(context: Reduction, message: Message, event: JsonObject, index: number): void {
  const block = message.blocks.get(index), delta = object(event.delta)
  if (!block || !delta) { context.state.skipped++; return }
  if (block.committed) return
  if (block.kind === 'tool_use') { toolInputDelta(context, message, block, delta); return }
  const field = block.kind === 'thinking' ? 'thinking' : 'text'
  if (delta.type !== `${field}_delta` || typeof delta[field] !== 'string') { context.state.skipped++; return }
  block.text += delta[field]
  flushBlock(context.events, message, index, false)
}
function blockStop(events: ClaudeProtocolEvent[], message: Message, index: number): void {
  if (message.blocks.get(index)?.kind === 'thinking') commitBlock(events, message, index)
  else flushBlock(events, message, index, true)
}
function streamBlock(context: Reduction, event: JsonObject, message: Message): void {
  if (event.type === 'message_stop') {
    for (const index of message.blocks.keys()) commitBlock(context.events, message, index)
    return
  }
  if (event.type === 'message_delta') return
  const index = event.index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) { context.state.skipped++; return }
  switch (event.type) {
    case 'content_block_start': blockStart(context, message, event, index); break
    case 'content_block_delta': blockDelta(context, message, event, index); break
    case 'content_block_stop': blockStop(context.events, message, index); break
    default: context.state.skipped++
  }
}
function stream(context: Reduction, frame: JsonObject): void {
  const { state } = context
  const event = object(frame.event), threadId = threadOf(state, frame.parent_tool_use_id)
  if (!event) { state.skipped++; return }
  if (event.type === 'message_start') { streamStart(context, event, threadId); return }
  const message = state.messages.get(state.activeMessages.get(threadId) ?? '')
  if (!message) { state.skipped++; return }
  streamBlock(context, event, message)
}
function finalTool(context: Reduction, message: Message, block: JsonObject, position: number): void {
  const id = string(block.id)
  const streamedIndex = [...message.blocks].find(([, b]) => b.toolId === id)?.[0]
  const index = streamedIndex ?? (message.blocks.has(position) ? Math.max(...message.blocks.keys()) + 1 : position)
  message.blocks.set(index, { kind: 'tool_use', text: '', emitted: 0, committed: true, finalized: true, toolId: id })
  toolStart(context, block, message.threadId)
  if (context.state.spawnLifecycle.get(id) === 'provisional') context.state.spawnLifecycle.set(id, 'submitted')
}
function finalText(events: ClaudeProtocolEvent[], message: Message, block: JsonObject, index: number): void {
  const kind = block.type
  if (kind !== 'text' && kind !== 'thinking') return
  // Full frames correlate by block index; single-block frames choose their index before this call.
  const previous = message.blocks.get(index)
  if (previous?.committed) { previous.finalized = true; return }
  message.blocks.set(index, { kind, text: string(block[kind]), emitted: previous?.emitted ?? 0, committed: false, finalized: true })
  commitBlock(events, message, index)
}
function assistantBlocks(context: Reduction, message: Message, content: unknown[]): void {
  for (const [position, value] of content.entries()) {
    const block = object(value)
    if (!block) { context.state.skipped++; continue }
    if (block.type === 'tool_use') { finalTool(context, message, block, position); continue }
    if (block.type !== 'text' && block.type !== 'thinking') { context.state.skipped++; continue }
    const candidate = content.length === 1
      ? [...message.blocks].find(([, b]) => b.kind === block.type && !b.finalized)?.[0]
        ?? Math.max(-1, ...message.blocks.keys()) + 1
      : position
    finalText(context.events, message, block, candidate)
  }
}
function assistant(context: Reduction, frame: JsonObject): void {
  const { state, at } = context
  const body = object(frame.message), id = string(body?.id) || string(frame.uuid)
  const content = body?.content, threadId = threadOf(state, frame.parent_tool_use_id)
  if (!id || !Array.isArray(content)) { state.skipped++; return }
  let message = state.messages.get(id)
  if (!message) { message = { id, at, threadId, blocks: new Map() }; state.messages.set(id, message) }
  assistantBlocks(context, message, content)
}
function questionPrompt(base: Omit<PendingPrompt, 'kind' | 'options'>, question: JsonObject | null): PendingPrompt {
  const options = objects(question?.options).flatMap((option, index) => {
    const label = string(option.label)
    return label ? [{ id: `option_${index}`, label }] : []
  })
  options.push({ id: 'text', label: options.length ? 'Other' : 'Answer' })
  return { ...base, kind: 'question', title: string(question?.question) || 'AskUserQuestion', options }
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter(entry => entry !== null) : []
}
function requestBase(state: ClaudeProtocolState, body: JsonObject, tool: { id: string; name: string; input: Tool['input'] }): Omit<PendingPrompt, 'kind' | 'options'> {
  const spawn = state.agents.get(string(body.agent_id))
  const threadId = (spawn ? state.threads.get(spawn)?.id : undefined)
    ?? state.tools.get(string(body.tool_use_id))?.item.threadId ?? null
  return { id: tool.id, title: string(body.title) || tool.name, detail: string(body.description), threadId,
    callsign: null, arbitration: { state: 'off', reason: null },
    attributed: threadId !== null || ![...state.threads.values()].some(thread => thread.state === 'running'),
    tool: { name: tool.name, input: tool.input } }
}
function recordPrompt(context: Reduction, prompt: PendingPrompt): void {
  const name = string(prompt.tool?.name)
  item(context.events, { kind: 'approval_request', id: `approval:${prompt.id}`, at: context.at, ...scope(prompt.threadId), requestId: prompt.id,
    category: name === 'Bash' ? 'command' : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name) ? 'file_edit' : 'other',
    tool: name, summary: prompt.title, input: prompt.tool?.input })
}
function approvalPrompt(base: Omit<PendingPrompt, 'kind' | 'options'>, suggestions: JsonObject[]): PendingPrompt {
  return { ...base, kind: 'approval', options: [{ id: 'allow_once', label: 'Allow once' },
    ...(suggestions.length ? [{ id: 'allow_chat' as const, label: 'Allow for this chat' }] : []), { id: 'deny', label: 'Deny' }] }
}
function request(context: Reduction, frame: JsonObject): void {
  const { state, events } = context, body = object(frame.request)
  if (!body) { state.skipped++; return }
  const id = string(frame.request_id), input = object(body.input), name = string(body.tool_name)
  if (body.subtype !== 'can_use_tool' || !id || !input || !name) { state.skipped++; return }
  if ([...state.pending.values()].some(held => held.requestId === id)) return
  if (name === 'AskUserQuestion' && !validQuestions(input.questions)) {
    state.skipped++
    item(events, { kind: 'error', id: `question:${id}`, at: context.at,
      message: 'Malformed AskUserQuestion request: expected nonempty questions with question text.' })
    return
  }
  const suggestions = objects(body.permission_suggestions)
  const summary = summaryInput(input)
  const base = requestBase(state, body, { id, name, input: summary.input })
  const prompt = name === 'AskUserQuestion' ? questionPrompt(base, objects(input.questions)[0])
    : approvalPrompt(base, suggestions)
  state.pending.set(mask(id), { requestId: id, prompt: mask(prompt), input, inputClipped: summary.clipped, suggestions, questionIndex: 0, answers: {} })
  recordPrompt(context, prompt)
  events.push({ type: 'pending', prompt: mask(prompt) })
}
function userResults(context: Reduction, content: unknown[], frame: JsonObject): void {
  for (const part of content) {
    const block = object(part)
    if (block?.type === 'tool_result') toolResult(context, block, frame)
  }
}
function user(context: Reduction, frame: JsonObject): void {
  const content = object(frame.message)?.content
  if (Array.isArray(content) && content.some(part => object(part)?.type === 'tool_result')) {
    userResults(context, content, frame)
  } else if (frame.parent_tool_use_id) {
    const text = resultText(content)
    if (text) assistant(context, { ...frame, message: { id: string(frame.uuid), content: [{ type: 'text', text }] } })
  } else if (typeof content !== 'string' && !Array.isArray(content)) context.state.skipped++
}
function controlResponse({ state, events, at }: Reduction, frame: JsonObject): void {
  const response = object(frame.response)
  if (!response) { state.skipped++; return }
  const id = string(response.request_id)
  if (id !== state.initializeRequest && id !== state.interruptRequest) { state.skipped++; return }
  if (response.subtype === 'error') {
    item(events, { kind: 'error', id: `control:${id}`, at, message: string(response.error) || 'Control request failed' })
    events.push({ type: 'status', status: 'failed' })
  } else if (response.subtype === 'success' && id === state.initializeRequest) {
    state.initialized = true
    events.push({ type: 'status', status: 'idle' })
  } else if (response.subtype !== 'success') state.skipped++
}
function taskNotification({ state, events }: Reduction, frame: JsonObject): void {
  const direct = string(frame.tool_use_id)
  const spawn = state.threads.has(direct) ? direct : state.agents.get(string(frame.task_id)) ?? ''
  if (!state.threads.has(spawn) || !['completed', 'failed', 'stopped'].includes(string(frame.status))) state.skipped++
  else settleThread(state, events, spawn, frame.status !== 'completed')
}
function system(context: Reduction, frame: JsonObject): void {
  const { state } = context
  switch (frame.subtype) {
    case 'init': state.sessionId = string(frame.session_id) || null; break
    case 'task_started': {
      const spawn = string(frame.tool_use_id), agent = string(frame.task_id)
      if (state.threads.has(spawn) && agent) {
        state.agents.set(agent, spawn)
        state.spawnLifecycle.set(spawn, 'launched')
      }
      else state.skipped++
      break
    }
    case 'task_notification': taskNotification(context, frame); break
    default: state.skipped++
  }
}
function commitStreams(state: ClaudeProtocolState, events: ClaudeProtocolEvent[], threadId: string | null): void {
  for (const message of state.messages.values()) {
    if (message.threadId !== threadId) continue
    for (const index of message.blocks.keys()) commitBlock(events, message, index)
  }
}
function cancelMainWork({ state, events }: Reduction): void {
  for (const held of state.tools.values()) {
    if (held.item.threadId || held.item.status !== 'running') continue
    held.item = { ...held.item, status: 'cancelled' }
    item(events, held.item)
    if (state.spawnLifecycle.get(held.item.id) === 'provisional') settleThread(state, events, held.item.id, true)
  }
  let removed = false
  for (const [id, held] of state.pending) {
    if (held.prompt.threadId !== null) continue
    state.pending.delete(id)
    removed = true
  }
  if (removed) events.push({ type: 'pending', prompt: [...state.pending.values()].at(-1)?.prompt ?? null })
}
function terminalItem(context: Reduction, frame: JsonObject, stopped: boolean): void {
  const { state, events, at } = context
  if (stopped) item(events, { kind: 'turn_stopped', id: `stopped:${string(frame.uuid) || ++state.sequence}`, at })
  else if (frame.is_error === true) item(events, { kind: 'error', id: `error:${string(frame.uuid) || ++state.sequence}`, at,
    message: Array.isArray(frame.errors) ? frame.errors.map(string).join('\n') : string(frame.result) || 'Claude turn failed' })
}
function result(context: Reduction, frame: JsonObject): void {
  const { state, events } = context
  if (typeof frame.is_error !== 'boolean') { state.skipped++; return }
  commitStreams(state, events, null)
  const stopped = state.interruptRequest !== null && ['aborted_streaming', 'aborted_tools'].includes(string(frame.terminal_reason))
  terminalItem(context, frame, stopped)
  state.interruptRequest = null
  if (stopped || frame.is_error === true) cancelMainWork(context)
  if (Number.isInteger(frame.queued_turn_count) && Number(frame.queued_turn_count) >= 0)
    events.push({ type: 'queued', count: Number(frame.queued_turn_count) })
  events.push({ type: 'status', status: 'idle' })
}
function validQuestions(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(entry => {
    const question = object(entry)
    return !!string(question?.question).trim()
  })
}
function supportedAssistant(frame: JsonObject): boolean {
  const body = object(frame.message)
  return !!(string(body?.id) || string(frame.uuid)) && Array.isArray(body?.content) && body.content.length > 0 && body.content.every(value => {
    const block = object(value)
    if (block?.type === 'text' || block?.type === 'thinking') return typeof block[block.type] === 'string'
    return block?.type === 'tool_use' && !!string(block.id) && !!string(block.name) && !!object(block.input)
  })
}
function supportedUser(frame: JsonObject): boolean {
  const content = object(frame.message)?.content
  return !!string(frame.uuid) && (typeof content === 'string' ? !!content : Array.isArray(content)
    && content.length > 0 && content.every(value => object(value)?.type === 'text' && typeof object(value)?.text === 'string'))
}
function supportedForwarded(frame: JsonObject): boolean {
  if (frame.type === 'assistant') return supportedAssistant(frame)
  if (frame.type === 'user') return supportedUser(frame)
  const event = object(frame.event)
  return frame.type === 'stream_event' && event?.type === 'message_start' && !!string(object(event.message)?.id)
}
function forwardedThread({ state, events, at }: Reduction, frame: JsonObject): void {
  const parent = string(frame.parent_tool_use_id)
  // Unrecognized child envelopes must not acquire a persistent identity or fall through to the main stream.
  if (!parent || !supportedForwarded(frame)) return
  state.spawnLifecycle.set(parent, 'launched')
  if (state.threads.has(parent)) return
  const thread: Thread = { kind: 'thread', id: `thread:${parent}`, at, parentItemId: parent, label: 'Subagent', state: 'running' }
  state.threads.set(parent, thread)
  item(events, thread)
}
function dispatch(context: Reduction, frame: JsonObject): void {
  switch (frame.type) {
    case 'stream_event': stream(context, frame); break
    case 'assistant': assistant(context, frame); break
    case 'user': user(context, frame); break
    case 'control_request': request(context, frame); break
    case 'control_response': controlResponse(context, frame); break
    case 'system': system(context, frame); break
    case 'result': result(context, frame); break
    default: context.state.skipped++
  }
}
/** Translate one JSONL line; only `events` are safe for storage/IPC. Internal claims are transient. */
export function translateClaudeLine(line: string, previous: ClaudeProtocolState, at: string): Translation & { internalEvents: ThreadClaimEvent[] } {
  const state = structuredClone(previous), events: ClaudeProtocolEvent[] = [], internalEvents: ThreadClaimEvent[] = []
  let frame: JsonObject | null
  try { frame = object(JSON.parse(line)) } catch { frame = null }
  if (!frame) { state.skipped++; return { state, events, internalEvents } }
  const uuid = string(frame.uuid)
  if (uuid && state.seen.has(uuid)) return { state, events, internalEvents }
  if (uuid) state.seen.add(uuid)
  const context = { state, events, at, internalEvents }
  if (string(frame.parent_tool_use_id) && !state.threads.has(string(frame.parent_tool_use_id)) && !supportedForwarded(frame)) {
    state.skipped++
    return { state, events, internalEvents }
  }
  forwardedThread(context, frame)
  dispatch(context, frame)
  return { state, events: mask(events), internalEvents }
}

/** Call once with a fresh host request id; system/init alone does not admit turns. */
export function claudeInitLines(previous: ClaudeProtocolState, requestId: string): Encoding {
  const state = structuredClone(previous)
  if (state.initializeRequest !== null) return { state, events: [], lines: [] }
  state.initializeRequest = requestId
  return { state, events: [{ type: 'status', status: 'starting' }],
    lines: [JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })] }
}

type Answer = Extract<ClaudeCommand, { type: 'answer' }>
function questionAnswer(held: HeldPrompt, question: JsonObject, command: Answer): string | null {
  if (!held.prompt.options.some(option => option.id === command.optionId)) return null
  if (command.optionId === 'text') return command.text || null
  const selected = objects(question.options)[Number(command.optionId.slice('option_'.length))]
  return selected ? string(selected.label) : null
}
function answerQuestion(context: Reduction, held: HeldPrompt, command: Answer): JsonObject | null {
  const questions = objects(held.input.questions), question = questions[held.questionIndex]
  if (!question) return null
  const answer = questionAnswer(held, question, command)
  if (answer === null) return null
  item(context.events, { kind: 'approval_decision', id: `decision:${command.promptId}`, at: context.at,
    ...scope(held.prompt.threadId), requestId: command.promptId, decision: 'allow_once', decidedBy: 'person' })
  item(context.events, { kind: 'user_message', id: `answer:${command.promptId}`, at: context.at,
    ...scope(held.prompt.threadId), text: answer })
  held.answers = { ...held.answers, [string(question.question)]: answer }
  held.questionIndex++
  if (held.questionIndex < questions.length) {
    context.state.pending.delete(command.promptId)
    held.prompt = mask(questionPrompt({ ...held.prompt, id: `${held.requestId}:question:${held.questionIndex}` }, questions[held.questionIndex]))
    context.state.pending.set(held.prompt.id, held)
    context.events.push({ type: 'pending', prompt: held.prompt })
    recordPrompt(context, held.prompt)
    return null
  }
  return { behavior: 'allow', updatedInput: { ...held.input, answers: held.answers } }
}
function answerApproval(context: Reduction, held: HeldPrompt, command: Answer): JsonObject | null {
  if (!held.prompt.options.some(option => option.id === command.optionId)) return null
  const response = command.optionId === 'deny' ? { behavior: 'deny', message: command.text ?? 'Denied by user' }
    : { behavior: 'allow', updatedInput: held.input,
      ...(command.optionId === 'allow_chat' ? { updatedPermissions: held.suggestions.map(suggestion => ({ ...suggestion, destination: 'session' })) } : {}) }
  item(context.events, { kind: 'approval_decision', id: `decision:${command.promptId}`, at: context.at,
    ...scope(held.prompt.threadId), requestId: command.promptId, decision: command.optionId as 'allow_once' | 'allow_chat' | 'deny', decidedBy: 'person' })
  return response
}
function encodeAnswer(context: Reduction, command: Answer): string[] {
  const { state, events } = context, held = state.pending.get(command.promptId)
  if (!held) return []
  const response = held.prompt.kind === 'question' ? answerQuestion(context, held, command) : answerApproval(context, held, command)
  if (response === null) return []
  state.pending.delete(command.promptId)
  events.push({ type: 'pending', prompt: [...state.pending.values()].at(-1)?.prompt ?? null })
  return [JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: held.requestId, response } })]
}
function encodeSend({ state, events, at }: Reduction, command: Extract<ClaudeCommand, { type: 'send' }>): string[] {
  if (!state.initialized) return []
  const sessionId = command.sessionId ?? state.sessionId
  const frame = { type: 'user', ...(sessionId ? { session_id: sessionId } : {}), uuid: command.uuid,
    parent_tool_use_id: null, message: { role: 'user', content: command.text } }
  item(events, { kind: 'user_message', id: command.uuid, at, text: command.text })
  events.push({ type: 'status', status: 'busy' })
  return [JSON.stringify(frame)]
}
/** Wire strings are main-to-CLI only. In particular, updatedInput is the original held input. */
export function encodeClaudeCommand(command: ClaudeCommand, previous: ClaudeProtocolState, at: string): Encoding {
  const state = structuredClone(previous), events: ClaudeProtocolEvent[] = []
  const context = { state, events, at }
  let lines: string[]
  if (command.type === 'send') lines = encodeSend(context, command)
  else if (command.type === 'answer') lines = encodeAnswer(context, command)
  else {
    state.interruptRequest = command.requestId
    lines = [JSON.stringify({ type: 'control_request', request_id: command.requestId, request: { subtype: 'interrupt' } })]
  }
  return { state, events: mask(events), lines }
}
