import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { TransferStatus, TransferView } from '../../shared/domain/transfer'
import type { CommentView, EpicDetailView, RunView, TicketDetailView } from '../../shared/domain/views'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { AgentAuthStatus, AgentId, AgentView, CommandResult } from '../../shared/desktop/api'
import { transferKickoff } from '../../mcp/transferKickoff'
import { AT, builtInAgent, connectedAgents, REPO } from './__mocks__/chatFixtures'
import { recordingAgentChats, type RecordingAgentChats } from './__mocks__/agentChatDoubles'
import { createChatHandlers, type ChatHandlers, type ConversationWorkspace } from './chatHandlers'
import type { PlannerAgents } from './plannerStart'
import type { ConversationDeliveries, ConversationDelivery } from './conversationDeliveries'
import type { ChatRecords } from './chatRecords'
import type { OrchestratorRuns } from './orchestratorStart'
import type { TransferReads } from './transferStart'
import type { KanbanCardView, KanbanMessageView } from '../../shared/domain/kanban'
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
    recoverFolder: async () => {},
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


/** Claude connected and signed in, unless `signedIn` says otherwise; records each agent whose sign-in was checked. */
function plannerAgents(signedIn = true, checked: string[] = []): PlannerAgents {
  const status: AgentAuthStatus = signedIn ? { state: 'signed_in', reason: 'Signed in.' } : { state: 'signed_out', reason: 'Signed out.' }
  return { list: () => [builtInAgent('claude')], checkAuth: async (agent: AgentView) => (checked.push(agent.id), status) }
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
    kanban = recordingCards(),
    agentChats = recordingAgentChats(),
    planners = plannerAgents()
  }: { push?: (event: ChatPushEvent) => void; terminals?: Terminals; transfers?: TransferReads; kanban?: KanbanCards; agentChats?: RecordingAgentChats; planners?: PlannerAgents } = {}
): ChatHandlers {
  return createChatHandlers({
    registry: { resolve: (path) => (path === REPO || path === SPELLING ? REPO : null), list: () => [] },
    agents: AGENTS,
    chats,
    terminals,
    agentChats,
    plannerAgents: planners,
    runs,
    transfers,
    kanban,
    ...(push === undefined ? {} : { push }),
    onUnexpectedError: (error) => errors.push(error)
  })
}

const REF = { folder: SPELLING, chatId: 'chat_1' }
const CANONICAL = { folder: REPO, id: 'chat_1' }

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
      ['readChat', CANONICAL, { live: false }],
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
      { folder: REPO, agent: 'codex', role: 'orchestrator', model: 'big', allowSave: true, title: 'Orchestrator · Agent chats', runId: 'rn_2', epicId: EPIC_ID }
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

