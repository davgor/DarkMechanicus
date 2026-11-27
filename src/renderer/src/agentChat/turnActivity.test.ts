import { expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { agentChatState, reduceAgentChat } from './agentChatModel'
import { formatElapsed, STALL_AFTER_MS, threadActivity, turnActivity } from './turnActivity'

const ref = { folder: null, chatId: 'chat' }
const busy = () => reduceAgentChat(agentChatState(), { ...ref, type: 'status', status: 'busy' }, 1_000)
const tools: ChatItem[] = [
  { id: 'build', at: '1970-01-01T00:00:02.000Z', kind: 'tool_call', name: 'Build', input: {}, status: 'running', resultSummary: null },
  { id: 'read', at: '1970-01-01T00:00:03.000Z', kind: 'tool_call', name: 'Read', input: {}, status: 'running', resultSummary: null, threadId: 'worker' },
  { id: 'done', at: '1970-01-01T00:00:04.000Z', kind: 'tool_call', name: 'Edit', input: {}, status: 'completed', resultSummary: null, threadId: 'worker' }
]

it('reports the newest running tool across all threads and never stalls a long tool', () => {
  const state = { ...busy(), items: tools }
  expect(turnActivity(state, 5_000)).toEqual({ kind: 'working', elapsedMs: 4_000, tool: 'Read' })
  expect(turnActivity(state, 601_000)).toEqual({ kind: 'working', elapsedMs: 600_000, tool: 'Read' })
})

it('stalls at exactly 30,000 ms of silence, not at 29,999 ms', () => {
  const state = busy()
  expect(STALL_AFTER_MS).toBe(30_000)
  expect(turnActivity(state, 30_999)).toEqual({ kind: 'working', elapsedMs: 29_999, tool: null })
  expect(turnActivity(state, 31_000)).toEqual({ kind: 'stalled', silentMs: 30_000 })
  const delta = reduceAgentChat(state, { ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'Alive' }, 31_000)
  expect(turnActivity(delta, 31_000)).toEqual({ kind: 'working', elapsedMs: 30_000, tool: null })
})

it('does not treat completed, failed, denied or cancelled tools as running', () => {
  for (const status of ['completed', 'failed', 'denied', 'cancelled'] as const) {
    const items: ChatItem[] = [{ id: 'tool', kind: 'tool_call', at: '1970-01-01T00:00:01.000Z', name: 'Build', input: {}, resultSummary: null, status }]
    expect(turnActivity({ ...busy(), items }, 31_000)).toEqual({ kind: 'stalled', silentMs: 30_000 })
  }
})

it('waits for pending prompts even with silence or running tools', () => {
  const state = { ...busy(), pending: { id: 'p', kind: 'question' as const, title: 'Choose', detail: '', threadId: null, attributed: true, callsign: null, arbitration: { state: 'off' as const, reason: null }, options: [] } }
  expect(turnActivity(state, 601_000)).toEqual({ kind: 'waiting' })
  expect(turnActivity({ ...state, items: tools }, 601_000)).toEqual({ kind: 'waiting' })
})

it('has no activity outside busy, including idle after a turn', () => {
  expect(turnActivity(agentChatState(), 1_000)).toBeNull()
  for (const status of ['idle', 'starting', 'exited', 'failed', 'signed_out'] as const) {
    expect(turnActivity(reduceAgentChat(busy(), { ...ref, type: 'status', status }, 2_000), 601_000)).toBeNull()
  }
})

it('formats whole seconds and minutes without rounding up', () => {
  expect([12_000, 72_000, 3_720_000].map(formatElapsed)).toEqual(['12s', '1m 12s', '1h 2m'])
  expect([0, 999, 59_999, 60_000, 3_599_999, 3_600_000, -1].map(formatElapsed)).toEqual(['0s', '0s', '59s', '1m 0s', '59m 59s', '1h 0m', '0s'])
})

it('derives worker and main elapsed time and newest tool independently', () => {
  const items: ChatItem[] = [
    { id: 'user', kind: 'user_message', at: '1970-01-01T00:00:01.000Z', text: 'Work' },
    { id: 'worker', kind: 'thread', at: '1970-01-01T00:00:02.000Z', parentItemId: 'spawn', label: 'Worker', state: 'running' },
    ...tools
  ]
  expect(threadActivity(items, 'worker', 10_000)).toEqual({ elapsedMs: 8_000, lastTool: 'Edit' })
  expect(threadActivity(items, '', 10_000)).toEqual({ elapsedMs: 9_000, lastTool: 'Build' })
  expect(threadActivity(items, 'absent', 10_000)).toEqual({ elapsedMs: 0, lastTool: null })
  expect(threadActivity([], '', 10_000)).toEqual({ elapsedMs: 0, lastTool: null })
})
