import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import { AT, builtInAgent, connectedAgents, memoryChatFs, memoryChatStore, REPO, storeItems, type MemoryChatFs } from './__mocks__/chatFixtures'
import { ATTEMPT_A, ORCHESTRATOR_CHAT_ITEMS, RUN_ID } from './__mocks__/orchestratorChat'
import { createActivityBindings } from './activityBindings'
import { createChatRecords, type ChatRecords } from './chatRecords'
import type { ChatStore } from './chatStore'

const BINDINGS_FILE = resolve('/state/agents/activity-bindings.jsonl')

interface Rig {
  fs: MemoryChatFs
  store: ChatStore
  records: ChatRecords
}

/** The chat records over `fs`: a second rig over the same `fs` stands for the app started again. */
function rig(fs: MemoryChatFs = memoryChatFs()): Rig {
  const store = memoryChatStore(fs)
  const records = createChatRecords({ store, agentFor: connectedAgents(), activity: createActivityBindings({ file: BINDINGS_FILE, fs }) })
  return { fs, store, records }
}

function newChat(records: ChatRecords): ChatRecord {
  return records.createChat({ folder: REPO, agent: 'codex', role: 'orchestrator', title: 'Run the epic' })
}

function call(id: string, status: 'running' | 'completed' = 'running', threadId?: string): ChatItem {
  return { id, at: AT, kind: 'tool_call', name: 'Bash', input: { command: 'npm test' }, status, resultSummary: null, ...(threadId === undefined ? {} : { threadId }) }
}

function thread(id: string): ChatItem {
  return { id, at: AT, kind: 'thread', parentItemId: 'spawn', label: 'Worker DM-12', state: 'running' }
}

function request(requestId: string, threadId?: string): ChatItem {
  const base = { id: `item_${requestId}`, at: AT, kind: 'approval_request', requestId, category: 'command', tool: 'Bash', summary: 'Use Bash' } as const
  return threadId === undefined ? base : { ...base, threadId }
}

function everythingStored(fs: MemoryChatFs): string {
  return [...fs.files.entries()].map(([path, text]) => `${path}\n${text}`).join('\n--\n')
}

/** A chat an app from before terminals stored, which quit with a call, a worker thread and a request unfinished. */
function leftBehind(): { before: Rig; chat: ChatRecord } {
  const before = rig()
  const chat = newChat(before.records)
  storeItems(before.fs, chat, [call('c1'), thread('th1'), call('c2', 'running', 'th1'), request('q1', 'th1'), call('c3', 'completed')])
  return { before, chat }
}

describe('chat records: creating, listing and renaming', () => {
  it('creates a chat with the defaults (allow save, the CLI model) and lists it', () => {
    const { records } = rig()

    const chat = records.createChat({ folder: REPO, agent: 'claude', role: 'planner' })

    expect(chat).toMatchObject({ folder: REPO, agent: 'claude', role: 'planner', model: null, allowSave: true, title: 'New chat' })
    expect(chat).not.toHaveProperty('runId')
    expect(chat).not.toHaveProperty('transferEpicId')
    expect(records.listChats(REPO)).toEqual([chat])
  })

  it('keeps the run an orchestrator chat was created for, its model and title, and binds nothing', () => {
    const state = rig()

    const chat = state.records.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', model: 'opus', allowSave: false, title: 'Orchestrator', runId: RUN_ID })

    expect(chat).toMatchObject({ runId: RUN_ID, model: 'opus', allowSave: false, title: 'Orchestrator' })
    expect(state.fs.files.has(BINDINGS_FILE)).toBe(false)
  })

  it('keeps the epic a transfer chat was created for across a restart, with no run', () => {
    const before = rig()

    const chat = before.records.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', allowSave: false, title: 'Linear transfer', transferEpicId: 'ep_1' })

    expect(chat).toMatchObject({ transferEpicId: 'ep_1', role: 'orchestrator', allowSave: false })
    expect(chat).not.toHaveProperty('runId')
    expect(rig(before.fs).records.listChats(REPO)).toEqual([chat])
  })

  it('keeps the Kanban card a chat was created for across a restart, and records none otherwise', () => {
    const before = rig()

    const chat = before.records.createChat({ folder: REPO, agent: 'claude', role: 'worker', title: 'Card', cardId: 'kc_1' })
    const plain = before.records.createChat({ folder: REPO, agent: 'claude', role: 'worker', title: 'No card' })

    expect(chat).toMatchObject({ cardId: 'kc_1' })
    expect(plain).not.toHaveProperty('cardId')
    expect(rig(before.fs).records.listChats(REPO).find((listed) => listed.id === chat.id)).toMatchObject({ cardId: 'kc_1' })
  })

  it('renames only the title, and refuses an unknown chat', () => {
    const { records } = rig()
    const chat = newChat(records)

    const renamed = records.renameChat(chat, 'Fix the build')

    expect(renamed).toMatchObject({ id: chat.id, title: 'Fix the build', role: chat.role, model: chat.model, agent: chat.agent })
    expect(records.listChats(REPO).map((listed) => listed.title)).toEqual(['Fix the build'])
    expect(() => records.renameChat({ folder: REPO, id: 'chat_nope' }, 'x')).toThrowError(expect.objectContaining({ code: 'not_found' }) as Error)
  })
})

