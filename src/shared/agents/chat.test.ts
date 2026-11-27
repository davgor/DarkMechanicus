import { describe, expect, it } from 'vitest'
import { CHAT_ROLES, ERROR_PROBLEMS, canSavePlans, chatItemSchema, chatRecordSchema, type ChatItem } from './chat'

const BASE = { id: 'it_1', at: '2026-01-01T00:00:01.000Z' }

const ITEMS: ChatItem[] = [
  { ...BASE, kind: 'user_message', text: 'hello' },
  { ...BASE, kind: 'assistant_text', text: 'hi there' },
  { ...BASE, kind: 'tool_call', name: 'Bash', input: { command: 'npm test', nested: { a: [1, 'b'] } }, status: 'running', resultSummary: null },
  { ...BASE, kind: 'tool_call', name: 'Bash', input: {}, status: 'completed', resultSummary: '3 passed' },
  { ...BASE, kind: 'tool_call', name: 'Bash', input: {}, status: 'cancelled', resultSummary: null },
  { ...BASE, kind: 'approval_request', requestId: 'req_1', category: 'command', tool: 'Bash', summary: 'Run npm test', input: { command: 'npm test' } },
  { ...BASE, kind: 'approval_decision', requestId: 'req_1', decision: 'allow_once' },
  { ...BASE, kind: 'approval_decision', requestId: 'req_1', decision: 'cancelled', automatic: false },
  { ...BASE, kind: 'model_change', from: null, to: 'opus' },
  { ...BASE, kind: 'error', message: 'agent exited' },
  { ...BASE, kind: 'turn_stopped' },
  { ...BASE, kind: 'context_reset', reason: 'model_change' },
  { ...BASE, kind: 'auth_required', agent: 'claude', message: 'Not logged in · Please run /login' },
  { ...BASE, kind: 'thread', parentItemId: 'it_0', label: 'Summarize a.txt', state: 'running' },
  { ...BASE, kind: 'approval_request', requestId: 'req_2', category: 'file_edit', tool: 'Write', summary: 'Write a.txt', threadId: 'th_1', threadLabel: 'Summarize a.txt' }
]

describe('chatItemSchema', () => {
  it.each(ITEMS.map((item) => [item.kind, item] as const))('accepts a %s item', (_kind, item) => {
    expect(chatItemSchema.parse(item)).toEqual(item)
  })

  it('accepts main-resolved callsigns and arbiter decisions while preserving legacy items', () => {
    const callsign = { role: 'Acolyte', ticketKey: 'DM-770', ordinal: null, purpose: null, ticketVerified: true }
    for (const item of ITEMS.filter(item => item.kind === 'approval_request' || item.kind === 'thread')) {
      expect(chatItemSchema.parse({ ...item, callsign })).toEqual({ ...item, callsign })
    }
    const decision = { ...BASE, kind: 'approval_decision', requestId: 'req_1', decision: 'allow_once' }
    expect(chatItemSchema.parse(decision)).toEqual(decision)
    const arbitrated = { ...decision, decidedBy: 'magos', reason: 'Routine test run' }
    expect(chatItemSchema.parse(arbitrated)).toEqual(arbitrated)
    expect(chatItemSchema.safeParse({ ...decision, decidedBy: 'robot' }).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...arbitrated, reason: 'a'.repeat(501) }).success).toBe(false)
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

describe('chatItemSchema: account problems and sign-in notices', () => {
  it('reads an error that names a problem with the account, and an error that names none (stored before)', () => {
    const error = { ...BASE, kind: 'error', message: 'Your account is on hold.' }
    expect(chatItemSchema.parse(error)).not.toHaveProperty('problem')
    for (const problem of ERROR_PROBLEMS) {
      expect(chatItemSchema.parse({ ...error, problem })).toHaveProperty('problem', problem)
    }
    expect(ERROR_PROBLEMS).toEqual(['organization_not_allowed', 'account_on_hold', 'verification_required'])
    expect(chatItemSchema.safeParse({ ...error, problem: 'oauth_org_not_allowed' }).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...error, problem: 'authentication_failed' }).success).toBe(false)
  })

  it('reads an auth_required item that says whether a turn was cut short, and one stored without it', () => {
    const item = { ...BASE, kind: 'auth_required', agent: 'claude', message: 'Not logged in' }
    expect(chatItemSchema.parse(item)).not.toHaveProperty('cutShort')
    expect(chatItemSchema.parse({ ...item, cutShort: false })).toHaveProperty('cutShort', false)
    expect(chatItemSchema.parse({ ...item, cutShort: true })).toHaveProperty('cutShort', true)
    expect(chatItemSchema.safeParse({ ...item, cutShort: 'yes' }).success).toBe(false)
  })
})

describe('chatItemSchema: stopped turns and cancelled calls', () => {
  it("reads a stopped turn in the chat's own thread and in a nested one", () => {
    const stopped = { ...BASE, kind: 'turn_stopped' }
    expect(chatItemSchema.parse(stopped)).not.toHaveProperty('threadId')
    expect(chatItemSchema.parse({ ...stopped, threadId: 'th_1' })).toHaveProperty('threadId', 'th_1')
  })

  it('knows a tool call that was cancelled, and still reads calls stored with the older statuses', () => {
    const call = { ...BASE, kind: 'tool_call', name: 'Bash', input: {}, resultSummary: null }
    for (const status of ['running', 'completed', 'failed', 'denied', 'cancelled']) {
      expect(chatItemSchema.safeParse({ ...call, status }).success).toBe(true)
    }
    expect(chatItemSchema.safeParse({ ...call, status: 'abandoned' }).success).toBe(false)
  })
})