describe('chat handlers: start an orchestrator with additional instructions', () => {
  const REQUEST = { folder: SPELLING, epicId: EPIC_ID, agent: 'codex', model: 'big' }

  it('appends non-blank instructions to the orchestrator kickoff and records that kickoff as the chat’s first input', async () => {
    const { chats, calls } = recordingChats()

    const result = await handlersOver(chats, [], recordingRuns(), { terminals: recordingTerminals(calls) }).startOrchestrator({ ...REQUEST, instructions: 'Run the UI tickets first.' })

    expect(result.ok).toBe(true)
    const created = calls[0]?.[1] as { firstPrompt?: string; runId?: string }
    const started = calls[1]?.[2] as { kickoff: string }
    expect(started.kickoff).toContain(`Epic: Agent chats (${EPIC_ID})`)
    expect(started.kickoff).toContain('Additional instructions from the person')
    expect(started.kickoff).toContain('Run the UI tickets first.')
    expect(created).toMatchObject({ runId: 'rn_2', allowSave: true, firstPrompt: started.kickoff })
  })

  it('refuses blank, oversized or non-text instructions before anything is queued, and a transfer chat refuses them all', async () => {
    const { chats, calls } = recordingChats()
    const queue: string[] = []
    const handlers = handlersOver(chats, [], recordingRuns(queue))

    const results = [
      await handlers.startOrchestrator({ ...REQUEST, instructions: '' }),
      await handlers.startOrchestrator({ ...REQUEST, instructions: '   ' }),
      await handlers.startOrchestrator({ ...REQUEST, instructions: 'x'.repeat(32_001) }),
      await handlers.startOrchestrator({ ...REQUEST, instructions: null }),
      await handlers.startTransferChat({ ...REQUEST, instructions: 'Go.' })
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(Array(5).fill('invalid_input'))
    expect(queue).toEqual([])
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
      ['createChat', { folder: REPO, agent: 'codex', role: 'orchestrator', model: 'big', allowSave: true, title: 'Linear transfer · Agent chats', transferEpicId: EPIC_ID, epicId: EPIC_ID }],
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
    registry: { resolve: (path) => (path === REPO || path === SPELLING ? REPO : null), list: () => [] },
    agents: AGENTS,
    chats: recordingChats().chats,
    terminals: recordingTerminals(),
    agentChats: recordingAgentChats(),
    plannerAgents: plannerAgents(),
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
      registry: { resolve: () => REPO, list: () => [] },
      agents: AGENTS,
      chats: recordingChats().chats,
      terminals: recordingTerminals(),
      agentChats: recordingAgentChats(),
      plannerAgents: plannerAgents(),
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
      ['createChat', { folder: REPO, agent: 'claude', role: 'orchestrator', model: 'sonnet', allowSave: true, title: 'Kanban · DM-7 Fix the flaky upload test', cardId: CARD_ID }],
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

describe('chat handlers: play a Kanban card with additional instructions', () => {
  const REQUEST = { folder: SPELLING, cardId: CARD_ID, agent: 'claude', model: 'sonnet' }

  it('appends non-blank instructions to the card kickoff and records that kickoff as the chat’s first input, delivered once', async () => {
    const { chats, calls } = recordingChats()
    const instructions = `${'x'.repeat(31_990)} Use tabs.`

    const result = await handlersOver(chats, [], recordingRuns(), { terminals: recordingTerminals(calls), kanban: recordingCards() }).startKanbanCard({ ...REQUEST, instructions })

    expect(result.ok).toBe(true)
    const created = calls[0]?.[1] as { firstPrompt?: string; role: string; allowSave: boolean }
    const started = calls[1]?.[2] as { kickoff: string }
    expect(started.kickoff).toContain(`claim_kanban_card with cardId ${CARD_ID}`)
    expect(started.kickoff).toContain('Additional instructions from the person')
    expect(started.kickoff.endsWith(`Use tabs.\n=== End of additional instructions ===`)).toBe(true)
    expect(created).toMatchObject({ role: 'orchestrator', allowSave: true, firstPrompt: started.kickoff })
  })

  it('refuses blank, oversized or non-text instructions before the card is played', async () => {
    const { chats, calls } = recordingChats()
    const cards: string[] = []
    const handlers = handlersOver(chats, [], recordingRuns(), { terminals: recordingTerminals(calls), kanban: recordingCards(cards) })

    const results = [
      await handlers.startKanbanCard({ ...REQUEST, instructions: '' }),
      await handlers.startKanbanCard({ ...REQUEST, instructions: ' \n\t ' }),
      await handlers.startKanbanCard({ ...REQUEST, instructions: 'x'.repeat(32_001) }),
      await handlers.startKanbanCard({ ...REQUEST, instructions: 42 })
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(Array(4).fill('invalid_input'))
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

it('accepts the full original first prompt at the guarded creation boundary but refuses blank prompts', async () => {
  const { chats, calls } = recordingChats()
  const handlers = handlersOver(chats)
  const request = { folder: SPELLING, agent: 'claude', role: 'orchestrator' }
  const firstPrompt = '  Could you investigate the expiry failure?\nPreserve every line.  '
  expect(await handlers.create({ ...request, firstPrompt })).toMatchObject({ ok: true })
  expect(calls).toEqual([['createChat', { ...request, folder: REPO, firstPrompt }]])
  for (const blank of ['', ' \n\t ', 'x'.repeat(32_001)]) {
    expect(await handlers.create({ ...request, firstPrompt: blank })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  }
  expect(calls).toHaveLength(1)
})

const TICKET_ID = 'tk_01m418epbg8qkqa2e2krvdkqk5'
const COMMENT_ID = 'cm_01m418epbg8qkqa2e2krvdkqk5'
const CARD_MESSAGE_ID = 'km_01m418epbg8qkqa2e2krvdkqk5'
const ATTEMPT_ID = 'at_01m418epbg8qkqa2e2krvdkqk5'
const TICKET = {
  epicId: EPIC_ID,
  view: 'saved',
  ticket: { id: TICKET_ID, key: 'DM-8', title: 'Route board messages' },
  attempts: []
} as unknown as TicketDetailView

interface ConversationHarnessOptions {
  chats?: ChatRecord[]
  attemptId?: string | null
  activeRunId?: string | null
  bound?: Record<string, string | null>
  pasteFailure?: string
  pasteError?: unknown
  createError?: unknown
  deleteError?: unknown
  disappearAfterFirstList?: boolean
  omitBoundTerminal?: boolean
  omitNow?: boolean
  defaultAgent?: AgentId | null
  comments?: CommentView[]
  cardMessages?: KanbanMessageView[]
  contextInserted?: boolean
  resumeProblem?: string | null
  /** The GUI session manager the handlers get; a recording one that answers idle otherwise. */
  agentChats?: RecordingAgentChats
  /** The surface the harness stores new chats on, as the records would for a GUI-capable agent; none otherwise. */
  createSurface?: 'gui' | 'terminal'
}

function conversationWorkspace(
  calls: unknown[][],
  comments: CommentView[],
  initialCardMessages: readonly KanbanMessageView[] = []
): ConversationWorkspace {
  const cardMessages: KanbanMessageView[] = [...initialCardMessages]
  return {
    addComment: async (input) => {
      calls.push(['addComment', input])
      const comment: CommentView = {
        id: comments.length === 0 ? COMMENT_ID : 'cm_01m418epbg8qkqa2e2krvdkqk6',
        epicId: input.epicId,
        ticketId: input.ticketId ?? null,
        body: input.body,
        author: { role: 'desktop', label: 'Person' },
        createdAt: `2026-01-01T00:00:0${comments.length}.000Z`
      }
      comments.push(comment)
      return comment
    },
    listComments: async (input) => {
      calls.push(['listComments', input])
      return comments.filter((comment) => comment.epicId === input.epicId && (input.ticketId === undefined || comment.ticketId === input.ticketId))
    },
    getEpic: async () => EPIC,
    getTicket: async () => TICKET,
    getKanbanCard: async () => CARD,
    addKanbanMessage: async (input) => {
      calls.push(['addKanbanMessage', input])
      const message: KanbanMessageView = {
        id: CARD_MESSAGE_ID,
        body: input.body,
        authorRole: 'desktop',
        authorLabel: 'Person',
        createdAt: AT
      }
      cardMessages.push(message)
      return message
    },
    listKanbanMessages: async () => [...cardMessages]
  }
}

/** The record the harness stores for request number `created`, on `surface` when one is given. */
function conversationRecord(request: Parameters<ChatRecords['createChat']>[0], created: number, surface: ChatRecord['surface']): ChatRecord {
  return {
    id: `chat_conversation_${created}`,
    folder: request.folder,
    agent: request.agent,
    model: request.model ?? null,
    role: request.role,
    allowSave: request.allowSave ?? true,
    title: request.title ?? 'New chat',
    createdAt: `2026-01-01T00:00:1${created}.000Z`,
    updatedAt: `2026-01-01T00:00:1${created}.000Z`,
    sessionId: null,
    ...(request.conversation === undefined ? {} : { conversation: request.conversation }),
    ...(request.epicId === undefined ? {} : { epicId: request.epicId }),
    ...(surface === undefined ? {} : { surface }),
    ...(request.firstPrompt === undefined ? {} : { firstPrompt: request.firstPrompt, firstPromptDelivery: 'pending' })
  }
}

function conversationChats(
  calls: unknown[][],
  initial: readonly ChatRecord[],
  options: Pick<ConversationHarnessOptions, 'createError' | 'deleteError' | 'disappearAfterFirstList' | 'createSurface'>
): { chats: ChatRecords; records(): ChatRecord[] } {
  let records = [...initial], created = 0, lists = 0
  return {
    records: () => records,
    chats: {
      listChats: () => {
        lists += 1
        return options.disappearAfterFirstList === true && lists > 1 ? [] : [...records]
      },
      createChat: (request) => {
        if (options.createError !== undefined) throw options.createError
        created += 1
        const chat = conversationRecord(request, created, options.createSurface)
        calls.push(['createChat', request])
        records.push(chat)
        return chat
      },
      renameChat: () => {
        throw new Error('not used')
      },
      deleteChat: async (ref) => {
        if (options.deleteError !== undefined) throw options.deleteError
        calls.push(['deleteChat', ref])
        records = records.filter((chat) => chat.id !== ref.id)
      },
      recoverFolder: async () => {},
      readChat: () => {
        throw new Error('not used')
      },
      agentName: (id) => id
    }
  }
}

function conversationTerminals(calls: unknown[][], options: ConversationHarnessOptions): Terminals {
  return {
    start: async (...args) => {
      calls.push(['start', ...args])
      return { state: 'running', pid: 4242 }
    },
    paste: async (...args) => {
      calls.push(['paste', ...args])
      if (options.pasteError !== undefined) throw options.pasteError
      return options.pasteFailure === undefined ? { state: 'running', pid: 4242 } : { state: 'failed', message: options.pasteFailure }
    }
  }
}

function conversationDeliveryStore(deliveries: Map<string, ConversationDelivery>): ConversationDeliveries {
  return {
    record: (entry) => void deliveries.set(entry.messageId, entry),
    forMessages: (_folder, ids) => new Map(ids.flatMap((id) => (deliveries.has(id) ? [[id, deliveries.get(id)!]] : []))),
    pending: () => [...deliveries.values()].filter((entry) => entry.state === 'pending'),
    proof: (folder, chatId, source, messageId) => {
      const entry = deliveries.get(messageId)
      return entry?.folder === folder && entry.chatId === chatId && (entry.source ?? 'board') === source ? entry : undefined
    }
  }
}

function conversationHarness(options: ConversationHarnessOptions = {}) {
  const calls: unknown[][] = [], comments = [...(options.comments ?? [])]
  const workspace = conversationWorkspace(calls, comments, options.cardMessages)
  const chatState = conversationChats(calls, options.chats ?? [], options)
  const deliveries = new Map<string, ConversationDelivery>()
  const errors: unknown[] = []
  const terminals = conversationTerminals(calls, options)
  const agentChats = options.agentChats ?? recordingAgentChats()
  const handlers = createChatHandlers({
    registry: { resolve: (path) => (path === REPO || path === SPELLING ? REPO : null), list: () => [] },
    agents: { get: (id) => id === 'omp' ? builtInAgent('omp') : AGENTS.get(id) },
    chats: chatState.chats,
    terminals,
    agentChats,
    plannerAgents: plannerAgents(),
    runs: recordingRuns(),
    transfers: recordingTransfers(),
    kanban: recordingCards(),
    ...(options.omitBoundTerminal === true
      ? {}
      : { boundTerminal: async (_folder: string, target: { attemptId: string } | { runId: string }) =>
          options.bound?.['attemptId' in target ? target.attemptId : target.runId] ?? null }),
    conversation: {
      workspace: () => workspace,
      reads: {
        openAttemptId: async () => options.attemptId ?? null,
        activeRunId: async () => options.activeRunId ?? null
      },
      deliveries: conversationDeliveryStore(deliveries),
      contextDelivery: {
        queueBoard: async (chat, message) => {
          calls.push(['queueBoard', chat, message])
          deliveries.set(message.id, { folder: chat.folder!, chatId: chat.id, messageId: message.id, source: 'board',
            state: 'pending', text: message.text, problem: null, at: AT })
        },
        hasBoardMessage: () => options.contextInserted === true
      },
      resume: async (chat) => {
        calls.push(['resume', chat])
        return options.resumeProblem ?? null
      },
      defaultAgent: () => (options.defaultAgent === undefined ? 'claude' : options.defaultAgent),
      ...(options.omitNow === true ? {} : { now: () => AT })
    },
    onUnexpectedError: (error) => errors.push(error)
  })
  return { handlers, calls, comments, deliveries, errors, records: chatState.records, agentChats }
}

describe('chat handlers: board conversations', () => {
  it('stores a ticket message before pasting it into the open attempt chat with relay guidance', async () => {
    const claimChat = { ...CHAT, id: 'chat_claim', role: 'orchestrator' as const }
    const subject = conversationHarness({ chats: [claimChat], attemptId: ATTEMPT_ID, bound: { [ATTEMPT_ID]: claimChat.id } })

    const result = await subject.handlers.sendConversationMessage({
      folder: SPELLING,
      target: { epicId: EPIC_ID, ticketId: TICKET_ID },
      body: 'Should I keep the compatibility path?'
    })
    const state = await subject.handlers.conversationState({
      folder: REPO,
      target: { epicId: EPIC_ID, ticketId: TICKET_ID },
      messageIds: [COMMENT_ID]
    })

    expect(result).toEqual({ ok: true, data: { messageId: COMMENT_ID, chatId: claimChat.id, state: 'pending', problem: null } })
    expect(state).toMatchObject({
      ok: true,
      data: {
        chat: { id: claimChat.id, via: 'attempt' },
        deliveries: { [COMMENT_ID]: { chatId: claimChat.id, state: 'pending', chatExists: true } }
      }
    })
    expect(subject.calls[0]).toEqual(['addComment', { epicId: EPIC_ID, ticketId: TICKET_ID, body: 'Should I keep the compatibility path?' }])
    expect(subject.calls.find((call) => call[0] === 'paste')).toEqual([
      'paste',
      claimChat,
      expect.stringContaining('pass this to it now and post its answer'),
      COMMENT_ID
    ])
  })
})

describe('chat handlers: active-run board relays', () => {

  it('relays a ticket message through the active run chat when no claim chat exists', async () => {
    const runChat = { ...CHAT, id: 'chat_run', role: 'orchestrator' as const }
    const subject = conversationHarness({
      chats: [runChat],
      activeRunId: RUN.id,
      bound: { [RUN.id]: runChat.id }
    })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID, ticketId: TICKET_ID },
      body: 'Please ask the active orchestrator'
    })

    expect(result).toMatchObject({ ok: true, data: { chatId: runChat.id, state: 'pending', problem: null } })
    expect(subject.calls.find((call) => call[0] === 'paste')).toEqual([
      'paste',
      runChat,
      expect.stringContaining('pass this to it now and post its answer'),
      COMMENT_ID
    ])
  })
})

describe('chat handlers: opening board conversations', () => {

  it('opens a bound allow-save orchestrator chat with the earlier ticket conversation in its durable input', async () => {
    const earlier: CommentView = {
      id: 'cm_01m418epbg8qkqa2e2krvdkqk4',
      epicId: EPIC_ID,
      ticketId: TICKET_ID,
      body: 'Earlier context',
      author: { role: 'desktop', label: 'Person' },
      createdAt: AT
    }
    const subject = conversationHarness({ comments: [earlier] })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID, ticketId: TICKET_ID },
      body: 'New question'
    })

    expect(result).toMatchObject({ ok: true, data: { chatId: 'chat_conversation_1', state: 'pending', problem: null } })
    expect(subject.calls.find((call) => call[0] === 'createChat')).toEqual([
      'createChat',
      expect.objectContaining({
        role: 'orchestrator',
        allowSave: true,
        conversation: { epicId: EPIC_ID },
        title: 'Conversation · DM-8'
      })
    ])
    expect(subject.calls.find((call) => call[0] === 'paste')).toEqual([
      'paste',
      expect.objectContaining({ id: 'chat_conversation_1' }),
      expect.stringContaining('Earlier context'),
      expect.stringMatching(/^cm_/)
    ])
  })

})

describe('chat handlers: opening epic board conversations', () => {
  it('opens an epic conversation with the active-run warning when no run chat is available', async () => {
    const subject = conversationHarness({ activeRunId: RUN.id })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID },
      body: 'What is the current risk?'
    })

    expect(result).toMatchObject({ ok: true, data: { chatId: 'chat_conversation_1', state: 'pending', problem: null } })
    expect(subject.calls.find((call) => call[0] === 'createChat')).toEqual([
      'createChat',
      expect.objectContaining({ conversation: { epicId: EPIC_ID }, title: 'Conversation · Agent chats' })
    ])
    expect(subject.calls.find((call) => call[0] === 'paste')?.[2]).toEqual(
      expect.stringContaining('A run of this epic is active under another session.')
    )
  })

})

describe('chat handlers: opening card board conversations', () => {
  it('stores card attachments and includes an earlier reply when it opens a card conversation', async () => {
    const earlier: KanbanMessageView = {
      id: 'km_01m418epbg8qkqa2e2krvdkqk4',
      body: 'Earlier card reply',
      authorRole: 'worker',
      authorLabel: 'worker-a',
      createdAt: AT
    }
    const subject = conversationHarness({ cardMessages: [earlier] })
    const attachments = ['im_01m418epbg8qkqa2e2krvdkqk5']

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { cardId: CARD_ID },
      body: 'Please review the trace.',
      attachments
    })

    expect(result).toMatchObject({ ok: true, data: { chatId: 'chat_conversation_1', state: 'pending', problem: null } })
    expect(subject.calls[0]).toEqual(['addKanbanMessage', { cardId: CARD_ID, body: 'Please review the trace.', attachments }])
    expect(subject.calls.find((call) => call[0] === 'createChat')).toEqual([
      'createChat',
      expect.objectContaining({ conversation: { cardId: CARD_ID }, title: 'Conversation · DM-7' })
    ])
    expect(subject.calls.find((call) => call[0] === 'paste')?.[2]).toEqual(
      expect.stringMatching(/Attached images: im_01m418epbg8qkqa2e2krvdkqk5[\s\S]*Earlier card reply/)
    )
  })
})

