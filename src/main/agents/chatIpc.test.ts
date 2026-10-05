import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ApprovalDecision, ChatItem, ChatRecord } from '../../shared/agents/chat'
import { CHAT_EVENT_CHANNEL, type BoundThread, type ChatOpenView, type ChatPushEvent, type StartOrchestratorResult, type ThreadBinding } from '../../shared/agents/chatApi'
import type { CommandResult } from '../../shared/desktop/api'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import { AT, fakeAdapters, memoryChatFs, memoryChatStore, MODELS, REPO, type FakeAdapters, type MemoryChatFs } from './__mocks__/fakeChatAdapter'
import { ATTEMPT_A, ATTEMPT_B, RUN_ID, THREAD_A } from './__mocks__/orchestratorChat'
import { createActivityBindings } from './activityBindings'
import { createChatHandlers } from './chatHandlers'
import { createChatPush, registerChatIpc, type ChatWindow } from './chatIpc'
import { listBoundThreads } from './boundThreads'
import { listThreadBindings } from './threadBindings'
import type { ChatStore } from './chatStore'
import { guardIpc } from '../ipcGuard'
import type { OrchestratorRuns } from './orchestratorStart'
import { createSessionManager, type SessionManager } from './sessionManager'

type Listener = Parameters<IpcMain['handle']>[1]

const EVENT = {} as IpcMainInvokeEvent

const CHAT_CHANNELS = [
  'chats:answerApproval',
  'chats:boundThreads',
  'chats:create',
  'chats:delete',
  'chats:list',
  'chats:models',
  'chats:open',
  'chats:read',
  'chats:rename',
  'chats:retryTurn',
  'chats:send',
  'chats:setModel',
  'chats:startOrchestrator',
  'chats:stop',
  'chats:threadBindings'
]

const EPIC_ID = 'ep_01m418epbg8qkqa2e2krvdkqk5'
const EPIC = { id: EPIC_ID, title: 'Agent chats', branch: { repository: null, name: 'epic/agent-chats', startCommit: null } } as EpicDetailView
const RUN = { id: 'rn_2', number: 2, epicId: EPIC_ID, state: 'queued' } as RunView

function createFakeIpcMain(): { handle(channel: string, listener: Listener): void; channels(): string[]; invoke(channel: string, ...args: unknown[]): Promise<unknown> } {
  const listeners = new Map<string, Listener>()
  return {
    handle(channel, listener) {
      if (listeners.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      listeners.set(channel, listener)
    },
    channels: () => [...listeners.keys()].sort(),
    invoke: async (channel, ...args) => listeners.get(channel)?.(EVENT, ...args)
  }
}

interface IpcRig {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  sessions: SessionManager
  fakes: FakeAdapters
  fs: MemoryChatFs
  store: ChatStore
  events: ChatPushEvent[]
  /** The epics a run was queued for, in order. */
  queued: string[]
  channels(): string[]
}

/** The real handlers and session manager behind fake IPC, with fake adapters, an in-memory store and a fake run queue. */
function ipcRig(options: { bindings?: boolean; windows?: readonly ChatWindow[] } = {}): IpcRig {
  const ipc = createFakeIpcMain()
  const fakes = fakeAdapters()
  const fs = memoryChatFs()
  const store = memoryChatStore(fs)
  const activity = options.bindings === true ? createActivityBindings({ file: '/state/agents/activity-bindings.jsonl', fs }) : undefined
  const events: ChatPushEvent[] = []
  const sessions = createSessionManager({
    store,
    ...(activity === undefined ? {} : { activity }),
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['mcp.js', '--repo', folder], env: {} }),
    push: (event) => events.push(event)
  })
  const queued: string[] = []
  const runs: OrchestratorRuns = {
    getEpic: () => Promise.resolve(EPIC),
    queueRun: (_folder, epicId) => (queued.push(epicId), Promise.resolve(RUN))
  }
  const threadBindings =
    activity === undefined
      ? undefined
      : (chat: Parameters<typeof listThreadBindings>[1]) =>
          listThreadBindings({ activity, reads: { attempt: async () => ({ runId: RUN_ID, ticketId: 'tk_1' }), run: async () => ({ epicId: EPIC_ID, tickets: [{ ticketId: 'tk_1', key: 'DM-12' }] }) } }, chat)
  const boundThreads = activity === undefined ? undefined : (folder: string, target: Parameters<typeof listBoundThreads>[2]) => listBoundThreads(activity, folder, target)
  registerChatIpc(
    ipc,
    createChatHandlers({
      registry: { resolve: (path) => (path === REPO ? REPO : null) },
      sessions,
      runs,
      ...(options.windows === undefined ? {} : { push: createChatPush(() => options.windows ?? []) }),
      ...(threadBindings === undefined ? {} : { threadBindings }),
      ...(boundThreads === undefined ? {} : { boundThreads })
    })
  )
  return {
    invoke: async <T>(channel: string, ...args: unknown[]) => (await ipc.invoke(channel, ...args)) as T,
    sessions,
    fakes,
    fs,
    store,
    events,
    queued,
    channels: ipc.channels
  }
}

