import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import { AT, fakeAdapters, memoryChatStore, REPO, type FakeAdapters } from './__mocks__/fakeChatAdapter'
import type { ChatStore } from './chatStore'
import { startOrchestratorRun, type OrchestratorRuns } from './orchestratorStart'
import { createSessionManager, type SessionManager } from './sessionManager'

const EPIC = {
  id: 'ep_1',
  title: 'Agent chats',
  branch: { repository: null, name: 'epic/agent-chats', startCommit: null }
} as EpicDetailView

const RUN = { id: 'rn_2', number: 2, epicId: 'ep_1', state: 'queued' } as RunView

interface Rig {
  store: ChatStore
  fakes: FakeAdapters
  manager: SessionManager
  runs: OrchestratorRuns
  /** What the runs side was asked for, as "<call> <epic id>". */
  calls: string[]
  errors: unknown[]
}

function rig(runs: Partial<OrchestratorRuns> = {}): Rig {
  const store = memoryChatStore()
  const fakes = fakeAdapters()
  const errors: unknown[] = []
  const calls: string[] = []
  const manager = createSessionManager({
    store,
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['/app/out/main/mcp.js', '--repo', folder], env: {} }),
    push: () => {},
    now: () => AT,
    onError: (error) => errors.push(error)
  })
  const wired: OrchestratorRuns = {
    getEpic: (_folder, epicId) => (calls.push(`getEpic ${epicId}`), Promise.resolve(EPIC)),
    queueRun: (_folder, epicId) => (calls.push(`queueRun ${epicId}`), Promise.resolve(RUN)),
    ...runs
  }
  return { store, fakes, manager, calls, errors, runs: wired }
}

const REQUEST = { folder: REPO, epicId: 'ep_1', agent: 'claude', model: 'big' } as const

function chatsOf(store: ChatStore): ChatRecord[] {
  return store.listChats(REPO)
}

describe('start an orchestrator for a run', () => {
  it('queues the run, then creates the orchestrator chat for it and sends the kickoff as its first message', async () => {
    const { store, fakes, manager, runs, calls } = rig()

    const result = await startOrchestratorRun({ runs, sessions: manager }, REQUEST)

    expect(calls).toEqual(['getEpic ep_1', 'queueRun ep_1'])
    expect(result.run).toBe(RUN)
    expect(result.problem).toBeNull()
    expect(result.chat).toMatchObject({
      folder: REPO,
      agent: 'claude',
      model: 'big',
      role: 'orchestrator',
      allowSave: false,
      title: 'Orchestrator · Agent chats',
      runId: 'rn_2'
    })
    expect(chatsOf(store).map((chat) => chat.id)).toEqual([result.chat?.id])

    const first = store.readTranscript({ folder: REPO, id: result.chat?.id ?? '' })?.items[0]
    expect(first).toMatchObject({ kind: 'user_message' })
    const text = first?.kind === 'user_message' ? first.text : ''
    for (const wanted of ['ep_1', 'epic/agent-chats', 'darkmechanicus-orchestrator', 'rn_2']) {
      expect(text).toContain(wanted)
    }
    expect(fakes.of('claude')[0]?.sent).toEqual([text])
  })

  it('starts the agent as an orchestrator that cannot save plans', async () => {
    const { fakes, manager, runs } = rig()

    await startOrchestratorRun({ runs, sessions: manager }, REQUEST)

    const started = fakes.of('claude')[0]?.started[0]
    expect(started).toMatchObject({ role: 'orchestrator', allowSave: false, model: 'big' })
    expect(started?.darkMechanicus.args).not.toContain('--allow-save')
  })

  it('lets the agent use its default model when none was chosen', async () => {
    const { manager, runs } = rig()

    const result = await startOrchestratorRun({ runs, sessions: manager }, { folder: REPO, epicId: 'ep_1', agent: 'claude' })

    expect(result.chat?.model).toBeNull()
  })
})

