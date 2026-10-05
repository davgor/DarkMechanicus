import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import { AT, fakeAdapters, memoryChatFs, memoryChatStore, REPO, type FakeAdapters, type FakeChatAdapter, type MemoryChatFs } from './__mocks__/fakeChatAdapter'
import { CHAT_BEFORE_THREADS_LINES } from './__mocks__/chatBeforeThreads'
import type { ChatStore } from './chatStore'
import { createSessionManager, type SessionManager } from './sessionManager'

const IDLE_MS = 600_000

interface Rig {
  fs: MemoryChatFs
  manager: SessionManager
  store: ChatStore
  fakes: FakeAdapters
  events: ChatPushEvent[]
  errors: unknown[]
  /** Runs what the idle timer was set to do. */
  fireIdle: () => void
}

/** A session manager over `fs`: a second rig over the same `fs` stands for the app started again. */
function rig(fs: MemoryChatFs = memoryChatFs()): Rig {
  const store = memoryChatStore(fs)
  const fakes = fakeAdapters()
  const events: ChatPushEvent[] = []
  const errors: unknown[] = []
  const callbacks: (() => void)[] = []
  let itemCount = 0
  const manager = createSessionManager({
    store,
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['/app/out/main/mcp.js', '--repo', folder], env: {} }),
    push: (event) => events.push(event),
    newId: () => `item_s${(itemCount += 1)}`,
    now: () => AT,
    idleMs: IDLE_MS,
    timers: { set: (callback) => callbacks.push(callback), clear: () => {} },
    onError: (error) => errors.push(error)
  })
  return { fs, manager, store, fakes, events, errors, fireIdle: () => callbacks.splice(0).forEach((callback) => callback()) }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function newChat(manager: SessionManager): ChatRecord {
  return manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', title: 'Fix the build' })
}

function stored(store: ChatStore, chat: ChatRecord): ChatItem[] {
  return store.readTranscript(chat)?.items ?? []
}

function byId(items: readonly ChatItem[], id: string): ChatItem | undefined {
  return items.find((item) => item.id === id)
}

function call(id: string, status: 'running' | 'completed' | 'failed' | 'cancelled' = 'running', threadId?: string): ChatItem {
  return { id, at: AT, kind: 'tool_call', name: 'Bash', input: { command: 'npm test' }, status, resultSummary: null, ...(threadId === undefined ? {} : { threadId }) }
}

function thread(id: string, state: 'running' | 'done' | 'failed' = 'running', threadId?: string): ChatItem {
  return { id, at: AT, kind: 'thread', parentItemId: 'spawn', label: 'Summarize a.txt', state, ...(threadId === undefined ? {} : { threadId }) }
}

function statusOf(items: readonly ChatItem[], id: string): string | undefined {
  const item = byId(items, id)
  return item?.kind === 'tool_call' ? item.status : item?.kind === 'thread' ? item.state : undefined
}

/** Plays a first turn in which the fake agent emits `items` and then waits to be stopped (or ends at once). */
async function play(state: Rig, chat: ChatRecord, items: readonly ChatItem[], hold = true): Promise<FakeChatAdapter> {
  state.fakes.prepare = (adapter) => {
    adapter.turn = async (self) => {
      for (const item of items) {
        self.emit({ type: 'item', item })
      }
      if (hold) {
        await self.untilStopped()
      }
    }
  }
  await state.manager.send(chat, 'go')
  await settle()
  return state.fakes.created[0] as FakeChatAdapter
}

describe('session manager: a turn the person stops', () => {
  it('stores a stopped item after the message and what the agent wrote, pushes it before the turn ends, and keeps it across a restart', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    await play(state, chat, [{ id: 'a1', at: AT, kind: 'assistant_text', text: 'Let me look.' }])

    await state.manager.stop(chat)
    await settle()

    expect(stored(state.store, chat).map((item) => item.kind)).toEqual(['user_message', 'assistant_text', 'turn_stopped'])
    const pushed = state.events.flatMap((event) => (event.type === 'item' ? [`item:${event.item.kind}`] : event.type === 'turn' ? [`turn:${event.running}`] : []))
    expect(pushed.slice(-2)).toEqual(['item:turn_stopped', 'turn:false'])

    const reopened = await rig(state.fs).manager.openChat(chat)
    expect(reopened.items.map((item) => item.kind)).toEqual(['user_message', 'assistant_text', 'turn_stopped'])
  })

  it('stores nothing for a turn that ended on its own, or when there was no turn to stop', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    await play(state, chat, [], false)

    await state.manager.stop(chat)
    await state.manager.stop(newChat(state.manager))

    expect(stored(state.store, chat).map((item) => item.kind)).toEqual(['user_message'])
  })

})