function data<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  return result.data
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function createdChat(state: IpcRig): Promise<ChatRecord> {
  return data(await state.invoke<CommandResult<ChatRecord>>('chats:create', { folder: REPO, agent: 'claude', role: 'orchestrator', title: 'Ship it' }))
}

describe('chat IPC registration', () => {
  it('registers exactly the chats channels, each once', () => {
    expect(ipcRig().channels()).toEqual(CHAT_CHANNELS)
  })

  it('passes a missing argument through for the handler to refuse', async () => {
    const state = ipcRig()

    for (const channel of CHAT_CHANNELS) {
      expect(await state.invoke<CommandResult<unknown>>(channel)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    }
  })
})

describe('chat IPC end to end with a fake adapter', () => {
  it('streams a chat created through IPC to the renderer channel and to the store, in order', async () => {
    const state = ipcRig()
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'item', item: { id: 't1', at: AT, kind: 'tool_call', name: 'Read', input: { path: 'a.ts' }, status: 'completed', resultSummary: null } })
        self.emit({ type: 'assistant_delta', itemId: 'a1', delta: 'Done' })
        self.emit({ type: 'item', item: { id: 'a1', at: AT, kind: 'assistant_text', text: 'Done.' } })
      }
    }
    const chat = await createdChat(state)

    const message = data(await state.invoke<CommandResult<ChatItem>>('chats:send', { folder: REPO, chatId: chat.id, text: 'Go' }))
    await settle()

    const stored = state.store.readTranscript(chat)?.items ?? []
    expect(stored.map((item) => item.id)).toEqual([message.id, 't1', 'a1'])
    expect(state.events.filter((event) => event.type === 'item').map((event) => event.item)).toEqual(stored)
    expect(state.events.map((event) => event.type)).toEqual(['item', 'turn', 'item', 'assistant_delta', 'item', 'turn'])
    const opened = data(await state.invoke<CommandResult<ChatOpenView>>('chats:open', { folder: REPO, chatId: chat.id }))
    expect(opened.items).toEqual(stored)
  })

  it('holds an approval until it is answered through IPC, and keeps it pending across reopening', async () => {
    const state = ipcRig()
    const answers: ApprovalDecision[] = []
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        answers.push(await self.ask('q1', 'file_edit', 'Edit'))
      }
    }
    const chat = await createdChat(state)
    const ref = { folder: REPO, chatId: chat.id }
    await state.invoke('chats:send', { ...ref, text: 'Edit a.ts' })
    await settle()

    const reopened = data(await state.invoke<CommandResult<ChatOpenView>>('chats:open', ref))
    expect(reopened.pending.map((request) => [request.requestId, request.category])).toEqual([['q1', 'file_edit']])
    expect(answers).toEqual([])

    expect(await state.invoke('chats:answerApproval', { ...ref, requestId: 'q1', decision: 'allow_chat' })).toEqual({ ok: true, data: null })
    await settle()
    expect(answers).toEqual(['allow_chat'])
  })
})

/** Everything the app wrote for chats: each file and its text. */
function stored(fs: MemoryChatFs): string {
  return JSON.stringify([...fs.files.entries()])
}

