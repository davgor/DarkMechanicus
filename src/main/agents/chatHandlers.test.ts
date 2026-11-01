import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { TransferStatus, TransferView } from '../../shared/domain/transfer'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { CommandResult } from '../../shared/desktop/api'
import { transferKickoff } from '../../mcp/transferKickoff'
import { AT, connectedAgents, REPO } from './__mocks__/chatFixtures'
import { createChatHandlers, type ChatHandlers } from './chatHandlers'
import type { ChatRecords } from './chatRecords'
import type { OrchestratorRuns } from './orchestratorStart'
import type { TransferReads } from './transferStart'
import type { KanbanCardView } from '../../shared/domain/kanban'
import type { KanbanCards } from '../kanban/startKanbanCard'
import type { TerminalSessions } from '../terminals/terminalSessions'

const CHAT: ChatRecord = {
  id: 'chat_1',
  folder: REPO,
  agent: 'claude',
  model: null,
  role: 'planner',
  allowSave: true,
  title: 'New chat',
  createdAt: AT,
  updatedAt: AT,
  sessionId: null
}

/** Another spelling of the tracked folder, which the registry resolves to REPO. */
const SPELLING = `${REPO}${sep}`

/** Claude, Codex and Cursor are connected; no custom agent is. */
const AGENTS = { get: connectedAgents() }
const UNKNOWN_AGENT = 'cu_01m65kwqqeyajbj5bnq81gngrb'

/** Chat records that record [method, ...args] and answer with fixed values. */
function recordingChats(): { chats: ChatRecords; calls: unknown[][] } {
  const calls: unknown[][] = []
  const chats: ChatRecords = {
    listChats: (...args) => (calls.push(['listChats', ...args]), [CHAT]),
    createChat: (...args) => (calls.push(['createChat', ...args]), CHAT),
    renameChat: (...args) => (calls.push(['renameChat', ...args]), { ...CHAT, title: 'Fix the build' }),
    deleteChat: async (...args) => {
      calls.push(['deleteChat', ...args])
    },
    readChat: (...args) => (calls.push(['readChat', ...args]), { chat: CHAT, items: [] }),
    agentName: (id) => id
  }
  return { chats, calls }
}

const EPIC_ID = 'ep_01m418epbg8qkqa2e2krvdkqk5'
const EPIC = { id: EPIC_ID, title: 'Agent chats', branch: null } as EpicDetailView
const RUN = { id: 'rn_2', number: 2, epicId: EPIC_ID, state: 'queued' } as RunView

/** A run queue that records "<call> <folder> <epic id>" and answers with a fixed epic and run. */
function recordingRuns(calls: string[] = []): OrchestratorRuns {
  return {
    getEpic: (folder, epicId) => (calls.push(`getEpic ${folder} ${epicId}`), Promise.resolve(EPIC)),
    queueRun: (folder, epicId) => (calls.push(`queueRun ${folder} ${epicId}`), Promise.resolve(RUN))
  }
}

/** Transfer reads that record "<call> <folder> <epic id>" and answer with a fixed epic and a transfer in `status`. */
function recordingTransfers(calls: string[] = [], status: TransferStatus = 'queued'): TransferReads {
  return {
    getEpic: (folder, epicId) => (calls.push(`getEpic ${folder} ${epicId}`), Promise.resolve(EPIC)),
    getTransfer: (folder, epicId) =>
      (calls.push(`getTransfer ${folder} ${epicId}`), Promise.resolve({ epicId, status, packet: null, recorded: [], lastMismatches: [], next: [] } as TransferView))
  }
}

type Terminals = Pick<TerminalSessions, 'start' | 'paste'>

/** Terminals that record [`start`, chat, options] and [`paste`, chat, text] and answer that the PTY runs. */
function recordingTerminals(calls: unknown[][] = []): Terminals {
  return {
    start: async (...args) => (calls.push(['start', ...args]), { state: 'running', pid: 4242 }),
    paste: async (...args) => (calls.push(['paste', ...args]), { state: 'running', pid: 4242 })
  }
}

const CARD_ID = 'kc_01m6aspj4vxjq38vcbgxpg73jn'
const CARD = { id: CARD_ID, key: 'DM-7', title: 'Fix the flaky upload test' } as KanbanCardView

