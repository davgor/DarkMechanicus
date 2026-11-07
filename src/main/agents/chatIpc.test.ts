import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import {
  CHAT_EVENT_CHANNEL,
  type BoundThread,
  type ChatPushEvent,
  type ChatReadView,
  type KickBackKanbanCardResult,
  type StartKanbanCardResult,
  type StartOrchestratorResult,
  type StartTransferChatResult
} from '../../shared/agents/chatApi'
import type { CommandResult } from '../../shared/desktop/api'
import type { KanbanCardView } from '../../shared/domain/kanban'
import type { TransferView } from '../../shared/domain/transfer'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import { transferKickoff } from '../../mcp/transferKickoff'
import { AT, connectedAgents, memoryChatFs, memoryChatStore, REPO, storeItems, type MemoryChatFs } from './__mocks__/chatFixtures'
import { ATTEMPT_A, ATTEMPT_B, RUN_ID, THREAD_A } from './__mocks__/orchestratorChat'
import { createActivityBindings, type ActivityBinding } from './activityBindings'
import { createChatHandlers } from './chatHandlers'
import { createChatPush, registerChatIpc, type ChatWindow } from './chatIpc'
import { createChatRecords, type ChatRecords } from './chatRecords'
import { listBoundThreads } from './boundThreads'
import { findBoundTerminal, type GrantBindingReads } from './grantBindings'
import type { BoundTerminalLookup } from './chatHandlers'
import type { ActivityEntry } from '../../shared/domain/activity'
import type { ChatStore } from './chatStore'
import { guardIpc } from '../ipcGuard'
import type { OrchestratorRuns } from './orchestratorStart'
import type { TransferReads } from './transferStart'
import type { KanbanCards } from '../kanban/startKanbanCard'
import type { TerminalSessions } from '../terminals/terminalSessions'

type Listener = Parameters<IpcMain['handle']>[1]

const EVENT = {} as IpcMainInvokeEvent

const CHAT_CHANNELS = [
  'chats:boundTerminal',
  'chats:boundThreads',
  'chats:create',
  'chats:delete',
  'chats:findTransferChat',
  'chats:kickBackKanbanCard',
  'chats:list',
  'chats:read',
  'chats:rename',
  'chats:startKanbanCard',
  'chats:startOrchestrator',
  'chats:startTransferChat',
  'chats:submitPrompt',
  'chats:transferPrompt'
]

/** The channels of chats run by protocol adapters, gone now that every chat runs in its terminal. */
const REMOVED_CHANNELS = ['chats:answerApproval', 'chats:models', 'chats:open', 'chats:retryTurn', 'chats:send', 'chats:setModel', 'chats:stop', 'chats:threadBindings']

const BINDINGS_FILE = '/state/agents/activity-bindings.jsonl'
const EPIC_ID = 'ep_01m418epbg8qkqa2e2krvdkqk5'
const EPIC = { id: EPIC_ID, title: 'Agent chats', branch: { repository: null, name: 'epic/agent-chats', startCommit: null } } as EpicDetailView
const RUN = { id: 'rn_2', number: 2, epicId: EPIC_ID, state: 'queued' } as RunView
/** A transfer the person authorized, of `EPIC`. */
const TRANSFERS: TransferReads = {
  getEpic: () => Promise.resolve(EPIC),
  getTransfer: (_folder, epicId) => Promise.resolve({ epicId, status: 'queued', packet: null, recorded: [], lastMismatches: [], next: [] } as TransferView)
}

const CARD_ID = 'kc_01m6a1p7qaxttbw9f5927qk2dx'

/** The card the fake Kanban side answers with: what the kickoff and the kick-back message read of it. */
function cardView(cardId: string, lane: KanbanCardView['lane']): KanbanCardView {
  return { id: cardId, key: 'DM-42', title: 'Fix the flaky upload test', lane, playPending: true } as KanbanCardView
}