/** What an app that quit mid-turn left in a chat: a running call, a running worker thread and a request nobody answered. */
const STALE = [
  { id: 'c1', at: AT, kind: 'tool_call', name: 'Bash', input: { command: 'npm test' }, status: 'running', resultSummary: null },
  { id: 'th1', at: AT, kind: 'thread', parentItemId: 'spawn', label: 'Worker DM-12', state: 'running' },
  { id: 'item_q1', at: AT, kind: 'approval_request', requestId: 'q1', category: 'command', tool: 'Bash', summary: 'Use Bash' }
] as const

describe('chat IPC: reading a chat for a panel (chats:read)', () => {
  it('starts no agent and writes nothing to the store for a chat whose vendor starts on open, where chats:open does both', async () => {
    const state = ipcRig({ bindings: true })
    const chat = data(await state.invoke<CommandResult<ChatRecord>>('chats:create', { folder: REPO, agent: 'codex', role: 'orchestrator', title: 'Ship it' }))
    for (const item of STALE) {
      state.store.appendItem(chat, item)
    }
    const before = stored(state.fs)
    state.events.length = 0

    const read = data(await state.invoke<CommandResult<ChatOpenView>>('chats:read', { folder: REPO, chatId: chat.id }))

    expect(state.fakes.created).toEqual([])
    expect(stored(state.fs)).toBe(before)
    expect(state.events).toEqual([])
    expect(read.pending).toEqual([])
    expect(read.items.map((item) => item.kind)).toEqual(['tool_call', 'thread', 'approval_request', 'approval_decision'])

    await state.invoke('chats:open', { folder: REPO, chatId: chat.id })
    expect(state.fakes.created).toHaveLength(1)
    expect(stored(state.fs)).not.toBe(before)
  })

  it('shows what a live agent is waiting on, and the answer sent after reading reaches the agent', async () => {
    const state = ipcRig()
    const answers: ApprovalDecision[] = []
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'item', item: { id: 't1', at: AT, kind: 'tool_call', name: 'Read', input: {}, status: 'running', resultSummary: null } })
        answers.push(await self.ask('q1', 'file_edit', 'Edit'))
      }
    }
    const chat = await createdChat(state)
    const ref = { folder: REPO, chatId: chat.id }
    await state.invoke('chats:send', { ...ref, text: 'Edit a.ts' })
    await settle()

    const read = data(await state.invoke<CommandResult<ChatOpenView>>('chats:read', ref))

    expect(read.running).toBe(true)
    expect(read.pending.map((request) => [request.requestId, request.category])).toEqual([['q1', 'file_edit']])
    expect(read.items.find((item) => item.id === 't1')).toMatchObject({ status: 'running' })
    expect(await state.invoke('chats:answerApproval', { ...ref, requestId: 'q1', decision: 'allow_once' })).toEqual({ ok: true, data: null })
    await settle()
    expect(answers).toEqual(['allow_once'])
    expect(state.fakes.created).toHaveLength(1)
  })

  it('refuses a chat that does not exist and a folder that is not tracked', async () => {
    const state = ipcRig()

    expect(await state.invoke('chats:read', { folder: REPO, chatId: 'chat_gone' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(await state.invoke('chats:read', { folder: '/elsewhere', chatId: 'chat_gone' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })
})

describe('chat IPC: retrying a turn a sign-in cut short', () => {
  const SIGNED_IN = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' } as const

  it('re-sends the message once after sign-in, and is refused while the agent is signed out or has nothing to retry', async () => {
    const state = ipcRig()
    let turns = 0
    state.fakes.prepare = (adapter) => {
      adapter.turn = (self) => {
        turns += 1
        if (turns === 1) {
          self.emit({ type: 'item', item: { id: 'a1', at: AT, kind: 'auth_required', agent: 'claude', message: 'Not logged in · Please run /login' } })
        }
        return Promise.resolve()
      }
    }
    const chat = await createdChat(state)
    const ref = { folder: REPO, chatId: chat.id }
    const message = data(await state.invoke<CommandResult<ChatItem>>('chats:send', { ...ref, text: 'Go' }))
    await settle()

    expect(await state.invoke('chats:retryTurn', ref)).toMatchObject({ ok: false, error: { code: 'conflict' } })
    state.sessions.reconcileAuthStatus('claude', SIGNED_IN)
    expect(data(await state.invoke<CommandResult<ChatItem>>('chats:retryTurn', ref))).toEqual(message)
    await settle()
    expect(await state.invoke('chats:retryTurn', ref)).toMatchObject({ ok: false, error: { code: 'not_found' } })

    expect(state.fakes.created[0]?.sent).toEqual(['Go', 'Go'])
  })

  it('takes a chat and nothing else: another message or an id of one is refused, and nothing is sent', async () => {
    const state = ipcRig()
    const chat = await createdChat(state)
    const ref = { folder: REPO, chatId: chat.id }

    const answers = await Promise.all([{ ...ref, text: 'send this instead' }, { ...ref, messageId: 'm1' }, { folder: REPO }].map((payload) => state.invoke<CommandResult<unknown>>('chats:retryTurn', payload)))

    expect(answers.map((answer) => (answer.ok ? 'ok' : answer.error.code))).toEqual(Array(3).fill('invalid_input'))
    expect(state.fakes.created).toEqual([])
  })
})

describe('chat IPC: stop, model and listing', () => {
  it('stops a turn, changes the model and lists models through IPC', async () => {
    const state = ipcRig()
    state.fakes.prepare = (adapter) => {
      adapter.turn = (self) => self.untilStopped()
    }
    const chat = await createdChat(state)
    const ref = { folder: REPO, chatId: chat.id }
    await state.invoke('chats:send', { ...ref, text: 'Long job' })

    expect(await state.invoke('chats:stop', ref)).toEqual({ ok: true, data: null })
    expect(data(await state.invoke<CommandResult<ChatRecord>>('chats:setModel', { ...ref, model: 'small' })).model).toBe('small')
    expect(data(await state.invoke<CommandResult<unknown>>('chats:models', 'claude'))).toEqual([...MODELS, { id: '/bin/claude', label: 'claude' }])
    expect(data(await state.invoke<CommandResult<ChatRecord[]>>('chats:list', REPO)).map((listed) => listed.id)).toEqual([chat.id])

    const adapter = state.fakes.created[0]
    expect([adapter?.stops, adapter?.modelChanges]).toEqual([1, ['small']])
  })
})

describe('chat IPC: rename and delete', () => {
  it('renames a chat, then deletes it, ending its agent and removing it from the store', async () => {
    const state = ipcRig()
    state.fakes.prepare = (adapter) => {
      adapter.turn = (self) => self.untilStopped()
    }
    const chat = await createdChat(state)
    const ref = { folder: REPO, chatId: chat.id }
    await state.invoke('chats:send', { ...ref, text: 'Long job' })

    expect(data(await state.invoke<CommandResult<ChatRecord>>('chats:rename', { ...ref, title: 'Renamed' })).title).toBe('Renamed')
    expect(state.store.getChat({ folder: REPO, id: chat.id })?.title).toBe('Renamed')
    expect(await state.invoke('chats:delete', ref)).toEqual({ ok: true, data: null })

    expect(state.fakes.created[0]?.disposals).toBe(1)
    expect(state.store.getChat({ folder: REPO, id: chat.id })).toBeNull()
    expect(data(await state.invoke<CommandResult<ChatRecord[]>>('chats:list', REPO))).toEqual([])
    expect(await state.invoke('chats:delete', ref)).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })
})

describe('chat IPC: start an orchestrator', () => {
  it('queues the run and starts the chat with the kickoff as its first stored and pushed item', async () => {
    const state = ipcRig()

    const result = data(
      await state.invoke<CommandResult<StartOrchestratorResult>>('chats:startOrchestrator', { folder: REPO, epicId: EPIC_ID, agent: 'claude', model: 'big' })
    )
    await settle()

    expect(state.queued).toEqual([EPIC_ID])
    expect(result.problem).toBeNull()
    const chat = result.chat as ChatRecord
    expect(chat).toMatchObject({ role: 'orchestrator', allowSave: false, runId: 'rn_2', title: 'Orchestrator · Agent chats', model: 'big' })
    const stored = state.store.readTranscript(chat)?.items ?? []
    expect(stored[0]).toMatchObject({ kind: 'user_message' })
    expect(state.events.flatMap((event) => (event.type === 'item' ? [event.item] : []))[0]).toEqual(stored[0])
    expect(state.fakes.created[0]?.started[0]).toMatchObject({ role: 'orchestrator', allowSave: false })
  })

  it('refuses an executable path, a role, an Allow save choice or another folder in the request', async () => {
    const state = ipcRig()
    const request = { folder: REPO, epicId: EPIC_ID, agent: 'claude' }

    const answers = await Promise.all(
      [
        { ...request, executablePath: '/bin/evil' },
        { ...request, role: 'planner' },
        { ...request, allowSave: true },
        { ...request, epicId: '../ep' },
        { ...request, agent: 'gemini' },
        { folder: '/elsewhere', epicId: EPIC_ID, agent: 'claude' }
      ].map((payload) => state.invoke<CommandResult<unknown>>('chats:startOrchestrator', payload))
    )

    expect(answers.map((answer) => (answer.ok ? 'ok' : answer.error.code))).toEqual([...Array(5).fill('invalid_input'), 'unauthorized'])
    expect(state.queued).toEqual([])
    expect(state.fakes.created).toEqual([])
  })
})

describe('chat IPC behind the sender guard', () => {
  it('answers no chats channel for a sender that is not the app page, and never reaches a handler', async () => {
    const listeners = new Map<string, Listener>()
    const reached = (): never => {
      throw new Error('a handler was reached')
    }
    const handlers = createChatHandlers({ registry: { resolve: reached }, sessions: {} as SessionManager, runs: {} as OrchestratorRuns })
    registerChatIpc(guardIpc({ handle: (channel, listener) => void listeners.set(channel, listener) }, { appUrl: 'http://localhost:5173' }), handlers)
    const stranger = { senderFrame: { url: 'https://example.com/', parent: null, detached: false, isDestroyed: () => false } } as unknown as IpcMainInvokeEvent

    const answers = await Promise.all([...listeners.values()].map((listener) => listener(stranger, { folder: REPO, chatId: 'chat_1', text: 'x' })))

    expect([...listeners.keys()].sort()).toEqual(CHAT_CHANNELS)
    expect(answers.map((answer) => (answer as CommandResult<unknown>).ok === false && (answer as { error: { code: string } }).error.code)).toEqual(Array(CHAT_CHANNELS.length).fill('unauthorized'))
  })
})

function fakeWindow(destroyed = false): ChatWindow & { sent: unknown[][] } {
  const sent: unknown[][] = []
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        sent.push([channel, ...args])
      }
    }
  }
}

describe('chat push channel', () => {
  it('sends each event to every open window on the chats event channel', () => {
    const open = fakeWindow()
    const closed = fakeWindow(true)
    const event: ChatPushEvent = { type: 'turn', chatId: 'chat_1', running: true }

    createChatPush(() => [open, closed])(event)

    expect(open.sent).toEqual([[CHAT_EVENT_CHANNEL, event]])
    expect(closed.sent).toEqual([])
  })

  it('tells every window when a chat is renamed or deleted in one of them, so each refreshes its list', async () => {
    const first = fakeWindow()
    const second = fakeWindow()
    const state = ipcRig({ windows: [first, second] })
    const chat = await createdChat(state)
    const changed: ChatPushEvent = { type: 'chats_changed', folder: REPO, chatId: chat.id }

    data(await state.invoke<CommandResult<ChatRecord>>('chats:rename', { folder: REPO, chatId: chat.id, title: 'Ship it now' }))
    data(await state.invoke<CommandResult<null>>('chats:delete', { folder: REPO, chatId: chat.id }))

    for (const window of [first, second]) {
      expect(window.sent.filter(([, event]) => (event as ChatPushEvent).type === 'chats_changed')).toEqual(Array(3).fill([CHAT_EVENT_CHANNEL, changed]))
    }
  })
})

describe('chat preload bridge', () => {
  const preload = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf8')

  it('invokes exactly the chats channels main registers', () => {
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'(chats:[A-Za-z]+)'/g)].map((match) => match[1]).sort()

    expect(invoked).toEqual(CHAT_CHANNELS)
  })

  it('listens for pushed chat events on the shared channel name', () => {
    expect(preload).toMatch(/ipcRenderer\.on\(CHAT_EVENT_CHANNEL, /)
    expect(preload).toMatch(/ipcRenderer\.removeListener\(CHAT_EVENT_CHANNEL, /)
  })
})

describe('chat IPC: thread bindings end to end', () => {
  const BASE = { at: AT, kind: 'tool_call', status: 'completed', resultSummary: null } as const

  it('answers the bindings of the calls and subagent threads a chat stored, with the ticket key resolved', async () => {
    const state = ipcRig({ bindings: true })
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'item', item: { ...BASE, id: 'take', name: 'mcp__darkmechanicus__takeover_run', input: { runId: RUN_ID } } })
        self.emit({ type: 'item', item: { ...BASE, id: 'beat', threadId: THREAD_A, name: 'mcp__darkmechanicus__heartbeat_attempt', input: { attemptId: ATTEMPT_A } } })
      }
    }
    const chat = await createdChat(state)
    const ref = { folder: REPO, chatId: chat.id }
    await state.invoke('chats:send', { ...ref, text: 'Go' })
    await settle()

    const bindings = data(await state.invoke<CommandResult<ThreadBinding[]>>('chats:threadBindings', ref))

    expect(bindings).toEqual([
      { threadId: null, role: 'orchestrator', kind: 'run', runId: RUN_ID, epicId: EPIC_ID },
      { threadId: THREAD_A, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A, runId: RUN_ID, epicId: EPIC_ID, ticketId: 'tk_1', ticketKey: 'DM-12' }
    ])
    expect(await state.invoke('chats:threadBindings', { ...ref, chatId: 'chat_unknown' })).toEqual({ ok: true, data: [] })
  })
})

