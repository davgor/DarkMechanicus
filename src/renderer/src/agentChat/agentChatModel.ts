import type { AgentChatEvent, AgentChatSnapshot } from '../../../shared/agents/agentChat'
import { applyItem } from '../agents/chatViewModel'

export interface AgentChatState extends Omit<AgentChatSnapshot, 'status'> {
  status: AgentChatSnapshot['status'] | null
  statusDetail?: string
  streaming: Map<string, { text: string; thinking: string }>
}

export function agentChatState(snapshot?: AgentChatSnapshot): AgentChatState {
  return {
    items: [], status: null, pending: null, queued: 0, surface: 'gui', todos: [],
    ...snapshot, streaming: new Map()
  }
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
      return { ...state, status: event.status, statusDetail: event.detail }
    case 'pending':
      return { ...state, pending: event.prompt }
    case 'queued':
      return { ...state, queued: event.count }
    case 'todos': {
      const entry = { threadId: event.threadId, phases: event.phases }
      const index = state.todos.findIndex((todo) => todo.threadId === event.threadId)
      const todos = [...state.todos]
      if (index === -1) todos.push(entry)
      else todos[index] = entry
      return { ...state, todos }
    }
  }
}
