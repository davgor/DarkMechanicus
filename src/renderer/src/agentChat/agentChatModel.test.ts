import { expect, it } from 'vitest'
import type { AgentChatEvent, AgentTodoPhase, PendingPrompt } from '../../../shared/agents/agentChat'
import type { ChatItem } from '../../../shared/agents/chat'
import { agentChatState, reduceAgentChat } from './agentChatModel'

const ref = { folder: 'C:\\project', chatId: 'chat-one' }
const item = (id: string, text: string): ChatItem => ({ id, kind: 'assistant_text', at: '2026-01-01T00:00:00.000Z', text })
const prompt: PendingPrompt = { id: 'p1', kind: 'question', title: 'Choose', detail: '', threadId: null, attributed: true, callsign: null, arbitration: { state: 'off', reason: null }, options: [] }

  it('accumulates text and thinking separately and commits exactly one item without mutating old state', () => {
    const initial = agentChatState()
    const first = reduceAgentChat(initial, { ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'Hello' })
    const thought = reduceAgentChat(first, { ...ref, type: 'delta', itemId: 'a', kind: 'thinking', text: 'Consider' })
    const streamed = reduceAgentChat(thought, { ...ref, type: 'delta', itemId: 'a', kind: 'text', text: ' world' })
    expect(initial.streaming.size).toBe(0)
    expect(first.streaming.get('a')).toEqual({ text: 'Hello', thinking: '' })
    expect(streamed.streaming.get('a')).toEqual({ text: 'Hello world', thinking: 'Consider' })
    const committed = reduceAgentChat(streamed, { ...ref, type: 'item', item: item('a', 'Hello world') })
    expect(committed.items).toEqual([item('a', 'Hello world')])
    expect(committed.streaming.size).toBe(0)
    expect(streamed.streaming.size).toBe(1)
  })

  it('upserts an earlier item in place and drops only its own streaming buffer', () => {
    let state = agentChatState()
    for (const id of ['a', 'b']) {
      state = reduceAgentChat(state, { ...ref, type: 'item', item: item(id, 'old') })
      state = reduceAgentChat(state, { ...ref, type: 'delta', itemId: id, kind: 'text', text: 'new' })
    }
    const updated = reduceAgentChat(state, { ...ref, type: 'item', item: item('a', 'new') })
    expect(updated.items).toEqual([item('a', 'new'), item('b', 'old')])
    expect(updated.items[1]).toBe(state.items[1])
    expect([...updated.streaming.keys()]).toEqual(['b'])
  })

  it('sets and clears pending prompts and tracks queued counts', () => {
    const pending = reduceAgentChat(agentChatState(), { ...ref, type: 'pending', prompt })
    expect(pending.pending).toBe(prompt)
    const queued = reduceAgentChat(pending, { ...ref, type: 'queued', count: 3 })
    expect(queued.queued).toBe(3)
    expect(reduceAgentChat(queued, { ...ref, type: 'queued', count: 0 }).queued).toBe(0)
    expect(reduceAgentChat(queued, { ...ref, type: 'pending', prompt: null }).pending).toBeNull()
  })

  it('tracks every status transition and clears old failure details', () => {
    let state = agentChatState()
    const statuses: Extract<AgentChatEvent, { type: 'status' }>['status'][] = ['starting', 'idle', 'busy', 'signed_out', 'failed', 'exited']
    for (const status of statuses) {
      state = reduceAgentChat(state, { ...ref, type: 'status', status, detail: 'detail' })
      expect(state.status).toBe(status)
      expect(state.statusDetail).toBe('detail')
    }
    expect(reduceAgentChat(state, { ...ref, type: 'status', status: 'idle' }).statusDetail).toBeUndefined()
  })

  it('seeds the renderer map from snapshot arrays, omitting empty lists', () => {
    const phases = [{ name: 'Work', tasks: [{ id: null, content: 'Implement', status: 'in_progress' as const }] }]
    const todos = [{ threadId: null, phases }, { threadId: 'child', phases }, { threadId: 'empty', phases: [] }]
    const initial = agentChatState({ items: [item('a', 'stored')], status: 'busy', pending: prompt, queued: 2, surface: 'gui', todos })
    expect(initial.todos).toEqual(new Map([['', phases], ['child', phases]]))
    expect(initial.todos.get('')).toBe(phases)
    expect(todos).toHaveLength(3)
    expect(initial.turn).toBe(0)
  })

  it('sets, replaces and deletes thread lists without mutating other threads or previous state', () => {
    const phases = [{ name: 'Work', tasks: [{ id: null, content: 'Implement', status: 'in_progress' as const }] }]
    const replacement = [{ name: 'Done', tasks: [{ id: null, content: 'Implement', status: 'completed' as const }] }]
    const initial = agentChatState()
    const main = reduceAgentChat(initial, { ...ref, type: 'todos', threadId: null, phases })
    const child = reduceAgentChat(main, { ...ref, type: 'todos', threadId: 'child', phases })
    const replaced = reduceAgentChat(child, { ...ref, type: 'todos', threadId: null, phases: replacement })
    const cleared = reduceAgentChat(replaced, { ...ref, type: 'todos', threadId: null, phases: [] })
    expect(initial.todos.size).toBe(0)
    expect(main.todos).toEqual(new Map([['', phases]]))
    expect(child.todos).toEqual(new Map([['', phases], ['child', phases]]))
    expect(replaced.todos).toEqual(new Map<string, AgentTodoPhase[]>([['', replacement], ['child', phases]]))
    expect(replaced.todos.get('child')).toBe(child.todos.get('child'))
    expect(cleared.todos).toEqual(new Map([['child', phases]]))
    expect(cleared.items).toBe(initial.items)
    expect(reduceAgentChat(cleared, { ...ref, type: 'todos', threadId: 'child', phases: [] }).todos.size).toBe(0)
    expect(reduceAgentChat(initial, { ...ref, type: 'todos', threadId: 'absent', phases: [] }).todos.size).toBe(0)
  })

  it('increments turns only on transitions into busy', () => {
    let state = agentChatState()
    expect(state.turn).toBe(0)
    for (const [status, turn] of [
      ['idle', 0], ['busy', 1], ['busy', 1], ['idle', 1],
      ['busy', 2], ['failed', 2], ['busy', 3]
    ] as const) {
      state = reduceAgentChat(state, { ...ref, type: 'status', status })
      expect(state.turn).toBe(turn)
    }
  })

