import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIdGenerator } from '../../core/ids'
import type { Workspace } from '../../core/workspace'
import type { ApprovalDecision, ChatItem, ChatRecord } from '../../shared/agents/chat'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { AgentAuthStatus } from '../../shared/desktop/api'
import { dropAcceptanceNodes } from '../../test/acceptanceNodes'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { AT, fakeAdapters, memoryChatFs, memoryChatStore, MODELS, REPO, type FakeAdapters, type FakeChatAdapter } from './__mocks__/fakeChatAdapter'
import type { ChatStore, ChatStoreFs } from './chatStore'
import { CLAIM_TOKEN_MASK } from './claimTokenMask'
import { createSessionManager, type SessionManager, type SessionManagerDeps, type SignedOutRuns } from './sessionManager'

const IDLE_MS = 600_000

interface ManualTimers {
  set: (callback: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
  fire: () => void
  delays: number[]
  count: () => number
}

function manualTimers(): ManualTimers {
  const scheduled = new Map<number, () => void>()
  const delays: number[] = []
  let next = 0
  return {
    set: (callback, ms) => {
      next += 1
      scheduled.set(next, callback)
      delays.push(ms)
      return next
    },
    clear: (handle) => {
      scheduled.delete(handle as number)
    },
    fire: () => {
      const callbacks = [...scheduled.values()]
      scheduled.clear()
      for (const callback of callbacks) {
        callback()
      }
    },
    delays,
    count: () => scheduled.size
  }
}

interface Rig {
  manager: SessionManager
  store: ChatStore
  fakes: FakeAdapters
  events: ChatPushEvent[]
  timers: ManualTimers
  errors: unknown[]
}

function rig(fs: ChatStoreFs = memoryChatFs(), overrides: Partial<SessionManagerDeps> = {}): Rig {
  const store = memoryChatStore(fs)
  const fakes = fakeAdapters()
  const events: ChatPushEvent[] = []
  const timers = manualTimers()
  const errors: unknown[] = []
  let itemCount = 0
  const manager = createSessionManager({
    store,
    adapters: fakes.definitions,
    executablePath: (kind) => (kind === 'cursor' ? null : `/bin/${kind}`),
    mcpConfig: (folder) => ({ command: 'node', args: ['/app/out/main/mcp.js', '--repo', folder], env: {} }),
    push: (event) => events.push(event),
    newId: () => `item_m${(itemCount += 1)}`,
    now: () => AT,
    idleMs: IDLE_MS,
    timers,
    onError: (error) => errors.push(error),
    ...overrides
  })
  return { manager, store, fakes, events, timers, errors }
}

/** Lets every queued promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

type NewChatOverrides = Partial<Parameters<SessionManager['createChat']>[0]>

function newChat(manager: SessionManager, overrides: NewChatOverrides = {}): ChatRecord {
  return manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', title: 'Fix the build', ...overrides })
}

function storedItems(store: ChatStore, chat: ChatRecord): ChatItem[] {
  return store.readTranscript(chat)?.items ?? []
}

function pushedItems(events: readonly ChatPushEvent[]): ChatItem[] {
  return events.flatMap((event) => (event.type === 'item' ? [event.item] : []))
}

function decisionsIn(items: readonly ChatItem[]): [string, string][] {
  return items.flatMap((item) => (item.kind === 'approval_decision' ? [[item.requestId, item.decision] as [string, string]] : []))
}

/** One line per pushed event, to compare orders at a glance. */
function describeEvent(event: ChatPushEvent): string {
  if (event.type === 'item') {
    return `item:${event.item.id}:${event.item.kind}`
  }
  if (event.type === 'agent_auth') {
    return `auth:${event.chatId}:${event.state}`
  }
  return event.type === 'turn' ? `turn:${event.running}` : `delta:${event.delta}`
}

function only<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1)
  return values[0] as T
}

describe('session manager: the agent process', () => {
  it('starts nothing until the first message, then runs one adapter per chat in the chat folder', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager, { model: 'big' })

    await manager.openChat(chat)
    expect(fakes.created).toHaveLength(0)

    await manager.send(chat, 'hello')
    await settle()
    await manager.send(chat, 'again')
    await settle()

    const adapter = only(fakes.created)
    expect(adapter.executablePath).toBe('/bin/claude')
    expect(adapter.started).toEqual([
      expect.objectContaining({ chatId: chat.id, folder: REPO, model: 'big', role: 'orchestrator', allowSave: true, sessionId: null })
    ])
    expect(adapter.sent).toEqual(['hello', 'again'])
    expect(manager.liveCount()).toBe(1)
  })

  it('starts the process when the chat is opened for a vendor that needs it running', async () => {
    const { manager, fakes, timers } = rig()
    const chat = newChat(manager, { agent: 'codex' })

    await manager.openChat(chat)

    expect(only(fakes.of('codex')).started).toHaveLength(1)
    expect(timers.count()).toBe(1)
  })

  it('opens a start-on-open chat whose agent is not connected without starting anything', async () => {
    const { manager, fakes, errors } = rig()
    fakes.definitions.cursor = fakes.definitions.codex
    const chat = newChat(manager, { agent: 'cursor' })

    const opened = await manager.openChat(chat)

    expect(opened).toMatchObject({ chat: { id: chat.id }, items: [], pending: [], running: false })
    expect(fakes.created).toHaveLength(0)
    expect(errors).toEqual([])
  })
})

describe('session manager: agents that cannot start', () => {
  it('refuses a chat whose agent has no adapter yet or is not connected, and starts nothing', async () => {
    const { manager, fakes } = rig()

    await expect(manager.send(newChat(manager, { agent: 'cursor' }), 'hi')).rejects.toMatchObject({ code: 'unsupported_capability' })
    fakes.definitions.cursor = fakes.definitions.claude
    await expect(manager.send(newChat(manager, { agent: 'cursor' }), 'hi')).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('Cursor')
    })
    await expect(manager.send({ folder: REPO, id: 'chat_missing' }, 'hi')).rejects.toMatchObject({ code: 'not_found' })
    await expect(manager.openChat({ folder: REPO, id: 'chat_missing' })).rejects.toMatchObject({ code: 'not_found' })
    expect(fakes.created).toHaveLength(0)
  })
})

describe('session manager: failed starts', () => {
  it('leaves no session behind when the Dark Mechanicus server cannot be built', async () => {
    let fail = true
    const { manager, fakes } = rig(memoryChatFs(), {
      mcpConfig: (folder) => {
        if (fail) {
          throw new Error('no app path')
        }
        return { command: 'node', args: ['mcp.js', '--repo', folder], env: {} }
      }
    })
    const chat = newChat(manager)

    await expect(manager.send(chat, 'first')).rejects.toThrow('no app path')
    expect([manager.liveCount(), fakes.created.length]).toEqual([0, 0])
    fail = false
    await manager.send(chat, 'second')
    expect(only(fakes.created).sent).toEqual(['second'])
  })

  it('drops an adapter that failed to start, so the next message starts a fresh one', async () => {
    const { manager, fakes, store } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.startError = fakes.created.length === 0 ? new Error('spawn ENOENT') : null
    }

    await expect(manager.send(chat, 'first')).rejects.toThrow('spawn ENOENT')
    expect(fakes.created[0]?.disposals).toBe(1)
    expect(manager.liveCount()).toBe(0)
    expect(storedItems(store, chat)).toEqual([])

    await manager.send(chat, 'second')
    expect(fakes.created).toHaveLength(2)
    expect(fakes.created[1]?.sent).toEqual(['second'])
  })

  it('starts a chat once when two messages race to start it, refusing the one that finds a turn running', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = (self) => self.untilStopped()
    }

    const results = await Promise.allSettled([manager.send(chat, 'one'), manager.send(chat, 'two')])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } })
    expect(only(fakes.created).sent).toHaveLength(1)
  })
})