/** Kanban cards that record "<call> <folder> <card id>" and answer with a fixed card. */
function recordingCards(calls: string[] = []): KanbanCards {
  return {
    play: (folder, cardId) => (calls.push(`play ${folder} ${cardId}`), Promise.resolve(CARD)),
    kickBack: (folder, input) => (calls.push(`kickBack ${folder} ${input.cardId}`), Promise.resolve(CARD)),
    branch: (folder) => (calls.push(`branch ${folder}`), Promise.resolve('feature/cards'))
  }
}

/**
 * Handlers over `chats` and `runs`; `push`, `terminals`, `transfers` and `kanban` when a test needs to see them
 * (terminals that answer running, a queued transfer and a card that plays and kicks back otherwise).
 */
function handlersOver(
  chats: ChatRecords,
  errors: unknown[] = [],
  runs: OrchestratorRuns = recordingRuns(),
  {
    push,
    terminals = recordingTerminals(),
    transfers = recordingTransfers(),
    kanban = recordingCards()
  }: { push?: (event: ChatPushEvent) => void; terminals?: Terminals; transfers?: TransferReads; kanban?: KanbanCards } = {}
): ChatHandlers {
  return createChatHandlers({
    registry: { resolve: (path) => (path === REPO || path === SPELLING ? REPO : null) },
    agents: AGENTS,
    chats,
    terminals,
    runs,
    transfers,
    kanban,
    ...(push === undefined ? {} : { push }),
    onUnexpectedError: (error) => errors.push(error)
  })
}

const REF = { folder: SPELLING, chatId: 'chat_1' }
const CANONICAL = { folder: REPO, id: 'chat_1' }

describe('chat handlers: the channels', () => {
  it('serve the chat records, Start run, the transfer chat and the bound lookups, and nothing that sends, stops, answers or lists models', () => {
    const handlers = handlersOver(recordingChats().chats)

    expect(Object.keys(handlers).sort()).toEqual([
      'boundTerminal',
      'boundThreads',
      'create',
      'delete',
      'findTransferChat',
      'kickBackKanbanCard',
      'list',
      'read',
      'rename',
      'startKanbanCard',
      'startOrchestrator',
      'startTransferChat',
      'transferPrompt'
    ])
  })
})

describe('chat handlers: forwarding', () => {
  it('resolves the tracked folder and hands the records only validated fields', async () => {
    const { chats, calls } = recordingChats()
    const handlers = handlersOver(chats)

    expect(await handlers.list(SPELLING)).toEqual({ ok: true, data: [CHAT] })
    expect(await handlers.create({ folder: SPELLING, agent: 'codex', role: 'orchestrator' })).toEqual({ ok: true, data: CHAT })
    expect(await handlers.read(REF)).toEqual({ ok: true, data: { chat: CHAT, items: [] } })
    expect(await handlers.rename({ ...REF, title: '  Fix the build ' })).toEqual({ ok: true, data: { ...CHAT, title: 'Fix the build' } })
    expect(await handlers.delete(REF)).toEqual({ ok: true, data: null })

    expect(calls).toEqual([
      ['listChats', REPO],
      ['createChat', { folder: REPO, agent: 'codex', role: 'orchestrator' }],
      ['readChat', CANONICAL],
      ['renameChat', CANONICAL, 'Fix the build'],
      ['deleteChat', CANONICAL]
    ])
  })

  it('passes the optional fields of a new chat through', async () => {
    const { chats, calls } = recordingChats()
    const request = { folder: REPO, agent: 'claude', role: 'planner', model: null, allowSave: false, title: 'Plan it' }

    await handlersOver(chats).create(request)

    expect(calls).toEqual([['createChat', request]])
  })
})

