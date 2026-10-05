import { describe, expect, it } from 'vitest'
import { CHAT_ROLES, canSavePlans, chatItemSchema, chatRecordSchema, type ChatItem } from './chat'

const BASE = { id: 'it_1', at: '2026-01-01T00:00:01.000Z' }

const ITEMS: ChatItem[] = [
  { ...BASE, kind: 'user_message', text: 'hello' },
  { ...BASE, kind: 'assistant_text', text: 'hi there' },
  { ...BASE, kind: 'tool_call', name: 'Bash', input: { command: 'npm test', nested: { a: [1, 'b'] } }, status: 'running', resultSummary: null },
  { ...BASE, kind: 'tool_call', name: 'Bash', input: {}, status: 'completed', resultSummary: '3 passed' },
  { ...BASE, kind: 'approval_request', requestId: 'req_1', category: 'command', tool: 'Bash', summary: 'Run npm test', input: { command: 'npm test' } },
  { ...BASE, kind: 'approval_decision', requestId: 'req_1', decision: 'allow_once' },
  { ...BASE, kind: 'approval_decision', requestId: 'req_1', decision: 'cancelled', automatic: false },
  { ...BASE, kind: 'model_change', from: null, to: 'opus' },
  { ...BASE, kind: 'error', message: 'agent exited' },
  { ...BASE, kind: 'context_reset', reason: 'model_change' },
  { ...BASE, kind: 'auth_required', agent: 'claude', message: 'Not logged in · Please run /login' }
]

describe('chatItemSchema', () => {
  it.each(ITEMS.map((item) => [item.kind, item] as const))('accepts a %s item', (_kind, item) => {
    expect(chatItemSchema.parse(item)).toEqual(item)
  })

  it('fails an item of unknown kind', () => {
    expect(chatItemSchema.safeParse({ ...BASE, kind: 'hologram', text: 'x' }).success).toBe(false)
  })

  it('fails an item whose fields do not fit its kind', () => {
    expect(chatItemSchema.safeParse({ ...BASE, kind: 'user_message' }).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...BASE, kind: 'approval_decision', requestId: 'r', decision: 'maybe' }).success).toBe(false)
    expect(chatItemSchema.safeParse('user_message').success).toBe(false)
  })

  it('needs an approval request to say what it asks for, and a decision to be one of the known outcomes', () => {
    const request = { ...BASE, kind: 'approval_request', requestId: 'r', tool: 'Edit', summary: 'Edit a.ts' }
    expect(chatItemSchema.safeParse(request).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...request, category: 'file_edit' }).success).toBe(true)
    expect(chatItemSchema.safeParse({ ...request, category: 'read' }).success).toBe(false)
    for (const decision of ['allow_once', 'allow_chat', 'deny', 'cancelled']) {
      expect(chatItemSchema.safeParse({ ...BASE, kind: 'approval_decision', requestId: 'r', decision }).success).toBe(true)
    }
    expect(chatItemSchema.safeParse({ ...BASE, kind: 'approval_decision', requestId: 'r', decision: 'allow' }).success).toBe(false)
  })

  it('needs an auth_required item to name a known agent and carry the CLI message', () => {
    const item = { ...BASE, kind: 'auth_required', agent: 'codex', message: 'Please log out and sign in again.' }
    expect(chatItemSchema.safeParse(item).success).toBe(true)
    expect(chatItemSchema.safeParse({ ...item, agent: 'gemini' }).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...item, message: undefined }).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...item, agent: undefined }).success).toBe(false)
  })

  it('leaves room for nested threads: threadId is optional and, when present, non-empty', () => {
    const base = { ...BASE, kind: 'assistant_text', text: 'x' }
    expect(chatItemSchema.parse(base)).not.toHaveProperty('threadId')
    expect(chatItemSchema.parse({ ...base, threadId: 'th_1' })).toHaveProperty('threadId', 'th_1')
    expect(chatItemSchema.safeParse({ ...base, threadId: '' }).success).toBe(false)
  })
})

describe('chatRecordSchema', () => {
  const record = {
    id: 'chat_0b2a9c1e-5d3f-4c2a-9a41-7e8f6d5c4b3a',
    folder: '/work/repo',
    agent: 'claude',
    model: 'opus',
    role: 'orchestrator',
    allowSave: true,
    title: 'Run the epic',
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
    sessionId: null
  }

  it('accepts a chat record', () => {
    expect(chatRecordSchema.parse(record)).toEqual(record)
  })

  it('records the run a chat orchestrates, and reads chats stored before runs were recorded', () => {
    expect(chatRecordSchema.parse(record)).not.toHaveProperty('runId')
    expect(chatRecordSchema.parse({ ...record, runId: 'rn_1' })).toHaveProperty('runId', 'rn_1')
    expect(chatRecordSchema.safeParse({ ...record, runId: '' }).success).toBe(false)
  })

  it('records the user message whose turn a sign-in cut short, and reads chats stored without it', () => {
    expect(chatRecordSchema.parse(record)).not.toHaveProperty('cutShortMessageId')
    expect(chatRecordSchema.parse({ ...record, cutShortMessageId: 'it_9' })).toHaveProperty('cutShortMessageId', 'it_9')
    expect(chatRecordSchema.parse({ ...record, cutShortMessageId: null })).toHaveProperty('cutShortMessageId', null)
    expect(chatRecordSchema.safeParse({ ...record, cutShortMessageId: '' }).success).toBe(false)
  })

  it('rejects ids that are not filesystem-safe, and unknown agents or roles', () => {
    expect(chatRecordSchema.safeParse({ ...record, id: '../escape' }).success).toBe(false)
    expect(chatRecordSchema.safeParse({ ...record, agent: 'gemini' }).success).toBe(false)
    expect(chatRecordSchema.safeParse({ ...record, role: 'janitor' }).success).toBe(false)
  })

  it('accepts all four Dark Mechanicus roles, and only planner and orchestrator may save plans', () => {
    expect(CHAT_ROLES).toEqual(['planner', 'orchestrator', 'worker', 'reviewer'])
    for (const role of CHAT_ROLES) {
      expect(chatRecordSchema.safeParse({ ...record, role }).success).toBe(true)
    }
    expect(CHAT_ROLES.filter((role) => canSavePlans(role))).toEqual(['planner', 'orchestrator'])
  })
})