describe('session manager: the Dark Mechanicus server each chat gets', () => {
  it('passes the chat role, the label "<Agent> · <title>" and --allow-save for an orchestrator that allows it', async () => {
    const { manager, fakes } = rig()
    await manager.send(newChat(manager, { role: 'orchestrator', title: 'Fix the build' }), 'go')

    expect(only(fakes.created).started[0]?.darkMechanicus).toEqual({
      command: 'node',
      args: ['/app/out/main/mcp.js', '--repo', REPO, '--role', 'orchestrator', '--allow-save', '--label', 'Claude Code · Fix the build']
    })
  })

  it('allows saving by default, and leaves --allow-save out for a planner that does not allow it', async () => {
    const { manager, fakes } = rig()
    const planner = newChat(manager, { agent: 'codex', role: 'planner', title: 'Plan', allowSave: false })
    const byDefault = manager.createChat({ folder: REPO, agent: 'claude', role: 'planner' })
    await manager.send(planner, 'go')
    await manager.send(byDefault, 'go')

    expect(byDefault.allowSave).toBe(true)
    const [codex, claude] = [only(fakes.of('codex')), only(fakes.of('claude'))]
    expect(codex.started[0]?.darkMechanicus.args).toEqual(['/app/out/main/mcp.js', '--repo', REPO, '--role', 'planner', '--label', 'Codex · Plan'])
    expect(codex.started[0]?.allowSave).toBe(false)
    expect(claude.started[0]?.darkMechanicus.args).toEqual([
      '/app/out/main/mcp.js',
      '--repo',
      REPO,
      '--role',
      'planner',
      '--allow-save',
      '--label',
      'Claude Code · New chat'
    ])
  })

  it('runs a worker or reviewer under its own role and never passes --allow-save, even when the chat allows it', async () => {
    const { manager, fakes } = rig()
    await manager.send(newChat(manager, { role: 'worker', title: 'Do DM-1', allowSave: true }), 'go')
    await manager.send(newChat(manager, { role: 'reviewer', title: 'Review DM-1', allowSave: true }), 'go')

    const [worker, reviewer] = fakes.of('claude')
    expect(worker?.started[0]).toMatchObject({ role: 'worker', allowSave: false })
    expect(worker?.started[0]?.darkMechanicus.args).toEqual(['/app/out/main/mcp.js', '--repo', REPO, '--role', 'worker', '--label', 'Claude Code · Do DM-1'])
    expect(reviewer?.started[0]).toMatchObject({ role: 'reviewer', allowSave: false })
  })
})

describe('session manager: streaming', () => {
  it('stores and pushes the message, the items and the deltas in the order they happened', async () => {
    const { manager, fakes, store, events } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'item', item: { id: 't1', at: AT, kind: 'tool_call', name: 'Read', input: {}, status: 'running', resultSummary: null } })
        self.emit({ type: 'assistant_delta', itemId: 'a1', delta: 'Hel' })
        self.emit({ type: 'assistant_delta', itemId: 'a1', delta: 'lo' })
        self.emit({ type: 'item', item: { id: 't1', at: AT, kind: 'tool_call', name: 'Read', input: {}, status: 'completed', resultSummary: 'ok' } })
        self.emit({ type: 'item', item: { id: 'a1', at: AT, kind: 'assistant_text', text: 'Hello' } })
        self.emit({ type: 'session', sessionId: 'vendor-1' })
      }
    }

    const message = await manager.send(chat, 'hi')
    await settle()

    expect(message).toMatchObject({ kind: 'user_message', text: 'hi' })
    expect(events.map(describeEvent)).toEqual([
      `item:${message.id}:user_message`,
      'turn:true',
      'item:t1:tool_call',
      'delta:Hel',
      'delta:lo',
      'item:t1:tool_call',
      'item:a1:assistant_text',
      'turn:false'
    ])
    expect(events.every((event) => event.chatId === chat.id)).toBe(true)
    expect(storedItems(store, chat).map((item) => item.kind)).toEqual(['user_message', 'tool_call', 'assistant_text'])
    expect(store.getChat(chat)?.sessionId).toBe('vendor-1')
  })
})

describe('session manager: masking streamed text', () => {
  it('never pushes a claim token, even split across deltas, and releases a held tail when the turn ends', async () => {
    const ids = createIdGenerator(() => 1_700_000_000_000, (size) => Buffer.alloc(size, 7))
    const secret = ids.secret()
    const token = `${ids.next('attempt')}.${secret}`
    const { manager, fakes, events } = rig()
    fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'assistant_delta', itemId: 'a1', delta: `Claim with ${token.slice(0, 20)}`, threadId: 'th_1' })
        self.emit({ type: 'assistant_delta', itemId: 'a1', delta: `${token.slice(20)} now. Ask the dat`, threadId: 'th_1' })
        self.emit({ type: 'assistant_delta', itemId: 'a2', delta: 'second ' })
      }
    }

    await manager.send(newChat(manager), 'go')
    await settle()

    const deltas = events.flatMap((event) => (event.type === 'assistant_delta' ? [event] : []))
    const first = deltas.filter((delta) => delta.itemId === 'a1')
    expect(first.map((delta) => delta.delta).join('')).toBe(`Claim with ${CLAIM_TOKEN_MASK} now. Ask the dat`)
    expect(first.every((delta) => delta.threadId === 'th_1')).toBe(true)
    expect(deltas.filter((delta) => delta.itemId === 'a2')).toEqual([{ type: 'assistant_delta', chatId: expect.any(String), itemId: 'a2', delta: 'second ' }])
    expect(JSON.stringify(events)).not.toContain(secret.slice(0, 8))
  })
})

describe('session manager: failed turns and refused items', () => {
  it('records a failed turn as an error item and ends the turn', async () => {
    const { manager, fakes, store, events } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = () => Promise.reject(new Error('agent exited with code 1'))
    }

    await manager.send(chat, 'go')
    await settle()

    expect(storedItems(store, chat).at(-1)).toMatchObject({ kind: 'error', message: 'agent exited with code 1' })
    expect(events.at(-1)).toEqual({ type: 'turn', chatId: chat.id, running: false })
    expect((await manager.openChat(chat)).running).toBe(false)
  })

  it('reports an adapter item the store refuses, and keeps going', async () => {
    const { manager, fakes, store, errors } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'item', item: { id: '', at: AT, kind: 'assistant_text', text: 'bad id' } })
        self.emit({ type: 'item', item: { id: 'a2', at: AT, kind: 'assistant_text', text: 'fine' } })
      }
    }

    await manager.send(chat, 'go')
    await settle()

    expect(errors).toEqual([expect.objectContaining({ code: 'invalid_input' })])
    expect(storedItems(store, chat).map((item) => item.id)).toContain('a2')
  })
})