describe('chat IPC: bound threads end to end', () => {
  const BASE = { at: AT, kind: 'tool_call', status: 'completed', resultSummary: null } as const

  it('answers which chat and thread are bound to an attempt and to a run, once the chat stored the calls that bind them', async () => {
    const state = ipcRig({ bindings: true })
    state.fakes.prepare = (adapter) => {
      adapter.turn = async (self) => {
        self.emit({ type: 'item', item: { ...BASE, id: 'take', name: 'mcp__darkmechanicus__takeover_run', input: { runId: RUN_ID } } })
        self.emit({ type: 'item', item: { ...BASE, id: 'beat', threadId: THREAD_A, name: 'mcp__darkmechanicus__heartbeat_attempt', input: { attemptId: ATTEMPT_A } } })
      }
    }
    const chat = await createdChat(state)
    await state.invoke('chats:send', { folder: REPO, chatId: chat.id, text: 'Go' })
    await settle()

    const ofAttempt = data(await state.invoke<CommandResult<BoundThread[]>>('chats:boundThreads', { folder: REPO, attemptId: ATTEMPT_A }))
    const ofRun = data(await state.invoke<CommandResult<BoundThread[]>>('chats:boundThreads', { folder: REPO, runId: RUN_ID }))

    expect(ofAttempt).toEqual([{ folder: REPO, chatId: chat.id, threadId: THREAD_A, role: 'worker' }])
    expect(ofRun).toEqual([{ folder: REPO, chatId: chat.id, threadId: null, role: 'orchestrator' }])
    expect(await state.invoke('chats:boundThreads', { folder: REPO, attemptId: ATTEMPT_B })).toEqual({ ok: true, data: [] })
  })

  it('refuses a folder that is not tracked and a request that names neither an attempt nor a run', async () => {
    const state = ipcRig({ bindings: true })

    const answers = [
      await state.invoke<CommandResult<unknown>>('chats:boundThreads', { folder: '/elsewhere', attemptId: ATTEMPT_A }),
      await state.invoke<CommandResult<unknown>>('chats:boundThreads', { folder: REPO })
    ]

    expect(answers.map((answer) => (answer.ok ? 'ok' : answer.error.code))).toEqual(['unauthorized', 'invalid_input'])
  })
})
