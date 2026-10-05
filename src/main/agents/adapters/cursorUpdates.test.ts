import { describe, expect, it } from 'vitest'
import type { ChatAdapterEvent } from '../../../shared/agents/chat'
import { UpdateTranslator } from './cursorUpdates'

const AT = '2026-01-01T00:00:00.000Z'
const S = 'sess_1'

function translator(): { events: ChatAdapterEvent[]; apply: (update: unknown) => void; flush: () => void; denied: (id: string) => void } {
  const events: ChatAdapterEvent[] = []
  let count = 0
  const t = new UpdateTranslator({ newId: () => `id_${++count}`, now: () => AT }, (event) => events.push(event))
  return { events, apply: (update) => t.apply(S, update), flush: () => t.flush(), denied: (id) => t.markDenied(S, id) }
}

const chunk = (text: string, messageId?: string) => ({
  sessionUpdate: 'agent_message_chunk',
  ...(messageId === undefined ? {} : { messageId }),
  content: { type: 'text', text }
})

describe('UpdateTranslator text', () => {
  it('streams the chunks as deltas of one item and stores the whole text when flushed', () => {
    const t = translator()

    t.apply(chunk('Hello '))
    t.apply(chunk('there'))
    t.flush()

    expect(t.events).toEqual([
      { type: 'assistant_delta', itemId: 'id_1', delta: 'Hello ' },
      { type: 'assistant_delta', itemId: 'id_1', delta: 'there' },
      { type: 'item', item: { id: 'id_1', at: AT, kind: 'assistant_text', text: 'Hello there' } }
    ])
  })

  it('starts a new text item when the agent starts a new message, and when a tool call interrupts', () => {
    const t = translator()

    t.apply(chunk('one', 'm1'))
    t.apply(chunk('two', 'm2'))
    t.apply({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Grep', kind: 'search', status: 'pending' })
    t.apply(chunk('three', 'm2'))
    t.flush()

    const texts = t.events.flatMap((event) => (event.type === 'item' && event.item.kind === 'assistant_text' ? [event.item] : []))
    expect(texts.map((item) => item.text)).toEqual(['one', 'two', 'three'])
    expect(new Set(texts.map((item) => item.id)).size).toBe(3)
  })

  it('flushing with nothing written emits nothing, and empty chunks are not streamed', () => {
    const t = translator()

    t.apply(chunk(''))
    t.flush()
    t.flush()

    expect(t.events).toEqual([])
  })
})

describe('UpdateTranslator tool calls', () => {
  it('follows a call from running to completed under one item id, with what it printed', () => {
    const t = translator()

    t.apply({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Run `ls`', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } })
    t.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' })
    t.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'a.txt\nb.txt' } }]
    })

    const base = { id: 'tool_sess_1_c1', at: AT, kind: 'tool_call', name: 'Shell', input: { command: 'ls' } }
    expect(t.events).toEqual([
      { type: 'item', item: { ...base, status: 'running', resultSummary: null } },
      { type: 'item', item: { ...base, status: 'completed', resultSummary: 'a.txt\nb.txt' } }
    ])
  })

  it('creates the item from an update for a call it never saw announced', () => {
    const t = translator()

    t.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'late', status: 'completed', title: 'Read file' })

    expect(t.events).toEqual([
      {
        type: 'item',
        item: { id: 'tool_sess_1_late', at: AT, kind: 'tool_call', name: 'Read file', input: {}, status: 'completed', resultSummary: null }
      }
    ])
  })
})

describe('UpdateTranslator tool call results', () => {
  it('reports a failed call, and a refused one as denied', () => {
    const t = translator()
    t.apply({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'x', kind: 'execute', status: 'pending' })
    t.apply({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'y', kind: 'execute', status: 'pending' })

    t.denied('b')
    t.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'failed' })
    t.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'b', status: 'failed' })

    const statuses = t.events.flatMap((event) => (event.type === 'item' && event.item.kind === 'tool_call' ? [event.item.status] : []))
    expect(statuses).toEqual(['running', 'running', 'failed', 'denied'])
  })

  it('summarises an edit by the files it touched, and keeps a long result short', () => {
    const t = translator()

    t.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'e',
      title: 'Edit',
      kind: 'edit',
      status: 'completed',
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }]
    })
    t.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'r',
      title: 'Read',
      kind: 'read',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(5000) } }]
    })

    const summaries = t.events.flatMap((event) => (event.type === 'item' && event.item.kind === 'tool_call' ? [event.item.resultSummary] : []))
    expect(summaries[0]).toBe('Edited src/a.ts')
    expect(summaries[1]?.length).toBeLessThan(700)
  })

  it('does not repeat an item when an update changes nothing', () => {
    const t = translator()

    t.apply({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'x', kind: 'other', status: 'in_progress' })
    t.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'in_progress' })

    expect(t.events).toHaveLength(1)
  })
})

describe('UpdateTranslator ignores', () => {
  it('thoughts, plans, the user\'s own echoed messages and anything it does not know', () => {
    const t = translator()

    t.apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })
    t.apply({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } })
    t.apply({ sessionUpdate: 'plan', entries: [] })
    t.apply({ sessionUpdate: 'available_commands_update', availableCommands: [] })
    t.apply({ sessionUpdate: 'something_new' })
    t.apply({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '' } })
    t.apply({ sessionUpdate: 'tool_call', title: 'no id' })
    t.apply('garbage')
    t.apply(null)
    t.apply({})
    t.flush()

    expect(t.events).toEqual([])
  })
})

describe('UpdateTranslator tool call content that says nothing', () => {
  const resultsOf = (events: ChatAdapterEvent[]): (string | null)[] =>
    events.flatMap((event) => (event.type === 'item' && event.item.kind === 'tool_call' ? [event.item.resultSummary] : []))

  it('has no result for content that is neither a diff nor text', () => {
    const t = translator()

    t.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'c',
      title: 'Run',
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'terminal', terminalId: 'term_1' }, { type: 'content', content: { type: 'image', data: '' } }, 'junk']
    })

    expect(resultsOf(t.events)).toEqual([null])
  })

  it('keeps the status and the result of earlier updates when a later one carries none', () => {
    const t = translator()
    const text = [{ type: 'content', content: { type: 'text', text: 'partial output' } }]

    t.apply({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Run', kind: 'execute', status: 'in_progress', content: text })
    t.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'c', rawInput: { command: 'ls' } })

    expect(t.events).toMatchObject([
      { item: { status: 'running', input: {}, resultSummary: 'partial output' } },
      { item: { status: 'running', input: { command: 'ls' }, resultSummary: 'partial output' } }
    ])
  })
})