describe('chat handlers: conversation failures and deletion', () => {

  it('keeps the stored comment and reports the terminal reason when paste fails', async () => {
    const chat = { ...CHAT, id: 'chat_claim', role: 'orchestrator' as const }
    const subject = conversationHarness({
      chats: [chat],
      attemptId: ATTEMPT_ID,
      bound: { [ATTEMPT_ID]: chat.id },
      pasteFailure: 'The CLI exited.'
    })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID, ticketId: TICKET_ID },
      body: 'Please relay this'
    })

    expect(result).toEqual({ ok: true, data: { messageId: COMMENT_ID, chatId: chat.id, state: 'pending', problem: 'The CLI exited.' } })
    expect(subject.comments).toHaveLength(1)
    expect(subject.comments[0]?.body).toBe('Please relay this')
  })

  it('retains replacement-chat history in durable pending input and queues that input exactly once', async () => {
    const subject = conversationHarness()
    const request = { folder: REPO, target: { epicId: EPIC_ID, ticketId: TICKET_ID }, body: 'First' }
    const first = await subject.handlers.sendConversationMessage(request)
    if (!first.ok) throw new Error(first.error.message)

    await subject.handlers.delete({ folder: REPO, chatId: first.data.chatId })
    const state = await subject.handlers.conversationState({
      folder: REPO,
      target: request.target,
      messageIds: [first.data.messageId]
    })
    const second = await subject.handlers.sendConversationMessage({ ...request, body: 'Second' })
    const replacement = subject.records()[0]
    const pastes = subject.calls.filter((call) => call[0] === 'paste')

    expect(state).toMatchObject({
      ok: true,
      data: { chat: null, deliveries: { [COMMENT_ID]: { chatId: 'chat_conversation_1', state: 'pending', chatExists: false } } }
    })
    expect(second).toMatchObject({ ok: true, data: { chatId: 'chat_conversation_2', state: 'pending' } })
    expect(replacement).toMatchObject({ id: 'chat_conversation_2' })
    expect(replacement?.firstPrompt).toBeUndefined()
    expect(pastes).toHaveLength(2)
    expect(pastes[1]?.[2]).toContain('First')
    expect(pastes[1]?.[2]).toContain('Second')
    expect(pastes[1]?.[3]).toBe(second.ok ? second.data.messageId : null)
    expect(subject.calls.some((call) => call[0] === 'start')).toBe(false)
    expect([...subject.deliveries.values()].at(-1)?.text).toEqual(expect.stringContaining('Second'))
  })

})