interface AskedRequest {
  id: string
  tool?: string
}

/** A chat whose turn asks for approval with each request in turn, recording the answers it gets. */
async function askingChat(state: Rig, requests: AskedRequest[]): Promise<{ chat: ChatRecord; answers: ApprovalDecision[] }> {
  const answers: ApprovalDecision[] = []
  state.fakes.prepare = (adapter) => {
    adapter.turn = async (self) => {
      for (const request of requests) {
        answers.push(await self.ask(request.id, 'command', request.tool))
      }
    }
  }
  const chat = newChat(state.manager)
  await state.manager.send(chat, 'go')
  await settle()
  return { chat, answers }
}

describe('session manager: approvals', () => {
  it('blocks the adapter until the person answers, and stores the request and the decision', async () => {
    const state = rig()
    const { chat, answers } = await askingChat(state, [{ id: 'q1' }])

    expect(answers).toEqual([])
    expect(state.events.at(-1)).toMatchObject({ type: 'item', item: { kind: 'approval_request', requestId: 'q1', category: 'command' } })
    expect((await state.manager.openChat(chat)).running).toBe(true)

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_once' })
    await settle()

    expect(answers).toEqual(['allow_once'])
    expect(decisionsIn(storedItems(state.store, chat))).toEqual([['q1', 'allow_once']])
    expect(state.events.at(-1)).toEqual({ type: 'turn', chatId: chat.id, running: false })
  })

  it('hands Allow once, Allow for this chat and Deny to the adapter as distinct outcomes', async () => {
    const state = rig()
    const { chat, answers } = await askingChat(state, [
      { id: 'q1', tool: 'Bash' },
      { id: 'q2', tool: 'Write' },
      { id: 'q3', tool: 'Fetch' }
    ])

    for (const [requestId, decision] of [['q1', 'allow_once'], ['q2', 'allow_chat'], ['q3', 'deny']] as const) {
      state.manager.answerApproval(chat, { requestId, decision })
      await settle()
    }

    expect(answers).toEqual(['allow_once', 'allow_chat', 'deny'])
    expect(decisionsIn(storedItems(state.store, chat))).toEqual([['q1', 'allow_once'], ['q2', 'allow_chat'], ['q3', 'deny']])
  })

  it('remembers Allow for this chat for the same category and tool only, answering later requests itself', async () => {
    const state = rig()
    const { chat, answers } = await askingChat(state, [
      { id: 'q1', tool: 'Bash' },
      { id: 'q2', tool: 'Bash' },
      { id: 'q3', tool: 'Write' }
    ])

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_chat' })
    await settle()

    expect(answers).toEqual(['allow_chat', 'allow_chat'])
    const decisions = storedItems(state.store, chat).filter((item) => item.kind === 'approval_decision')
    expect(decisions[1]).toMatchObject({ requestId: 'q2', decision: 'allow_chat', automatic: true })
    expect((await state.manager.openChat(chat)).pending.map((request) => request.requestId)).toEqual(['q3'])
  })
})

describe('session manager: chats waiting on an answer', () => {
  const pendingOf = (state: Rig): Record<string, number> => Object.fromEntries(state.manager.listChats(REPO).map((chat) => [chat.title, chat.pending]))

  it('counts the requests each listed chat is waiting on, until they are answered', async () => {
    const state = rig()
    newChat(state.manager, { title: 'Idle' })
    const { chat } = await askingChat(state, [{ id: 'q1' }])

    expect(pendingOf(state)).toEqual({ Idle: 0, 'Fix the build': 1 })

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'deny' })
    await settle()

    expect(pendingOf(state)).toEqual({ Idle: 0, 'Fix the build': 0 })
  })

  it('stops counting a request that Stop cancelled', async () => {
    const state = rig()
    const { chat } = await askingChat(state, [{ id: 'q1' }])
    expect(pendingOf(state)).toEqual({ 'Fix the build': 1 })

    await state.manager.stop(chat)

    expect(pendingOf(state)).toEqual({ 'Fix the build': 0 })
  })
})

describe('session manager: approvals after reopening', () => {
  it('answers every waiting request of the same category and tool when one is allowed for the chat', async () => {
    const state = rig()
    const answers: ApprovalDecision[] = []
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        answers.push(...(await Promise.all([self.ask('q1'), self.ask('q2'), self.ask('q3', 'file_edit', 'Bash')])))
      }
    }
    const chat = newChat(state.manager)
    await state.manager.send(chat, 'go')
    await settle()

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_chat' })
    expect((await state.manager.openChat(chat)).pending.map((request) => request.requestId)).toEqual(['q3'])
    state.manager.answerApproval(chat, { requestId: 'q3', decision: 'deny' })
    await settle()

    expect(answers).toEqual(['allow_chat', 'allow_chat', 'deny'])
  })

  it('keeps an unanswered request pending in main when the chat is opened again, and takes the answer then', async () => {
    const state = rig()
    const { chat, answers } = await askingChat(state, [{ id: 'q1' }])

    const reopened = await state.manager.openChat(chat)

    expect(reopened.pending).toEqual([expect.objectContaining({ requestId: 'q1', summary: 'Use Bash' })])
    expect(reopened.items.at(-1)).toMatchObject({ kind: 'approval_request', requestId: 'q1' })
    expect(decisionsIn(reopened.items)).toEqual([])
    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'deny' })
    await settle()
    expect(answers).toEqual(['deny'])
  })
})

describe('session manager: approvals that are no longer waiting', () => {
  it('refuses an answer to a request that is not waiting', async () => {
    const state = rig()
    const { chat } = await askingChat(state, [{ id: 'q1' }])
    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_once' })

    expect(() => state.manager.answerApproval(chat, { requestId: 'q1', decision: 'deny' })).toThrow(
      expect.objectContaining({ code: 'not_found' })
    )
    expect(() => state.manager.answerApproval(newChat(state.manager), { requestId: 'q1', decision: 'deny' })).toThrow(
      expect.objectContaining({ code: 'not_found' })
    )
  })

  it('denies a request it cannot store, so the adapter is not left waiting', async () => {
    const state = rig()
    const answers: ApprovalDecision[] = []
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        answers.push(await self.ask(''))
      }
    }
    await state.manager.send(newChat(state.manager), 'go')
    await settle()

    expect(answers).toEqual(['deny'])
    expect(state.errors).toEqual([expect.objectContaining({ code: 'invalid_input' })])
  })

  it('records a request left unanswered when the app quit as cancelled when the chat is next opened', async () => {
    const fs = memoryChatFs()
    const before = rig(fs)
    const chat = newChat(before.manager)
    before.store.appendItem(chat, { id: 'r1', at: AT, kind: 'approval_request', requestId: 'q1', category: 'file_edit', tool: 'Edit', summary: 'Edit a.ts' })

    const after = rig(fs)
    const opened = await after.manager.openChat(chat)

    expect(opened.pending).toEqual([])
    expect(decisionsIn(opened.items)).toEqual([['q1', 'cancelled']])
    expect(decisionsIn((await after.manager.openChat(chat)).items)).toEqual([['q1', 'cancelled']])
  })
})

