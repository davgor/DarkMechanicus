/**
 * A new chat's model and thinking level (New chat, Start run, Play, a transfer, the Lexmechanic card): a Skitarii
 * chat's must be in its agent's OMP catalog and a level one that model takes, as `agentChat:setModel` checks; only a
 * Skitarii chat takes a level, and only with a model. Nothing is created, queued or played when they are refused.
 */
import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import { chatModelOptions } from '../../shared/agents/models'
import type { AgentAuthStatus } from '../../shared/desktop/api'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import type { KanbanCardView } from '../../shared/domain/kanban'
import hostCatalog from '../agentChat/__fixtures__/omp/models.json'
import { AT, builtInAgent, connectedAgents, REPO } from './__mocks__/chatFixtures'
import { recordingAgentChats } from './__mocks__/agentChatDoubles'
import { createChatHandlers } from './chatHandlers'
import type { ChatRecords } from './chatRecords'

/** The Windows host's catalog (omp 18.20.2): Sonnet 5.5 takes low … max. */
const CATALOG = chatModelOptions(hostCatalog)
const SONNET = 'anthropic/claude-sonnet-5-5'
const EPIC_ID = 'ep_01m418epbg8qkqa2e2krvdkqk5'
const CARD_ID = 'kc_01m6aspj4vxjq38vcbgxpg73jn'
const CHAT: ChatRecord = {
  id: 'chat_1', folder: REPO, agent: 'omp', model: null, role: 'orchestrator', allowSave: true, title: 'New chat', createdAt: AT, updatedAt: AT, sessionId: null
}
const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Signed in.' }

function subject() {
  const calls: unknown[][] = []
  const catalogReads: string[] = []
  const chats: ChatRecords = {
    listChats: () => [CHAT],
    createChat: (...args) => (calls.push(['createChat', ...args]), CHAT),
    renameChat: () => CHAT,
    deleteChat: async () => {},
    recoverFolder: async () => {},
    readChat: () => ({ chat: CHAT, items: [] }),
    agentName: (id) => id
  }
  const handlers = createChatHandlers({
    registry: { resolve: (path) => (path === REPO ? REPO : null), list: () => [] },
    agents: { get: connectedAgents([builtInAgent('omp'), builtInAgent('claude')]) },
    chats,
    terminals: { start: async () => ({ state: 'running', pid: 1 }), paste: async () => ({ state: 'running', pid: 1 }) },
    agentChats: recordingAgentChats(),
    plannerAgents: { list: () => [builtInAgent('omp')], checkAuth: async () => SIGNED_IN },
    runs: {
      getEpic: async () => ({ id: EPIC_ID, title: 'Agent chats', branch: null }) as EpicDetailView,
      queueRun: async () => (calls.push(['queueRun']), { id: 'rn_2', number: 2, epicId: EPIC_ID, state: 'queued' } as RunView)
    },
    transfers: { getEpic: async () => ({ id: EPIC_ID, title: 'Agent chats' }) as EpicDetailView, getTransfer: async () => { throw new Error('unused') } },
    kanban: {
      play: async () => (calls.push(['play']), { id: CARD_ID, key: 'DM-7', title: 'Fix it' } as KanbanCardView),
      kickBack: async () => { throw new Error('unused') },
      branch: async () => null
    },
    models: { catalogModels: async (agentId) => (catalogReads.push(agentId), CATALOG) }
  })
  return { handlers, calls, catalogReads }
}

const created = (calls: unknown[][]): unknown[] => calls.filter((call) => call[0] === 'createChat').map((call) => call[1])

