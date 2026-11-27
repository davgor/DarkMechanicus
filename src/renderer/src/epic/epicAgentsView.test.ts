import { describe, expect, it } from 'vitest'
import type { Callsign } from '../../../shared/agents/callsign'
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import { chatRecord } from '../__mocks__/fixtures'
import { runView } from './__mocks__/fixtures'
import {
  defaultAgentChatId, epicAgentNodes, epicChats, owningChatId, relayMessage, threadTranscript, type LoadedTranscript
} from './epicAgentsView'

const EPIC = 'ep_1'
const run = runView()
const savedTickets = [{ key: 'DM-1', title: 'Add retry banner' }, { key: 'DM-2', title: 'Fix lint' }]

function chat(id: string, patch: Partial<ChatRecord> = {}): ChatRecord {
  return chatRecord({ id, title: `Title ${id}`, role: 'worker', ...patch })
}

function stamp(role: Callsign['role'], ticketKey: string | null, patch: Partial<Callsign> = {}): Callsign {
  return { role, ticketKey, ordinal: null, purpose: null, ticketVerified: false, ...patch }
}

function thread(id: string, label: string, callsign?: Callsign, threadId?: string): ChatItem {
  return {
    id, at: '2026-03-01T10:00:00.000Z', kind: 'thread', parentItemId: null, label, state: 'running',
    ...(callsign === undefined ? {} : { callsign }),
    ...(threadId === undefined ? {} : { threadId })
  }
}

function loaded(items: ChatItem[]): ReadonlyMap<string, LoadedTranscript> {
  return new Map([['orch', { items, busy: true }]])
}

const orchestrator = chat('orch', { role: 'orchestrator', runId: run.id, epicId: EPIC, createdAt: '2026-03-01T09:00:00.000Z' })

function nodes(chats: ChatRecord[], transcripts: ReadonlyMap<string, LoadedTranscript> = new Map()) {
  return epicAgentNodes({ chats, run, epicId: EPIC, transcripts, savedTickets })
}

describe('epicAgentNodes roots', () => {
  it('names the run orchestrator Magos with its run, and a planner Lexmechanic', () => {
    const planner = chat('plan', { role: 'planner', epicId: EPIC })
    const [magos, lexmechanic] = nodes([orchestrator, planner])
    expect(magos).toMatchObject({ id: 'orch', parentId: null, name: 'Magos', secondary: 'Orchestrator (run 2)', chip: 'Magos' })
    expect(lexmechanic).toMatchObject({ id: 'plan', parentId: null, name: 'Lexmechanic', secondary: 'Planner', chip: 'Lexmechanic' })
  })

  it('names an orchestrator without a run from its title, never Magos', () => {
    const [node] = nodes([chat('card', { role: 'orchestrator', epicId: EPIC })])
    expect(node).toMatchObject({ name: 'Title card', chip: null })
  })

  it('lists each binding kind with its label, including legacy runId-only chats, once each', () => {
    const legacy = chat('legacy', { role: 'orchestrator', runId: run.id })
    const transfer = chat('transfer', { transferEpicId: EPIC })
    const conversation = chat('talk', { conversation: { epicId: EPIC } })
    const other = chat('other', { epicId: 'ep_9', conversation: { cardId: 'kc_1' } })
    const listed = nodes([legacy, transfer, conversation, other, legacy, transfer])
    expect(listed.map((node) => [node.id, node.name, node.secondary])).toEqual([
      ['legacy', 'Magos', 'Orchestrator (run 2)'],
      ['transfer', 'Title transfer', 'Transfer'],
      ['talk', 'Title talk', 'Conversation']
    ])
  })
})