describe('session manager: stop and model', () => {
  it('Stop ends the running turn, cancels its pending approvals and keeps the session', async () => {
    const state = rig()
    const { chat, answers } = await askingChat(state, [{ id: 'q1' }])
    const adapter = only(state.fakes.created)

    await state.manager.stop(chat)
    await settle()

    expect(adapter.stops).toBe(1)
    expect(answers).toEqual(['deny'])
    expect(decisionsIn(storedItems(state.store, chat))).toEqual([['q1', 'cancelled']])
    expect(state.events.at(-1)).toEqual({ type: 'turn', chatId: chat.id, running: false })
    expect(adapter.disposals).toBe(0)
    await state.manager.stop(chat)
    expect(adapter.stops).toBe(1)
  })

  it('Stop interrupts a turn that is still writing, and does nothing for a chat with no process', async () => {
    const { manager, fakes, events } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = (self) => self.untilStopped()
    }
    await manager.send(chat, 'go')

    await manager.stop(chat)
    await settle()
    await manager.stop(newChat(manager))

    expect(only(fakes.created).stops).toBe(1)
    expect(events.at(-1)).toEqual({ type: 'turn', chatId: chat.id, running: false })
  })
})

describe('session manager: models', () => {
  it('applies a model change from the next turn and records it', async () => {
    const { manager, fakes, store } = rig()
    const chat = newChat(manager, { model: 'big' })
    await manager.send(chat, 'go')

    const updated = await manager.setModel(chat, 'small')
    await manager.setModel(chat, 'small')

    expect(updated.model).toBe('small')
    expect(only(fakes.created).modelChanges).toEqual(['small'])
    expect(storedItems(store, chat).filter((item) => item.kind === 'model_change')).toEqual([expect.objectContaining({ from: 'big', to: 'small' })])
  })

  it('records a model change for a chat with no process, which then starts on that model', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager)

    await manager.setModel(chat, 'small')
    await manager.send(chat, 'go')

    expect(only(fakes.created).started[0]?.model).toBe('small')
    expect(only(fakes.created).modelChanges).toEqual([])
  })

  it('lists models for an agent kind without a chat', async () => {
    const { manager } = rig()

    expect(await manager.listModels('codex')).toEqual([...MODELS, { id: '/bin/codex', label: 'codex' }])
    await expect(manager.listModels('cursor')).rejects.toMatchObject({ code: 'unsupported_capability' })
  })
})

describe('session manager: idle processes', () => {
  it('disposes an idle process and resumes the vendor session on the next message', async () => {
    const { manager, fakes, timers } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = async (self) => self.emit({ type: 'session', sessionId: 'vendor-7' })
    }
    await manager.send(chat, 'go')
    await settle()
    expect(timers.delays).toEqual([IDLE_MS])

    timers.fire()
    await settle()
    expect(fakes.created[0]?.disposals).toBe(1)
    expect(manager.liveCount()).toBe(0)

    await manager.send(chat, 'back')
    expect(fakes.created[1]?.started[0]?.sessionId).toBe('vendor-7')
  })

  it('does not count a session as idle while a turn runs or an approval waits', async () => {
    const state = rig()
    const { chat } = await askingChat(state, [{ id: 'q1' }])
    expect(state.timers.count()).toBe(0)

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_once' })
    await settle()
    expect(state.timers.count()).toBe(1)
  })
})

describe('session manager: quitting', () => {
  it('disposes every adapter, cancels pending approvals and starts no more', async () => {
    const state = rig()
    const { chat } = await askingChat(state, [{ id: 'q1' }])
    const other = newChat(state.manager, { agent: 'codex' })
    await state.manager.openChat(other)
    expect(state.manager.liveCount()).toBe(2)

    await state.manager.disposeAll()
    await settle()

    expect(state.fakes.created.map((adapter) => adapter.disposals)).toEqual([1, 1])
    expect(state.manager.liveCount()).toBe(0)
    expect(decisionsIn(storedItems(state.store, chat))).toEqual([['q1', 'cancelled']])
    expect(state.timers.count()).toBe(0)
    await expect(state.manager.send(other, 'more')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('disposes a chat that is still starting, and its first message fails', async () => {
    const state = rig()
    let finishStart: () => void = () => {}
    state.fakes.prepare = (adapter) => {
      adapter.start = (options) => {
        adapter.started.push(options)
        return new Promise((resolve) => {
          finishStart = resolve
        })
      }
    }
    const sending = state.manager.send(newChat(state.manager), 'go')
    await settle()

    const quitting = state.manager.disposeAll()
    finishStart()
    await quitting

    await expect(sending).rejects.toMatchObject({ code: 'conflict' })
    expect(only(state.fakes.created).disposals).toBe(1)
    expect(only(state.fakes.created).sent).toEqual([])
  })

  it('keeps disposing the rest when one adapter fails to dispose', async () => {
    const state = rig()
    await state.manager.send(newChat(state.manager), 'one')
    await state.manager.send(newChat(state.manager), 'two')
    const [first, second] = state.fakes.created as [FakeChatAdapter, FakeChatAdapter]
    first.dispose = () => Promise.reject(new Error('kill failed'))

    await state.manager.disposeAll()

    expect(second.disposals).toBe(1)
    expect(state.errors).toEqual([expect.objectContaining({ message: 'kill failed' })])
  })
})

describe('session manager: chats', () => {
  it('lists a folder\'s chats and pushes exactly the stored items', async () => {
    const { manager, events, store } = rig()
    const chat = newChat(manager)
    await manager.send(chat, 'go')
    await settle()

    expect(manager.listChats(REPO).map((listed) => listed.id)).toEqual([chat.id])
    expect(pushedItems(events)).toEqual(storedItems(store, chat))
  })
})

describe('session manager: renaming a chat', () => {
  it('changes only the title, and names the chat\'s next agent session after it', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager, { title: 'Old' })

    const renamed = manager.renameChat(chat, 'Fix the build')
    await manager.send(chat, 'go')

    expect(renamed).toMatchObject({ id: chat.id, title: 'Fix the build', role: chat.role, model: chat.model, agent: chat.agent })
    expect(manager.listChats(REPO).map((listed) => listed.title)).toEqual(['Fix the build'])
    expect(only(fakes.created).started[0]?.darkMechanicus.args.at(-1)).toBe('Claude Code · Fix the build')
  })

  it('does not lose the title when the vendor session id is stored while the chat runs', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        await Promise.resolve()
        self.emit({ type: 'session', sessionId: 'vendor-1' })
      }
    }
    await manager.send(chat, 'go')
    manager.renameChat(chat, 'Renamed mid-turn')
    await settle()

    expect(manager.listChats(REPO)[0]).toMatchObject({ title: 'Renamed mid-turn', sessionId: 'vendor-1' })
  })

  it('refuses an unknown chat', () => {
    const { manager } = rig()

    expect(() => manager.renameChat({ folder: REPO, id: 'chat_nope' }, 'x')).toThrowError(expect.objectContaining({ code: 'not_found' }) as Error)
  })
})

