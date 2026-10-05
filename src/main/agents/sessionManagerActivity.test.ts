import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import { AT, fakeAdapters, memoryChatFs, memoryChatStore, REPO, type FakeAdapters, type MemoryChatFs } from './__mocks__/fakeChatAdapter'
import { ATTEMPT_A, ORCHESTRATOR_CHAT_ITEMS, RUN_ID, THREAD_A } from './__mocks__/orchestratorChat'
import { createActivityBindings, type ActivityBindings } from './activityBindings'
import type { ChatStore } from './chatStore'
import { createSessionManager, type SessionManager } from './sessionManager'

const FILE = resolve('/state/agents/activity-bindings.jsonl')
const SECRET = 'Qx7vT2mN9pL4kR8sW1yZ3bC6dF0gH5jA'
const TOKEN = `${ATTEMPT_A}.${SECRET}`
const THREAD = 'claude_thread_toolu_live1'

interface Rig {
  fs: MemoryChatFs
  store: ChatStore
  fakes: FakeAdapters
  activity: ActivityBindings
  manager: SessionManager
  errors: unknown[]
}

function rig(fs: MemoryChatFs = memoryChatFs()): Rig {
  const store = memoryChatStore(fs)
  const fakes = fakeAdapters()
  const activity = createActivityBindings({ file: FILE, fs })
  const errors: unknown[] = []
  const manager = createSessionManager({
    store,
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['/app/out/main/mcp.js', '--repo', folder], env: {} }),
    push: () => {},
    now: () => AT,
    activity,
    onError: (error) => errors.push(error)
  })
  return { fs, store, fakes, activity, manager, errors }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function everythingStored(fs: MemoryChatFs): string {
  return [...fs.files.values()].join('\n')
}

/** What a live Claude orchestrator emits when it hands a worker its packet: the raw prompt carries the whole token. */
const LIVE_ITEMS: ChatItem[] = [
  {
    id: 'claude_tool_toolu_live1',
    at: AT,
    kind: 'tool_call',
    name: 'Agent',
    input: { description: 'DM-12 worker', prompt: `Execution packet: {"claimToken":"${TOKEN}"}` },
    status: 'running',
    resultSummary: null
  },
  { id: THREAD, at: AT, kind: 'thread', parentItemId: 'claude_tool_toolu_live1', label: 'DM-12 worker', state: 'running' }
]

/** Plays one turn in which the fake agent emits `items`. */
async function playTurn(target: Rig, chat: ChatRecord, items: readonly ChatItem[]): Promise<void> {
  target.fakes.prepare = (adapter) => {
    adapter.turn = (fake) => {
      for (const item of items) {
        fake.emit({ type: 'item', item })
      }
      return Promise.resolve()
    }
  }
  await target.manager.send(chat, 'Run the epic.')
  await settle()
}

describe('session manager: binding chats to the runs and attempts they act on', () => {
  it('binds a chat Start run launched to its run as soon as it is created', () => {
    const { manager, activity } = rig()

    const chat = manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', runId: RUN_ID })

    expect(activity.byRun(RUN_ID).map((binding) => [binding.chatId, binding.threadId])).toEqual([[chat.id, null]])
  })

  it('binds live items as they are stored, taking the attempt id from a raw prompt without keeping its secret', async () => {
    const target = rig()
    const chat = target.manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator' })

    await playTurn(target, chat, LIVE_ITEMS)

    expect(target.activity.byAttempt(ATTEMPT_A).map((binding) => [binding.chatId, binding.threadId, binding.role])).toEqual([[chat.id, THREAD, 'worker']])
    expect(everythingStored(target.fs)).toContain(ATTEMPT_A)
    expect(everythingStored(target.fs)).not.toContain(SECRET)
    expect(target.errors).toEqual([])
  })

  it('replays the transcript of a chat when it is opened, so chats stored before bindings existed are bound', async () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const chat = store.createChat({ folder: REPO, agent: 'claude', model: 'opus', role: 'orchestrator', allowSave: true, runId: RUN_ID })
    for (const item of ORCHESTRATOR_CHAT_ITEMS) {
      store.appendItem(chat, item)
    }
    const target = rig(fs)

    await target.manager.openChat(chat)

    expect(target.activity.byRun(RUN_ID).map((binding) => binding.chatId)).toEqual([chat.id])
    expect(target.activity.byAttempt(ATTEMPT_A).map((binding) => binding.threadId)).toEqual([null, THREAD_A])
  })
})

describe('session manager: activity bindings of deleted chats and failed bindings', () => {
  it('forgets the bindings of a deleted chat', async () => {
    const target = rig()
    const chat = target.manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', runId: RUN_ID })
    await playTurn(target, chat, LIVE_ITEMS)

    await target.manager.deleteChat(chat)

    expect(target.activity.byRun(RUN_ID)).toEqual([])
    expect(target.activity.byAttempt(ATTEMPT_A)).toEqual([])
    expect(target.fs.files.get(FILE) ?? '').not.toContain(chat.id)
  })

  it('still stores and pushes an item when binding it fails, and reports the failure', async () => {
    const fs = memoryChatFs()
    const appendFile = fs.appendFile.bind(fs)
    fs.appendFile = (path, data) => {
      if (path === FILE) {
        throw new Error('disk full')
      }
      appendFile(path, data)
    }
    const target = rig(fs)
    const chat = target.manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator' })

    await playTurn(target, chat, LIVE_ITEMS)

    expect(target.store.readTranscript(chat)?.items.map((item) => item.id)).toContain(THREAD)
    expect(target.errors.map(String)).toEqual(['Error: disk full'])
  })
})