describe('chat handlers: refusals', () => {
  it('refuses a folder that is not tracked, without reaching the records', async () => {
    const { chats, calls } = recordingChats()
    const handlers = handlersOver(chats)
    const elsewhere = join(REPO, '..', 'elsewhere')

    const results = [
      await handlers.list(elsewhere),
      await handlers.create({ folder: elsewhere, agent: 'claude', role: 'planner' }),
      await handlers.rename({ folder: elsewhere, chatId: 'chat_1', title: 'x' }),
      await handlers.delete({ folder: elsewhere, chatId: 'chat_1' }),
      await handlers.read({ folder: elsewhere, chatId: 'chat_1' })
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(Array(results.length).fill('unauthorized'))
    const named = `The folder ${elsewhere} is not tracked by Dark Mechanicus. Track the folder again to keep using this chat.`
    expect(results.map((result) => (result.ok ? 'ok' : result.error.message))).toEqual(Array(results.length).fill(named))
    expect(calls).toEqual([])
  })

  it('refuses malformed requests, including an executable path or MCP arguments', async () => {
    const { chats, calls } = recordingChats()
    const handlers = handlersOver(chats)

    const results = [
      await handlers.create({ folder: REPO, agent: 'claude', role: 'planner', executablePath: '/bin/evil' }),
      await handlers.create({ folder: REPO, agent: 'claude', role: 'planner', mcpArgs: ['--role', 'worker'] }),
      await handlers.create({ folder: REPO, agent: 'claude', role: 'janitor' }),
      await handlers.create({ folder: REPO, agent: 'gemini', role: 'planner' }),
      await handlers.read('chat_1'),
      await handlers.read({ folder: REPO }),
      await handlers.read({ ...REF, start: true }),
      await handlers.read({ ...REF, text: 'send this' }),
      await handlers.read({ folder: REPO, chatId: '../index' }),
      await handlers.list(42)
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(Array(results.length).fill('invalid_input'))
    expect(calls).toEqual([])
  })
})

describe('chat handlers: agents named by id', () => {
  it('refuses an agent id that is not connected with not_found, before anything runs', async () => {
    const { chats, calls } = recordingChats()
    const queue: string[] = []
    const handlers = handlersOver(chats, [], recordingRuns(queue))

    const results = [
      await handlers.create({ folder: REPO, agent: UNKNOWN_AGENT, role: 'planner' }),
      await handlers.startOrchestrator({ folder: REPO, epicId: EPIC_ID, agent: UNKNOWN_AGENT })
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['not_found', 'not_found'])
    expect(queue).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses a transfer chat for a built-in agent that is not connected or an unknown agent id, reading no transfer', async () => {
    const { chats, calls } = recordingChats()
    const reads: string[] = []
    const handlers = handlersOver(chats, [], recordingRuns(), { transfers: recordingTransfers(reads) })

    const results = [
      await handlers.startTransferChat({ folder: REPO, epicId: EPIC_ID, agent: 'autonomous' }),
      await handlers.startTransferChat({ folder: REPO, epicId: EPIC_ID, agent: UNKNOWN_AGENT }),
      await handlers.startTransferChat({ folder: REPO, epicId: EPIC_ID, agent: 'cu_../../../etc' })
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['not_found', 'not_found', 'invalid_input'])
    expect(results[1]).toMatchObject({ error: { message: `No connected agent has the id ${UNKNOWN_AGENT}. Connect it under Agents first.` } })
    expect(reads).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('chat handlers: start an orchestrator', () => {
  const REQUEST = { folder: SPELLING, epicId: EPIC_ID, agent: 'codex', model: 'big' }

  it('queues the run in the tracked folder, then creates the chat for it and starts its terminal with the kickoff', async () => {
    const { chats, calls } = recordingChats()
    const queue: string[] = []

    const result = await handlersOver(chats, [], recordingRuns(queue), { terminals: recordingTerminals(calls) }).startOrchestrator(REQUEST)

    expect(result).toEqual({ ok: true, data: { run: RUN, chat: CHAT, problem: null } })
    expect(queue).toEqual([`getEpic ${REPO} ${EPIC_ID}`, `queueRun ${REPO} ${EPIC_ID}`])
    expect(calls[0]).toEqual([
      'createChat',
      { folder: REPO, agent: 'codex', role: 'orchestrator', model: 'big', allowSave: false, title: 'Orchestrator · Agent chats', runId: 'rn_2' }
    ])
    expect(calls[1]?.slice(0, 2)).toEqual(['start', CHAT])
    expect(calls[1]?.[2]).toEqual({ kickoff: expect.stringContaining(EPIC_ID) })
    expect(calls).toHaveLength(2)
  })

  it('refuses a folder that is not tracked and a malformed request, before anything is queued', async () => {
    const { chats, calls } = recordingChats()
    const queue: string[] = []
    const handlers = handlersOver(chats, [], recordingRuns(queue))

    const results = [
      await handlers.startOrchestrator({ ...REQUEST, folder: join(REPO, '..', 'elsewhere') }),
      await handlers.startOrchestrator({ ...REQUEST, epicId: 'ep_1' }),
      await handlers.startOrchestrator({ ...REQUEST, role: 'planner' }),
      await handlers.startOrchestrator({ ...REQUEST, allowSave: true }),
      await handlers.startOrchestrator({ ...REQUEST, agent: 'gemini' }),
      await handlers.startOrchestrator({ ...REQUEST, model: '' }),
      await handlers.startOrchestrator(undefined)
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['unauthorized', ...Array(6).fill('invalid_input')])
    expect(queue).toEqual([])
    expect(calls).toEqual([])
  })

  it('answers with the queue error when the run cannot be queued, and reports only unexpected failures', async () => {
    const { chats, calls } = recordingChats()
    const errors: unknown[] = []
    const refusing: OrchestratorRuns = {
      ...recordingRuns(),
      queueRun: () => Promise.reject(new DomainError('conflict', 'Epic already has an active run.'))
    }

    const refused = await handlersOver(chats, errors, refusing).startOrchestrator(REQUEST)
    const broken = await handlersOver(chats, errors, { ...recordingRuns(), getEpic: () => Promise.reject(new Error('boom')) }).startOrchestrator(REQUEST)

    expect(refused).toEqual({ ok: false, error: { code: 'conflict', message: 'Epic already has an active run.' } })
    expect(broken).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } })
    expect(errors).toEqual([expect.objectContaining({ message: 'boom' })])
    expect(calls).toEqual([])
  })
})

describe('chat handlers: start a transfer chat', () => {
  const REQUEST = { folder: SPELLING, epicId: EPIC_ID, agent: 'codex', model: 'big' }

  it('reads the transfer in the tracked folder, then creates the transfer chat and starts its terminal with the transfer kickoff', async () => {
    const { chats, calls } = recordingChats()
    const reads: string[] = []

    const result = await handlersOver(chats, [], recordingRuns(), { terminals: recordingTerminals(calls), transfers: recordingTransfers(reads) }).startTransferChat(REQUEST)

    expect(result).toEqual({ ok: true, data: { chat: CHAT, problem: null } })
    expect(reads).toEqual([`getEpic ${REPO} ${EPIC_ID}`, `getTransfer ${REPO} ${EPIC_ID}`])
    expect(calls).toEqual([
      ['createChat', { folder: REPO, agent: 'codex', role: 'orchestrator', model: 'big', allowSave: false, title: 'Linear transfer · Agent chats', transferEpicId: EPIC_ID }],
      ['start', CHAT, { kickoff: transferKickoff({ epicId: EPIC_ID, epicTitle: 'Agent chats' }) }]
    ])
  })

  it('refuses a folder that is not tracked, a malformed request and a transfer nobody authorized, before any chat is created', async () => {
    const { chats, calls } = recordingChats()
    const reads: string[] = []
    const handlers = handlersOver(chats, [], recordingRuns(), { terminals: recordingTerminals(calls), transfers: recordingTransfers(reads, 'not_started') })

    const results = [
      await handlers.startTransferChat({ ...REQUEST, folder: join(REPO, '..', 'elsewhere') }),
      await handlers.startTransferChat({ ...REQUEST, epicId: 'ep_1' }),
      await handlers.startTransferChat({ ...REQUEST, role: 'planner' }),
      await handlers.startTransferChat({ ...REQUEST, transferEpicId: EPIC_ID }),
      await handlers.startTransferChat(undefined)
    ]
    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['unauthorized', ...Array(4).fill('invalid_input')])
    expect(reads).toEqual([])

    expect(await handlers.startTransferChat(REQUEST)).toMatchObject({ ok: false, error: { code: 'unmet_prerequisite' } })
    expect(calls).toEqual([])
  })
})

describe('chat handlers: find a transfer chat and its prompt', () => {
  it('finds the transfer chat of an epic in the tracked folder, and none for another epic', async () => {
    const { chats, calls } = recordingChats()
    chats.listChats = (folder) => (calls.push(['listChats', folder]), [{ ...CHAT, transferEpicId: EPIC_ID }])
    const handlers = handlersOver(chats)

    expect(await handlers.findTransferChat({ folder: SPELLING, epicId: EPIC_ID })).toEqual({ ok: true, data: { ...CHAT, transferEpicId: EPIC_ID } })
    expect(await handlers.findTransferChat({ folder: SPELLING, epicId: 'ep_01m418epbg8qkqa2e2krvdkqk6' })).toEqual({ ok: true, data: null })
    expect(calls).toEqual([
      ['listChats', REPO],
      ['listChats', REPO]
    ])
    expect((await handlers.findTransferChat({ folder: '/elsewhere', epicId: EPIC_ID })).ok).toBe(false)
    expect((await handlers.findTransferChat({ folder: SPELLING, epicId: EPIC_ID, chatId: 'chat_1' })).ok).toBe(false)
  })

  it('answers the transfer kickoff as the prompt for an agent started elsewhere', async () => {
    const reads: string[] = []
    const handlers = handlersOver(recordingChats().chats, [], recordingRuns(), { transfers: recordingTransfers(reads) })

    expect(await handlers.transferPrompt({ folder: SPELLING, epicId: EPIC_ID })).toEqual({ ok: true, data: transferKickoff({ epicId: EPIC_ID, epicTitle: 'Agent chats' }) })
    expect(reads).toEqual([`getEpic ${REPO} ${EPIC_ID}`])
    expect((await handlers.transferPrompt({ folder: SPELLING, epicId: 'ep_1' })).ok).toBe(false)
  })
})

describe('chat handlers: rename, delete and failures', () => {
  it('refuses a rename or delete that names more than a chat and a title, or an empty or oversized title', async () => {
    const { chats, calls } = recordingChats()
    const handlers = handlersOver(chats)

    const results = [
      await handlers.rename({ ...REF, title: '' }),
      await handlers.rename({ ...REF, title: '   ' }),
      await handlers.rename({ ...REF, title: 'x'.repeat(301) }),
      await handlers.rename({ ...REF, title: 'ok', executablePath: '/bin/evil' }),
      await handlers.rename({ folder: REPO, chatId: '../index', title: 'x' }),
      await handlers.delete({ ...REF, force: true }),
      await handlers.delete({ folder: REPO, chatId: '../index' }),
      await handlers.delete({ folder: REPO })
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(Array(results.length).fill('invalid_input'))
    expect(calls).toEqual([])
  })

  it('answers with the records error code, reporting only unexpected failures', async () => {
    const { chats } = recordingChats()
    const errors: unknown[] = []
    chats.readChat = () => {
      throw new DomainError('not_found', 'Chat not found: chat_1')
    }
    chats.listChats = () => {
      throw new Error('boom')
    }
    const handlers = handlersOver(chats, errors)

    expect(await handlers.read(REF)).toEqual({ ok: false, error: { code: 'not_found', message: 'Chat not found: chat_1' } })
    expect(await handlers.list(REPO)).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } })
    expect(errors).toEqual([expect.objectContaining({ message: 'boom' })])
  })
})