describe('session manager: deleting a chat', () => {
  it('removes a chat that has no agent process, and leaves its sibling alone', async () => {
    const { manager, store } = rig()
    const doomed = newChat(manager)
    const kept = newChat(manager)

    await manager.deleteChat(doomed)

    expect(manager.listChats(REPO).map((listed) => listed.id)).toEqual([kept.id])
    expect(store.getChat(doomed)).toBeNull()
    await expect(manager.openChat(doomed)).rejects.toMatchObject({ code: 'not_found' })
    await expect(manager.send(doomed, 'late')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('ends a running chat first: disposes its agent, denies what it was waiting on and pushes nothing more', async () => {
    const state = rig()
    const { chat, answers } = await askingChat(state, [{ id: 'q1' }])
    const adapter = only(state.fakes.created)
    const pushedBefore = state.events.length

    await state.manager.deleteChat(chat)
    await settle()

    expect(adapter.disposals).toBe(1)
    expect(answers).toEqual(['deny'])
    expect(state.manager.liveCount()).toBe(0)
    expect(state.timers.count()).toBe(0)
    expect(state.store.readTranscript(chat)).toBeNull()
    expect(state.events.slice(pushedBefore).filter((event) => event.type === 'turn')).toEqual([])
    expect(state.errors).toEqual([])
  })

  it('keeps the agent of another chat running', async () => {
    const { manager, fakes } = rig()
    const doomed = newChat(manager)
    const kept = newChat(manager)
    await manager.send(doomed, 'go')
    await manager.send(kept, 'go')

    await manager.deleteChat(doomed)

    expect(fakes.created.map((adapter) => adapter.disposals)).toEqual([1, 0])
    expect(manager.liveCount()).toBe(1)
  })

  it('refuses an unknown chat', async () => {
    const { manager } = rig()

    await expect(manager.deleteChat({ folder: REPO, id: 'chat_nope' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

// ---- A sign-in the agent's CLI says is gone ----

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' }
const CLI_WORDS = 'Not logged in · Please run /login'

function authItem(message = CLI_WORDS, agent: 'claude' | 'codex' = 'claude'): ChatItem {
  return { id: `auth_${message.length}`, at: AT, kind: 'auth_required', agent, message }
}

/** A turn that the CLI ends because its sign-in is gone: one auth_required item, then the turn settles. */
function signedOutTurn(adapter: FakeChatAdapter, message = CLI_WORDS): Promise<void> {
  adapter.emit({ type: 'item', item: authItem(message, adapter.kind === 'codex' ? 'codex' : 'claude') })
  return Promise.resolve()
}

/** The first turn of each adapter is signed out; later turns settle normally. */
function signedOutOnce(fakes: FakeAdapters, message = CLI_WORDS): { turns: number } {
  const counter = { turns: 0 }
  fakes.prepare = (adapter) => {
    adapter.turn = (self) => {
      counter.turns += 1
      return counter.turns === 1 ? signedOutTurn(self, message) : Promise.resolve()
    }
  }
  return counter
}

function authItems(items: readonly ChatItem[]): ChatItem[] {
  return items.filter((item) => item.kind === 'auth_required')
}

describe('session manager: an agent that is signed out', () => {
  it('stores one auth_required item for the turn, ends the turn without an error, and marks the agent signed out', async () => {
    const { manager, fakes, store, events } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes)

    const message = await manager.send(chat, 'Run the sprint')
    await settle()

    expect(storedItems(store, chat).map((item) => item.kind)).toEqual(['user_message', 'auth_required'])
    expect(authItems(storedItems(store, chat))).toEqual([expect.objectContaining({ agent: 'claude', message: CLI_WORDS })])
    expect(events.at(-1)).toEqual({ type: 'turn', chatId: chat.id, running: false })
    expect(store.getChat(chat)?.cutShortMessageId).toBe(message.id)
    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toEqual({ state: 'signed_out', reason: expect.stringContaining('Claude Code') })
  })

  it('leaves other agents alone', async () => {
    const { manager, fakes } = rig()
    signedOutOnce(fakes)
    await manager.send(newChat(manager), 'go')
    await settle()

    const codex: AgentAuthStatus = { state: 'signed_in', reason: 'Codex reports it is signed in.' }

    expect(manager.reconcileAuthStatus('codex', codex)).toEqual(codex)
  })

  it('does not blame an earlier message when the sign-in is reported outside a turn', async () => {
    const { manager, fakes, store } = rig()
    const chat = newChat(manager)
    await manager.send(chat, 'finished fine')
    await settle()

    only(fakes.created).emit({ type: 'item', item: authItem() })

    expect(authItems(storedItems(store, chat))).toHaveLength(1)
    expect(store.getChat(chat)?.cutShortMessageId ?? null).toBeNull()
    await expect(manager.retryTurn(chat)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('keeps the status the CLI reports while no chat found the sign-in gone', () => {
    const { manager } = rig()
    const unknown: AgentAuthStatus = { state: 'unknown', reason: 'Claude Code did not answer in time.' }

    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toEqual(SIGNED_IN)
    expect(manager.reconcileAuthStatus('claude', unknown)).toEqual(unknown)
  })

})

describe('session manager: new turns in chats of an agent that is signed out', () => {
  it('answers a new turn in another chat with that agent with auth_required, without starting the CLI', async () => {
    const { manager, fakes, store } = rig()
    const first = newChat(manager, { title: 'First' })
    const second = newChat(manager, { title: 'Second' })
    signedOutOnce(fakes)
    await manager.send(first, 'go')
    await settle()

    const message = await manager.send(second, 'Do the other thing')
    await settle()

    expect(fakes.of('claude')).toHaveLength(1)
    expect(storedItems(store, second).map((item) => item.kind)).toEqual(['user_message', 'auth_required'])
    expect(authItems(storedItems(store, second))).toEqual([expect.objectContaining({ agent: 'claude', message: CLI_WORDS })])
    expect(store.getChat(second)?.cutShortMessageId).toBe(message.id)
    expect(manager.liveCount()).toBe(1)
  })

  it('also refuses a new turn in a chat whose process is live, without sending anything to it', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes)
    await manager.send(chat, 'first')
    await settle()

    await manager.send(chat, 'second')
    await settle()

    expect(only(fakes.created).sent).toEqual(['first'])
  })

  it('still starts turns for another agent', async () => {
    const { manager, fakes } = rig()
    signedOutOnce(fakes)
    await manager.send(newChat(manager), 'go')
    await settle()

    await manager.send(newChat(manager, { agent: 'codex' }), 'hello')

    expect(fakes.of('codex')).toHaveLength(1)
  })

})

describe('session manager: turns around the one that found the sign-in gone', () => {
  it('still reports a turn that is already running when another chat found the sign-in gone', async () => {
    const { manager, fakes } = rig()
    const busy = newChat(manager, { title: 'Busy' })
    const other = newChat(manager, { title: 'Other' })
    fakes.prepare = (adapter) => {
      adapter.turn = (self) => self.untilStopped()
    }
    await manager.send(busy, 'long job')
    fakes.prepare = (adapter) => {
      adapter.turn = (self) => signedOutTurn(self)
    }
    await manager.send(other, 'go')
    await settle()

    await expect(manager.send(busy, 'again')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('reports one auth_required item per turn however many the adapter emits', async () => {
    const { manager, fakes, store } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        await signedOutTurn(self, 'first words')
        await signedOutTurn(self, 'second words')
      }
    }

    await manager.send(chat, 'go')
    await settle()

    expect(authItems(storedItems(store, chat))).toHaveLength(1)
  })
})

describe('session manager: claim tokens in what the CLI says', () => {
  it('stores and pushes the CLI message with claim tokens masked', async () => {
    const ids = createIdGenerator(() => 1_700_000_000_000, (size) => Buffer.alloc(size, 9))
    const secret = ids.secret()
    const token = `${ids.next('attempt')}.${secret}`
    const { manager, fakes, store, events } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes, `Auth failed for ${token}. Please sign in again.`)

    await manager.send(chat, 'go')
    await settle()

    const expected = `Auth failed for ${CLAIM_TOKEN_MASK}. Please sign in again.`
    expect(authItems(storedItems(store, chat))).toEqual([expect.objectContaining({ message: expected })])
    expect(authItems(pushedItems(events))).toEqual([expect.objectContaining({ message: expected })])
    expect(JSON.stringify([...storedItems(store, chat), ...events])).not.toContain(secret.slice(0, 8))
  })

  it('shows a refused turn in another chat the same masked words', async () => {
    const ids = createIdGenerator(() => 1_700_000_000_000, (size) => Buffer.alloc(size, 9))
    const secret = ids.secret()
    const { manager, fakes, store } = rig()
    const second = newChat(manager, { title: 'Second' })
    signedOutOnce(fakes, `Token ${ids.next('attempt')}.${secret} was rejected.`)
    await manager.send(newChat(manager), 'go')
    await settle()

    await manager.send(second, 'hello')

    expect(JSON.stringify(storedItems(store, second))).not.toContain(secret.slice(0, 8))
    expect(authItems(storedItems(store, second))).toEqual([expect.objectContaining({ message: `Token ${CLAIM_TOKEN_MASK} was rejected.` })])
  })
})

describe('session manager: signing in again', () => {
  it('keeps reporting signed out until a sign-in was started and the CLI says it is signed in', async () => {
    const { manager, fakes } = rig()
    signedOutOnce(fakes)
    await manager.send(newChat(manager), 'go')
    await settle()
    const signedOut = { state: 'signed_out', reason: expect.any(String) }
    const unknown: AgentAuthStatus = { state: 'unknown', reason: 'Claude Code did not answer in time.' }

    // The CLI's own check cannot see an expired token, so a "signed in" before anyone signed in again proves nothing.
    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toEqual(signedOut)
    manager.signInStarted('claude')
    expect(manager.reconcileAuthStatus('claude', unknown)).toEqual(signedOut)
    expect(manager.reconcileAuthStatus('claude', { state: 'signed_out', reason: 'Claude Code reports it is not signed in.' })).toMatchObject({ state: 'signed_out' })
    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toEqual(SIGNED_IN)
    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toEqual(SIGNED_IN)
  })

  it('lets turns start again once the flag is cleared', async () => {
    const { manager, fakes, store } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes)
    await manager.send(chat, 'go')
    await settle()
    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)

    await manager.send(chat, 'next')
    await settle()

    expect(only(fakes.created).sent).toEqual(['go', 'next'])
    expect(authItems(storedItems(store, chat))).toHaveLength(1)
  })

})

describe('session manager: a sign-in that did not hold', () => {
  it('needs a new sign-in when the agent says again that the sign-in is gone', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = (self) => signedOutTurn(self)
    }
    await manager.send(chat, 'go')
    await settle()
    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)

    await manager.send(chat, 'go again')
    await settle()

    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toMatchObject({ state: 'signed_out' })
  })

  it('ignores a sign-in that was started for an agent that is not signed out', () => {
    const { manager } = rig()

    manager.signInStarted('claude')

    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toEqual(SIGNED_IN)
  })

})

describe('session manager: telling the opened chats', () => {
  it('tells the opened chats of that agent when the agent is signed out and when it is signed in again', async () => {
    const { manager, fakes, events } = rig()
    const first = newChat(manager, { title: 'First' })
    const second = newChat(manager, { title: 'Second' })
    const codex = newChat(manager, { agent: 'codex' })
    await manager.openChat(first)
    await manager.openChat(second)
    await manager.openChat(codex)
    signedOutOnce(fakes)
    await manager.send(first, 'go')
    await settle()
    const authEvents = (): ChatPushEvent[] => events.filter((event) => event.type === 'agent_auth')

    expect(authEvents()).toEqual([
      { type: 'agent_auth', chatId: first.id, agent: 'claude', state: 'signed_out' },
      { type: 'agent_auth', chatId: second.id, agent: 'claude', state: 'signed_out' }
    ])

    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)
    manager.reconcileAuthStatus('claude', SIGNED_IN)

    expect(authEvents().slice(2)).toEqual([
      { type: 'agent_auth', chatId: first.id, agent: 'claude', state: 'signed_in' },
      { type: 'agent_auth', chatId: second.id, agent: 'claude', state: 'signed_in' }
    ])
  })

  it('does not tell a chat that was deleted', async () => {
    const { manager, fakes, events } = rig()
    const gone = newChat(manager, { title: 'Gone' })
    const kept = newChat(manager, { title: 'Kept' })
    await manager.openChat(gone)
    await manager.openChat(kept)
    await manager.deleteChat(gone)
    signedOutOnce(fakes)
    await manager.send(kept, 'go')
    await settle()

    expect(events.filter((event) => event.type === 'agent_auth').map((event) => event.chatId)).toEqual([kept.id])
  })
})

describe('session manager: retrying the turn a sign-in cut short', () => {
  it('refuses while the agent is still signed out, and sends nothing', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes)
    await manager.send(chat, 'Run the sprint')
    await settle()

    await expect(manager.retryTurn(chat)).rejects.toMatchObject({ code: 'conflict' })
    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', { state: 'signed_out', reason: 'Claude Code reports it is not signed in.' })
    await expect(manager.retryTurn(chat)).rejects.toMatchObject({ code: 'conflict' })

    expect(only(fakes.created).sent).toEqual(['Run the sprint'])
  })

  it('re-sends the cut-short message exactly once after sign-in, and nothing without a retry', async () => {
    const { manager, fakes, store, events } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes)
    const message = await manager.send(chat, 'Run the sprint')
    await settle()
    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)
    await settle()
    expect(only(fakes.created).sent).toEqual(['Run the sprint'])

    const resent = await manager.retryTurn(chat)
    await settle()

    expect(resent).toEqual(message)
    expect(only(fakes.created).sent).toEqual(['Run the sprint', 'Run the sprint'])
    expect(events.slice(-2)).toEqual([
      { type: 'turn', chatId: chat.id, running: true },
      { type: 'turn', chatId: chat.id, running: false }
    ])
    expect(storedItems(store, chat).filter((item) => item.kind === 'user_message')).toHaveLength(1)
    expect(store.getChat(chat)?.cutShortMessageId).toBeNull()

    await expect(manager.retryTurn(chat)).rejects.toMatchObject({ code: 'not_found' })
    expect(only(fakes.created).sent).toHaveLength(2)
  })

})