describe('chat handlers: a new chat\'s model and thinking level', () => {
  it('stores a Skitarii catalog model and its effort on the new chat', async () => {
    const { handlers, calls, catalogReads } = subject()
    expect(await handlers.create({ folder: REPO, agent: 'omp', role: 'orchestrator', model: SONNET, thinking: 'low' })).toMatchObject({ ok: true })
    expect(created(calls)).toEqual([{ folder: REPO, agent: 'omp', role: 'orchestrator', model: SONNET, thinking: 'low' }])
    expect(catalogReads).toEqual(['omp'])
  })

  it('leaves both unset for Default, without reading the catalog', async () => {
    const { handlers, calls, catalogReads } = subject()
    expect(await handlers.create({ folder: REPO, agent: 'omp', role: 'planner', model: null })).toMatchObject({ ok: true })
    expect(created(calls)).toEqual([{ folder: REPO, agent: 'omp', role: 'planner', model: null }])
    expect(catalogReads).toEqual([])
  })

  it('validates thinking against OMP\'s levels, the catalog and the agent, and creates nothing it refuses', async () => {
    const { handlers, calls } = subject()
    const base = { folder: REPO, agent: 'omp', role: 'orchestrator' }
    const results = [
      await handlers.create({ ...base, model: SONNET, thinking: 'turbo' }),
      await handlers.create({ ...base, model: SONNET, thinking: 'minimal' }),
      await handlers.create({ ...base, model: 'anthropic/claude-nope-9', thinking: 'low' }),
      await handlers.create({ ...base, model: null, thinking: 'low' }),
      await handlers.create({ ...base, agent: 'claude', model: 'opus', thinking: 'high' })
    ]
    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(['invalid_input', 'invalid_input', 'invalid_input', 'invalid_input', 'unsupported_agent'])
    expect(results.map((result) => (result.ok ? 'ok' : result.error.message)).slice(1)).toEqual([
      `${SONNET} does not take the minimal thinking level.`,
      'anthropic/claude-nope-9 is not in this agent\'s model catalog.',
      'Choose a model for the thinking level.',
      'Only a Skitarii chat takes a thinking level.'
    ])
    expect(calls).toEqual([])
  })
})

describe('chat handlers: the start requests\' model and thinking level', () => {
  it('carries the model and thinking on Start run, the Lexmechanic card, Play and a transfer, and refuses before queueing or playing', async () => {
    const { handlers, calls } = subject()
    expect((await handlers.startOrchestrator({ folder: REPO, epicId: EPIC_ID, agent: 'omp', model: SONNET, thinking: 'high' })).ok).toBe(true)
    expect((await handlers.startPlanner({ folder: REPO, epicId: EPIC_ID, model: SONNET, thinking: 'low' })).ok).toBe(true)
    expect((await handlers.startKanbanCard({ folder: REPO, cardId: CARD_ID, agent: 'omp', model: SONNET, thinking: 'medium' })).ok).toBe(true)
    expect(created(calls)).toEqual([
      expect.objectContaining({ role: 'orchestrator', runId: 'rn_2', model: SONNET, thinking: 'high' }),
      expect.objectContaining({ role: 'planner', model: SONNET, thinking: 'low' }),
      expect.objectContaining({ role: 'orchestrator', cardId: CARD_ID, model: SONNET, thinking: 'medium' })
    ])

    const refused = subject()
    const results = [
      await refused.handlers.startOrchestrator({ folder: REPO, epicId: EPIC_ID, agent: 'omp', model: 'anthropic/claude-nope-9' }),
      await refused.handlers.startPlanner({ folder: REPO, epicId: EPIC_ID, model: SONNET, thinking: 'off' }),
      await refused.handlers.startKanbanCard({ folder: REPO, cardId: CARD_ID, agent: 'omp', model: SONNET, thinking: 'minimal' }),
      await refused.handlers.startTransferChat({ folder: REPO, epicId: EPIC_ID, agent: 'omp', model: SONNET, thinking: 'turbo' })
    ]
    expect(results.map((result) => (result.ok ? 'ok' : result.error.code))).toEqual(Array(4).fill('invalid_input'))
    expect(refused.calls).toEqual([])
  })
})
