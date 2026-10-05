import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import type { ThreadBinding } from '../../shared/agents/chatApi'
import type { CommandResult } from '../../shared/desktop/api'
import { AT, MODELS, REPO } from './__mocks__/fakeChatAdapter'
import { createChatHandlers, type ChatHandlers } from './chatHandlers'
import type { OrchestratorRuns } from './orchestratorStart'
import type { SessionManager } from './sessionManager'

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

const MESSAGE = { id: 'm1', at: AT, kind: 'user_message', text: 'hi' } as const

/** Another spelling of the tracked folder, which the registry resolves to REPO. */
const SPELLING = `${REPO}${sep}`

/** A session manager that records [method, ...args] and answers with fixed values. */
function recordingSessions(): { sessions: SessionManager; calls: unknown[][] } {
  const calls: unknown[][] = []
  const sessions: SessionManager = {
    listChats: (...args) => (calls.push(['listChats', ...args]), [{ ...CHAT, pending: 0 }]),
    createChat: (...args) => (calls.push(['createChat', ...args]), CHAT),
    renameChat: (...args) => (calls.push(['renameChat', ...args]), { ...CHAT, title: 'Fix the build' }),
    deleteChat: async (...args) => {
      calls.push(['deleteChat', ...args])
    },
    openChat: async (...args) => (calls.push(['openChat', ...args]), { chat: CHAT, items: [], pending: [], running: false }),
    send: async (...args) => (calls.push(['send', ...args]), MESSAGE),
    stop: async (...args) => {
      calls.push(['stop', ...args])
    },
    retryTurn: async (...args) => (calls.push(['retryTurn', ...args]), MESSAGE),
    reconcileAuthStatus: (kind, status) => (calls.push(['reconcileAuthStatus', kind]), status),
    signInStarted: (kind) => {
      calls.push(['signInStarted', kind])
    },
    setModel: async (...args) => (calls.push(['setModel', ...args]), { ...CHAT, model: 'small' }),
    answerApproval: (...args) => {
      calls.push(['answerApproval', ...args])
    },
    listModels: async (...args) => (calls.push(['listModels', ...args]), MODELS),
    liveCount: () => 0,
    disposeAll: async () => {}
  }
  return { sessions, calls }
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

function handlersOver(sessions: SessionManager, errors: unknown[] = [], runs: OrchestratorRuns = recordingRuns()): ChatHandlers {
  return createChatHandlers({
    registry: { resolve: (path) => (path === REPO || path === SPELLING ? REPO : null) },
    sessions,
    runs,
    onUnexpectedError: (error) => errors.push(error)
  })
}

const REF = { folder: SPELLING, chatId: 'chat_1' }
const CANONICAL = { folder: REPO, id: 'chat_1' }

describe('chat handlers: forwarding', () => {
  it('resolves the tracked folder and hands the manager only validated fields', async () => {
    const { sessions, calls } = recordingSessions()
    const handlers = handlersOver(sessions)

    expect(await handlers.list(SPELLING)).toEqual({ ok: true, data: [{ ...CHAT, pending: 0 }] })
    expect(await handlers.create({ folder: SPELLING, agent: 'codex', role: 'orchestrator' })).toEqual({ ok: true, data: CHAT })
    expect((await handlers.open(REF)).ok).toBe(true)
    expect(await handlers.send({ ...REF, text: 'hi' })).toEqual({ ok: true, data: MESSAGE })
    expect(await handlers.stop(REF)).toEqual({ ok: true, data: null })
    expect(await handlers.retryTurn(REF)).toEqual({ ok: true, data: MESSAGE })
    expect((await handlers.setModel({ ...REF, model: 'small' })).ok).toBe(true)
    expect(await handlers.answerApproval({ ...REF, requestId: 'q1', decision: 'allow_chat' })).toEqual({ ok: true, data: null })
    expect(await handlers.models('cursor')).toEqual({ ok: true, data: MODELS })
    expect(await handlers.rename({ ...REF, title: '  Fix the build ' })).toEqual({ ok: true, data: { ...CHAT, title: 'Fix the build' } })
    expect(await handlers.delete(REF)).toEqual({ ok: true, data: null })

    expect(calls).toEqual([
      ['listChats', REPO],
      ['createChat', { folder: REPO, agent: 'codex', role: 'orchestrator' }],
      ['openChat', CANONICAL],
      ['send', CANONICAL, 'hi'],
      ['stop', CANONICAL],
      ['retryTurn', CANONICAL],
      ['setModel', CANONICAL, 'small'],
      ['answerApproval', CANONICAL, { requestId: 'q1', decision: 'allow_chat' }],
      ['listModels', 'cursor'],
      ['renameChat', CANONICAL, 'Fix the build'],
      ['deleteChat', CANONICAL]
    ])
  })

  it('passes the optional fields of a new chat through', async () => {
    const { sessions, calls } = recordingSessions()
    const request = { folder: REPO, agent: 'claude', role: 'planner', model: null, allowSave: false, title: 'Plan it' }

    await handlersOver(sessions).create(request)

    expect(calls).toEqual([['createChat', request]])
  })
})

describe('chat handlers: refusals', () => {
  it('refuses a folder that is not tracked, without reaching the manager', async () => {
    const { sessions, calls } = recordingSessions()
    const handlers = handlersOver(sessions)
    const elsewhere = join(REPO, '..', 'elsewhere')

    const results = [
      await handlers.list(elsewhere),
      await handlers.create({ folder: elsewhere, agent: 'claude', role: 'planner' }),
      await handlers.send({ folder: elsewhere, chatId: 'chat_1', text: 'hi' }),
      await handlers.rename({ folder: elsewhere, chatId: 'chat_1', title: 'x' }),
      await handlers.delete({ folder: elsewhere, chatId: 'chat_1' }),
      await handlers.retryTurn({ folder: elsewhere, chatId: 'chat_1' })
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(Array(results.length).fill('unauthorized'))
    expect(calls).toEqual([])
  })

  it('refuses malformed requests, including an executable path or MCP arguments', async () => {
    const { sessions, calls } = recordingSessions()
    const handlers = handlersOver(sessions)

    const results = [
      await handlers.create({ folder: REPO, agent: 'claude', role: 'planner', executablePath: '/bin/evil' }),
      await handlers.create({ folder: REPO, agent: 'claude', role: 'planner', mcpArgs: ['--role', 'worker'] }),
      await handlers.create({ folder: REPO, agent: 'claude', role: 'janitor' }),
      await handlers.create({ folder: REPO, agent: 'gemini', role: 'planner' }),
      await handlers.send({ ...REF, text: '' }),
      await handlers.send({ folder: REPO, chatId: '../index', text: 'x' }),
      await handlers.setModel(REF),
      await handlers.answerApproval({ ...REF, requestId: 'q1', decision: 'allow' }),
      await handlers.open('chat_1'),
      await handlers.models('/bin/claude'),
      await handlers.list(42),
      await handlers.retryTurn({ ...REF, text: 'send this instead' }),
      await handlers.retryTurn({ ...REF, messageId: 'm1' }),
      await handlers.retryTurn({ folder: REPO }),
      await handlers.retryTurn({ folder: REPO, chatId: '../index' }),
      await handlers.retryTurn('chat_1')
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(Array(results.length).fill('invalid_input'))
    expect(calls).toEqual([])
  })

})

describe('chat handlers: start an orchestrator', () => {
  const REQUEST = { folder: SPELLING, epicId: EPIC_ID, agent: 'codex', model: 'big' }

  it('queues the run in the tracked folder, then creates the chat for it and sends the kickoff', async () => {
    const { sessions, calls } = recordingSessions()
    const queue: string[] = []

    const result = await handlersOver(sessions, [], recordingRuns(queue)).startOrchestrator(REQUEST)

    expect(result).toEqual({ ok: true, data: { run: RUN, chat: CHAT, problem: null } })
    expect(queue).toEqual([`getEpic ${REPO} ${EPIC_ID}`, `queueRun ${REPO} ${EPIC_ID}`])
    expect(calls[0]).toEqual([
      'createChat',
      { folder: REPO, agent: 'codex', role: 'orchestrator', model: 'big', allowSave: false, title: 'Orchestrator · Agent chats', runId: 'rn_2' }
    ])
    expect(calls[1]?.[0]).toBe('send')
    expect(calls[1]?.[1]).toBe(CHAT)
    expect(calls[1]?.[2]).toContain(EPIC_ID)
  })

  it('refuses a folder that is not tracked and a malformed request, before anything is queued', async () => {
    const { sessions, calls } = recordingSessions()
    const queue: string[] = []
    const handlers = handlersOver(sessions, [], recordingRuns(queue))

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
    const { sessions, calls } = recordingSessions()
    const errors: unknown[] = []
    const refusing: OrchestratorRuns = {
      ...recordingRuns(),
      queueRun: () => Promise.reject(new DomainError('conflict', 'Epic already has an active run.'))
    }

    const refused = await handlersOver(sessions, errors, refusing).startOrchestrator(REQUEST)
    const broken = await handlersOver(sessions, errors, { ...recordingRuns(), getEpic: () => Promise.reject(new Error('boom')) }).startOrchestrator(REQUEST)

    expect(refused).toEqual({ ok: false, error: { code: 'conflict', message: 'Epic already has an active run.' } })
    expect(broken).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } })
    expect(errors).toEqual([expect.objectContaining({ message: 'boom' })])
    expect(calls).toEqual([])
  })
})

