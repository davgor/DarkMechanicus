import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApprovalDecision, ChatItem, ChatRecord } from '../../shared/agents/chat'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import { AT, fakeAdapters, memoryChatFs, memoryChatStore, REPO, type FakeAdapters, type MemoryChatFs } from './__mocks__/fakeChatAdapter'
import { ATTEMPT_A, ORCHESTRATOR_CHAT_ITEMS } from './__mocks__/orchestratorChat'
import { createActivityBindings, type ActivityBindings } from './activityBindings'
import type { ChatStore } from './chatStore'
import { createSessionManager, type SessionManager } from './sessionManager'

const BINDINGS_FILE = resolve('/state/agents/activity-bindings.jsonl')

interface Rig {
  fs: MemoryChatFs
  store: ChatStore
  fakes: FakeAdapters
  activity: ActivityBindings
  manager: SessionManager
  events: ChatPushEvent[]
  errors: unknown[]
  /** Runs what the idle timer was set to do. */
  fireIdle: () => void
}

/** A session manager over `fs`: a second rig over the same `fs` stands for the app started again. */
function rig(fs: MemoryChatFs = memoryChatFs()): Rig {
  const store = memoryChatStore(fs)
  const fakes = fakeAdapters()
  const activity = createActivityBindings({ file: BINDINGS_FILE, fs })
  const events: ChatPushEvent[] = []
  const errors: unknown[] = []
  const callbacks: (() => void)[] = []
  const manager = createSessionManager({
    store,
    activity,
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['/app/out/main/mcp.js', '--repo', folder], env: {} }),
    push: (event) => events.push(event),
    now: () => AT,
    timers: { set: (callback) => callbacks.push(callback), clear: () => {} },
    onError: (error) => errors.push(error)
  })
  return { fs, store, fakes, activity, manager, events, errors, fireIdle: () => callbacks.splice(0).forEach((callback) => callback()) }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function newChat(manager: SessionManager, agent: 'claude' | 'codex' = 'claude'): ChatRecord {
  return manager.createChat({ folder: REPO, agent, role: 'orchestrator', title: 'Run the epic' })
}

function call(id: string, status: 'running' | 'completed' = 'running', threadId?: string): ChatItem {
  return { id, at: AT, kind: 'tool_call', name: 'Bash', input: { command: 'npm test' }, status, resultSummary: null, ...(threadId === undefined ? {} : { threadId }) }
}

function thread(id: string, state: 'running' | 'done' = 'running'): ChatItem {
  return { id, at: AT, kind: 'thread', parentItemId: 'spawn', label: 'Worker DM-12', state }
}

function request(requestId: string, threadId?: string): ChatItem {
  return {
    id: `item_${requestId}`,
    at: AT,
    kind: 'approval_request',
    requestId,
    category: 'command',
    tool: 'Bash',
    summary: 'Use Bash',
    ...(threadId === undefined ? {} : { threadId })
  }
}

function everythingStored(fs: MemoryChatFs): string {
  return [...fs.files.entries()].map(([path, text]) => `${path}\n${text}`).join('\n--\n')
}

/** A chat stored by an app that has since quit: it ran a call, a worker thread and a request, and none of them finished. */
function leftBehind(): { before: Rig; chat: ChatRecord } {
  const before = rig()
  const chat = newChat(before.manager, 'codex')
  for (const item of [call('c1'), thread('th1'), call('c2', 'running', 'th1'), request('q1', 'th1'), call('c3', 'completed')]) {
    before.store.appendItem(chat, item)
  }
  return { before, chat }
}

/** Plays a turn in which the fake agent writes a running call, then asks for an approval and waits for the answer. */
async function askingChat(state: Rig): Promise<{ chat: ChatRecord; answers: ApprovalDecision[] }> {
  const chat = newChat(state.manager)
  const answers: ApprovalDecision[] = []
  state.fakes.prepare = (adapter) => {
    adapter.turn = async (self) => {
      self.emit({ type: 'item', item: call('c1') })
      self.emit({ type: 'item', item: thread('th1') })
      answers.push(await self.ask('q1'))
    }
  }
  await state.manager.send(chat, 'go')
  await settle()
  return { chat, answers }
}

describe('session manager: reading a chat for a panel', () => {
  it('starts no agent, even for a vendor that starts on open, and writes and pushes nothing', async () => {
    const { before, chat } = leftBehind()
    const after = rig(before.fs)
    const stored = everythingStored(after.fs)

    const read = after.manager.readChat(chat)

    expect(read.items.map((item) => item.id)).toContain('c1')
    expect(after.fakes.created).toEqual([])
    expect(after.manager.liveCount()).toBe(0)
    expect(everythingStored(after.fs)).toBe(stored)
    expect(after.events).toEqual([])
    expect(after.errors).toEqual([])
  })

  it('does not bind the chat\'s threads to their runs and attempts: that stays with opening it', async () => {
    const before = rig()
    const chat = newChat(before.manager)
    for (const item of ORCHESTRATOR_CHAT_ITEMS) {
      before.store.appendItem(chat, item)
    }
    const after = rig(before.fs)

    const read = after.manager.readChat(chat)

    expect(read.items.length).toBeGreaterThan(10)
    expect(after.activity.byAttempt(ATTEMPT_A)).toEqual([])
    expect(after.fs.files.has(BINDINGS_FILE)).toBe(false)
    await after.manager.openChat(chat)
    expect(after.activity.byAttempt(ATTEMPT_A)).not.toEqual([])
  })

})

