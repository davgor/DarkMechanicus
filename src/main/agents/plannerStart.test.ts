import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../core/errors'
import type { AgentChatSnapshot } from '../../shared/agents/agentChat'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentAuthStatus, AgentView } from '../../shared/desktop/api'
import type { EpicDetailView } from '../../shared/domain/views'
import { startPlannerChat } from './plannerStart'

const at = '2026-11-26T00:00:00.000Z'
const agent = { id: 'claude', kind: 'claude', displayName: 'Claude Code' } as AgentView
const planner: ChatRecord = {
  id: 'chat_p', folder: '/repo', agent: 'claude', model: null, role: 'planner', allowSave: true, title: 'Planner · Retry banner',
  createdAt: at, updatedAt: at, sessionId: null, surface: 'gui', epicId: 'ep_1'
}

function deps(options: { signedIn?: boolean; create?: () => Promise<ChatRecord>; started?: string; remove?: () => Promise<void>; checkModel?: () => Promise<void> } = {}) {
  const status = { state: options.signedIn === false ? 'signed_out' : 'signed_in' } as AgentAuthStatus
  return {
    epics: { getEpic: vi.fn(() => Promise.resolve({ id: 'ep_1', title: 'Retry\nbanner' } as EpicDetailView)) },
    agents: { list: () => [agent], checkAuth: vi.fn(() => Promise.resolve(status)) },
    chats: {
      createChat: vi.fn(options.create ?? (() => Promise.resolve(planner))),
      deleteChat: vi.fn(options.remove ?? (() => Promise.resolve())),
      agentName: () => 'Claude Code'
    },
    terminals: { start: vi.fn() },
    agentChats: { start: vi.fn(() => Promise.resolve({ status: options.started ?? 'idle' } as unknown as AgentChatSnapshot)) },
    checkModel: vi.fn(options.checkModel ?? (() => Promise.resolve())),
    onError: vi.fn()
  }
}

const request = { folder: '/repo', epicId: 'ep_1' }

describe('startPlannerChat', () => {
  it('creates the epic-bound planner chat with Allow save and starts it with a kickoff naming the epic', async () => {
    const d = deps()
    expect(await startPlannerChat(d, request)).toEqual({ chat: planner, problem: null })
    expect(d.chats.createChat).toHaveBeenCalledWith(expect.objectContaining({ folder: '/repo', agent: 'claude', role: 'planner', allowSave: true, epicId: 'ep_1', title: 'Planner · Retry banner' }))
    expect(d.agentChats.start).toHaveBeenCalledWith(planner, { firstMessage: expect.stringContaining('Epic: Retry banner (ep_1)') })
    const [created] = d.chats.createChat.mock.calls[0] as unknown as [object]
    expect(created).toMatchObject({ model: null })
    expect(created).not.toHaveProperty('thinking')
  })

  it('stores the chosen model and thinking level on the planner chat once the picked agent takes them', async () => {
    const d = deps()
    const choice = { ...request, model: 'anthropic/claude-sonnet-5-5', thinking: 'low' as const }
    expect(await startPlannerChat(d, choice)).toEqual({ chat: planner, problem: null })
    expect(d.checkModel.mock.calls).toEqual([['claude', choice]])
    expect(d.chats.createChat).toHaveBeenCalledWith(expect.objectContaining({ role: 'planner', model: 'anthropic/claude-sonnet-5-5', thinking: 'low' }))
  })

  it('creates nothing when the picked agent cannot start on the chosen model', async () => {
    const d = deps({ checkModel: () => Promise.reject(new DomainError('invalid_input', 'anthropic/nope is not in this agent\'s model catalog.')) })
    await expect(startPlannerChat(d, { ...request, model: 'anthropic/nope' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(d.chats.createChat).not.toHaveBeenCalled()
  })

  it('refuses with no_agent and creates nothing when no connected agent is signed in', async () => {
    const d = deps({ signedIn: false })
    await expect(startPlannerChat(d, request)).rejects.toMatchObject({ code: 'no_agent' })
    expect(d.chats.createChat).not.toHaveBeenCalled()
  })

  it('answers a refused create without reporting it, and reports an unexpected one', async () => {
    const refused = deps({ create: () => Promise.reject(new DomainError('busy', 'The folder is busy.')) })
    expect(await startPlannerChat(refused, request)).toEqual({ chat: null, problem: 'The planner chat could not be created: The folder is busy. Start the planner again.' })
    expect(refused.onError).not.toHaveBeenCalled()
    const broken = deps({ create: () => Promise.reject('disk full') })
    expect((await startPlannerChat(broken, request)).problem).toBe('The planner chat could not be created: disk full. Start the planner again.')
    expect(broken.onError.mock.calls).toEqual([['disk full']])
  })

  it('removes a chat whose agent did not start, and keeps it with the reason when it cannot be removed', async () => {
    const removed = deps({ started: 'signed_out' })
    expect(await startPlannerChat(removed, request)).toEqual({
      chat: null, problem: 'Claude Code could not be started: The agent is signed out. Sign in from Agents, then start the chat again. Start the planner again.'
    })
    expect(removed.chats.deleteChat.mock.calls).toEqual([[planner]])
    const stuck = new Error('locked')
    const kept = deps({ started: 'failed', remove: () => Promise.reject(stuck) })
    expect(await startPlannerChat(kept, request)).toEqual({ chat: planner, problem: 'Claude Code could not be started: The agent process did not start. Start the planner again.' })
    expect(kept.onError.mock.calls).toEqual([[stuck]])
  })
})
