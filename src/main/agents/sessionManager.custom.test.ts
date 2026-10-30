/**
 * Custom agents in the session manager. Removing an agent ends the live processes of its chats, so a chat
 * behaves as not connected at once; the chats themselves stay listed. And a custom CLI that asks to sign in
 * does not lock its chats: the app cannot check its sign-in, so nothing could ever lift such a lock.
 */
import { describe, expect, it } from 'vitest'
import type { AgentView } from '../../shared/desktop/api'
import type { ChatItem } from '../../shared/agents/chat'
import { AT, builtInAgent, connectedAgents, fakeAdapters, memoryChatFs, memoryChatStore, REPO, trackedFolders, type FakeAdapters } from './__mocks__/fakeChatAdapter'
import { createSessionManager, type SessionManager } from './sessionManager'

const CUSTOM: AgentView = builtInAgent('cursor', { id: 'cu_01m65kwqqeyajbj5bnq81gngrb', kind: 'custom', displayName: 'My CLI', executablePath: '/opt/mine' })

interface Rig {
  manager: SessionManager
  fakes: FakeAdapters
  agents: AgentView[]
}

function rig(): Rig {
  const fakes = fakeAdapters()
  const agents = [builtInAgent('claude'), builtInAgent('codex'), CUSTOM]
  let itemCount = 0
  const manager = createSessionManager({
    store: memoryChatStore(memoryChatFs()),
    adapters: fakes.definitions,
    agentFor: (id) => connectedAgents(agents)(id),
    folders: trackedFolders(),
    issueChatCli: async (folder: string) => ({
      cli: { command: 'node', args: ['/app/out/main/cli.js', '--repo', folder], env: { DM_SESSION_TOKEN: 'dmg_test' } },
      grantId: 'gr_00000000000000000000000001'
    }),
    revokeChatGrant: async () => undefined,
    push: () => {},
    newId: () => `item_i${(itemCount += 1)}`,
    now: () => '2026-01-01T00:00:00.000Z'
  })
  return { manager, fakes, agents }
}

describe('session manager: ending the chats of a removed agent', () => {
  it('disposes the live processes of that agent only, and keeps its chats listed', async () => {
    const state = rig()
    const claudeChat = state.manager.createChat({ folder: REPO, agent: 'claude', role: 'planner', title: 'Plan' })
    const codexChat = state.manager.createChat({ folder: REPO, agent: 'codex', role: 'planner', title: 'Other' })
    await state.manager.send(claudeChat, 'Hello')
    await state.manager.send(codexChat, 'Hello')
    const [claude, codex] = [state.fakes.of('claude')[0], state.fakes.of('codex')[0]]
    expect(state.manager.liveCount()).toBe(2)

    state.agents.splice(0, 1)
    await state.manager.endAgentSessions('claude')

    expect(claude?.disposals).toBe(1)
    expect(codex?.disposals).toBe(0)
    expect(state.manager.liveCount()).toBe(1)
    expect(state.manager.listChats(REPO).map((chat) => chat.id).sort()).toEqual([claudeChat.id, codexChat.id].sort())
  })

  it('answers the next message of such a chat as not connected, without starting anything', async () => {
    const state = rig()
    const chat = state.manager.createChat({ folder: REPO, agent: 'claude', role: 'planner', title: 'Plan' })
    await state.manager.send(chat, 'Hello')

    state.agents.splice(0, 1)
    await state.manager.endAgentSessions('claude')

    await expect(state.manager.send(chat, 'Again')).rejects.toMatchObject({ code: 'not_found' })
    expect(state.fakes.of('claude')).toHaveLength(1)
  })

  it('does nothing for an agent with no live chat', async () => {
    const state = rig()

    await state.manager.endAgentSessions('cursor')

    expect(state.manager.liveCount()).toBe(0)
  })
})

describe('session manager: a custom CLI that asks to sign in', () => {
  const signedOut = (agent: string): ChatItem => ({ id: 'a1', at: AT, kind: 'auth_required', agent, message: 'Please log in' })
  /** Lets the turn's queued promise callbacks run, as `sessionManager.cutShort.test.ts` does; no clock is involved. */
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('records what it said but starts it again for the next message, since no status check could clear a lock', async () => {
    const state = rig()
    state.fakes.prepare = (adapter) => {
      adapter.turn = (self) => {
        if (self.sent.length === 1) {
          self.emit({ type: 'item', item: signedOut(CUSTOM.id) })
        }
        return Promise.resolve()
      }
    }
    const chat = state.manager.createChat({ folder: REPO, agent: CUSTOM.id, role: 'planner', title: 'Plan' })

    await state.manager.send(chat, 'Hello')
    await settle()
    await state.manager.send(chat, 'Logged in now')

    expect(state.manager.readChat(chat).items.filter((item) => item.kind === 'auth_required')).toHaveLength(1)
    expect(state.fakes.of('acp').flatMap((adapter) => adapter.sent)).toEqual(['Hello', 'Logged in now'])
    expect(state.manager.reconcileAuthStatus(CUSTOM.id, { state: 'unchecked', reason: 'r' })).toEqual({ state: 'unchecked', reason: 'r' })
  })

  it('still holds a built-in agent that asked to sign in until its status says signed in', async () => {
    const state = rig()
    state.fakes.prepare = (adapter) => {
      adapter.turn = (self) => {
        self.emit({ type: 'item', item: signedOut('claude') })
        return Promise.resolve()
      }
    }
    const chat = state.manager.createChat({ folder: REPO, agent: 'claude', role: 'planner', title: 'Plan' })

    await state.manager.send(chat, 'Hello')
    await settle()
    await state.manager.send(chat, 'Again')

    expect(state.fakes.of('claude').flatMap((adapter) => adapter.sent)).toEqual(['Hello'])
  })
})
