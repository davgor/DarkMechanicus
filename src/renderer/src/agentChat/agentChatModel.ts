import type { AgentChatEvent, AgentChatSnapshot, AgentTodoPhase } from '../../../shared/agents/agentChat'
import { applyItem } from '../agents/chatViewModel'
import { nextTodoMemory, type TodoMemory } from './todoPanelModel'

export interface AgentChatState extends Omit<AgentChatSnapshot, 'status' | 'todos'> {
  /** Renderer-only index: the chat's own thread is '', and empty lists have no entry. */
  todos: ReadonlyMap<string, AgentTodoPhase[]>
  /** Ephemeral history advanced in event order, including threads not currently selected. */
  todoMemory: ReadonlyMap<string, TodoMemory>
  /** Busy transitions, not repeated busy notifications, mark new turns. */
  turn: number
  /** Arrival times come from the hook's injected clock, never the reducer's wall clock. */
  lastEventAt: number
  turnStartedAt: number | null
  status: AgentChatSnapshot['status'] | null
  statusDetail?: string
  streaming: Map<string, { text: string; thinking: string }>
}

function snapshotTurnStartedAt(snapshot: AgentChatSnapshot | undefined, at: number): number | null {
  if (snapshot?.status !== 'busy') return null
  for (let index = snapshot.items.length - 1; index >= 0; index--) {
    const item = snapshot.items[index]
    if (item.kind === 'user_message') {
      const parsed = Date.parse(item.at)
      return Number.isFinite(parsed) ? parsed : at
    }
  }
  return at
}

function advanceTodoMemory(todos: AgentChatState['todos'], previous: AgentChatState['todoMemory'] | undefined, turn: number, busy: boolean): AgentChatState['todoMemory'] {
  const memories = new Map<string, TodoMemory>()
  for (const [key, phases] of todos) {
    memories.set(key, nextTodoMemory(previous?.get(key) ?? null, { phases, turn, busy }))
  }
  return memories
}

function indexSnapshotTodos(entries: AgentChatSnapshot['todos']): AgentChatState['todos'] {
  const todos = new Map<string, AgentTodoPhase[]>()
  for (const entry of entries) {
    const key = entry.threadId ?? ''
    if (entry.phases.length) todos.set(key, entry.phases)
    else todos.delete(key)
  }
  return todos
}

export function agentChatState(snapshot?: AgentChatSnapshot, at = 0, baseline?: AgentChatState): AgentChatState {
  const todos = indexSnapshotTodos(snapshot?.todos ?? [])
  const state: AgentChatState = {
    items: [], status: null, pending: null, queued: 0, surface: 'gui',
    ...snapshot, todos, todoMemory: advanceTodoMemory(todos, undefined, 0, snapshot?.status === 'busy'),
    turn: 0, streaming: new Map(), lastEventAt: at,
    turnStartedAt: snapshotTurnStartedAt(snapshot, at)
  }
  return baseline ? reconcileAgentChatLifecycle(state, baseline) : state
}

/** Snapshot data cannot replay or rewind the subscription's observed lifecycle. */
export function reconcileAgentChatLifecycle(state: AgentChatState, live: AgentChatState): AgentChatState {
  const busy = state.status === 'busy'
  const turn = live.turn + Number(busy && live.status !== 'busy')
  return {
    ...state, turn,
    todoMemory: advanceTodoMemory(state.todos, live.todoMemory, turn, busy),
    turnStartedAt: state.status === live.status ? live.turnStartedAt : state.turnStartedAt
  }
}

function replaceThreadTodos(state: AgentChatState, threadId: string | null, phases: AgentTodoPhase[]): AgentChatState {
  const key = threadId ?? ''
  const todos = new Map(state.todos)
  const todoMemory = new Map(state.todoMemory)
  if (phases.length) {
    todos.set(key, phases)
    todoMemory.set(key, nextTodoMemory(todoMemory.get(key) ?? null, { phases, turn: state.turn, busy: state.status === 'busy' }))
  } else {
    todos.delete(key)
    todoMemory.delete(key)
  }
  return { ...state, todos, todoMemory }
}

function statusState(state: AgentChatState, event: Extract<AgentChatEvent, { type: 'status' }>, at: number): AgentChatState {
  const newTurn = event.status === 'busy' && state.status !== 'busy'
  let turnStartedAt = state.turnStartedAt
  if (newTurn) turnStartedAt = at
  else if (event.status !== 'busy' && event.status !== 'starting') turnStartedAt = null
  const turn = state.turn + Number(newTurn)
  const todoMemory = event.status === state.status ? state.todoMemory
    : advanceTodoMemory(state.todos, state.todoMemory, turn, event.status === 'busy')
  return {
    ...state, lastEventAt: at, status: event.status, statusDetail: event.detail,
    turn, turnStartedAt, todoMemory
  }
}

function withoutStream(streaming: AgentChatState['streaming'], itemId: string): AgentChatState['streaming'] {
  if (!streaming.has(itemId)) return streaming
  const next = new Map(streaming)
  next.delete(itemId)
  return next
}

/** Durable items replace their stream, never append its text a second time. */
export function reduceAgentChat(state: AgentChatState, event: AgentChatEvent, at = 0): AgentChatState {
  switch (event.type) {
    case 'item':
      return { ...state, lastEventAt: at, items: applyItem(state.items, event.item),
        streaming: withoutStream(state.streaming, event.item.id) }
    case 'delta': {
      const previous = state.streaming.get(event.itemId) ?? { text: '', thinking: '' }
      const streaming = new Map(state.streaming)
      streaming.set(event.itemId, { ...previous, [event.kind]: previous[event.kind] + event.text })
      return { ...state, lastEventAt: at, streaming }
    }
    case 'stream_end':
      return { ...state, lastEventAt: at, streaming: withoutStream(state.streaming, event.itemId) }
    case 'status':
      return statusState(state, event, at)
    case 'pending':
      return { ...state, lastEventAt: at, pending: event.prompt }
    case 'queued':
      return { ...state, lastEventAt: at, queued: event.count }
    case 'todos':
      return { ...replaceThreadTodos(state, event.threadId, event.phases), lastEventAt: at }
    default:
      // `attention`: folder-level needs-you state; the chat's own card follows `pending`.
      return state
  }
}