describe('chat handlers: conversation resolution races', () => {
  it('uses a surviving conversation chat without adding claim-relay guidance', async () => {
    const subject = conversationHarness()
    const request = { folder: REPO, target: { epicId: EPIC_ID, ticketId: TICKET_ID }, body: 'First' }
    const first = await subject.handlers.sendConversationMessage(request)
    if (!first.ok) throw new Error(first.error.message)

    const second = await subject.handlers.sendConversationMessage({ ...request, body: 'Second' })
    const paste = [...subject.calls].reverse().find((call) => call[0] === 'paste')

    expect(second).toMatchObject({ ok: true, data: { chatId: first.data.chatId, state: 'pending', problem: null } })
    expect(paste?.[2]).toContain('Second')
    expect(paste?.[2]).not.toContain('worker subagent')
  })
  it('reports when a resolved chat disappears before delivery without losing the message', async () => {
    const chat = { ...CHAT, id: 'chat_claim', role: 'orchestrator' as const }
    const subject = conversationHarness({
      chats: [chat],
      attemptId: ATTEMPT_ID,
      bound: { [ATTEMPT_ID]: chat.id },
      disappearAfterFirstList: true
    })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID, ticketId: TICKET_ID },
      body: 'Race-safe delivery'
    })

    expect(result).toEqual({
      ok: true,
      data: {
        messageId: COMMENT_ID,
        chatId: chat.id,
        state: 'failed',
        problem: 'The selected chat was deleted before the message could be delivered.'
      }
    })
    expect(subject.comments.map((comment) => comment.body)).toEqual(['Race-safe delivery'])
    expect(subject.calls.some((call) => call[0] === 'paste')).toBe(false)
  })

})

