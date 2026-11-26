import { describe, expect, it } from 'vitest'
import {
  AGENT_CHAT_CHANNELS, GUI_PROTOCOL_KINDS, TODO_TOOL_NAMES, agentChatStartSchema, agentChatSendSchema,
  agentChatInterruptSchema, agentChatAnswerSchema, agentChatSetSurfaceSchema, agentChatSnapshotRequestSchema,
  agentChatEventSchema, agentChatSnapshotSchema, pendingPromptSchema, agentTodoTaskSchema, agentTodoPhaseSchema,
  agentChatAttentionSchema, attentionItemSchema, type AgentChatEvent, type AttentionItem, type PendingPrompt
} from './agentChat'

const ref = { folder: null, chatId: 'chat_1' }
const task = { id: null, content: 'Implement contract', status: 'pending' as const }
const phase = { name: 'Work', tasks: [task] }
const prompt: PendingPrompt = {
  id: 'req_1', kind: 'approval', title: 'Run tests', detail: 'npm test', threadId: 'thread_1',
  attributed: true,
  callsign: { role: 'Acolyte', ticketKey: 'DM-770', ordinal: null, purpose: 'Implement contract', ticketVerified: true },
  arbitration: { state: 'deciding', reason: null }, options: [{ id: 'allow_once', label: 'Allow once' }],
  tool: { name: 'Bash', input: { command: 'npm test' } }
}

describe('agent chat contract', () => {
  it.each([
    ['start', agentChatStartSchema, ref], ['send', agentChatSendSchema, { ...ref, text: 'hello' }],
    ['interrupt', agentChatInterruptSchema, ref],
    ['answer', agentChatAnswerSchema, { ...ref, promptId: 'req_1', optionId: 'allow_once', text: 'yes' }],
    ['setSurface', agentChatSetSurfaceSchema, { ...ref, surface: 'gui' }],
    ['snapshot', agentChatSnapshotRequestSchema, ref]
  ] as const)('%s accepts only its strict request payload', (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value)
    expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false)
  })

  it('keeps requests text-only and bounded, with no renderer-supplied identity or authority', () => {
    expect(agentChatSendSchema.safeParse({ ...ref, text: '' }).success).toBe(false)
    expect(agentChatSendSchema.safeParse({ ...ref, text: 'a'.repeat(20_000) }).success).toBe(true)
    expect(agentChatSendSchema.safeParse({ ...ref, text: 'a'.repeat(20_001) }).success).toBe(false)
    for (const field of ['images', 'path', 'bytes', 'dataUrl', 'attachmentId', 'args', 'env', 'cwd']) {
      expect(agentChatSendSchema.safeParse({ ...ref, text: 'hi', [field]: 'forbidden' }).success).toBe(false)
    }
    for (const field of ['decidedBy', 'reason', 'callsign']) {
      expect(agentChatAnswerSchema.safeParse({ ...ref, promptId: 'p', optionId: 'deny', [field]: 'magos' }).success).toBe(false)
    }
    expect(agentChatAnswerSchema.safeParse({ ...ref, promptId: 'p', optionId: 'x', text: 'a'.repeat(20_001) }).success).toBe(false)
  })
})

