import type { AgentChatEvent, AgentChatSnapshot, AgentTodoPhase } from '../../../../shared/agents/agentChat'
import type { Callsign } from '../../../../shared/agents/callsign'
import type { ChatItem } from '../../../../shared/agents/chat'

const ref = { folder: null, chatId: 'fixture-chat' }
const at = '2026-11-24T08:00:00.000Z'
export const agentChatScenarioClockStart = Date.parse(at)
const empty: AgentChatSnapshot = { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] }
const conversation: ChatItem[] = [
  { id: 'user', at, kind: 'user_message', text: 'Check the chat view.' },
  { id: 'assistant', at, kind: 'assistant_text', text: 'I will inspect the **chat view**.' }
]
const tool: ChatItem = { id: 'tool', at, kind: 'tool_call', name: 'Read', input: { path: 'src/renderer/src/agentChat/AgentChat.tsx' }, status: 'running', resultSummary: null }

const stamp = (role: Callsign['role'], ticketKey: string | null, ordinal: number | null = null): Callsign =>
  ({ role, ticketKey, ordinal, purpose: null, ticketVerified: false })
/** Two Acolytes, an Inquisitor inside the DM-2 thread and an unnamed helper; each thread ran one tool. */
const treeItems: ChatItem[] = [
  ...conversation,
  { id: 'spawn-dm1', at, kind: 'tool_call', name: 'Task', input: { description: 'Add retry banner' }, status: 'completed', resultSummary: 'Worker finished' },
  { id: 'th-dm1', at, kind: 'thread', parentItemId: 'spawn-dm1', label: 'Acolyte:DM-1 Add retry banner', state: 'done', callsign: stamp('Acolyte', 'DM-1') },
  { id: 'dm1-edit', at, kind: 'tool_call', threadId: 'th-dm1', name: 'Edit', input: { path: 'src/banner.tsx' }, status: 'completed', resultSummary: 'Edited' },
  { id: 'spawn-dm2', at, kind: 'tool_call', name: 'Task', input: { description: 'Fix lint' }, status: 'running', resultSummary: null },
  { id: 'th-dm2', at, kind: 'thread', parentItemId: 'spawn-dm2', label: 'Acolyte:DM-2 Fix lint', state: 'running', callsign: stamp('Acolyte', 'DM-2') },
  { id: 'dm2-lint', at, kind: 'tool_call', threadId: 'th-dm2', name: 'Bash', input: { command: 'npm run lint' }, status: 'completed', resultSummary: 'Clean' },
  { id: 'spawn-review', at, kind: 'tool_call', threadId: 'th-dm2', name: 'Task', input: { description: 'Review diff' }, status: 'running', resultSummary: null },
  { id: 'th-review', at, kind: 'thread', threadId: 'th-dm2', parentItemId: 'spawn-review', label: 'Inquisitor:DM-2 Review diff', state: 'running', callsign: stamp('Inquisitor', 'DM-2') },
  { id: 'review-read', at, kind: 'tool_call', threadId: 'th-review', name: 'Read', input: { path: 'src/lint.ts' }, status: 'running', resultSummary: null },
  { id: 'spawn-look', at, kind: 'tool_call', name: 'Task', input: { description: 'look around' }, status: 'running', resultSummary: null },
  { id: 'th-look', at, kind: 'thread', parentItemId: 'spawn-look', label: 'look around', state: 'running', callsign: stamp('Servitor', null, 1) },
  { id: 'look-glob', at, kind: 'tool_call', threadId: 'th-look', name: 'Glob', input: { pattern: '**/*.ts' }, status: 'running', resultSummary: null }
]

/** A live helper stored before callsigns existed, then one main stamped Servitor-1 counting only stamped threads. */
const legacyItems: ChatItem[] = [
  ...conversation,
  { id: 'spawn-old', at, kind: 'tool_call', name: 'Task', input: { description: 'Explore the repo' }, status: 'running', resultSummary: null },
  { id: 'th-old', at, kind: 'thread', parentItemId: 'spawn-old', label: 'Explore the repo', state: 'running' },
  { id: 'old-grep', at, kind: 'tool_call', threadId: 'th-old', name: 'Grep', input: { pattern: 'callsign' }, status: 'running', resultSummary: null },
  { id: 'spawn-new', at, kind: 'tool_call', name: 'Task', input: { description: 'look around' }, status: 'running', resultSummary: null },
  { id: 'th-new', at, kind: 'thread', parentItemId: 'spawn-new', label: 'look around', state: 'running', callsign: stamp('Servitor', null, 1) },
  { id: 'new-glob', at, kind: 'tool_call', threadId: 'th-new', name: 'Glob', input: { pattern: '**/*.ts' }, status: 'running', resultSummary: null }
]