describe('session manager: how often a cut-short turn is sent', () => {
  it('sends it once however many retries race', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes)
    await manager.send(chat, 'go')
    await settle()
    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)

    const results = await Promise.allSettled([manager.retryTurn(chat), manager.retryTurn(chat), manager.retryTurn(chat)])
    await settle()

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(only(fakes.created).sent).toEqual(['go', 'go'])
  })

  it('has nothing to retry in a chat no sign-in cut short, or in an unknown chat', async () => {
    const { manager, fakes } = rig()
    const chat = newChat(manager)
    await manager.send(chat, 'go')
    await settle()

    await expect(manager.retryTurn(chat)).rejects.toMatchObject({ code: 'not_found' })
    await expect(manager.retryTurn({ folder: REPO, id: 'chat_nope' })).rejects.toMatchObject({ code: 'not_found' })
    expect(only(fakes.created).sent).toEqual(['go'])
  })

})

describe('session manager: what a retry leaves behind', () => {
  it('forgets the cut-short message when the person sends a new one, which then cannot be retried either', async () => {
    const { manager, fakes, store } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes)
    await manager.send(chat, 'first')
    await settle()
    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)

    await manager.send(chat, 'second')
    await settle()

    expect(store.getChat(chat)?.cutShortMessageId).toBeNull()
    await expect(manager.retryTurn(chat)).rejects.toMatchObject({ code: 'not_found' })
    expect(only(fakes.created).sent).toEqual(['first', 'second'])
  })

  it('keeps the same message for retry when the retried turn is cut short again', async () => {
    const { manager, fakes, store } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = (self) => signedOutTurn(self)
    }
    const message = await manager.send(chat, 'go')
    await settle()
    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)

    await manager.retryTurn(chat)
    await settle()

    expect(store.getChat(chat)?.cutShortMessageId).toBe(message.id)
    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toMatchObject({ state: 'signed_out' })
    await expect(manager.retryTurn(chat)).rejects.toMatchObject({ code: 'conflict' })
  })

})