it('records the injected arrival time for every event, including deltas and ephemeral state', () => {
  const events: AgentChatEvent[] = [
    { ...ref, type: 'status', status: 'busy' },
    { ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'Hello' },
    { ...ref, type: 'item', item: item('a', 'Hello') },
    { ...ref, type: 'todos', threadId: null, phases: [] },
    { ...ref, type: 'pending', prompt },
    { ...ref, type: 'queued', count: 1 }
  ]
  let state = agentChatState()
  for (const [index, event] of events.entries()) {
    const previous = state
    state = reduceAgentChat(state, event, (index + 1) * 1_000)
    expect(state.lastEventAt).toBe((index + 1) * 1_000)
    expect(previous.lastEventAt).toBe(index * 1_000)
  }
})

it('starts timing only on entry into busy and clears every terminal turn status', () => {
  const busy = reduceAgentChat(agentChatState(), { ...ref, type: 'status', status: 'busy' }, 1_000)
  expect(busy.turnStartedAt).toBe(1_000)
  expect(reduceAgentChat(busy, { ...ref, type: 'status', status: 'busy' }, 2_000).turnStartedAt).toBe(1_000)
  for (const status of ['idle', 'exited', 'failed', 'signed_out'] as const) {
    const ended = reduceAgentChat(busy, { ...ref, type: 'status', status }, 3_000)
    expect(ended.turnStartedAt).toBeNull()
    expect(reduceAgentChat(ended, { ...ref, type: 'status', status: 'busy' }, 4_000).turnStartedAt).toBe(4_000)
  }
})

it('loads busy timing from the last user message, otherwise from the load time', () => {
  const snapshot = {
    items: [
      { id: 'u1', text: 'First', kind: 'user_message' as const, at: new Date(1_000).toISOString() },
      { id: 'u2', text: 'Second', kind: 'user_message' as const, at: new Date(2_000).toISOString() },
      item('a', 'Later assistant')
    ],
    status: 'busy' as const, pending: null, queued: 0, surface: 'gui' as const, todos: []
  }
  expect(agentChatState(snapshot, 5_000)).toMatchObject({ lastEventAt: 5_000, turnStartedAt: 2_000 })
  expect(agentChatState({ ...snapshot, items: [] }, 5_000).turnStartedAt).toBe(5_000)
  expect(agentChatState({ ...snapshot, items: [{ ...snapshot.items[1], at: 'invalid' }] }, 5_000).turnStartedAt).toBe(5_000)
  expect(agentChatState({ ...snapshot, status: 'idle' }, 5_000).turnStartedAt).toBeNull()
})

it('retires only the named ephemeral stream without changing durable answers or earlier state', () => {
  let state = agentChatState()
  state = reduceAgentChat(state, { ...ref, type: 'item', item: item('answer', 'Final answer') })
  for (const itemId of ['thinking', 'worker']) {
    state = reduceAgentChat(state, { ...ref, type: 'delta', itemId, kind: 'thinking', text: 'Working' })
  }
  const retired = reduceAgentChat(state, { ...ref, type: 'stream_end', itemId: 'thinking' }, 42)
  expect([...retired.streaming.keys()]).toEqual(['worker'])
  expect(retired.items).toBe(state.items)
  expect(retired.lastEventAt).toBe(42)
  expect([...state.streaming.keys()]).toEqual(['thinking', 'worker'])
  expect(reduceAgentChat(retired, { ...ref, type: 'stream_end', itemId: 'absent' }, 43))
    .toEqual({ ...retired, lastEventAt: 43 })
})