const BOUND_ATTEMPT = 'at_01k8zq4a1b2c3d4e5f6g7h8j9k'
const BOUND_RUN = 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb'
const FOUND = [{ folder: REPO, chatId: 'chat_1', threadId: 'thread_a', role: 'worker' as const }]

/** Handlers whose bound threads are `FOUND`, recording the folder and target they were asked about. */
function handlersWithBound(asked: unknown[][]): ChatHandlers {
  return createChatHandlers({
    registry: { resolve: (path) => (path === REPO || path === SPELLING ? REPO : null) },
    agents: AGENTS,
    chats: recordingChats().chats,
    terminals: recordingTerminals(),
    runs: recordingRuns(),
    transfers: recordingTransfers(),
    kanban: recordingCards(),
    boundThreads: (folder, target) => {
      asked.push([folder, target])
      return FOUND
    }
  })
}

/** Requests the handler must refuse: the first for its folder, the rest for what they say. */
function badBoundRequests(handlers: ChatHandlers): Promise<CommandResult<unknown>>[] {
  return [
    handlers.boundThreads({ folder: join(REPO, '..', 'elsewhere'), attemptId: BOUND_ATTEMPT }),
    handlers.boundThreads({ folder: REPO }),
    handlers.boundThreads({ folder: REPO, attemptId: BOUND_ATTEMPT, runId: BOUND_RUN }),
    handlers.boundThreads({ folder: REPO, attemptId: BOUND_RUN }),
    handlers.boundThreads({ folder: REPO, runId: BOUND_ATTEMPT }),
    handlers.boundThreads({ folder: REPO, attemptId: `${BOUND_ATTEMPT}.secret` }),
    handlers.boundThreads({ folder: REPO, attemptId: 'chat_1' }),
    handlers.boundThreads({ folder: REPO, attemptId: BOUND_ATTEMPT, chatId: 'chat_1' }),
    handlers.boundThreads({ folder: '', attemptId: BOUND_ATTEMPT }),
    handlers.boundThreads(BOUND_ATTEMPT),
    handlers.boundThreads(undefined)
  ]
}