describe('chat handlers: rename, delete and failures', () => {
  it('refuses a rename or delete that names more than a chat and a title, or an empty or oversized title', async () => {
    const { sessions, calls } = recordingSessions()
    const handlers = handlersOver(sessions)

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

  it('answers with the manager error code, reporting only unexpected failures', async () => {
    const { sessions } = recordingSessions()
    const errors: unknown[] = []
    sessions.send = () => Promise.reject(new DomainError('conflict', 'still answering'))
    sessions.retryTurn = () => Promise.reject(new DomainError('conflict', 'Claude Code is still signed out. Sign in first.'))
    sessions.listModels = () => Promise.reject(new Error('boom'))
    const handlers = handlersOver(sessions, errors)

    expect(await handlers.send({ ...REF, text: 'hi' })).toEqual({ ok: false, error: { code: 'conflict', message: 'still answering' } })
    expect(await handlers.retryTurn(REF)).toEqual({ ok: false, error: { code: 'conflict', message: 'Claude Code is still signed out. Sign in first.' } })
    expect(await handlers.models('claude')).toEqual({ ok: false, error: { code: 'internal', message: 'boom' } })
    expect(errors).toEqual([expect.objectContaining({ message: 'boom' })])
  })
})

const BINDINGS: ThreadBinding[] = [
  { threadId: null, role: 'orchestrator', kind: 'run', runId: 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb', epicId: EPIC_ID },
  { threadId: 'thread_a', role: 'worker', kind: 'attempt', attemptId: 'at_01k8zq4a1b2c3d4e5f6g7h8j9k', runId: null, epicId: null, ticketId: null, ticketKey: null }
]

/** Handlers whose thread bindings are `BINDINGS`, recording the chats they were asked about. */
function handlersWithBindings(asked: unknown[]): ChatHandlers {
  return createChatHandlers({
    registry: { resolve: (path) => (path === REPO || path === SPELLING ? REPO : null) },
    sessions: recordingSessions().sessions,
    runs: recordingRuns(),
    threadBindings: async (chat) => {
      asked.push(chat)
      return BINDINGS
    }
  })
}

describe('chat handlers: thread bindings', () => {
  it('answers the bindings of the chat, asked for by its canonical folder and id', async () => {
    const asked: unknown[] = []

    expect(await handlersWithBindings(asked).threadBindings(REF)).toEqual({ ok: true, data: BINDINGS })
    expect(asked).toEqual([CANONICAL])
  })

  it('answers none when the app wired no bindings', async () => {
    expect(await handlersOver(recordingSessions().sessions).threadBindings(REF)).toEqual({ ok: true, data: [] })
  })

  it('refuses an untracked folder and malformed requests without asking for bindings', async () => {
    const asked: unknown[] = []
    const handlers = handlersWithBindings(asked)

    const results = [
      await handlers.threadBindings({ folder: join(REPO, '..', 'elsewhere'), chatId: 'chat_1' }),
      await handlers.threadBindings({ ...REF, attemptId: 'at_01k8zq4a1b2c3d4e5f6g7h8j9k' }),
      await handlers.threadBindings({ folder: REPO }),
      await handlers.threadBindings({ folder: REPO, chatId: '../index' }),
      await handlers.threadBindings({ folder: '', chatId: 'chat_1' }),
      await handlers.threadBindings('chat_1'),
      await handlers.threadBindings(undefined)
    ]

    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['unauthorized', ...Array(results.length - 1).fill('invalid_input')])
    expect(asked).toEqual([])
  })

  it('reports a failure that is not a domain error and does not throw', async () => {
    const errors: unknown[] = []
    const failing = createChatHandlers({
      registry: { resolve: () => REPO },
      sessions: recordingSessions().sessions,
      runs: recordingRuns(),
      threadBindings: () => Promise.reject(new Error('disk')),
      onUnexpectedError: (error) => errors.push(error)
    })

    expect(await failing.threadBindings(REF)).toMatchObject({ ok: false })
    expect(errors).toHaveLength(1)
  })
})

const BOUND_ATTEMPT = 'at_01k8zq4a1b2c3d4e5f6g7h8j9k'
const BOUND_RUN = 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb'
const FOUND = [{ folder: REPO, chatId: 'chat_1', threadId: 'thread_a', role: 'worker' as const }]

/** Handlers whose bound threads are `FOUND`, recording the folder and target they were asked about. */
function handlersWithBound(asked: unknown[][]): ChatHandlers {
  return createChatHandlers({
    registry: { resolve: (path) => (path === REPO || path === SPELLING ? REPO : null) },
    sessions: recordingSessions().sessions,
    runs: recordingRuns(),
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
    expect(await handlersOver(recordingSessions().sessions).boundThreads({ folder: REPO, attemptId: BOUND_ATTEMPT })).toEqual({ ok: true, data: [] })
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
      sessions: recordingSessions().sessions,
      runs: recordingRuns(),
      boundThreads: () => {
        throw new Error('disk')
      },
      onUnexpectedError: (error) => errors.push(error)
    })

    expect(await failing.boundThreads({ folder: REPO, attemptId: BOUND_ATTEMPT })).toMatchObject({ ok: false })
    expect(errors).toHaveLength(1)
  })
})