describe('chat handlers: conversation terminal start failures', () => {
  it('retains a fresh pending conversation when its terminal cannot start', async () => {
    const subject = conversationHarness({ pasteFailure: 'The agent is signed out.' })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID },
      body: 'Can anyone answer?'
    })

    expect(result).toMatchObject({
      ok: true,
      data: { messageId: COMMENT_ID, chatId: 'chat_conversation_1', state: 'pending', problem: 'The agent is signed out.' }
    })
    expect(subject.records()).toHaveLength(1)
    expect(subject.calls.some((call) => call[0] === 'deleteChat')).toBe(false)
  })

  it('reports a terminal host exception and retains the pending recipient and body for recovery', async () => {
    const terminalError = new Error('The terminal host disconnected.')
    const subject = conversationHarness({ pasteError: terminalError })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID },
      body: 'Please answer after reconnecting'
    })

    expect(result).toMatchObject({
      ok: true,
      data: { messageId: COMMENT_ID, chatId: 'chat_conversation_1', state: 'pending', problem: terminalError.message }
    })
    expect(subject.records()).toHaveLength(1)
    expect(subject.deliveries.get(COMMENT_ID)?.text).toContain('Please answer after reconnecting')
    expect(subject.errors).toEqual([terminalError])
  })

})

describe('chat handlers: conversation creation and cleanup failures', () => {
  it('never tries to delete pending work even when the chat store cannot remove chats', async () => {
    const cleanupError = new Error('The chat store is read-only.')
    const subject = conversationHarness({ pasteFailure: 'The CLI exited.', deleteError: cleanupError })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID },
      body: 'Please answer'
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        messageId: COMMENT_ID,
        chatId: 'chat_conversation_1',
        state: 'pending',
        problem: 'The CLI exited.'
      }
    })
    expect(subject.records()).toHaveLength(1)
    expect(subject.errors).toEqual([])
    expect(subject.calls.some((call) => call[0] === 'deleteChat')).toBe(false)
  })

  it('keeps a stored message and reports a non-Error chat creation failure', async () => {
    const subject = conversationHarness({ createError: 'storage offline' })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID },
      body: 'Durable before delivery'
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        messageId: COMMENT_ID,
        chatId: null,
        state: 'failed',
        problem: 'The conversation chat could not be created: storage offline'
      }
    })
    expect(subject.comments.map((comment) => comment.body)).toEqual(['Durable before delivery'])
    expect(subject.errors).toEqual(['storage offline'])
  })

})