describe('chat handlers: bound threads', () => {
  it('answers the threads bound to an attempt or a run, asked for by the canonical folder', async () => {
    const asked: unknown[][] = []
    const handlers = handlersWithBound(asked)

    expect(await handlers.boundThreads({ folder: SPELLING, attemptId: BOUND_ATTEMPT })).toEqual({ ok: true, data: FOUND })
    expect(await handlers.boundThreads({ folder: REPO, runId: BOUND_RUN })).toEqual({ ok: true, data: FOUND })
    expect(asked).toEqual([
      [REPO, { attemptId: BOUND_ATTEMPT }],
      [REPO, { runId: BOUND_RUN }]
    ])
  })

  it('answers none when the app wired no lookup', async () => {
    expect(await handlersOver(recordingChats().chats).boundThreads({ folder: REPO, attemptId: BOUND_ATTEMPT })).toEqual({ ok: true, data: [] })
  })

  it('refuses an untracked folder and malformed requests without looking anything up', async () => {
    const asked: unknown[][] = []

    const results = await Promise.all(badBoundRequests(handlersWithBound(asked)))

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['unauthorized', ...Array(results.length - 1).fill('invalid_input')])
    expect(asked).toEqual([])
  })

  it('reports a failure that is not a domain error and does not throw', async () => {
    const errors: unknown[] = []
    const failing = createChatHandlers({
      registry: { resolve: () => REPO },
      agents: AGENTS,
      chats: recordingChats().chats,
      terminals: recordingTerminals(),
      runs: recordingRuns(),
      transfers: recordingTransfers(),
      kanban: recordingCards(),
      boundThreads: () => {
        throw new Error('disk')
      },
      onUnexpectedError: (error) => errors.push(error)
    })

    expect(await failing.boundThreads({ folder: REPO, attemptId: BOUND_ATTEMPT })).toMatchObject({ ok: false })
    expect(errors).toHaveLength(1)
  })
})