describe('session manager: what a read shows of a chat no live agent holds', () => {
  it('shows what open would have settled (calls cancelled, threads failed, the request cancelled) but stores none of it', () => {
    const { before, chat } = leftBehind()
    const after = rig(before.fs)

    const read = after.manager.readChat(chat)

    const byId = new Map(read.items.map((item) => [item.id, item]))
    expect(byId.get('c1')).toMatchObject({ status: 'cancelled' })
    expect(byId.get('c2')).toMatchObject({ status: 'cancelled', threadId: 'th1' })
    expect(byId.get('c3')).toMatchObject({ status: 'completed' })
    expect(byId.get('th1')).toMatchObject({ state: 'failed' })
    expect(read.items.filter((item) => item.kind === 'approval_decision')).toEqual([
      { id: 'item_q1:cancelled', at: AT, kind: 'approval_decision', requestId: 'q1', decision: 'cancelled' }
    ])
    const storedItems = after.store.readTranscript(chat)?.items ?? []
    expect(storedItems.map((item) => item.kind)).toEqual(['tool_call', 'thread', 'tool_call', 'approval_request', 'tool_call'])
    expect(storedItems.find((item) => item.id === 'c1')).toMatchObject({ status: 'running' })
  })

  it('has no approval a person could answer for a chat no live agent holds, and says the chat is not running', () => {
    const { before, chat } = leftBehind()

    const read = rig(before.fs).manager.readChat(chat)

    expect(read.pending).toEqual([])
    expect(read.running).toBe(false)
    expect(read.chat.id).toBe(chat.id)
  })

  it('leaves a request that was already decided as it is', () => {
    const state = rig()
    const chat = newChat(state.manager)
    for (const item of [request('q1'), { id: 'd1', at: AT, kind: 'approval_decision', requestId: 'q1', decision: 'allow_once' } as const]) {
      state.store.appendItem(chat, item)
    }

    const read = state.manager.readChat(chat)

    expect(read.items.map((item) => item.id)).toEqual(['item_q1', 'd1'])
  })

})

describe('session manager: reading chats the store cannot give', () => {
  it('reads a chat the store cannot read as empty, and a chat that is gone as not found', () => {
    const state = rig()
    const chat = newChat(state.manager)
    state.store.readTranscript = () => null

    expect(state.manager.readChat(chat)).toMatchObject({ items: [], pending: [], running: false })
    expect(() => state.manager.readChat({ folder: REPO, id: 'chat_gone' })).toThrowError(expect.objectContaining({ code: 'not_found' }))
  })
})

describe('session manager: reading a chat a live agent holds', () => {
  it('lists the requests the agent is waiting on as pending, keeps its running work as it is and says a turn is running', async () => {
    const state = rig()
    const { chat } = await askingChat(state)
    const stored = everythingStored(state.fs)
    const written = state.events.length

    const read = state.manager.readChat(chat)

    expect(read.pending.map((asked) => asked.requestId)).toEqual(['q1'])
    expect(read.running).toBe(true)
    const byId = new Map(read.items.map((item) => [item.id, item]))
    expect(byId.get('c1')).toMatchObject({ status: 'running' })
    expect(byId.get('th1')).toMatchObject({ state: 'running' })
    expect(read.items.filter((item) => item.kind === 'approval_decision')).toEqual([])
    expect(everythingStored(state.fs)).toBe(stored)
    expect(state.events).toHaveLength(written)
    expect(state.fakes.created).toHaveLength(1)
  })

  it('does not take the agent\'s approval away: the answer sent after reading still reaches the agent', async () => {
    const state = rig()
    const { chat, answers } = await askingChat(state)
    state.manager.readChat(chat)
    state.manager.readChat(chat)

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_once' })
    await settle()

    expect(answers).toEqual(['allow_once'])
    expect(state.manager.readChat(chat).pending).toEqual([])
  })

})

describe('session manager: reading a chat a live agent holds, and one it has left', () => {
  it('shows a stored request that this agent is not waiting on (a crash left it) as cancelled, without storing that', async () => {
    const state = rig()
    const { chat } = await askingChat(state)
    state.store.appendItem(chat, request('old'))

    const read = state.manager.readChat(chat)

    expect(read.pending.map((asked) => asked.requestId)).toEqual(['q1'])
    expect(read.items.filter((item) => item.kind === 'approval_decision')).toMatchObject([{ requestId: 'old', decision: 'cancelled' }])
    expect((state.store.readTranscript(chat)?.items ?? []).filter((item) => item.kind === 'approval_decision')).toEqual([])
  })

  it('reads an agent that went idle (disposed) as no live agent: nothing pending, its running work shown as ended', async () => {
    const state = rig()
    const { chat } = await askingChat(state)
    await state.manager.stop(chat)
    await settle()
    state.fireIdle()
    await settle()
    expect(state.manager.liveCount()).toBe(0)

    const read = state.manager.readChat(chat)

    expect(read.pending).toEqual([])
    expect(read.running).toBe(false)
    expect(read.items.find((item) => item.id === 'th1')).toMatchObject({ state: 'failed' })
  })
})