describe('start an orchestrator: failures', () => {
  it('creates nothing when the run cannot be queued', async () => {
    const refusal = new DomainError('conflict', 'Epic ep_1 already has an active run.')
    const { store, fakes, manager, runs } = rig({ queueRun: () => Promise.reject(refusal) })

    await expect(startOrchestratorRun({ runs, sessions: manager }, REQUEST)).rejects.toBe(refusal)

    expect(chatsOf(store)).toEqual([])
    expect(fakes.created).toEqual([])
  })

  it('queues nothing when the epic cannot be read', async () => {
    const refusal = new DomainError('not_found', 'Epic ep_1 was not found.')
    const { calls, manager, runs } = rig({ getEpic: () => Promise.reject(refusal) })

    await expect(startOrchestratorRun({ runs, sessions: manager }, REQUEST)).rejects.toBe(refusal)

    expect(calls).toEqual([])
  })
})

describe('start an orchestrator: failures after the run is queued', () => {
  it('keeps the queued run and says so when the chat cannot be created', async () => {
    const { store, fakes, manager, runs } = rig()
    const failing: SessionManager = {
      ...manager,
      createChat: () => {
        throw new DomainError('invalid_input', 'The chat store is full.')
      }
    }

    const result = await startOrchestratorRun({ runs, sessions: failing }, REQUEST)

    expect(result.run).toBe(RUN)
    expect(result.chat).toBeNull()
    expect(result.problem).toContain('Run #2 is queued')
    expect(result.problem).toContain('The chat store is full.')
    expect(result.problem).toContain('waiting for an orchestrator')
    expect(chatsOf(store)).toEqual([])
    expect(fakes.created).toEqual([])
  })

  it('removes the chat again when the agent cannot start, so no chat is left without a running agent', async () => {
    const { store, fakes, manager, runs } = rig()
    fakes.prepare = (adapter) => {
      adapter.startError = new Error('claude exited with code 1')
    }

    const result = await startOrchestratorRun({ runs, sessions: manager }, REQUEST)

    expect(result.run).toBe(RUN)
    expect(result.chat).toBeNull()
    expect(result.problem).toContain('Run #2 is queued')
    expect(result.problem).toContain('Claude Code')
    expect(result.problem).toContain('claude exited with code 1')
    expect(chatsOf(store)).toEqual([])
    expect(fakes.of('claude')[0]?.disposals).toBe(1)
  })

})

describe('start an orchestrator: an agent that cannot start', () => {
  it('keeps the chat, and says why, when the agent cannot start and the chat cannot be removed either', async () => {
    const { store, fakes, manager, runs, errors } = rig()
    fakes.prepare = (adapter) => {
      adapter.startError = new Error('claude exited with code 1')
    }
    const stuck: SessionManager = {
      ...manager,
      deleteChat: () => Promise.reject(new Error('disk is read-only'))
    }

    const result = await startOrchestratorRun({ runs, sessions: stuck, onError: (error) => errors.push(error) }, REQUEST)

    expect(result.chat).toMatchObject({ runId: 'rn_2' })
    expect(result.problem).toContain('claude exited with code 1')
    expect(chatsOf(store)).toHaveLength(1)
    expect(errors.map((error) => (error as Error).message)).toEqual(['claude exited with code 1', 'disk is read-only'])
  })

  it('names an agent that is not connected, and leaves no chat behind', async () => {
    const { store, runs } = rig()
    const offline = createSessionManager({
      store,
      adapters: fakeAdapters().definitions,
      executablePath: () => null,
      mcpConfig: () => ({ command: 'node', args: [], env: {} }),
      push: () => {}
    })

    const result = await startOrchestratorRun({ runs, sessions: offline }, REQUEST)

    expect(result.run).toBe(RUN)
    expect(result.chat).toBeNull()
    expect(result.problem).toContain('Claude Code is not connected')
    expect(chatsOf(store)).toEqual([])
  })
})