describe('chat handlers: pushing list changes', () => {
  const CHANGED: ChatPushEvent = { type: 'chats_changed', folder: REPO, chatId: 'chat_1' }

  function pushing(chats: ChatRecords): { handlers: ChatHandlers; pushed: ChatPushEvent[] } {
    const pushed: ChatPushEvent[] = []
    return { handlers: handlersOver(chats, [], recordingRuns(), { push: (event) => pushed.push(event) }), pushed }
  }

  it('says a chat was created, renamed or deleted, naming the tracked folder and the chat', async () => {
    const { chats } = recordingChats()
    const { handlers, pushed } = pushing(chats)

    await handlers.create({ folder: SPELLING, agent: 'claude', role: 'planner' })
    await handlers.rename({ ...REF, title: 'Fix the build' })
    await handlers.delete(REF)

    expect(pushed).toEqual([CHANGED, CHANGED, CHANGED])
  })

  it('says the chat of a started orchestrator was created, and nothing when no chat was left', async () => {
    const { chats } = recordingChats()
    const started = pushing(chats)
    await started.handlers.startOrchestrator({ folder: SPELLING, epicId: EPIC_ID, agent: 'codex' })
    expect(started.pushed).toEqual([CHANGED])

    chats.createChat = () => {
      throw new Error('disk full')
    }
    const failed = pushing(chats)
    const result = await failed.handlers.startOrchestrator({ folder: SPELLING, epicId: EPIC_ID, agent: 'codex' })
    expect(result).toMatchObject({ ok: true, data: { chat: null } })
    expect(failed.pushed).toEqual([])
  })

  it('says nothing for a change that was refused or failed, and works without a push', async () => {
    const { chats } = recordingChats()
    chats.renameChat = () => {
      throw new DomainError('not_found', 'Chat not found.')
    }
    chats.deleteChat = () => Promise.reject(new DomainError('not_found', 'Chat not found.'))
    chats.createChat = () => {
      throw new DomainError('conflict', 'No.')
    }
    const { handlers, pushed } = pushing(chats)

    const results = [
      await handlers.create({ folder: SPELLING, agent: 'claude', role: 'planner' }),
      await handlers.rename({ ...REF, title: 'x' }),
      await handlers.delete(REF),
      await handlers.rename({ ...REF, title: '' }),
      await handlers.delete({ folder: join(REPO, '..', 'elsewhere'), chatId: 'chat_1' })
    ]

    expect(results.every((result) => !result.ok)).toBe(true)
    expect(pushed).toEqual([])
    expect(await handlersOver(recordingChats().chats).delete(REF)).toEqual({ ok: true, data: null })
  })
})