describe('session manager: a retry that cannot start the agent', () => {
  it('does not drop the cut-short message when the agent cannot be started for the retry', async () => {
    const { manager, fakes, store, timers } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes)
    const message = await manager.send(chat, 'go')
    await settle()
    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)
    timers.fire()
    await settle()
    fakes.prepare = (adapter) => {
      adapter.startError = new Error('spawn failed')
    }

    await expect(manager.retryTurn(chat)).rejects.toThrow('spawn failed')

    expect(store.getChat(chat)?.cutShortMessageId).toBe(message.id)
  })
})

// ---- Pausing the run of an orchestrator chat, through the desktop's own session ----

interface RunRig {
  harness: Harness
  /** The desktop session: the only one that may pause a run for a signed-out agent. */
  desktop: Workspace
  orchestrator: Workspace
  /** Every call the manager made on the run commands, as "<command> <run id> [<reason>]". */
  calls: string[]
  runs: SignedOutRuns
}

async function plannedEpic(agent: Workspace, title: string): Promise<string> {
  const epic = await agent.createEpic({ title })
  await dropAcceptanceNodes(agent, epic.id)
  const draft = await agent.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', ref: 'only', sprint: '1', ticket: { title: 'Only ticket' } }] })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return epic.id
}

async function runRig(): Promise<RunRig> {
  const harness = createHarness()
  const orchestrator = harness.open('orchestrator')
  await orchestrator.initializeRepository({ name: 'signed-out-repo' })
  const desktop = harness.open('desktop')
  const calls: string[] = []
  const runs: SignedOutRuns = {
    getRun: (_folder, runId) => (calls.push(`getRun ${runId}`), desktop.getRun({ runId })),
    pauseRun: (_folder, input) => (calls.push(`pauseRun ${input.runId} ${input.reason}`), desktop.pauseRun(input))
  }
  return { harness, desktop, orchestrator, calls, runs }
}

/** A real workspace for the describe it is called in, opened before each test and closed after it. */
function useRunRig(): { state(): RunRig; signedOutChat(runId: string | undefined): Promise<{ manager: SessionManager; chat: ChatRecord }> } {
  let current: RunRig | null = null
  const state = (): RunRig => current as RunRig
  beforeEach(async () => {
    current = await runRig()
  })
  afterEach(() => {
    current?.harness.cleanup()
  })
  return {
    state,
    async signedOutChat(runId) {
      const { manager, fakes } = rig(undefined, { runs: state().runs })
      const chat = newChat(manager, runId === undefined ? {} : { runId })
      signedOutOnce(fakes)
      await manager.send(chat, 'Run the sprint')
      await settle()
      return { manager, chat }
    }
  }
}