describe('chatItemSchema: image refs', () => {
  const image = { id: 'ci_01m8ec59dbq52ydhsy6ry7knhv', mime: 'image/png', width: 1280, height: 720, bytes: 40_960 }
  const message = { ...BASE, kind: 'user_message', text: 'See this' }
  const call = { ...BASE, kind: 'tool_call', name: 'screenshot', input: {}, status: 'completed', resultSummary: 'Captured' }

  it('reads a user message and a tool call with and without images', () => {
    for (const item of [message, call]) {
      expect(chatItemSchema.parse(item)).toEqual(item)
      expect(chatItemSchema.parse({ ...item, images: [image] })).toEqual({ ...item, images: [image] })
      expect(chatItemSchema.parse({ ...item, images: Array(8).fill(image) })).toHaveProperty('images.length', 8)
      expect(chatItemSchema.safeParse({ ...item, images: Array(9).fill(image) }).success).toBe(false)
      expect(chatItemSchema.safeParse({ ...item, images: [{ ...image, path: 'C:\\shot.png' }] }).success).toBe(false)
      expect(chatItemSchema.safeParse({ ...item, images: [{ ...image, mime: 'image/webp' }] }).success).toBe(false)
    }
    expect(chatItemSchema.parse({ ...message, text: '', images: [image] })).toHaveProperty('text', '')
  })

  it('still reads a legacy stored line with no images', () => {
    const line = '{"id":"it_9","at":"2025-06-01T10:00:00.000Z","kind":"user_message","text":"hello"}'
    expect(chatItemSchema.parse(JSON.parse(line))).toEqual({ id: 'it_9', at: '2025-06-01T10:00:00.000Z', kind: 'user_message', text: 'hello' })
  })
})

describe('chatItemSchema: nested threads', () => {
  const thread = { ...BASE, id: 'th_1', kind: 'thread', parentItemId: 'call_1', label: 'Summarize a.txt', state: 'running' }

  it('says which item spawned a thread, what it is called and how it is going', () => {
    expect(chatItemSchema.parse(thread)).toEqual(thread)
    for (const state of ['running', 'done', 'failed']) {
      expect(chatItemSchema.safeParse({ ...thread, state }).success).toBe(true)
    }
    expect(chatItemSchema.safeParse({ ...thread, state: 'paused' }).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...thread, parentItemId: undefined }).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...thread, parentItemId: '' }).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...thread, label: undefined }).success).toBe(false)
    expect(chatItemSchema.safeParse({ ...thread, label: '' }).success).toBe(false)
  })

  it('represents an unobserved spawning call explicitly without inventing an id', () => {
    expect(chatItemSchema.parse({ ...thread, parentItemId: null })).toEqual({ ...thread, parentItemId: null })
  })

  it('lets a thread sit inside another thread, so a subagent can start one of its own', () => {
    expect(chatItemSchema.parse({ ...thread, threadId: 'th_0' })).toHaveProperty('threadId', 'th_0')
  })

  it('lets an approval request name the thread it was raised in, and reads one that names none', () => {
    const request = { ...BASE, kind: 'approval_request', requestId: 'r', category: 'command', tool: 'Bash', summary: 'Run ls' }
    const plain = chatItemSchema.parse(request)
    expect(plain).not.toHaveProperty('threadId')
    expect(plain).not.toHaveProperty('threadLabel')
    expect(chatItemSchema.parse({ ...request, threadId: 'th_1', threadLabel: 'Summarize a.txt' })).toMatchObject({ threadId: 'th_1', threadLabel: 'Summarize a.txt' })
    expect(chatItemSchema.safeParse({ ...request, threadLabel: '' }).success).toBe(false)
  })
})

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

describe('chatRecordSchema', () => {
  it('accepts a chat record', () => {
    expect(chatRecordSchema.parse(record)).toEqual(record)
  })

  it('loads legacy records and round-trips explicit epic and surface fields', () => {
    expect(chatRecordSchema.parse(record)).not.toHaveProperty('epicId')
    expect(chatRecordSchema.parse(record)).not.toHaveProperty('surface')
    const bound = { ...record, epicId: 'ep_1', surface: 'gui' }
    expect(chatRecordSchema.parse(JSON.parse(JSON.stringify(bound)))).toEqual(bound)
    expect(chatRecordSchema.safeParse({ ...bound, surface: 'web' }).success).toBe(false)
  })

  it('records the run a chat orchestrates, and reads chats stored before runs were recorded', () => {
    expect(chatRecordSchema.parse(record)).not.toHaveProperty('runId')
    expect(chatRecordSchema.parse({ ...record, runId: 'rn_1' })).toHaveProperty('runId', 'rn_1')
    expect(chatRecordSchema.safeParse({ ...record, runId: '' }).success).toBe(false)
  })

  it('records the epic a transfer chat moves to Linear, and reads chats stored before transfers were recorded', () => {
    expect(chatRecordSchema.parse(record)).not.toHaveProperty('transferEpicId')
    expect(chatRecordSchema.parse({ ...record, transferEpicId: 'ep_1' })).toHaveProperty('transferEpicId', 'ep_1')
    expect(chatRecordSchema.parse(JSON.parse(JSON.stringify({ ...record, transferEpicId: 'ep_1' })))).toEqual({ ...record, transferEpicId: 'ep_1' })
    expect(chatRecordSchema.safeParse({ ...record, transferEpicId: '' }).success).toBe(false)
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