describe('chat handlers: pushing a started transfer chat', () => {
  const CHANGED: ChatPushEvent = { type: 'chats_changed', folder: REPO, chatId: 'chat_1' }
  const REQUEST = { folder: SPELLING, epicId: EPIC_ID, agent: 'codex' }

  it('says the chat of a started transfer was created, and nothing when no chat was left, reporting why', async () => {
    const { chats } = recordingChats()
    const pushed: ChatPushEvent[] = []
    await handlersOver(chats, [], recordingRuns(), { push: (event) => pushed.push(event) }).startTransferChat(REQUEST)
    expect(pushed).toEqual([CHANGED])

    chats.createChat = () => {
      throw new Error('disk full')
    }
    const failedPushes: ChatPushEvent[] = []
    const errors: unknown[] = []
    const result = await handlersOver(chats, errors, recordingRuns(), { push: (event) => failedPushes.push(event) }).startTransferChat(REQUEST)
    expect(result).toMatchObject({ ok: true, data: { chat: null } })
    expect(failedPushes).toEqual([])
    expect(errors).toEqual([expect.objectContaining({ message: 'disk full' })])
  })
})

describe('chat handlers: play a Kanban card', () => {
  const REQUEST = { folder: SPELLING, cardId: CARD_ID, agent: 'claude', model: 'sonnet' }
  const CHANGED: ChatPushEvent = { type: 'chats_changed', folder: REPO, chatId: 'chat_1' }

  it('plays the card in the tracked folder, creates its chat and starts its terminal with the card kickoff, then says the chat was created', async () => {
    const { chats, calls } = recordingChats()
    const cards: string[] = []
    const pushed: ChatPushEvent[] = []

    const result = await handlersOver(chats, [], recordingRuns(), { terminals: recordingTerminals(calls), kanban: recordingCards(cards), push: (event) => pushed.push(event) }).startKanbanCard(REQUEST)

    expect(result).toEqual({ ok: true, data: { card: CARD, chat: CHAT, problem: null } })
    expect(cards).toEqual([`play ${REPO} ${CARD_ID}`, `branch ${REPO}`])
    expect(calls).toEqual([
      ['createChat', { folder: REPO, agent: 'claude', role: 'orchestrator', model: 'sonnet', allowSave: false, title: 'Kanban · DM-7 Fix the flaky upload test', cardId: CARD_ID }],
      ['start', CHAT, { kickoff: expect.stringContaining(`claim_kanban_card with cardId ${CARD_ID}`) }]
    ])
    expect(pushed).toEqual([CHANGED])
  })

  it('removes the chat of a terminal that did not start and says why, pushing nothing', async () => {
    const { chats, calls } = recordingChats()
    const terminals: Terminals = { ...recordingTerminals(calls), start: async () => ({ state: 'signed_out', message: 'Claude Code is signed out.' }) }
    const pushed: ChatPushEvent[] = []

    const result = await handlersOver(chats, [], recordingRuns(), { terminals, push: (event) => pushed.push(event) }).startKanbanCard(REQUEST)

    expect(result).toEqual({
      ok: true,
      data: { card: CARD, chat: null, problem: 'DM-7 is played, but claude could not be started: Claude Code is signed out. The card keeps its pending play: press Play again to start a new chat.' }
    })
    expect(calls.map((call) => call[0])).toEqual(['createChat', 'deleteChat'])
    expect(pushed).toEqual([])
  })

  it('refuses a folder that is not tracked, an agent that is not connected and a malformed request, before the card is played', async () => {
    const { chats, calls } = recordingChats()
    const cards: string[] = []
    const handlers = handlersOver(chats, [], recordingRuns(), { terminals: recordingTerminals(calls), kanban: recordingCards(cards) })

    const results = [
      await handlers.startKanbanCard({ ...REQUEST, folder: join(REPO, '..', 'elsewhere') }),
      await handlers.startKanbanCard({ ...REQUEST, agent: UNKNOWN_AGENT }),
      await handlers.startKanbanCard({ ...REQUEST, cardId: 'ep_01m6aspj4vxjq38vcbgxpg73jn' }),
      await handlers.startKanbanCard({ ...REQUEST, role: 'planner' }),
      await handlers.startKanbanCard({ ...REQUEST, allowSave: true }),
      await handlers.startKanbanCard(undefined)
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['unauthorized', 'not_found', ...Array(4).fill('invalid_input')])
    expect(cards).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('chat handlers: kick back a Kanban card', () => {
  const REQUEST = { folder: SPELLING, cardId: CARD_ID, comment: 'Cover the empty upload.' }

  it("kicks the card back in the tracked folder and pastes the comment into its chat's terminal", async () => {
    const { chats, calls } = recordingChats()
    chats.listChats = (folder) => (calls.push(['listChats', folder]), [{ ...CHAT, cardId: CARD_ID }])
    const cards: string[] = []

    const result = await handlersOver(chats, [], recordingRuns(), { terminals: recordingTerminals(calls), kanban: recordingCards(cards) }).kickBackKanbanCard(REQUEST)

    expect(result).toEqual({ ok: true, data: { card: CARD, chatId: 'chat_1', problem: null } })
    expect(cards).toEqual([`kickBack ${REPO} ${CARD_ID}`])
    expect(calls).toEqual([
      ['listChats', REPO],
      ['paste', { ...CHAT, cardId: CARD_ID }, `DM-7 was kicked back by a person: Cover the empty upload. Claim it again with claim_kanban_card (cardId ${CARD_ID}) and address the comment.`]
    ])
  })

  it("reports a comment that could not reach the card's chat", async () => {
    const { chats } = recordingChats()
    chats.listChats = () => [{ ...CHAT, cardId: CARD_ID }]
    const terminals: Terminals = { ...recordingTerminals(), paste: async () => ({ state: 'refused', message: 'The folder is not tracked.' }) }

    const result = await handlersOver(chats, [], recordingRuns(), { terminals }).kickBackKanbanCard(REQUEST)

    expect(result).toMatchObject({ ok: true, data: { card: CARD, chatId: 'chat_1', problem: expect.stringContaining('the comment could not reach its chat: The folder is not tracked.') } })
  })

  it('refuses a folder that is not tracked, a blank comment and a malformed request, before the card is kicked back', async () => {
    const { chats, calls } = recordingChats()
    const cards: string[] = []
    const handlers = handlersOver(chats, [], recordingRuns(), { terminals: recordingTerminals(calls), kanban: recordingCards(cards) })

    const results = [
      await handlers.kickBackKanbanCard({ ...REQUEST, folder: join(REPO, '..', 'elsewhere') }),
      await handlers.kickBackKanbanCard({ ...REQUEST, comment: '   ' }),
      await handlers.kickBackKanbanCard({ ...REQUEST, cardId: `${CARD_ID}.secret` }),
      await handlers.kickBackKanbanCard({ ...REQUEST, chatId: 'chat_1' }),
      await handlers.kickBackKanbanCard(undefined)
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['unauthorized', ...Array(4).fill('invalid_input')])
    expect(cards).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('chat handlers: unexpected terminal failures reach the error reporter', () => {
  it('reports a terminal that throws something other than a domain error, for Start run, the transfer chat, Play and Kick back', async () => {
    const { chats } = recordingChats()
    chats.listChats = () => [{ ...CHAT, cardId: CARD_ID }]
    const terminals: Terminals = {
      start: () => Promise.reject(new Error('the PTY host is gone')),
      paste: () => Promise.reject(new Error('the PTY host is gone'))
    }
    const errors: unknown[] = []
    const handlers = handlersOver(chats, errors, recordingRuns(), { terminals })

    const results = [
      await handlers.startOrchestrator({ folder: SPELLING, epicId: EPIC_ID, agent: 'claude' }),
      await handlers.startTransferChat({ folder: SPELLING, epicId: EPIC_ID, agent: 'claude' }),
      await handlers.startKanbanCard({ folder: SPELLING, cardId: CARD_ID, agent: 'claude' }),
      await handlers.kickBackKanbanCard({ folder: SPELLING, cardId: CARD_ID, comment: 'Not yet.' })
    ]

    expect(results.map((result) => result.ok && (result.data as { problem: string | null }).problem)).toEqual(Array(4).fill(expect.stringContaining('the PTY host is gone')))
    expect(errors).toEqual(Array(4).fill(expect.objectContaining({ message: 'the PTY host is gone' })))
  })
})