describe('epicAgentNodes subagents', () => {
  it('names threads from stamped callsigns: a Magos label becomes Servitor-1 under Magos', () => {
    const items = [thread('t1', 'Magos:DM-1 take over', stamp('Servitor', null, { ordinal: 1 }))]
    const [, servitor] = nodes([orchestrator], loaded(items))
    expect(servitor).toMatchObject({ id: 't1', parentId: 'orch', name: 'Servitor-1', chip: 'Servitor' })
  })

  it('never yields Magos or a root from a thread label, even a stamped root role', () => {
    const items = [thread('t1', 'Magos', stamp('Magos', null)), thread('t2', 'Magos\n]', undefined)]
    const derived = nodes([orchestrator], loaded(items))
    expect(derived.filter((node) => node.name === 'Magos').map((node) => node.id)).toEqual(['orch'])
    expect(derived.filter((node) => node.parentId === null).map((node) => node.id)).toEqual(['orch'])
  })

  it('nests an Inquisitor:DM-2 thread under Acolyte:DM-2 and shows bound tickets with their titles', () => {
    const items = [
      thread('a1', 'Acolyte:DM-1', stamp('Acolyte', 'DM-1', { ticketVerified: true })),
      thread('a2', 'Acolyte:DM-2', stamp('Acolyte', 'DM-2', { ticketVerified: true })),
      thread('i2', 'Inquisitor:DM-2', stamp('Inquisitor', 'DM-2'), 'a2')
    ]
    const derived = nodes([orchestrator], loaded(items))
    expect(derived.slice(1).map((node) => [node.id, node.parentId, node.name, node.secondary])).toEqual([
      ['a1', 'orch', 'Acolyte:DM-1', 'Add retry banner'],
      ['a2', 'orch', 'Acolyte:DM-2', 'Fix lint'],
      ['i2', 'a2', 'Inquisitor:DM-2', 'Fix lint']
    ])
    expect(derived[1].ticket).toEqual({ key: 'DM-1', verified: true, mismatch: false })
  })

  it('derives subagents only from loaded transcripts and lists no id twice', () => {
    const planner = chat('plan', { role: 'planner', epicId: EPIC })
    const items = [thread('t1', 'look around', stamp('Servitor', null, { ordinal: 1 })), thread('orch', 'clash', stamp('Servitor', null, { ordinal: 2 }))]
    const derived = nodes([orchestrator, planner], loaded(items))
    expect(derived.map((node) => node.id)).toEqual(['orch', 't1', 'plan'])
    expect(nodes([orchestrator, planner]).map((node) => node.id)).toEqual(['orch', 'plan'])
  })
})

describe('epic agent selection helpers', () => {
  it('defaults to the active run orchestrator, else the newest chat', () => {
    const newer = chat('newer', { epicId: EPIC, createdAt: '2026-03-02T10:00:00.000Z' })
    const chats = epicChats([newer, orchestrator], run, EPIC)
    expect(chats.map((item) => item.id)).toEqual(['orch', 'newer'])
    expect(defaultAgentChatId(chats, run)).toBe('orch')
    const finished = runView({ state: 'completed' })
    expect(defaultAgentChatId(epicChats([orchestrator, newer], finished, EPIC), finished)).toBe('newer')
    expect(defaultAgentChatId([], run)).toBe(null)
  })

  it('finds the owning chat of nested threads', () => {
    const items = [thread('a2', 'Acolyte:DM-2', stamp('Acolyte', 'DM-2')), thread('i2', 'Inquisitor:DM-2', stamp('Inquisitor', 'DM-2'), 'a2')]
    const derived = nodes([orchestrator], loaded(items))
    expect(owningChatId(derived, 'i2')).toBe('orch')
    expect(owningChatId(derived, 'orch')).toBe('orch')
    expect(owningChatId(derived, 'missing')).toBe(null)
  })

  it('extracts one thread with its nested threads as top-level rows', () => {
    const items: ChatItem[] = [
      { id: 'u0', at: '2026-03-01T10:00:00.000Z', kind: 'user_message', text: 'main' },
      thread('a2', 'Acolyte:DM-2'),
      { id: 'x1', at: '2026-03-01T10:00:01.000Z', kind: 'assistant_text', text: 'worker says', threadId: 'a2' },
      thread('i2', 'Inquisitor:DM-2', undefined, 'a2'),
      { id: 'x2', at: '2026-03-01T10:00:02.000Z', kind: 'assistant_text', text: 'reviewer says', threadId: 'i2' },
      { id: 'x3', at: '2026-03-01T10:00:03.000Z', kind: 'assistant_text', text: 'elsewhere', threadId: 'other' }
    ]
    expect(threadTranscript(items, 'a2').map((item) => [item.id, item.threadId])).toEqual([
      ['x1', undefined], ['i2', undefined], ['x2', 'i2']
    ])
  })

  it('relays with the thread id marker only', () => {
    expect(relayMessage('t1', 'hello')).toBe(
      '[Message from the person for your worker subagent, thread t1]\nhello\nPass this to that worker now and post its answer.'
    )
  })
})