describe('chat handlers: conversation destination failures', () => {
  it('keeps the message when the configured default agent is no longer connected', async () => {
    const subject = conversationHarness({ defaultAgent: UNKNOWN_AGENT })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID },
      body: 'Please find an agent'
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        messageId: COMMENT_ID,
        chatId: null,
        state: 'failed',
        problem: `No connected agent has the id ${UNKNOWN_AGENT}. Connect it under Agents first.`
      }
    })
    expect(subject.comments.map((comment) => comment.body)).toEqual(['Please find an agent'])
    expect(subject.errors).toEqual([])
  })

  it('reports a null-chat delivery as nonexistent and uses the default clock', async () => {
    const subject = conversationHarness({ defaultAgent: null, omitNow: true })
    const sent = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID },
      body: 'Store this for later'
    })
    if (!sent.ok) throw new Error(sent.error.message)

    const state = await subject.handlers.conversationState({
      folder: REPO,
      target: { epicId: EPIC_ID },
      messageIds: [sent.data.messageId]
    })
    const delivery = subject.deliveries.get(sent.data.messageId)

    expect(state).toMatchObject({
      ok: true,
      data: { chat: null, deliveries: { [COMMENT_ID]: { chatId: null, state: 'failed', chatExists: false } } }
    })
    expect(delivery?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u)
  })

})

describe('chat handlers: conversation state races', () => {
  it('does not expose a chat that disappears between resolution and state assembly', async () => {
    const conversation = {
      ...CHAT,
      id: 'chat_bound',
      conversation: { epicId: EPIC_ID }
    }
    const subject = conversationHarness({ chats: [conversation], disappearAfterFirstList: true })

    const state = await subject.handlers.conversationState({
      folder: REPO,
      target: { epicId: EPIC_ID },
      messageIds: []
    })

    expect(state).toEqual({ ok: true, data: { chat: null, deliveries: {} } })
  })

  it('opens safely when claim lookup is not configured', async () => {
    const subject = conversationHarness({ attemptId: ATTEMPT_ID, omitBoundTerminal: true })

    const sent = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID, ticketId: TICKET_ID },
      body: 'Use a fresh conversation'
    })
    if (!sent.ok) throw new Error(sent.error.message)
    const state = await subject.handlers.conversationState({
      folder: REPO,
      target: { epicId: EPIC_ID, ticketId: TICKET_ID },
      messageIds: [sent.data.messageId]
    })

    expect(sent.data).toMatchObject({ chatId: 'chat_conversation_1', state: 'pending', problem: null })
    expect(state).toMatchObject({ ok: true, data: { chat: { id: 'chat_conversation_1', via: 'conversation' } } })
  })
})

