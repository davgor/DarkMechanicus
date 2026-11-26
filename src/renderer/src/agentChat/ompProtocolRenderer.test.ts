import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { createOmpState, initLines, translateOmpLine, type OmpEvent } from '../../../main/agentChat/ompProtocol'
import { agentChatState, reduceAgentChat } from './agentChatModel'

const at = '2026-11-24T00:00:00.000Z'
const root = join(import.meta.dirname, '..', '..', '..', 'main', 'agentChat', '__fixtures__', 'omp')
function lines(name: string, direction: 'in' | 'out'): string[] {
  const text = readFileSync(join(root, `${name}.${direction}.jsonl`), 'utf8')
  expect(text).not.toContain('\r')
  return text.trim().split(/\r?\n/)
}
function initialized() {
  let state = createOmpState()
  const events: OmpEvent[] = []
  function feed(frame: unknown) {
    const result = translateOmpLine(typeof frame === 'string' ? frame : JSON.stringify(frame), state, at)
    state = result.state; events.push(...result.events)
    return result.events
  }
  const startup = lines('init', 'out')
  feed(startup[0])
  const ids = ['protocol', 'askdialog', 'subscription', 'filter', 'state']
  const ready = initLines(JSON.parse(startup[0]), state, () => `req_T1_${ids.shift()}`)
  expect(ready.lines).toEqual(lines('init', 'in'))
  state = ready.state
  startup.slice(1).forEach(feed)
  events.length = 0
  return { events, feed }
}
const textItem = (text: string, index = 0): ChatItem => ({ kind: 'assistant_text', id: `omp:main:message:1:${index}`, at, text })

describe('OMP thinking retirement through the actual renderer reducer', () => {
  it('retires the fixture thinking stream while retaining its committed text and unrelated worker streams', () => {
    const h = initialized()
    let rendered = reduceAgentChat(agentChatState(), { type: 'delta', folder: null, chatId: 'test', itemId: 'worker-live', kind: 'thinking', text: 'Worker is still thinking' })
    for (const line of lines('text', 'out')) {
      for (const event of h.feed(line)) rendered = reduceAgentChat(rendered, { ...event, folder: null, chatId: 'test' })
    }
    expect(rendered.items).toEqual([textItem('Hello world', 1)])
    expect([...rendered.streaming]).toEqual([['worker-live', { text: '', thinking: 'Worker is still thinking' }]])
    expect(h.events.filter(event => event.type === 'stream_end')).toEqual([{ type: 'stream_end', itemId: 'omp:main:message:1:0' }])
  })
  it.each(['completed', 'error', 'aborted'])('retires thinking exactly once on %s without relying on a final assistant frame', status => {
    const h = initialized()
    let rendered = reduceAgentChat(agentChatState(), { type: 'delta', folder: null, chatId: 'test', itemId: 'worker-live', kind: 'thinking', text: 'Working' })
    const frames = [
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 2, delta: 'Think' } },
      { type: 'prompt_result', status, error: { message: 'Failed' } }
    ]
    for (const frame of frames) for (const event of h.feed(frame)) rendered = reduceAgentChat(rendered, { ...event, folder: null, chatId: 'test' })
    expect([...rendered.streaming.keys()]).toEqual(['worker-live'])
    expect(h.events.filter(event => event.type === 'stream_end')).toEqual([{ type: 'stream_end', itemId: 'omp:main:message:1:2' }])
    expect(rendered.items.some(item => item.kind === 'assistant_text')).toBe(false)
    expect(rendered.status).toBe('idle')
  })
  it('retires a thinking_end block before the answer finishes and never duplicates its retirement', () => {
    const h = initialized()
    h.feed({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Think' } })
    h.feed({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 } })
    const message = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Think' }, { type: 'text', text: 'Answer' }] }
    h.feed({ type: 'message_end', message }); h.feed({ type: 'turn_end', message }); h.feed({ type: 'prompt_result', status: 'completed' })
    const rendered = h.events.reduce((state, event) => reduceAgentChat(state, { ...event, folder: null, chatId: 'test' }), agentChatState())
    expect(rendered.streaming.size).toBe(0)
    expect(rendered.items).toEqual([textItem('Answer', 1)])
    expect(h.events.filter(event => event.type === 'stream_end')).toEqual([{ type: 'stream_end', itemId: 'omp:main:message:1:0' }])
  })
})
