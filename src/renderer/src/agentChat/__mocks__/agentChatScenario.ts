import type { AgentChatEvent, AgentChatSnapshot } from '../../../../shared/agents/agentChat'
import type { ChatItem } from '../../../../shared/agents/chat'

const ref = { folder: null, chatId: 'fixture-chat' }
const at = '2026-11-24T08:00:00.000Z'
const empty: AgentChatSnapshot = { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] }
const conversation: ChatItem[] = [
  { id: 'user', at, kind: 'user_message', text: 'Check the chat view.' },
  { id: 'assistant', at, kind: 'assistant_text', text: 'I will inspect the **chat view**.' }
]
const tool: ChatItem = { id: 'tool', at, kind: 'tool_call', name: 'Read', input: { path: 'src/renderer/src/agentChat/AgentChat.tsx' }, status: 'running', resultSummary: null }

/** Snapshot arrays remain the transport contract, independent of the renderer's derived state. */
export const agentChatScenarios: Record<'empty' | 'streaming' | 'tool' | 'approval' | 'error', { snapshot: AgentChatSnapshot; events: AgentChatEvent[]; commit: AgentChatEvent[] }> = {
  empty: { snapshot: empty, events: [], commit: [] },
  streaming: {
    snapshot: { ...empty, items: conversation, status: 'busy', queued: 2 },
    events: [
      { ...ref, type: 'delta', itemId: 'live', kind: 'thinking', text: 'Checking layout and keyboard behavior.' },
      { ...ref, type: 'delta', itemId: 'live', kind: 'text', text: 'The **streamed reply** is arriving.' }
    ],
    commit: [
      { ...ref, type: 'item', item: { id: 'live', at, kind: 'assistant_text', text: 'The **streamed reply** is arriving.' } },
      { ...ref, type: 'status', status: 'idle' }
    ]
  },
  tool: {
    snapshot: { ...empty, status: 'busy', items: [
      ...conversation, tool,
      { id: 'spawn', at, kind: 'tool_call', name: 'Task', input: { description: 'Inspect composer' }, status: 'completed', resultSummary: 'Worker started' },
      { id: 'thread', at, kind: 'thread', parentItemId: 'spawn', label: 'Acolyte:DM-785 Inspect composer', state: 'done' },
      { id: 'thread-message', at, kind: 'assistant_text', threadId: 'thread', text: 'Composer keyboard behavior inspected.' }
    ] },
    events: [],
    commit: [
      { ...ref, type: 'item', item: { ...tool, status: 'completed', resultSummary: 'Read 120 lines' } },
      { ...ref, type: 'status', status: 'idle' }
    ]
  },
  approval: {
    snapshot: { ...empty, items: conversation, pending: {
      id: 'approval', kind: 'approval', title: 'Run tests?', detail: 'Run the targeted chat tests.', threadId: null, callsign: null,
      arbitration: { state: 'off', reason: null }, options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }]
    } },
    events: [], commit: []
  },
  error: {
    snapshot: { ...empty, status: 'failed', items: [...conversation, { id: 'error', at, kind: 'error', code: 'agent_failed', message: 'The agent process stopped unexpectedly.' }] },
    events: [], commit: []
  }
}