describe('agent chat events and snapshots', () => {

  it('round-trips every push variant including callsigns, arbitration and per-thread to-dos', () => {
    const events: AgentChatEvent[] = [
      { ...ref, type: 'item', item: { id: 'it_1', at: 'now', kind: 'assistant_text', text: 'hello' } },
      { ...ref, type: 'delta', itemId: 'it_1', kind: 'text', text: 'hi' },
      { ...ref, type: 'delta', itemId: 'it_1', kind: 'thinking', text: 'considering' },
      { ...ref, type: 'stream_end', itemId: 'it_1' },
      { ...ref, type: 'status', status: 'busy', detail: 'working' },
      { ...ref, type: 'pending', prompt }, { ...ref, type: 'pending', prompt: null },
      { ...ref, type: 'queued', count: 2 },
      { ...ref, type: 'todos', threadId: null, phases: [phase] },
      { ...ref, type: 'todos', threadId: 'thread_1', phases: [] }
    ]
    for (const event of events) expect(agentChatEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event)
    expect(pendingPromptSchema.parse(JSON.parse(JSON.stringify(prompt)))).toEqual(prompt)
    expect(pendingPromptSchema.safeParse({ ...prompt, options: [{ id: 'custom', label: 'custom' }] }).success).toBe(false)
    expect(pendingPromptSchema.safeParse({ ...prompt, kind: 'question', options: [{ id: 'custom', label: 'custom' }] }).success).toBe(true)
    expect(pendingPromptSchema.safeParse({ ...prompt, arbitration: { state: 'escalated', reason: 'a'.repeat(501) } }).success).toBe(false)
    expect(pendingPromptSchema.safeParse({ ...prompt, attributed: false }).success).toBe(true)
    expect(pendingPromptSchema.safeParse({ ...prompt, attributed: undefined }).success).toBe(false)
    expect(pendingPromptSchema.safeParse({ ...prompt, attributed: 'true' }).success).toBe(false)
  })

  it('requires a nonempty stream retirement id and no durable content', () => {
    expect(agentChatEventSchema.safeParse({ ...ref, type: 'stream_end', itemId: '' }).success).toBe(false)
    expect(agentChatEventSchema.safeParse({ ...ref, type: 'stream_end', itemId: 'a', text: '' }).success).toBe(false)
  })

  it('rejects invalid tasks, phases and over-limit lists', () => {
    for (const invalid of [{ ...task, status: 'unknown' }, { id: null, status: 'pending' }, { ...task, extra: true }, { ...task, content: '' }, { ...task, content: 'a'.repeat(501) }, { ...task, id: 'a'.repeat(65) }]) {
      expect(agentTodoTaskSchema.safeParse(invalid).success).toBe(false)
    }
    expect(agentTodoPhaseSchema.safeParse({ ...phase, tasks: Array(101).fill(task) }).success).toBe(false)
    expect(agentTodoPhaseSchema.safeParse({ ...phase, extra: true }).success).toBe(false)
    expect(agentChatEventSchema.safeParse({ ...ref, type: 'todos', threadId: null, phases: Array(21).fill(phase) }).success).toBe(false)
    expect(agentChatEventSchema.safeParse({ ...ref, type: 'todos', threadId: null, phases: [{ ...phase, tasks: [{ ...task, status: 'unknown' }] }] }).success).toBe(false)
  })

  it('requires per-thread to-dos in a snapshot', () => {
    const snapshot = { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui' }
    expect(agentChatSnapshotSchema.safeParse(snapshot).success).toBe(false)
    const complete = { ...snapshot, todos: [{ threadId: null, phases: [phase] }] }
    expect(agentChatSnapshotSchema.parse(complete)).toEqual(complete)
  })

  it('fixes channel and protocol/tool names for all consumers', () => {
    expect(AGENT_CHAT_CHANNELS).toEqual(Object.fromEntries(['start', 'send', 'interrupt', 'answer', 'setSurface', 'snapshot', 'event', 'attention'].map(name => [name, `agentChat:${name}`])))
    expect(GUI_PROTOCOL_KINDS).toEqual(['omp', 'claude'])
    expect(TODO_TOOL_NAMES).toEqual(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'todo'])
  })
})

describe('agent chat attention', () => {
  it('carries a folder attention list with only the named fields, bounded titles and no tool input', () => {
    const item: AttentionItem = {
      chatId: 'chat_1', promptId: 'req_1', kind: 'approval', threadId: 'thread_1', callsign: prompt.callsign,
      arbitration: 'escalated', title: 'a'.repeat(200), shown: true
    }
    const queued: AttentionItem = { ...item, promptId: 'req_2', kind: 'question', threadId: null, callsign: null, arbitration: 'off', shown: false }
    for (const event of [{ ...ref, type: 'attention', items: [item, queued] }, { ...ref, type: 'attention', items: [] }] as AgentChatEvent[]) {
      expect(agentChatEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event)
    }
    for (const invalid of [
      { ...item, title: 'a'.repeat(201) }, { ...item, tool: prompt.tool }, { ...item, detail: 'npm test' },
      { ...item, options: prompt.options }, { ...item, arbitration: { state: 'deciding', reason: null } }, { ...item, arbitration: 'decided' },
      { ...item, kind: 'command' }, { ...item, promptId: '' }, { ...item, chatId: '../escape' }, { ...item, shown: undefined }
    ]) {
      expect(attentionItemSchema.safeParse(invalid).success).toBe(false)
      expect(agentChatEventSchema.safeParse({ ...ref, type: 'attention', items: [invalid] }).success).toBe(false)
    }
    expect(agentChatEventSchema.safeParse({ ...ref, type: 'attention' }).success).toBe(false)
  })

  it('accepts only a nullable folder as the attention request', () => {
    for (const valid of [{ folder: null }, { folder: '/repo' }]) expect(agentChatAttentionSchema.parse(valid)).toEqual(valid)
    for (const invalid of [{}, { folder: 1 }, { folder: '/repo', chatId: 'chat_1' }, { folder: '/repo', cwd: '/' }, null]) {
      expect(agentChatAttentionSchema.safeParse(invalid).success).toBe(false)
    }
  })
})