describe('chat handlers: card conversations and refusals', () => {

  it('queues a card message for its existing Play chat without claiming a context receipt', async () => {
    const play = { ...CHAT, id: 'chat_play', cardId: CARD_ID, role: 'orchestrator' as const }
    const subject = conversationHarness({ chats: [play] })

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { cardId: CARD_ID },

      body: 'Can this ship?'
    })

    expect(result).toEqual({ ok: true, data: { messageId: CARD_MESSAGE_ID, chatId: play.id, state: 'pending', problem: null } })
    expect(subject.calls[0]).toEqual(['addKanbanMessage', { cardId: CARD_ID, body: 'Can this ship?' }])
    expect(subject.calls.find((call) => call[0] === 'paste')).toEqual(['paste', play, expect.stringContaining('add_kanban_message'), CARD_MESSAGE_ID])
  })

  it('refuses invalid input before writing and keeps a message when no default agent is selected', async () => {
    const subject = conversationHarness({ defaultAgent: null })

    expect(
      await subject.handlers.sendConversationMessage({
        folder: REPO,
        target: { epicId: EPIC_ID },
        body: '   ',
        executablePath: '/bin/evil'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(subject.calls).toEqual([])

    const result = await subject.handlers.sendConversationMessage({
      folder: REPO,
      target: { epicId: EPIC_ID },
      body: 'Who can answer?'
    })
    expect(result).toMatchObject({
      ok: true,
      data: { messageId: COMMENT_ID, chatId: null, state: 'failed', problem: expect.stringContaining('No default agent') }
    })
    expect(subject.comments).toHaveLength(1)
  })
})

describe('chat handlers: durable board context transport', () => {
  it('queues the full person body before resuming the same OMP recipient, and does not call a PTY queue delivered', async () => {
    const chat = { ...CHAT, agent: 'omp' as const, conversation: { epicId: EPIC_ID } }
    const subject = conversationHarness({ chats: [chat] })
    const body = 'Complete person request\nincluding its final line.'
    const result = await subject.handlers.sendConversationMessage({ folder: REPO, target: { epicId: EPIC_ID }, body })
    expect(result).toMatchObject({ ok: true, data: { chatId: chat.id, state: 'pending', problem: null } })
    expect(subject.calls.filter((call) => call[0] === 'createChat' || call[0] === 'paste')).toEqual([])
    expect(subject.calls.find((call) => call[0] === 'resume')).toEqual(['resume', chat])
    const queued = subject.calls.find((call) => call[0] === 'queueBoard')
    expect(queued?.[2]).toMatchObject({ id: COMMENT_ID, text: expect.stringContaining(body) })
    expect(subject.deliveries.get(COMMENT_ID)).toMatchObject({ source: 'board', state: 'pending', text: expect.stringContaining(body) })
    expect(subject.calls.findIndex((call) => call[0] === 'queueBoard')).toBeLessThan(subject.calls.findIndex((call) => call[0] === 'resume'))
  })

  it('retains a signed-out existing recipient and the full body as pending rather than replacing its context', async () => {
    const chat = { ...CHAT, agent: 'omp' as const, conversation: { epicId: EPIC_ID } }
    const subject = conversationHarness({ chats: [chat], resumeProblem: 'Recipient sign-in is required.' })
    const result = await subject.handlers.sendConversationMessage({ folder: REPO, target: { epicId: EPIC_ID }, body: 'Retain this full message.' })
    expect(result).toMatchObject({ ok: true, data: { chatId: chat.id, state: 'pending', problem: 'Recipient sign-in is required.' } })
    expect(subject.records()).toEqual([chat])
    expect(subject.deliveries.get(COMMENT_ID)?.text).toContain('Retain this full message.')
  })

  it('preserves non-OMP routing and person authority but keeps a merely queued paste pending until a context receipt', async () => {
    const chat = { ...CHAT, conversation: { epicId: EPIC_ID } }
    const subject = conversationHarness({ chats: [chat] })
    const result = await subject.handlers.sendConversationMessage({ folder: REPO, target: { epicId: EPIC_ID }, body: 'Person request for the existing Claude session.' })
    expect(result).toMatchObject({ ok: true, data: { chatId: chat.id, state: 'pending' } })
    expect(subject.calls.find((call) => call[0] === 'paste')?.[2]).toContain('[Board message from the person]')
    expect(subject.calls.find((call) => call[0] === 'paste')?.[2]).toContain(COMMENT_ID)
    expect(subject.records()).toEqual([chat])
  })

  it('reports delivered only after the correct recipient context receipt is observed', async () => {
    const chat = { ...CHAT, agent: 'omp' as const, conversation: { epicId: EPIC_ID } }
    const subject = conversationHarness({ chats: [chat], contextInserted: true })
    expect(await subject.handlers.sendConversationMessage({ folder: REPO, target: { epicId: EPIC_ID }, body: 'Observed body.' }))
      .toMatchObject({ ok: true, data: { chatId: chat.id, state: 'delivered' } })
    expect(subject.calls.some((call) => call[0] === 'queueBoard')).toBe(true)
  })

  it('opens the supported no-recipient OMP route without duplicating a kickoff and a host outbox input', async () => {
    const subject = conversationHarness({ defaultAgent: 'omp' })
    expect(await subject.handlers.sendConversationMessage({ folder: REPO, target: { epicId: EPIC_ID }, body: 'New conversation body.' }))
      .toMatchObject({ ok: true, data: { chatId: 'chat_conversation_1', state: 'pending' } })
    const created = subject.calls.find((call) => call[0] === 'createChat')?.[1] as { firstPrompt?: string }
    expect(created.firstPrompt).toBeUndefined()
    expect(subject.calls.find((call) => call[0] === 'queueBoard')?.[2]).toMatchObject({ text: expect.stringContaining('New conversation body.') })
    expect(subject.calls.filter((call) => call[0] === 'start' || call[0] === 'paste')).toEqual([])
    expect(subject.calls.filter((call) => call[0] === 'resume')).toHaveLength(1)
  })
})

describe('chat handlers: GUI chats take board messages as user turns', () => {
  it('sends a board message to a GUI chat as a user turn, not a paste, and records it in the delivery ledger', async () => {
    const chat = { ...CHAT, id: 'chat_gui', surface: 'gui' as const, conversation: { epicId: EPIC_ID } }
    const subject = conversationHarness({ chats: [chat] })

    const result = await subject.handlers.sendConversationMessage({ folder: REPO, target: { epicId: EPIC_ID }, body: 'Ship it on Friday?' })

    expect(result).toEqual({ ok: true, data: { messageId: COMMENT_ID, chatId: chat.id, state: 'delivered', problem: null } })
    expect(subject.agentChats.calls).toEqual([['send', chat, { text: expect.stringContaining('[Board message from the person] on') }]])
    expect(subject.agentChats.calls[0]).toEqual(['send', chat, { text: expect.stringContaining('Ship it on Friday?') }])
    expect(subject.calls.filter((call) => call[0] === 'paste' || call[0] === 'queueBoard' || call[0] === 'resume')).toEqual([])
    expect(subject.deliveries.get(COMMENT_ID)).toMatchObject({ messageId: COMMENT_ID, folder: REPO, chatId: chat.id, state: 'delivered', problem: null, source: 'board', at: AT })
  })

  it('records a failed GUI turn with its reason', async () => {
    const chat = { ...CHAT, id: 'chat_gui', surface: 'gui' as const, conversation: { epicId: EPIC_ID } }
    const agentChats = recordingAgentChats()
    agentChats.send = async () => { throw new DomainError('busy_elsewhere', 'The chat is running in a terminal.') }
    const subject = conversationHarness({ chats: [chat], agentChats })

    const result = await subject.handlers.sendConversationMessage({ folder: REPO, target: { epicId: EPIC_ID }, body: 'Still there?' })

    expect(result).toMatchObject({ ok: true, data: { chatId: chat.id, state: 'failed', problem: 'The chat is running in a terminal.' } })
    expect(subject.deliveries.get(COMMENT_ID)).toMatchObject({ chatId: chat.id, state: 'failed', problem: 'The chat is running in a terminal.' })
    expect(subject.errors).toEqual([])
  })

  it('starts a fresh GUI conversation chat with the board kickoff as its first turn, not a paste, and records it', async () => {
    const subject = conversationHarness({ createSurface: 'gui' })

    const result = await subject.handlers.sendConversationMessage({ folder: REPO, target: { epicId: EPIC_ID }, body: 'Fresh GUI question' })

    const [chat] = subject.records()
    expect(result).toEqual({ ok: true, data: { messageId: COMMENT_ID, chatId: chat?.id, state: 'delivered', problem: null } })
    expect(chat).toMatchObject({ surface: 'gui', conversation: { epicId: EPIC_ID }, epicId: EPIC_ID })
    expect(subject.calls.find((call) => call[0] === 'createChat')?.[1]).toMatchObject({ conversation: { epicId: EPIC_ID }, epicId: EPIC_ID })
    expect(subject.agentChats.calls).toEqual([['start', chat, { firstMessage: expect.stringContaining('Fresh GUI question') }]])
    expect(subject.calls.filter((call) => call[0] === 'paste' || call[0] === 'queueBoard' || call[0] === 'start')).toEqual([])
    expect(subject.deliveries.get(COMMENT_ID)).toMatchObject({ chatId: chat?.id, state: 'delivered', source: 'board' })
  })

  it('opens a fresh card conversation chat bound to its card only, with no epicId', async () => {
    const subject = conversationHarness({ createSurface: 'gui' })

    const result = await subject.handlers.sendConversationMessage({ folder: REPO, target: { cardId: CARD_ID }, body: 'Card question' })

    expect(result).toMatchObject({ ok: true, data: { state: 'delivered' } })
    const request = subject.calls.find((call) => call[0] === 'createChat')?.[1]
    expect(request).toMatchObject({ conversation: { cardId: CARD_ID } })
    expect(request).not.toHaveProperty('epicId')
  })
})

describe('chat handlers: reading a chat', () => {
  it('reads a chat live while its GUI process runs, so running calls and pending requests are kept', async () => {
    const { chats, calls } = recordingChats()
    const agentChats = recordingAgentChats()
    agentChats.live.add('chat_1')

    expect(await handlersOver(chats, [], recordingRuns(), { agentChats }).read(REF)).toEqual({ ok: true, data: { chat: CHAT, items: [] } })
    expect(calls).toEqual([['readChat', CANONICAL, { live: true }]])
  })
})

describe('chat handlers: start planner', () => {
  it('creates a planner chat bound to the epic with Allow save, with the agent pickChatAgent picks, started on its surface', async () => {
    const { chats, calls } = recordingChats()
    const runCalls: string[] = []
    const pushed: ChatPushEvent[] = []
    const agentChats = recordingAgentChats()
    const terminalCalls: unknown[][] = []
    chats.createChat = (request) => (calls.push(['createChat', request]), { ...CHAT, ...request, id: 'chat_planner', surface: 'gui' } as ChatRecord)
    const handlers = handlersOver(chats, [], recordingRuns(runCalls), { agentChats, terminals: recordingTerminals(terminalCalls), push: (event) => pushed.push(event) })

    const result = await handlers.startPlanner({ folder: SPELLING, epicId: EPIC_ID })

    expect(result).toMatchObject({ ok: true, data: { chat: { id: 'chat_planner', role: 'planner', epicId: EPIC_ID, allowSave: true }, problem: null } })
    expect(runCalls).toEqual([`getEpic ${REPO} ${EPIC_ID}`])
    expect(calls).toEqual([['createChat', { folder: REPO, agent: 'claude', role: 'planner', model: null, allowSave: true, title: 'Planner · Agent chats', epicId: EPIC_ID }]])
    const [method, , options] = agentChats.calls[0] as [string, ChatRecord, { firstMessage: string }]
    expect(method).toBe('start')
    expect(options.firstMessage).toContain(`Epic: Agent chats (${EPIC_ID})`)
    expect(options.firstMessage).toContain('darkmechanicus-planner')
    expect(terminalCalls).toEqual([])
    expect(pushed).toEqual([{ type: 'chats_changed', folder: REPO, chatId: 'chat_planner' }])
  })
})

describe('chat handlers: start planner refusals', () => {
  it('refuses an unknown epic, creating nothing', async () => {
    const { chats, calls } = recordingChats()
    const agentChats = recordingAgentChats()
    const runs: OrchestratorRuns = { ...recordingRuns(), getEpic: () => Promise.reject(new DomainError('not_found', `Epic ${EPIC_ID} was not found.`)) }

    const result = await handlersOver(chats, [], runs, { agentChats }).startPlanner({ folder: REPO, epicId: EPIC_ID })

    expect(result).toEqual({ ok: false, error: { code: 'not_found', message: `Epic ${EPIC_ID} was not found.` } })
    expect([calls, agentChats.calls]).toEqual([[], []])
  })

  it('refuses with no_agent when nobody is signed in, creating nothing', async () => {
    const { chats, calls } = recordingChats()
    const agentChats = recordingAgentChats()
    const checked: string[] = []

    const result = await handlersOver(chats, [], recordingRuns(), { agentChats, planners: plannerAgents(false, checked) }).startPlanner({ folder: REPO, epicId: EPIC_ID })

    expect(result).toMatchObject({ ok: false, error: { code: 'no_agent' } })
    expect(checked).toEqual(['claude'])
    expect([calls, agentChats.calls]).toEqual([[], []])
  })

  it('refuses an untracked folder and malformed requests before reading anything', async () => {
    const { chats, calls } = recordingChats()
    const runCalls: string[] = []
    const handlers = handlersOver(chats, [], recordingRuns(runCalls))

    const results = [
      await handlers.startPlanner({ folder: join(REPO, '..', 'elsewhere'), epicId: EPIC_ID }),
      await handlers.startPlanner({ folder: REPO, epicId: 'rn_01m418epbg8qkqa2e2krvdkqk5' }),
      await handlers.startPlanner({ folder: REPO, epicId: EPIC_ID, agent: 'claude' }),
      await handlers.startPlanner({ folder: REPO, epicId: EPIC_ID, role: 'orchestrator' }),
      await handlers.startPlanner(undefined)
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['unauthorized', 'invalid_input', 'invalid_input', 'invalid_input', 'invalid_input'])
    expect([calls, runCalls]).toEqual([[], []])
  })

  it('removes the chat again and says why when its agent does not start', async () => {
    const { chats, calls } = recordingChats()
    const agentChats = recordingAgentChats('signed_out')
    chats.createChat = (request) => (calls.push(['createChat', request]), { ...CHAT, ...request, id: 'chat_planner', surface: 'gui' } as ChatRecord)

    const result = await handlersOver(chats, [], recordingRuns(), { agentChats }).startPlanner({ folder: REPO, epicId: EPIC_ID })

    expect(result).toMatchObject({ ok: true, data: { chat: null, problem: expect.stringContaining('signed out') } })
    expect(calls.map((call) => call[0])).toEqual(['createChat', 'deleteChat'])
  })
})
