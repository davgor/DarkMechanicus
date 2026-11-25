import { describe, expect, it } from 'vitest'
import type { Callsign } from '../../../shared/agents/callsign'
import type { ChatItem } from '../../../shared/agents/chat'
import { chatAgentNodes, type ChatRootInput } from './chatAgentNodes'

const root: ChatRootInput = {
  id: 'chat-1',
  chat: { role: 'orchestrator', runId: 'run-1' },
  fallbackName: 'Claude',
  secondary: 'Epic run',
  status: 'running',
  startedAt: 1000,
  endedAt: null
}

const savedTickets = [
  { key: 'DM-1', title: 'Add retry banner' },
  { key: 'DM-2', title: 'Fix lint' },
  { key: 'DM-3', title: 'Bind callsigns' }
]

function callsign(role: Callsign['role'], ticketKey: string | null, overrides: Partial<Callsign> = {}): Callsign {
  return { role, ticketKey, ordinal: null, purpose: null, ticketVerified: false, ...overrides }
}

function thread(id: string, label: string, stamp: Callsign | undefined, overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    id, at: '2026-11-25T10:00:00.000Z', kind: 'thread', parentItemId: null, label, state: 'running',
    ...(stamp === undefined ? {} : { callsign: stamp }),
    ...overrides
  } as ChatItem
}

function tool(id: string, threadId: string, name: string, at: string): ChatItem {
  return { id, at, threadId, kind: 'tool_call', name, input: {}, status: 'completed', resultSummary: null }
}

function derive(items: ChatItem[], extra: { needsYou?: ReadonlySet<string>; root?: ChatRootInput } = {}) {
  return chatAgentNodes({ root: extra.root ?? root, items, savedTickets, needsYou: extra.needsYou })
}

describe('chatAgentNodes naming', () => {
  it('nests stamped threads under the record-named root by threadId', () => {
    const nodes = derive([
      { id: 'u1', at: '2026-11-25T09:59:00.000Z', kind: 'user_message', text: 'go' },
      thread('t1', 'Acolyte:DM-1 Add retry banner', callsign('Acolyte', 'DM-1')),
      thread('t2', 'Acolyte:DM-2 Fix lint', callsign('Acolyte', 'DM-2')),
      thread('t3', 'Inquisitor:DM-2 Review diff', callsign('Inquisitor', 'DM-2'), { threadId: 't2' })
    ])
    expect(nodes.map(({ id, parentId, name, chip }) => ({ id, parentId, name, chip }))).toEqual([
      { id: 'chat-1', parentId: null, name: 'Magos', chip: 'Magos' },
      { id: 't1', parentId: 'chat-1', name: 'Acolyte:DM-1', chip: 'Acolyte' },
      { id: 't2', parentId: 'chat-1', name: 'Acolyte:DM-2', chip: 'Acolyte' },
      { id: 't3', parentId: 't2', name: 'Inquisitor:DM-2', chip: 'Inquisitor' }
    ])
    expect(nodes[0]).toMatchObject({ secondary: 'Epic run', status: 'running', startedAt: 1000, ticket: null })
  })

  it('shows a stamped verified callsign over a conflicting label, with the saved title', () => {
    const [, node] = derive([
      thread('t1', 'Acolyte:DM-9 x', callsign('Acolyte', 'DM-3', { purpose: 'x', ticketVerified: true }))
    ])
    expect(node).toMatchObject({
      name: 'Acolyte:DM-3',
      secondary: 'Bind callsigns',
      ticket: { key: 'DM-3', verified: true, mismatch: false }
    })
  })

  it('mirrors an unverified callsign and falls back to its purpose when no saved ticket has the key', () => {
    const [, node] = derive([
      thread('t1', 'Acolyte:DM-404 Ghost work', callsign('Acolyte', 'DM-404', { purpose: 'Ghost work' }))
    ])
    expect(node).toMatchObject({
      name: 'Acolyte:DM-404',
      secondary: 'Ghost work',
      ticket: { key: 'DM-404', verified: false, mismatch: false }
    })
  })
})