describe('chat records: first submitted question title', () => {
  it('names once from a real question, normalizes whitespace and persists across restart', () => {
    const before = rig()
    const chat = before.records.createChat({ folder: REPO, agent: 'omp', role: 'planner' })
    const named = before.records.nameFromQuestion(chat, '  Why does\n the build fail?  ')

    expect(named?.title).toBe('Why does the build fail?')
    expect(before.records.nameFromQuestion(chat, 'A later question')).toBeNull()
    expect(rig(before.fs).records.readChat(chat).chat.title).toBe('Why does the build fail?')
  })

  it('ignores blank questions without consuming eligibility, and bounds long titles at a word', () => {
    const { records } = rig()
    const chat = records.createChat({ folder: REPO, agent: 'omp', role: 'planner' })
    expect(records.nameFromQuestion(chat, ' \n\t ')).toBeNull()
    const question = 'Explain how to fix the application build without changing any of the existing security boundaries or dependencies'
    const title = records.nameFromQuestion(chat, question)?.title
    expect(title).toBe('Explain how to fix the application build without changing any…')
    expect(title?.length).toBeLessThanOrEqual(64)
  })

  it('preserves creation titles, including an explicitly supplied generic title and run/Kanban titles', () => {
    const { records } = rig()
    for (const fields of [{ title: 'New chat' }, { title: 'My investigation' }, { title: 'Run: deployment', runId: RUN_ID }, { title: 'DM-504: Naming', cardId: 'kc_1' }]) {
      const chat = records.createChat({ folder: REPO, agent: 'omp', role: 'planner', ...fields })
      expect(records.nameFromQuestion(chat, 'Replace this title?')).toBeNull()
      expect(records.readChat(chat).chat.title).toBe(fields.title)
    }
  })

  it('checks current persisted eligibility, so manual titles win before or after automatic naming', () => {
    const { records } = rig()
    const chat = records.createChat({ folder: REPO, agent: 'omp', role: 'planner' })
    records.renameChat(chat, 'New chat')
    expect(records.nameFromQuestion(chat, 'Delayed automatic question')).toBeNull()
    expect(records.readChat(chat).chat.title).toBe('New chat')

    const other = records.createChat({ folder: REPO, agent: 'omp', role: 'planner' })
    records.nameFromQuestion(other, 'Automatic question')
    records.renameChat(other, 'My title')
    expect(records.nameFromQuestion(other, 'Another delayed question')).toBeNull()
    expect(records.readChat(other).chat.title).toBe('My title')
  })
})

