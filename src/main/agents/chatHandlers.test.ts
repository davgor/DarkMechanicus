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

type Terminals = Pick<TerminalSessions, 'start'>

/** Terminals that record [`start`, chat, options] and answer that the PTY runs. */
function recordingTerminals(calls: unknown[][] = []): Terminals {
  return { start: async (...args) => (calls.push(['start', ...args]), { state: 'running', pid: 4242 }) }
}

/** Handlers over `chats` and `runs`; `push`, `terminals` and `transfers` when a test needs to see them (terminals that answer running, a queued transfer otherwise). */
function handlersOver(
  chats: ChatRecords,
  errors: unknown[] = [],
  runs: OrchestratorRuns = recordingRuns(),
  {
    push,
    terminals = recordingTerminals(),
    transfers = recordingTransfers()
  }: { push?: (event: ChatPushEvent) => void; terminals?: Terminals; transfers?: TransferReads } = {}
): ChatHandlers {
  return createChatHandlers({
    registry: { resolve: (path) => (path === REPO || path === SPELLING ? REPO : null) },
    agents: AGENTS,
    chats,
    terminals,
    runs,
    transfers,
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
      'list',
      'read',
      'rename',
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
