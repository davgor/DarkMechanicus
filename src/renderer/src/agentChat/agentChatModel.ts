import type { AgentChatEvent, AgentChatSnapshot, AgentTodoPhase } from '../../../shared/agents/agentChat'
import { applyItem } from '../agents/chatViewModel'

export interface AgentChatState extends Omit<AgentChatSnapshot, 'status' | 'todos'> {
  /** Renderer-only index: the chat's own thread is '', and empty lists have no entry. */
  todos: ReadonlyMap<string, AgentTodoPhase[]>
  /** Busy transitions, not repeated busy notifications, mark new turns. */
  turn: number
  status: AgentChatSnapshot['status'] | null
  statusDetail?: string
  streaming: Map<string, { text: string; thinking: string }>
}

export function agentChatState(snapshot?: AgentChatSnapshot): AgentChatState {
  const todos = new Map<string, AgentTodoPhase[]>()
  for (const entry of snapshot?.todos ?? []) {
    const key = entry.threadId ?? ''
    if (entry.phases.length) todos.set(key, entry.phases)
    else todos.delete(key)
  }
  return {
    items: [], status: null, pending: null, queued: 0, surface: 'gui',
    ...snapshot, todos, turn: 0, streaming: new Map()
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

/** Durable items replace their stream, never append its text a second time. */
export function reduceAgentChat(state: AgentChatState, event: AgentChatEvent): AgentChatState {
  switch (event.type) {
    case 'item': {
      let streaming = state.streaming
      if (streaming.has(event.item.id)) {
        streaming = new Map(streaming)
        streaming.delete(event.item.id)
      }
      return { ...state, items: applyItem(state.items, event.item), streaming }
    }
    case 'delta': {
      const previous = state.streaming.get(event.itemId) ?? { text: '', thinking: '' }
      const streaming = new Map(state.streaming)
      streaming.set(event.itemId, { ...previous, [event.kind]: previous[event.kind] + event.text })
      return { ...state, streaming }
    }
    case 'status':
      return {
        ...state, status: event.status, statusDetail: event.detail,
        turn: state.turn + Number(event.status === 'busy' && state.status !== 'busy')
      }
    case 'pending':
      return { ...state, pending: event.prompt }
    case 'queued':
      return { ...state, queued: event.count }
    case 'todos':
      return { ...state, todos: replaceThreadTodos(state.todos, event.threadId, event.phases) }
  }
}
