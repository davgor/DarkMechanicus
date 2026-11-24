import type { AgentChatEvent, AgentChatSnapshot, AgentTodoPhase } from '../../../shared/agents/agentChat'
import { applyItem } from '../agents/chatViewModel'

export interface AgentChatState extends Omit<AgentChatSnapshot, 'status' | 'todos'> {
  /** Renderer-only index: the chat's own thread is '', and empty lists have no entry. */
  todos: ReadonlyMap<string, AgentTodoPhase[]>
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

export function agentChatState(snapshot?: AgentChatSnapshot, at = 0): AgentChatState {
  const todos = new Map<string, AgentTodoPhase[]>()
  for (const entry of snapshot?.todos ?? []) {
    const key = entry.threadId ?? ''
    if (entry.phases.length) todos.set(key, entry.phases)
    else todos.delete(key)
  }
  return {
    items: [], status: null, pending: null, queued: 0, surface: 'gui',
    ...snapshot, todos, turn: 0, streaming: new Map(), lastEventAt: at,
    turnStartedAt: snapshotTurnStartedAt(snapshot, at)
  }
}

function replaceThreadTodos(
  previous: ReadonlyMap<string, AgentTodoPhase[]>, threadId: string | null, phases: AgentTodoPhase[]
): ReadonlyMap<string, AgentTodoPhase[]> {
  const key = threadId ?? ''
  const todos = new Map(previous)
  if (phases.length) todos.set(key, phases)
  else todos.delete(key)
  return todos
}

function statusState(state: AgentChatState, event: Extract<AgentChatEvent, { type: 'status' }>, at: number): AgentChatState {
  const newTurn = event.status === 'busy' && state.status !== 'busy'
  let turnStartedAt = state.turnStartedAt
  if (newTurn) turnStartedAt = at
  else if (event.status !== 'busy' && event.status !== 'starting') turnStartedAt = null
  return {
    ...state, lastEventAt: at, status: event.status, statusDetail: event.detail,
    turn: state.turn + Number(newTurn), turnStartedAt
  }
}

/** Durable items replace their stream, never append its text a second time. */
export function reduceAgentChat(state: AgentChatState, event: AgentChatEvent, at = 0): AgentChatState {
  switch (event.type) {
    case 'item': {
      let streaming = state.streaming
      if (streaming.has(event.item.id)) {
        streaming = new Map(streaming)
        streaming.delete(event.item.id)
      }
      return { ...state, lastEventAt: at, items: applyItem(state.items, event.item), streaming }
    }
    case 'delta': {
      const previous = state.streaming.get(event.itemId) ?? { text: '', thinking: '' }
      const streaming = new Map(state.streaming)
      streaming.set(event.itemId, { ...previous, [event.kind]: previous[event.kind] + event.text })
      return { ...state, lastEventAt: at, streaming }
    }
    case 'status':
      return statusState(state, event, at)
    case 'pending':
      return { ...state, lastEventAt: at, pending: event.prompt }
    case 'queued':
      return { ...state, lastEventAt: at, queued: event.count }
    case 'todos':
      return { ...state, lastEventAt: at, todos: replaceThreadTodos(state.todos, event.threadId, event.phases) }
  }
}
