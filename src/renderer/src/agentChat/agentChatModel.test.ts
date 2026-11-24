import { expect, it } from 'vitest'
import type { AgentChatEvent, PendingPrompt } from '../../../shared/agents/agentChat'
import type { ChatItem } from '../../../shared/agents/chat'
import { agentChatState, reduceAgentChat } from './agentChatModel'

const ref = { folder: 'C:\\project', chatId: 'chat-one' }
const item = (id: string, text: string): ChatItem => ({ id, kind: 'assistant_text', at: '2026-01-01T00:00:00.000Z', text })
const prompt: PendingPrompt = { id: 'p1', kind: 'question', title: 'Choose', detail: '', threadId: null, callsign: null, arbitration: { state: 'off', reason: null }, options: [] }

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

  it('loads snapshot todos and replaces or clears only the specified thread', () => {
    const phases = [{ name: 'Work', tasks: [{ id: null, content: 'Implement', status: 'in_progress' as const }] }]
    const initial = agentChatState({ items: [item('a', 'stored')], status: 'busy', pending: prompt, queued: 2, surface: 'gui', todos: [{ threadId: null, phases }] })
    const child = reduceAgentChat(initial, { ...ref, type: 'todos', threadId: 'child', phases })
    const cleared = reduceAgentChat(child, { ...ref, type: 'todos', threadId: null, phases: [] })
    expect(cleared.todos).toEqual([{ threadId: null, phases: [] }, { threadId: 'child', phases }])
    expect(initial.todos).toEqual([{ threadId: null, phases }])
    expect(cleared.items).toBe(initial.items)
  })