/** A Kanban side that plays and kicks back any card, recording "<call> <card id>" in `calls`. */
function recordingKanban(calls: string[]): KanbanCards {
  return {
    play: (_folder, cardId) => (calls.push(`play ${cardId}`), Promise.resolve(cardView(cardId, 'backlog'))),
    kickBack: (_folder, input) => (calls.push(`kickBack ${input.cardId}`), Promise.resolve(cardView(input.cardId, 'in_progress'))),
    branch: () => Promise.resolve('feature/cards')
  }
}

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
  fs: MemoryChatFs
  store: ChatStore
  /** The epics a run was queued for, in order. */
  queued: string[]
  /** The terminals started, with the kickoff each was given, in order. */
  terminalStarts: { chatId: string; kickoff: string }[]
  /** The text pasted into each chat's terminal, in order. */
  terminalPastes: { chatId: string; text: string }[]
  /** What the Kanban side was asked for, as "<call> <card id>". */
  kanbanCalls: string[]
  channels(): string[]
}

/** Terminals that write down each start with the kickoff it was given and each paste, and answer that the PTY runs. */
function recordingTerminals(starts: IpcRig['terminalStarts'], pastes: IpcRig['terminalPastes']): Pick<TerminalSessions, 'start' | 'paste'> {
  return {
    start: async (ref, options) => (starts.push({ chatId: ref.id, kickoff: options.kickoff }), { state: 'running', pid: 4242 }),
    paste: async (ref, text) => (pastes.push({ chatId: ref.id, text }), { state: 'running', pid: 4242 })
  }
}

/** A run queue that writes down the epics it queued a run for. */
function queueingRuns(queued: string[]): OrchestratorRuns {
  return { getEpic: () => Promise.resolve(EPIC), queueRun: (_folder, epicId) => (queued.push(epicId), Promise.resolve(RUN)) }
}

/** The real handlers and chat records behind fake IPC, with an in-memory store and the bindings old chats stored in `fs`. */
function ipcRig(options: { bindings?: boolean; windows?: readonly ChatWindow[]; boundTerminal?: (store: ChatStore) => BoundTerminalLookup } = {}): IpcRig {
  const ipc = createFakeIpcMain()
  const fs = memoryChatFs()
  const store = memoryChatStore(fs)
  const activity = options.bindings === true ? createActivityBindings({ file: BINDINGS_FILE, fs }) : undefined
  const queued: string[] = []
  const terminalStarts: IpcRig['terminalStarts'] = []
  const terminalPastes: IpcRig['terminalPastes'] = []
  const kanbanCalls: string[] = []
  const boundThreads = activity === undefined ? undefined : (folder: string, target: Parameters<typeof listBoundThreads>[2]) => listBoundThreads(activity, folder, target)
  registerChatIpc(
    ipc,
    createChatHandlers({
      registry: { resolve: (path) => (path === REPO ? REPO : null) },
      agents: { get: connectedAgents() },
      chats: createChatRecords({ store, agentFor: connectedAgents(), ...(activity === undefined ? {} : { activity }) }),
      terminals: recordingTerminals(terminalStarts, terminalPastes),
      runs: queueingRuns(queued),
      transfers: TRANSFERS,
      kanban: recordingKanban(kanbanCalls),
      ...(options.windows === undefined ? {} : { push: createChatPush(() => options.windows ?? []) }),
      ...(boundThreads === undefined ? {} : { boundThreads }),
      ...(options.boundTerminal === undefined ? {} : { boundTerminal: options.boundTerminal(store) })
    })
  )
  return {
    invoke: async <T>(channel: string, ...args: unknown[]) => (await ipc.invoke(channel, ...args)) as T,
    fs,
    store,
    queued,
    terminalStarts,
    terminalPastes,
    kanbanCalls,
    channels: ipc.channels
  }
}

function data<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  return result.data
}

async function createdChat(state: IpcRig): Promise<ChatRecord> {
  return data(await state.invoke<CommandResult<ChatRecord>>('chats:create', { folder: REPO, agent: 'claude', role: 'orchestrator', title: 'Ship it' }))
}