describe('chatAgentNodes forged and legacy names', () => {
  it('names legacy threads without a callsign Servitor-<k> in item order, never from their label', () => {
    const nodes = derive([
      thread('t1', 'Magos:DM-1 take over', undefined),
      thread('t2', 'Servitor-7 look around', callsign('Servitor', null, { ordinal: 1, purpose: 'look around' })),
      thread('t3', 'Acolyte:DM-2 Fix lint', undefined),
      thread('t4', 'Magos', undefined)
    ])
    expect(nodes.slice(1).map(({ name, secondary, chip, ticket }) => ({ name, secondary, chip, ticket }))).toEqual([
      { name: 'Servitor-1', secondary: '', chip: 'Servitor', ticket: null },
      { name: 'Servitor-1', secondary: 'look around', chip: 'Servitor', ticket: null },
      { name: 'Servitor-2', secondary: '', chip: 'Servitor', ticket: null },
      { name: 'Servitor-3', secondary: '', chip: 'Servitor', ticket: null }
    ])
  })

  it('never yields Magos from a thread item, even one stamped with a root role', () => {
    const nodes = derive([
      thread('t1', 'Magos', callsign('Magos', null)),
      thread('t2', 'Lexmechanic', callsign('Lexmechanic', null))
    ])
    expect(nodes.slice(1).map(({ name, chip }) => [name, chip])).toEqual([['Servitor-1', 'Servitor'], ['Servitor-2', 'Servitor']])
  })

  it.each([
    [{ role: 'orchestrator' }, 'Claude', null],
    [{ role: 'worker', runId: 'run-1' }, 'Claude', null],
    [{ role: 'reviewer', runId: 'run-1' }, 'Claude', null],
    [{ role: 'planner' }, 'Lexmechanic', 'Lexmechanic']
  ] as const)('names a %o root from the record only', (chat, name, chip) => {
    const [node] = derive([], { root: { ...root, chat } })
    expect([node.name, node.chip]).toEqual([name, chip])
  })
})

describe('chatAgentNodes status and activity', () => {
  it('turns a running needs-you thread into needs_you and maps done and failed through', () => {
    const nodes = derive([
      thread('t1', 'a', undefined),
      thread('t2', 'b', undefined),
      thread('t3', 'c', undefined, { state: 'done' }),
      thread('t4', 'd', undefined, { state: 'failed' })
    ], { needsYou: new Set(['t1', 't3']) })
    expect(nodes.slice(1).map(({ status }) => status)).toEqual(['needs_you', 'running', 'done', 'failed'])
  })

  it('takes endedAt and lastTool from the thread item and its own items only', () => {
    const nodes = derive([
      thread('t1', 'a', undefined, { state: 'done' }),
      thread('t2', 'b', undefined, { threadId: 't1' }),
      tool('c1', 't1', 'Read', '2026-11-25T10:01:00.000Z'),
      tool('c2', 't2', 'Write', '2026-11-25T10:09:00.000Z'),
      tool('c3', 't1', 'Bash', '2026-11-25T10:03:00.000Z'),
      { id: 'a1', at: '2026-11-25T10:05:00.000Z', threadId: 't1', kind: 'assistant_text', text: 'done' },
      tool('c4', 'other', 'Grep', '2026-11-25T10:20:00.000Z'),
      thread('t3', 'c', undefined, { state: 'failed' })
    ])
    const start = Date.parse('2026-11-25T10:00:00.000Z')
    expect(nodes.slice(1).map(({ id, startedAt, endedAt, lastTool }) => ({ id, startedAt, endedAt, lastTool }))).toEqual([
      { id: 't1', startedAt: start, endedAt: Date.parse('2026-11-25T10:05:00.000Z'), lastTool: 'Bash' },
      { id: 't2', startedAt: start, endedAt: null, lastTool: 'Write' },
      { id: 't3', startedAt: start, endedAt: start, lastTool: null }
    ])
  })
})