describe('session manager: pausing the run of a signed-out orchestrator', () => {
  const run = useRunRig()

  it('pauses a running run with the reason signed_out, through the desktop session', async () => {
    const { state, signedOutChat } = run
    const epicId = await plannedEpic(state().orchestrator, 'Pause me')
    const started = await state().orchestrator.startRun({ epicId })
    expect(started.state).toBe('running')

    await signedOutChat(started.id)

    expect(await state().desktop.getRun({ runId: started.id })).toMatchObject({ state: 'paused', pauseReason: 'signed_out' })
    expect(state().calls).toEqual([`getRun ${started.id}`, `pauseRun ${started.id} signed_out`])
  })

  it("does not let an agent session do it: the signed_out reason is the desktop session's alone", async () => {
    const epicId = await plannedEpic(run.state().orchestrator, 'Only the desktop')
    const started = await run.state().orchestrator.startRun({ epicId })

    await expect(run.state().orchestrator.pauseRun({ runId: started.id, reason: 'signed_out' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('pauses the run when a new turn in the orchestrator chat is refused because the agent is already signed out', async () => {
    const { state } = run
    const epicId = await plannedEpic(state().orchestrator, 'Refused turn')
    const started = await state().orchestrator.startRun({ epicId })
    const { manager, fakes } = rig(undefined, { runs: state().runs })
    signedOutOnce(fakes)
    await manager.send(newChat(manager, { title: 'Elsewhere' }), 'go')
    await settle()
    expect(await state().desktop.getRun({ runId: started.id })).toMatchObject({ state: 'running' })

    await manager.send(newChat(manager, { runId: started.id }), 'Run the sprint')

    expect(await state().desktop.getRun({ runId: started.id })).toMatchObject({ state: 'paused', pauseReason: 'signed_out' })
    expect(fakes.of('claude')).toHaveLength(1)
  })

  it('does not resume the run when the person signs in again: the run bar does that', async () => {
    const { state } = run
    const epicId = await plannedEpic(state().orchestrator, 'Stay paused')
    const started = await state().orchestrator.startRun({ epicId })
    const { manager } = await run.signedOutChat(started.id)

    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)
    await settle()

    expect(await state().desktop.getRun({ runId: started.id })).toMatchObject({ state: 'paused', pauseReason: 'signed_out' })
    expect(state().calls).toEqual([`getRun ${started.id}`, `pauseRun ${started.id} signed_out`])
  })
})

describe('session manager: runs that are left alone when their orchestrator is signed out', () => {
  const run = useRunRig()

  it('pauses nothing for a chat that orchestrates no run', async () => {
    await run.signedOutChat(undefined)

    expect(run.state().calls).toEqual([])
  })

  it("pauses nothing when the chat's run is queued, and leaves it queued", async () => {
    const { state } = run
    const epicId = await plannedEpic(state().orchestrator, 'Queued')
    const queued = await state().desktop.queueRun({ epicId })

    await run.signedOutChat(queued.id)

    expect(state().calls).toEqual([`getRun ${queued.id}`])
    expect(await state().desktop.getRun({ runId: queued.id })).toMatchObject({ state: 'queued', pauseReason: null })
  })

  it("pauses nothing when the chat's run is already paused, and keeps its own reason", async () => {
    const { state } = run
    const epicId = await plannedEpic(state().orchestrator, 'Paused by the person')
    const started = await state().orchestrator.startRun({ epicId })
    await state().orchestrator.pauseRun({ runId: started.id, reason: 'lunch' })

    await run.signedOutChat(started.id)

    expect(state().calls).toEqual([`getRun ${started.id}`])
    expect(await state().desktop.getRun({ runId: started.id })).toMatchObject({ state: 'paused', pauseReason: 'lunch' })
  })

  it('pauses nothing for a run that no longer exists, and does not fail the turn', async () => {
    const missing = 'rn_01m44m0qnd0nn90p29a12041js'

    const { manager } = await run.signedOutChat(missing)

    expect(run.state().calls).toEqual([`getRun ${missing}`])
    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toMatchObject({ state: 'signed_out' })
  })
})

describe('session manager: a pause that fails', () => {
  it('keeps the chat usable, ends the turn, and reports why', async () => {
    const errors: unknown[] = []
    const failing: SignedOutRuns = { getRun: () => Promise.resolve({ state: 'running' }), pauseRun: () => Promise.reject(new Error('database is locked')) }
    const { manager, fakes, store, events } = rig(undefined, { runs: failing, onError: (error) => errors.push(error) })
    const chat = newChat(manager, { runId: 'rn_1' })
    signedOutOnce(fakes)

    await manager.send(chat, 'go')
    await settle()

    expect(errors).toEqual([expect.objectContaining({ message: 'database is locked' })])
    expect(storedItems(store, chat).map((item) => item.kind)).toEqual(['user_message', 'auth_required'])
    expect(events.at(-1)).toEqual({ type: 'turn', chatId: chat.id, running: false })
  })
})

// ---- Failures and races at the edges ----

describe('session manager: turns that fail without an Error', () => {
  const errorItems = (store: ChatStore, chat: ChatRecord): ChatItem[] => storedItems(store, chat).filter((item) => item.kind === 'error')

  it('stores the text of a turn that rejects with a string', async () => {
    const { manager, fakes, store, events } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = () => Promise.reject('rate limited')
    }

    await manager.send(chat, 'go')
    await settle()

    expect(errorItems(store, chat)).toMatchObject([{ kind: 'error', message: 'rate limited' }])
    expect(events.at(-1)).toEqual({ type: 'turn', chatId: chat.id, running: false })
  })

  it('stores a general message for a turn that rejects with nothing', async () => {
    const { manager, fakes, store } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      adapter.turn = () => Promise.reject(undefined)
    }

    await manager.send(chat, 'go')
    await settle()

    expect(errorItems(store, chat)).toMatchObject([{ message: 'The turn failed.' }])
  })
})

describe('session manager: sessions that end while something else is waiting on them', () => {
  it('disposes the adapter once when two messages race a start that fails', async () => {
    const { manager, fakes } = rig()
    fakes.prepare = (adapter) => {
      adapter.startError = new Error('cannot start')
    }
    const chat = newChat(manager)

    const results = await Promise.allSettled([manager.send(chat, 'a'), manager.send(chat, 'b')])

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(only(fakes.created).disposals).toBe(1)
    expect(manager.liveCount()).toBe(0)
  })

  it('drops what an adapter emits after its session was disposed', async () => {
    const { manager, fakes, store, events } = rig()
    const chat = newChat(manager)
    await manager.send(chat, 'hello')
    await settle()
    const adapter = only(fakes.created)
    await manager.disposeAll()
    const pushed = events.length

    adapter.emit({ type: 'item', item: { id: 'late', at: AT, kind: 'assistant_text', text: 'too late' } })

    expect(events).toHaveLength(pushed)
    expect(storedItems(store, chat).map((item) => item.id)).not.toContain('late')
  })

})

describe('session manager: chats that open while their agent starts', () => {
  it('opens a chat that was deleted while its agent started, with nothing in it', async () => {
    const { manager, fakes, errors } = rig()
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    fakes.prepare = (adapter) => {
      adapter.start = () => started
    }
    const chat = newChat(manager, { agent: 'codex' })

    const opening = manager.openChat(chat)
    await settle()
    await manager.deleteChat(chat)
    release()

    await expect(opening).resolves.toEqual({ chat, items: [], pending: [], running: false })
    expect(errors).toEqual([])
  })

  it('opens a start-on-open chat whose agent cannot start, and reports why', async () => {
    const { manager, fakes, errors } = rig()
    fakes.prepare = (adapter) => {
      adapter.startError = new Error('spawn codex ENOENT')
    }
    const chat = newChat(manager, { agent: 'codex' })

    const opened = await manager.openChat(chat)

    expect(opened).toMatchObject({ chat: { id: chat.id }, items: [], running: false })
    expect(errors).toEqual([expect.objectContaining({ message: 'spawn codex ENOENT' })])
    expect(manager.liveCount()).toBe(0)
  })
})

describe('session manager: a retry that finds its message already sent', () => {
  it('refuses when the message was used while the process was starting', async () => {
    const { manager, fakes, store, timers } = rig()
    const chat = newChat(manager)
    signedOutOnce(fakes)
    await manager.send(chat, 'go')
    await settle()
    manager.signInStarted('claude')
    manager.reconcileAuthStatus('claude', SIGNED_IN)
    timers.fire()
    await settle()
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    fakes.prepare = (adapter) => {
      adapter.start = () => started
    }

    const retrying = manager.retryTurn(chat)
    await settle()
    store.updateChat(chat, { cutShortMessageId: null })
    release()

    await expect(retrying).rejects.toMatchObject({ code: 'conflict', message: 'That message was already sent again.' })
    expect(fakes.created.at(-1)?.sent).toEqual([])
  })
})

describe('session manager: allowing several tools for a chat', () => {
  it('remembers each allowed tool, answering later requests for any of them itself', async () => {
    const state = rig()
    const answers: ApprovalDecision[] = []
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        for (const [id, tool] of [['q1', 'Bash'], ['q2', 'Write'], ['q3', 'Bash'], ['q4', 'Write']] as const) {
          answers.push(await self.ask(id, 'command', tool))
        }
      }
    }
    const chat = newChat(state.manager)
    await state.manager.send(chat, 'go')
    await settle()

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_chat' })
    await settle()
    state.manager.answerApproval(chat, { requestId: 'q2', decision: 'allow_chat' })
    await settle()

    expect(answers).toEqual(['allow_chat', 'allow_chat', 'allow_chat', 'allow_chat'])
    expect(decisionsIn(storedItems(state.store, chat))).toEqual([
      ['q1', 'allow_chat'],
      ['q2', 'allow_chat'],
      ['q3', 'allow_chat'],
      ['q4', 'allow_chat']
    ])
  })
})