describe('chat records: deleting a chat', () => {
  it('removes the chat, its transcript and its old bindings, and leaves its sibling alone', async () => {
    const fs = memoryChatFs()
    const before = rig(fs)
    const doomed = newChat(before.records)
    const kept = newChat(before.records)
    storeItems(fs, doomed, [call('c1')])
    const binding = { chatId: doomed.id, threadId: null, folder: REPO, role: 'orchestrator', kind: 'attempt', attemptId: ATTEMPT_A }
    fs.files.set(BINDINGS_FILE, `${JSON.stringify(binding)}\n`)
    const { records, store } = rig(fs)

    await records.deleteChat(doomed)

    expect(records.listChats(REPO).map((listed) => listed.id)).toEqual([kept.id])
    expect([store.getChat(doomed), store.readTranscript(doomed)]).toEqual([null, null])
    expect(createActivityBindings({ file: BINDINGS_FILE, fs }).byAttempt(ATTEMPT_A)).toEqual([])
    expect(() => records.readChat(doomed)).toThrowError(expect.objectContaining({ code: 'not_found' }) as Error)
  })

  it('hands an OMP chat its id for removing its folder, and no other chat', async () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const removed: string[] = []
    const records = createChatRecords({ store, agentFor: connectedAgents(), removeOmpFolder: async (id) => void removed.push(id) })
    const omp = records.createChat({ folder: REPO, agent: 'omp', role: 'planner' })
    const codex = records.createChat({ folder: REPO, agent: 'codex', role: 'planner' })

    await records.deleteChat(omp)
    await records.deleteChat(codex)

    expect(removed).toEqual([omp.id])
  })

  it('refuses an unknown chat', async () => {
    const { records } = rig()

    await expect(records.deleteChat({ folder: REPO, id: 'chat_nope' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('chat records: reading an old transcript', () => {
  it('writes nothing and binds nothing, even for a transcript of an orchestrator that acted on runs and attempts', () => {
    const before = rig()
    const chat = before.records.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', runId: RUN_ID })
    storeItems(before.fs, chat, ORCHESTRATOR_CHAT_ITEMS)
    const after = rig(before.fs)
    const stored = everythingStored(after.fs)

    const read = after.records.readChat(chat)

    expect(read.items.length).toBeGreaterThan(10)
    expect(everythingStored(after.fs)).toBe(stored)
    expect(after.fs.files.has(BINDINGS_FILE)).toBe(false)
  })

  it('shows what no agent can finish as ended (calls cancelled, threads failed, the request cancelled) without storing it', () => {
    const { before, chat } = leftBehind()
    const after = rig(before.fs)

    const read = after.records.readChat(chat)

    const byId = new Map(read.items.map((item) => [item.id, item]))
    expect(byId.get('c1')).toMatchObject({ status: 'cancelled' })
    expect(byId.get('c2')).toMatchObject({ status: 'cancelled', threadId: 'th1' })
    expect(byId.get('c3')).toMatchObject({ status: 'completed' })
    expect(byId.get('th1')).toMatchObject({ state: 'failed' })
    expect(read.items.map((item) => item.id)).toEqual(['c1', 'th1', 'c2', 'item_q1', 'item_q1:cancelled', 'c3'])
    expect(byId.get('item_q1:cancelled')).toEqual({ id: 'item_q1:cancelled', at: AT, kind: 'approval_decision', requestId: 'q1', decision: 'cancelled' })
    const storedItems = after.store.readTranscript(chat)?.items ?? []
    expect(storedItems.map((item) => item.kind)).toEqual(['tool_call', 'thread', 'tool_call', 'approval_request', 'tool_call'])
    expect(storedItems.find((item) => item.id === 'c1')).toMatchObject({ status: 'running' })
    expect(read.chat.id).toBe(chat.id)
  })

  it('leaves a request that was already decided as it is', () => {
    const state = rig()
    const chat = newChat(state.records)
    storeItems(state.fs, chat, [request('q1'), { id: 'd1', at: AT, kind: 'approval_decision', requestId: 'q1', decision: 'allow_once' }])

    expect(state.records.readChat(chat).items.map((item) => item.id)).toEqual(['item_q1', 'd1'])
  })

  it('reads a chat with no transcript as empty, and a chat that is gone as not found', () => {
    const state = rig()
    const chat = newChat(state.records)

    expect(state.records.readChat(chat)).toEqual({ chat, items: [] })
    expect(() => state.records.readChat({ folder: REPO, id: 'chat_gone' })).toThrowError(expect.objectContaining({ code: 'not_found' }) as Error)
  })
})

describe('chat records: agent names', () => {
  it("names a connected agent by its row, a built-in kind that is not connected by the kind, and anything else generically", () => {
    const records = createChatRecords({ store: memoryChatStore(), agentFor: connectedAgents([builtInAgent('claude', { displayName: 'My Claude' })]) })

    expect([records.agentName('claude'), records.agentName('codex'), records.agentName('cu_01k8zq3v7c2m5n9p4r6t8w0xyb')]).toEqual([
      'My Claude',
      'Codex',
      'This agent'
    ])
  })
})
