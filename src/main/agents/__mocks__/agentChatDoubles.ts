/**
 * Test doubles for the chat start paths that choose a surface: a recording GUI session manager, and chat records that
 * keep new chats on the terminal surface. Main-only: the agent-chat rig (shared with renderer integration tests) must
 * not import this module, so the web ts-prune program never reaches the chat records. Not shipped.
 */
import type { AgentChatSnapshot } from '../../../shared/agents/agentChat'
import type { AgentChatSessions } from '../../agentChat/agentChatSessions'
import type { ChatRecords } from '../chatRecords'
import type { ChatStore } from '../chatStore'

/** A GUI session manager double: what it was asked, and the chat ids it reports live. */
export type RecordingAgentChats = Pick<AgentChatSessions, 'start' | 'send' | 'isLive'> & { calls: unknown[][]; live: Set<string> }

/** A GUI session manager that records [`start`, chat, options] and [`send`, chat, input], answering `status`; `live` holds the ids it reports live. */
export function recordingAgentChats(status: AgentChatSnapshot['status'] = 'idle'): RecordingAgentChats {
  const calls: unknown[][] = []
  const live = new Set<string>()
  return {
    calls,
    live,
    start: async (ref, options) => {
      calls.push(['start', ref, options])
      return { items: [], status, pending: null, queued: 0, surface: 'gui', todos: [] }
    },
    send: async (ref, input) => {
      calls.push(['send', ref, input])
    },
    isLive: (ref) => live.has(ref.id)
  }
}

/** `records` whose new chats are stored on the terminal surface whatever their agent: for tests of the terminal start path. */
export function onTerminalSurface(records: ChatRecords, store: Pick<ChatStore, 'updateChat'>): ChatRecords {
  return { ...records, createChat: async (request) => store.updateChat(await records.createChat(request), { surface: 'terminal' }) }
}