describe('session manager: stopped turns that go on to other turns', () => {
  it('marks only the turn that was stopped, not the ones after it', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    const adapter = await play(state, chat, [])
    await state.manager.stop(chat)
    await settle()

    adapter.turn = () => Promise.resolve()
    await state.manager.send(chat, 'again')
    await settle()

    expect(stored(state.store, chat).map((item) => item.kind)).toEqual(['user_message', 'turn_stopped', 'user_message'])
  })

  it('says why a stopped turn also failed: the stop, then the error', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        await self.untilStopped()
        throw new Error('interrupted')
      }
    }
    await state.manager.send(chat, 'go')
    await settle()

    await state.manager.stop(chat)
    await settle()

    expect(stored(state.store, chat).map((item) => item.kind)).toEqual(['user_message', 'turn_stopped', 'error'])
  })

})

describe('session manager: the calls a stopped turn leaves behind', () => {
  it('cancels the calls the stopped turn left running in the chat itself, and leaves finished calls and the work of subagents alone', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    await play(state, chat, [call('c1'), call('c2', 'completed'), call('c3', 'running', 'th1'), thread('th1')])

    await state.manager.stop(chat)
    await settle()

    const items = stored(state.store, chat)
    expect([statusOf(items, 'c1'), statusOf(items, 'c2'), statusOf(items, 'c3'), statusOf(items, 'th1')]).toEqual(['cancelled', 'completed', 'running', 'running'])
  })

  it('reports a stop it cannot store, and still ends the turn', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    await play(state, chat, [call('c1')])
    const append = state.fs.appendFile.bind(state.fs)
    state.fs.appendFile = (path, data) => {
      if (data.includes('turn_stopped')) {
        throw new Error('disk full')
      }
      append(path, data)
    }

    await state.manager.stop(chat)
    await settle()

    expect(state.errors).toEqual([expect.objectContaining({ message: 'disk full' })])
    expect(state.events.at(-1)).toEqual({ type: 'turn', chatId: chat.id, running: false })
  })
})

describe('session manager: a turn that failed', () => {
  it('cancels the calls it left running and stores the error, without a stopped item', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    state.fakes.prepare = (adapter) => {
      adapter.turn = (self) => {
        self.emit({ type: 'item', item: call('c1') })
        return Promise.reject(new Error('The agent exited.'))
      }
    }

    await state.manager.send(chat, 'go')
    await settle()

    const items = stored(state.store, chat)
    expect(items.map((item) => item.kind)).toEqual(['user_message', 'tool_call', 'error'])
    expect(statusOf(items, 'c1')).toBe('cancelled')
  })
})

describe('session manager: approvals that are cancelled', () => {
  it('marks the call an approval was for cancelled when Stop cancels the approval', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'item', item: call('c1') })
        await self.ask('q1')
      }
    }
    await state.manager.send(chat, 'go')
    await settle()
    expect(statusOf(stored(state.store, chat), 'c1')).toBe('running')

    await state.manager.stop(chat)
    await settle()

    const items = stored(state.store, chat)
    expect(items.flatMap((item) => (item.kind === 'approval_decision' ? [item.decision] : []))).toEqual(['cancelled'])
    expect(statusOf(items, 'c1')).toBe('cancelled')
  })

})

describe('session manager: approvals cancelled by a quit', () => {
  it('shows the approval and its call as cancelled, not running, when the app quit with the approval pending and is opened again', async () => {
    const before = rig()
    const chat = newChat(before.manager)
    before.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'item', item: call('c1') })
        await self.ask('q1')
      }
    }
    await before.manager.send(chat, 'go')
    await settle()

    await before.manager.disposeAll()
    const opened = await rig(before.fs).manager.openChat(chat)

    expect(opened.items.flatMap((item) => (item.kind === 'approval_decision' ? [[item.requestId, item.decision]] : []))).toEqual([['q1', 'cancelled']])
    expect(statusOf(opened.items, 'c1')).toBe('cancelled')
    expect(opened.pending).toEqual([])
  })

})

describe('session manager: approvals cancelled in a thread, or that cannot be stored', () => {
  it('cancels the calls of the thread an approval was raised in, and no others', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        for (const item of [call('c1'), call('c2', 'running', 'th1'), call('c3', 'running', 'th2')]) {
          self.emit({ type: 'item', item })
        }
        await new Promise<void>((respond) => {
          const request = { id: 'item_q1', at: AT, kind: 'approval_request', requestId: 'q1', category: 'command', tool: 'Bash', summary: 'Run ls', threadId: 'th1' } as const
          self.emit({ type: 'approval_request', request, respond: () => respond() })
        })
      }
    }
    await state.manager.send(chat, 'go')
    await settle()

    await state.manager.disposeAll()

    const items = stored(state.store, chat)
    expect([statusOf(items, 'c1'), statusOf(items, 'c2'), statusOf(items, 'c3')]).toEqual(['running', 'cancelled', 'running'])
  })

  it('reports a call it cannot mark cancelled, and still denies the request and disposes the agent', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    const answers: string[] = []
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'item', item: call('c1') })
        answers.push(await self.ask('q1'))
      }
    }
    await state.manager.send(chat, 'go')
    await settle()
    const append = state.fs.appendFile.bind(state.fs)
    state.fs.appendFile = (path, data) => {
      if (data.includes('"cancelled"') && data.includes('tool_call')) {
        throw new Error('disk full')
      }
      append(path, data)
    }

    await state.manager.disposeAll()

    expect(answers).toEqual(['deny'])
    expect(state.fakes.created[0]?.disposals).toBe(1)
    expect(state.errors).toEqual([expect.objectContaining({ message: 'disk full' })])
  })
})