/** A worker thread edited one file twice and wrote another; the orchestrator itself edited a file outside the folder. */
const changesItems: ChatItem[] = [
  ...conversation,
  { id: 'spawn-dm3', at, kind: 'tool_call', name: 'Task', input: { description: 'Add changes card' }, status: 'completed', resultSummary: 'Worker finished' },
  { id: 'th-dm3', at, kind: 'thread', parentItemId: 'spawn-dm3', label: 'Acolyte:DM-3 Add changes card', state: 'done', callsign: stamp('Acolyte', 'DM-3') },
  { id: 'dm3-edit-1', at, kind: 'tool_call', threadId: 'th-dm3', name: 'Edit', input: { file_path: 'src/card/ChangesCard.tsx' }, status: 'completed', resultSummary: 'Edited' },
  { id: 'dm3-write', at, kind: 'tool_call', threadId: 'th-dm3', name: 'Write', input: { file_path: 'src/card/changes.css' }, status: 'completed', resultSummary: 'Written' },
  { id: 'dm3-edit-2', at, kind: 'tool_call', threadId: 'th-dm3', name: 'Edit', input: { file_path: 'src/card/ChangesCard.tsx' }, status: 'completed', resultSummary: 'Edited' },
  { id: 'outside-edit', at, kind: 'tool_call', name: 'Edit', input: { file_path: 'C:/Elsewhere/notes.md' }, status: 'completed', resultSummary: 'Edited' }
]

const todoPhases: AgentTodoPhase[] = [
  { name: 'Inspect', tasks: [
    { id: '1', content: 'Read the contract', status: 'completed' },
    { id: '2', content: 'Inspect the view', status: 'completed' },
    { id: '3', content: 'Check the model', status: 'completed' }
  ] },
  { name: 'Deliver', tasks: [
    { id: '4', content: 'Implement the card', activeForm: 'Implementing the card', status: 'in_progress' },
    { id: '5', content: 'Capture the surface', status: 'blocked', blocker: 'Review fixture approval' },
    { id: '6', content: 'Replace the transcript', status: 'abandoned' },
    { id: '7', content: 'Review the result', status: 'pending' }
  ] }
]
/** Snapshot arrays remain the transport contract, independent of the renderer's derived state. */
export const agentChatScenarios: Record<'empty' | 'streaming' | 'tool' | 'approval' | 'error' | 'todos' | 'todosDone' | 'stalled' | 'tree' | 'legacy' | 'changes', { snapshot: AgentChatSnapshot; events: AgentChatEvent[]; commit: AgentChatEvent[]; advanceMs?: number }> = {
  empty: { snapshot: empty, events: [], commit: [] },
  tree: { snapshot: { ...empty, status: 'busy', items: treeItems }, events: [], commit: [] },
  legacy: { snapshot: { ...empty, status: 'busy', items: legacyItems }, events: [], commit: [] },
  changes: { snapshot: { ...empty, status: 'exited', items: changesItems }, events: [], commit: [] },
  stalled: {
    snapshot: { ...empty, status: 'busy', items: conversation },
    events: [], commit: [], advanceMs: 31_000
  },
  todos: {
    snapshot: { ...empty, status: 'busy', todos: [{ threadId: null, phases: todoPhases }] },
    events: [], commit: []
  },
  todosDone: {
    snapshot: { ...empty, status: 'busy', todos: [{ threadId: null, phases: todoPhases }] },
    events: [{ ...ref, type: 'todos', threadId: null, phases: todoPhases.map((phase) => ({
      ...phase, tasks: phase.tasks.map((task) => ({ ...task, status: 'completed' }))
    })) }],
    commit: [{ ...ref, type: 'status', status: 'idle' }]
  },
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
      attributed: false,
      arbitration: { state: 'off', reason: null }, options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }]
    } },
    events: [], commit: []
  },
  error: {
    snapshot: { ...empty, status: 'failed', items: [...conversation, { id: 'error', at, kind: 'error', code: 'agent_failed', message: 'The agent process stopped unexpectedly.' }] },
    events: [], commit: []
  }
}