describe('chat IPC registration', () => {
  it('registers exactly the chats channels, each once, and none of the removed ones', () => {
    const channels = ipcRig().channels()

    expect(channels).toEqual(CHAT_CHANNELS)
    expect(channels.filter((channel) => REMOVED_CHANNELS.includes(channel))).toEqual([])
  })

  it('passes a missing argument through for the handler to refuse', async () => {
    const state = ipcRig()

    for (const channel of CHAT_CHANNELS) {
      expect(await state.invoke<CommandResult<unknown>>(channel)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    }
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

describe('chat IPC: reading a chat stored before terminals (chats:read)', () => {
  it('reads the stored transcript with what no agent can finish shown ended, and writes nothing', async () => {
    const state = ipcRig({ bindings: true })
    const chat = data(await state.invoke<CommandResult<ChatRecord>>('chats:create', { folder: REPO, agent: 'codex', role: 'orchestrator', title: 'Ship it' }))
    storeItems(state.fs, chat, STALE)
    const before = stored(state.fs)

    const read = data(await state.invoke<CommandResult<ChatReadView>>('chats:read', { folder: REPO, chatId: chat.id }))

    expect(stored(state.fs)).toBe(before)
    expect(read.chat.id).toBe(chat.id)
    expect(read.items.map((item) => item.kind)).toEqual(['tool_call', 'thread', 'approval_request', 'approval_decision'])
    expect(read.items[0]).toMatchObject({ status: 'cancelled' })
    expect(read.items[1]).toMatchObject({ state: 'failed' })
  })

  it('refuses a chat that does not exist and a folder that is not tracked', async () => {
    const state = ipcRig()

    expect(await state.invoke('chats:read', { folder: REPO, chatId: 'chat_gone' })).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(await state.invoke('chats:read', { folder: '/elsewhere', chatId: 'chat_gone' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })
})

describe('chat IPC: rename and delete', () => {
  it('renames a chat, then deletes it with its transcript, removing it from the store', async () => {
    const state = ipcRig()
    const chat = await createdChat(state)
    const ref = { folder: REPO, chatId: chat.id }
    storeItems(state.fs, chat, [{ id: 'm1', at: AT, kind: 'user_message', text: 'Go' }])

    expect(data(await state.invoke<CommandResult<ChatRecord>>('chats:rename', { ...ref, title: 'Renamed' })).title).toBe('Renamed')
    expect(state.store.getChat({ folder: REPO, id: chat.id })?.title).toBe('Renamed')
    expect(data(await state.invoke<CommandResult<ChatRecord[]>>('chats:list', REPO)).map((listed) => listed.id)).toEqual([chat.id])
    expect(await state.invoke('chats:delete', ref)).toEqual({ ok: true, data: null })

    expect(state.store.getChat({ folder: REPO, id: chat.id })).toBeNull()
    expect(state.store.readTranscript({ folder: REPO, id: chat.id })).toBeNull()
    expect(data(await state.invoke<CommandResult<ChatRecord[]>>('chats:list', REPO))).toEqual([])
    expect(await state.invoke('chats:delete', ref)).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })
})

describe('chat IPC: explicit prompt submission', () => {
  it('passes the whole prompt unchanged to the terminal, names once and pushes the persisted title', async () => {
    const sent: unknown[][] = []
    const window: ChatWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } }
    const state = ipcRig({ windows: [window] })
    const chat = data(await state.invoke<CommandResult<ChatRecord>>('chats:create', { folder: REPO, agent: 'claude', role: 'planner' }))
    const ref = { folder: REPO, chatId: chat.id }
    const text = 'Why does\n the build fail?'
    expect(await state.invoke('chats:submitPrompt', { ...ref, text })).toEqual({ ok: true, data: { problem: null } })
    expect(state.terminalPastes).toEqual([{ chatId: chat.id, text }])
    expect(state.store.getChat(chat)?.title).toBe('Why does the build fail?')
    expect(sent.at(-1)).toEqual([CHAT_EVENT_CHANNEL, { type: 'chats_changed', folder: REPO, chatId: chat.id }])
    await state.invoke('chats:submitPrompt', { ...ref, text: 'A second question' })
    expect(state.store.getChat(chat)?.title).toBe('Why does the build fail?')
    expect(state.terminalPastes).toHaveLength(2)
  })

  it('rejects blanks, extra fields, missing chats and unauthorized folders before pasting', async () => {
    const state = ipcRig()
    const chat = data(await state.invoke<CommandResult<ChatRecord>>('chats:create', { folder: REPO, agent: 'claude', role: 'planner' }))
    const ref = { folder: REPO, chatId: chat.id }
    for (const request of [{ ...ref, text: ' \n ' }, { ...ref, text: 'Hi', source: 'assistant' }, { ...ref, chatId: 'missing', text: 'Hi' }, { ...ref, folder: '/untracked', text: 'Hi' }]) {
      expect(await state.invoke('chats:submitPrompt', request)).toMatchObject({ ok: false })
    }
    expect(state.terminalPastes).toEqual([])
    expect(state.store.getChat(chat)?.title).toBe('New chat')
  })
})

describe('chat IPC: start an orchestrator', () => {
  it('queues the run, creates the chat and starts its terminal with the kickoff, storing no transcript item', async () => {
    const state = ipcRig()

    const result = data(
      await state.invoke<CommandResult<StartOrchestratorResult>>('chats:startOrchestrator', { folder: REPO, epicId: EPIC_ID, agent: 'claude', model: 'big' })
    )

    expect(state.queued).toEqual([EPIC_ID])
    expect(result.problem).toBeNull()
    const chat = result.chat as ChatRecord
    expect(chat).toMatchObject({ role: 'orchestrator', allowSave: false, runId: 'rn_2', title: 'Orchestrator · Agent chats', model: 'big' })
    expect(state.terminalStarts).toEqual([{ chatId: chat.id, kickoff: expect.stringContaining('Run: rn_2') }])
    expect(state.terminalStarts[0]?.kickoff).toContain('Branch: epic/agent-chats')
    expect(state.store.readTranscript(chat)?.items ?? []).toEqual([])
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
    expect(state.terminalStarts).toEqual([])
  })
})

describe('chat IPC: start a transfer chat', () => {
  it('starts an orchestrator chat that records the epic and starts its terminal with the transfer kickoff, storing no transcript item', async () => {
    const state = ipcRig()
    const kickoff = transferKickoff({ epicId: EPIC_ID, epicTitle: 'Agent chats' })

    const result = data(
      await state.invoke<CommandResult<StartTransferChatResult>>('chats:startTransferChat', { folder: REPO, epicId: EPIC_ID, agent: 'claude', model: 'big' })
    )

    expect(result.problem).toBeNull()
    const chat = result.chat as ChatRecord
    expect(chat).toMatchObject({ role: 'orchestrator', allowSave: false, transferEpicId: EPIC_ID, title: 'Linear transfer · Agent chats', model: 'big' })
    expect(chat).not.toHaveProperty('runId')
    expect(state.terminalStarts).toEqual([{ chatId: chat.id, kickoff }])
    expect(state.store.readTranscript(chat)?.items ?? []).toEqual([])
    expect(state.queued).toEqual([])

    const found = data(await state.invoke<CommandResult<ChatRecord | null>>('chats:findTransferChat', { folder: REPO, epicId: EPIC_ID }))
    expect(found?.id).toBe(chat.id)
    expect(data(await state.invoke<CommandResult<string>>('chats:transferPrompt', { folder: REPO, epicId: EPIC_ID }))).toBe(kickoff)
  })

  it('refuses an executable path, a role, a recorded epic or run, or another folder in the request', async () => {
    const state = ipcRig()
    const request = { folder: REPO, epicId: EPIC_ID, agent: 'claude' }

    const answers = await Promise.all(
      [
        { ...request, executablePath: '/bin/evil' },
        { ...request, role: 'planner' },
        { ...request, transferEpicId: EPIC_ID },
        { ...request, runId: RUN_ID },
        { folder: '/elsewhere', epicId: EPIC_ID, agent: 'claude' }
      ].map((payload) => state.invoke<CommandResult<unknown>>('chats:startTransferChat', payload))
    )

    expect(answers.map((answer) => (answer.ok ? 'ok' : answer.error.code))).toEqual([...Array(4).fill('invalid_input'), 'unauthorized'])
    expect(state.terminalStarts).toEqual([])
    expect(state.store.listChats(REPO)).toEqual([])
  })
})

describe('chat IPC: play a Kanban card and kick it back', () => {
  it('plays the card, creates its orchestrator chat and starts its terminal with the card kickoff, storing no transcript item', async () => {
    const state = ipcRig()

    const result = data(await state.invoke<CommandResult<StartKanbanCardResult>>('chats:startKanbanCard', { folder: REPO, cardId: CARD_ID, agent: 'claude', model: 'big' }))

    expect(state.kanbanCalls).toEqual([`play ${CARD_ID}`])
    expect(result.problem).toBeNull()
    const chat = result.chat as ChatRecord
    expect(chat).toMatchObject({ role: 'orchestrator', allowSave: false, cardId: CARD_ID, title: 'Kanban · DM-42 Fix the flaky upload test', model: 'big' })
    expect(state.terminalStarts).toEqual([{ chatId: chat.id, kickoff: expect.stringContaining(`claim_kanban_card with cardId ${CARD_ID}`) }])
    expect(state.terminalStarts[0]?.kickoff).toContain('Branch: feature/cards')
    expect(state.store.readTranscript(chat)?.items ?? []).toEqual([])
  })

  it("kicks the card back and pastes the comment into the terminal of the card's chat, starting nothing new", async () => {
    const state = ipcRig()
    const started = data(await state.invoke<CommandResult<StartKanbanCardResult>>('chats:startKanbanCard', { folder: REPO, cardId: CARD_ID, agent: 'claude' }))

    const result = data(await state.invoke<CommandResult<KickBackKanbanCardResult>>('chats:kickBackKanbanCard', { folder: REPO, cardId: CARD_ID, comment: 'Still flaky.' }))

    expect(state.kanbanCalls).toEqual([`play ${CARD_ID}`, `kickBack ${CARD_ID}`])
    expect(result).toMatchObject({ chatId: started.chat?.id, problem: null, card: { lane: 'in_progress' } })
    expect(state.terminalPastes).toEqual([
      { chatId: started.chat?.id, text: `DM-42 was kicked back by a person: Still flaky. Claim it again with claim_kanban_card (cardId ${CARD_ID}) and address the comment.` }
    ])
    expect(state.terminalStarts).toHaveLength(1)
  })

})

describe('chat IPC: Kanban requests a renderer cannot shape', () => {
  it('refuses a card id that is not kc_, an extra field, a blank comment or an untracked folder, and plays nothing', async () => {
    const state = ipcRig()
    const start = { folder: REPO, cardId: CARD_ID, agent: 'claude' }
    const kickBack = { folder: REPO, cardId: CARD_ID, comment: 'Not yet.' }

    const answers = await Promise.all([
      ...[
        { ...start, cardId: 'ka_01m6aspj4vxjq38vcbgxpg73jn' },
        { ...start, cardId: `${CARD_ID}.gUJvQxJEDk0emfDt1HQ9H3tYGOmsf4IX` },
        { ...start, cardId: 'tk_01m6a1p7qaxttbw9f5927qk2dx' },
        { ...start, role: 'planner' },
        { ...start, allowSave: true },
        { ...start, agent: 'gemini' },
        { ...start, folder: '/elsewhere' }
      ].map((payload) => state.invoke<CommandResult<unknown>>('chats:startKanbanCard', payload)),
      ...[
        { ...kickBack, cardId: 'ep_01m418epbg8qkqa2e2krvdkqk5' },
        { ...kickBack, comment: '' },
        { ...kickBack, chatId: 'chat_1' },
        { ...kickBack, folder: '/elsewhere' }
      ].map((payload) => state.invoke<CommandResult<unknown>>('chats:kickBackKanbanCard', payload))
    ])

    expect(answers.map((answer) => (answer.ok ? 'ok' : answer.error.code))).toEqual([...Array(6).fill('invalid_input'), 'unauthorized', ...Array(3).fill('invalid_input'), 'unauthorized'])
    expect(state.kanbanCalls).toEqual([])
    expect(state.terminalStarts).toEqual([])
    expect(state.terminalPastes).toEqual([])
    expect(state.store.listChats(REPO)).toEqual([])
  })
})

describe('chat IPC: agents named by id', () => {
  it('refuses chats:create for an agent id that is not connected with not_found, and creates no chat', async () => {
    const state = ipcRig()

    const answer = await state.invoke<CommandResult<unknown>>('chats:create', { folder: REPO, agent: 'cu_01m65kwqqeyajbj5bnq81gngrb', role: 'planner' })

    expect(answer).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(state.store.listChats(REPO)).toEqual([])
  })

  it('refuses a malformed agent id with invalid_input before anything runs', async () => {
    const state = ipcRig()

    const answers = await Promise.all(
      ['cu_../../../etc', 'CU_01M65KWQQEYAJBJ5BNQ81GNGRB', ''].map((agent) => state.invoke<CommandResult<unknown>>('chats:create', { folder: REPO, agent, role: 'planner' }))
    )

    expect(answers.map((answer) => (answer.ok ? 'ok' : answer.error.code))).toEqual(['invalid_input', 'invalid_input', 'invalid_input'])
    expect(state.store.listChats(REPO)).toEqual([])
  })
})

describe('chat IPC behind the sender guard', () => {
  it('answers no chats channel for a sender that is not the app page, and never reaches a handler', async () => {
    const listeners = new Map<string, Listener>()
    const reached = (): never => {
      throw new Error('a handler was reached')
    }
    const handlers = createChatHandlers({
      registry: { resolve: reached },
      agents: { get: reached },
      chats: {} as ChatRecords,
      terminals: {} as TerminalSessions,
      runs: {} as OrchestratorRuns,
      transfers: {} as TransferReads,
      kanban: {} as KanbanCards
    })
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
    const event: ChatPushEvent = { type: 'chats_changed', folder: REPO, chatId: 'chat_1' }

    createChatPush(() => [open, closed])(event)

    expect(open.sent).toEqual([[CHAT_EVENT_CHANNEL, event]])
    expect(closed.sent).toEqual([])
  })

  it('tells every window when a chat is created, renamed or deleted in one of them, so each refreshes its list', async () => {
    const first = fakeWindow()
    const second = fakeWindow()
    const state = ipcRig({ windows: [first, second] })
    const chat = await createdChat(state)
    const changed: ChatPushEvent = { type: 'chats_changed', folder: REPO, chatId: chat.id }

    data(await state.invoke<CommandResult<ChatRecord>>('chats:rename', { folder: REPO, chatId: chat.id, title: 'Ship it now' }))
    data(await state.invoke<CommandResult<null>>('chats:delete', { folder: REPO, chatId: chat.id }))

    for (const window of [first, second]) {
      expect(window.sent).toEqual(Array(3).fill([CHAT_EVENT_CHANNEL, changed]))
    }
  })
})

describe('chat preload bridge', () => {
  const preload = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf8')

  it('invokes exactly the chats channels main registers, and none of the removed ones', () => {
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'(chats:[A-Za-z]+)'/g)].map((match) => match[1]).sort()

    expect(invoked).toEqual(CHAT_CHANNELS)
    expect(REMOVED_CHANNELS.filter((channel) => preload.includes(`'${channel}'`))).toEqual([])
  })

  it('listens for pushed chat events on the shared channel name', () => {
    expect(preload).toMatch(/ipcRenderer\.on\(CHAT_EVENT_CHANNEL, /)
    expect(preload).toMatch(/ipcRenderer\.removeListener\(CHAT_EVENT_CHANNEL, /)
  })
})

describe('chat IPC: threads of old chats bound to an attempt or a run', () => {
  it('answers the chat and thread an old chat stored bindings for, by attempt and by run', async () => {
    const state = ipcRig({ bindings: true })
    const chat = await createdChat(state)
    const stored: ActivityBinding[] = [
      { chatId: chat.id, threadId: null, folder: REPO, role: 'orchestrator', kind: 'run', runId: RUN_ID },
      { chatId: chat.id, threadId: THREAD_A, folder: REPO, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A }
    ]
    state.fs.files.set(BINDINGS_FILE, stored.map((binding) => `${JSON.stringify(binding)}\n`).join(''))

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

describe('chat IPC: the terminal bound by grant', () => {
  const CLAIM: ActivityEntry = {
    kind: 'claim',
    id: 'event:1',
    at: AT,
    sessionId: 'ss_cli',
    attemptId: ATTEMPT_A,
    ticketId: 'tk_1',
    number: 1,
    worker: { label: 'impl', modelId: null, hostId: null, effort: null, rationale: null }
  }
  const reads: GrantBindingReads = {
    attemptTimeline: async (_folder, attemptId) => ({
      attemptId,
      runId: RUN_ID,
      ticketId: 'tk_1',
      state: 'running',
      isLive: true,
      cursor: 1,
      entries: [CLAIM],
      sessions: [{ id: 'ss_cli', role: 'orchestrator', label: 'dm', grantId: 'gr_2' }]
    }),
    runTimeline: async (_folder, runId) => ({ runId, epicId: EPIC_ID, state: 'running', isLive: true, cursor: 0, groups: [] })
  }
  const lookup = (store: ChatStore): BoundTerminalLookup => (folder, target) => findBoundTerminal({ reads, store }, folder, target)

  it('answers the chat whose stored grants include the grant the claiming session presented, and null for a run no chat started', async () => {
    const state = ipcRig({ boundTerminal: lookup })
    const chat = await createdChat(state)
    state.store.updateChat(chat, { grantIds: ['gr_1', 'gr_2'] })
    // A newer chat of the same folder, on another grant: listed first, and not the one bound.
    const newer = await createdChat(state)
    state.store.updateChat(newer, { grantIds: ['gr_3'] })

    expect(await state.invoke('chats:boundTerminal', { folder: REPO, attemptId: ATTEMPT_A })).toEqual({ ok: true, data: chat.id })
    expect(await state.invoke('chats:boundTerminal', { folder: REPO, runId: RUN_ID })).toEqual({ ok: true, data: null })
  })

  it('answers null when the app wired no lookup, and refuses an untracked folder, a claim token and a request naming neither', async () => {
    const state = ipcRig({ boundTerminal: lookup })
    const unwired = ipcRig()

    const answers = [
      await state.invoke<CommandResult<unknown>>('chats:boundTerminal', { folder: '/elsewhere', attemptId: ATTEMPT_A }),
      await state.invoke<CommandResult<unknown>>('chats:boundTerminal', { folder: REPO, attemptId: `${ATTEMPT_A}.secret` }),
      await state.invoke<CommandResult<unknown>>('chats:boundTerminal', { folder: REPO })
    ]

    expect(answers.map((answer) => (answer.ok ? 'ok' : answer.error.code))).toEqual(['unauthorized', 'invalid_input', 'invalid_input'])
    expect(await unwired.invoke('chats:boundTerminal', { folder: REPO, attemptId: ATTEMPT_A })).toEqual({ ok: true, data: null })
  })
})