describe('session manager: opening a chat whose agent is gone', () => {
  it('cancels a call left running by a turn that is no longer active, and leaves the other calls alone', async () => {
    const before = rig()
    const chat = newChat(before.manager)
    for (const item of [call('c1'), call('c2', 'completed'), call('c3', 'failed'), call('c4', 'running', 'th1')]) {
      before.store.appendItem(chat, item)
    }

    const after = rig(before.fs)
    const opened = await after.manager.openChat(chat)

    expect(opened.items.map((item) => statusOf(opened.items, item.id))).toEqual(['cancelled', 'completed', 'failed', 'cancelled'])
    expect(byId(stored(after.store, chat), 'c4')).toMatchObject({ threadId: 'th1', status: 'cancelled' })
    expect(after.events.flatMap((event) => (event.type === 'item' ? [event.item.id] : []))).toEqual(['c1', 'c4'])
  })

  it('still opens a chat whose stale call cannot be stored as cancelled, and reports why', async () => {
    const before = rig()
    const chat = newChat(before.manager)
    before.store.appendItem(chat, call('c1'))
    const after = rig(before.fs)
    after.fs.appendFile = () => {
      throw new Error('disk full')
    }

    const opened = await after.manager.openChat(chat)

    expect(statusOf(opened.items, 'c1')).toBe('running')
    expect(after.errors).toEqual([expect.objectContaining({ message: 'disk full' })])
  })

  it('settles once: opening the chat again writes nothing', async () => {
    const before = rig()
    const chat = newChat(before.manager)
    before.store.appendItem(chat, call('c1'))
    before.store.appendItem(chat, thread('th1'))
    const after = rig(before.fs)
    await after.manager.openChat(chat)
    const written = after.events.length

    await after.manager.openChat(chat)

    expect(after.events).toHaveLength(written)
  })

})

describe('session manager: opening a chat after an idle stop or a quit', () => {
  it('stores a thread whose agent was disposed by an idle stop as failed when the chat next opens', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    await play(state, chat, [call('spawn', 'completed'), thread('th1'), call('c1', 'running', 'th1')], false)
    expect(statusOf(stored(state.store, chat), 'th1')).toBe('running')

    state.fireIdle()
    await settle()
    expect(state.manager.liveCount()).toBe(0)
    expect(statusOf(stored(state.store, chat), 'th1')).toBe('running')
    const opened = await state.manager.openChat(chat)

    expect(statusOf(opened.items, 'th1')).toBe('failed')
    expect(statusOf(opened.items, 'c1')).toBe('cancelled')
    expect(statusOf(stored(state.store, chat), 'th1')).toBe('failed')
  })

  it('stores a thread left running when the app quit as failed when the chat is opened again, and keeps the finished ones', async () => {
    const before = rig()
    const chat = newChat(before.manager)
    await play(before, chat, [thread('th1'), thread('th2', 'done'), thread('th3', 'failed'), thread('th4', 'running', 'th1')], false)

    await before.manager.disposeAll()
    const opened = await rig(before.fs).manager.openChat(chat)

    expect(['th1', 'th2', 'th3', 'th4'].map((id) => statusOf(opened.items, id))).toEqual(['failed', 'done', 'failed', 'failed'])
    expect(byId(opened.items, 'th4')).toMatchObject({ threadId: 'th1', label: 'Summarize a.txt', parentItemId: 'spawn' })
  })

})

describe('session manager: opening a chat that must not change', () => {
  it('leaves the running work of a live agent alone when its chat is opened again', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    await play(state, chat, [call('c1'), thread('th1'), call('c2', 'running', 'th1')])

    const opened = await state.manager.openChat(chat)

    expect(opened.running).toBe(true)
    expect([statusOf(opened.items, 'c1'), statusOf(opened.items, 'th1'), statusOf(opened.items, 'c2')]).toEqual(['running', 'running', 'running'])
  })

  it('opens a chat whose transcript the store cannot read with nothing in it, and settles nothing', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    state.store.readTranscript = () => null

    const opened = await state.manager.openChat(chat)

    expect(opened.items).toEqual([])
    expect(state.events).toEqual([])
  })

  it('reads a chat stored before stopped turns, cancelled calls and ended threads without changing it', async () => {
    const before = rig()
    const chat = newChat(before.manager)
    for (const line of CHAT_BEFORE_THREADS_LINES) {
      before.store.appendItem(chat, JSON.parse(line) as ChatItem)
    }
    const lines = [...before.fs.files.values()].join('')

    const after = rig(before.fs)
    const opened = await after.manager.openChat(chat)

    expect(opened.items.map((item) => item.kind)).toEqual(['user_message', 'tool_call', 'tool_call', 'approval_request', 'approval_decision', 'assistant_text'])
    expect([...before.fs.files.values()].join('')).toBe(lines)
    expect(after.events).toEqual([])
  })
})
