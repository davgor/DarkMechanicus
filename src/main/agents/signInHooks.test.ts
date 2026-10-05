import { describe, expect, it } from 'vitest'
import { createAgentAuthHandlers, type AgentAuthHandlers } from '../desktop/agentAuth'
import type { AgentAuthStatus, AgentKind, AgentSignInResult, AgentView } from '../../shared/desktop/api'
import { AT, fakeAdapters, memoryChatStore, REPO, type FakeAdapters } from './__mocks__/fakeChatAdapter'
import { createSessionManager, type SessionManager } from './sessionManager'
import { trackChatSignIn } from './signInHooks'

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' }

function connectedAgent(kind: AgentKind): AgentView {
  return { kind, executablePath: `/bin/${kind}`, version: '1.0.0', connectedVia: 'found', connectedAt: AT, lastProbed: AT }
}

interface World {
  sessions: SessionManager
  fakes: FakeAdapters
  /** The `agents:status` and `agents:signIn` handlers, as main wires them. */
  handlers: AgentAuthHandlers
  /** What the CLI's own status command says; the CLI cannot see that its login expired. */
  cliStatus: AgentAuthStatus
  /** What starting the CLI's sign-in answers. */
  signInResult: AgentSignInResult
  signIns: string[]
}

function world(): World {
  const fakes = fakeAdapters()
  const sessions = createSessionManager({
    store: memoryChatStore(),
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['mcp.js', '--repo', folder], env: {} }),
    push: () => {},
    now: () => AT
  })
  const state: World = { sessions, fakes, handlers: undefined as never, cliStatus: SIGNED_IN, signInResult: { outcome: 'started' }, signIns: [] }
  state.handlers = createAgentAuthHandlers(
    { list: () => [connectedAgent('claude'), connectedAgent('codex')] },
    trackChatSignIn(
      {
        checkAuth: () => Promise.resolve(state.cliStatus),
        signIn: (kind) => (state.signIns.push(kind), Promise.resolve(state.signInResult))
      },
      sessions
    )
  )
  return state
}

/** A chat of `kind` whose turn ends because the CLI says its sign-in is gone. */
async function signedOutChat(state: World, kind: AgentKind = 'claude'): Promise<void> {
  state.fakes.prepare = (adapter) => {
    adapter.turn = (self) => {
      self.emit({ type: 'item', item: { id: 'a1', at: AT, kind: 'auth_required', agent: kind === 'codex' ? 'codex' : 'claude', message: 'Please sign in again.' } })
      return Promise.resolve()
    }
  }
  const chat = state.sessions.createChat({ folder: REPO, agent: kind, role: 'planner' })
  await state.sessions.send(chat, 'go')
  await new Promise((resolve) => setImmediate(resolve))
}

describe('the status the app shows, with what chats found out', () => {
  it('is what the CLI says while no chat found its sign-in gone', async () => {
    const state = world()

    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_IN)
  })

  it('says signed_out for the agent a chat found signed out, even when the CLI still says signed in, and only for that agent', async () => {
    const state = world()
    await signedOutChat(state)

    expect(await state.handlers.agentStatus('claude')).toMatchObject({ state: 'signed_out' })
    expect(await state.handlers.agentStatus('codex')).toEqual(SIGNED_IN)
  })

  it('goes back to what the CLI says once the person signed in and the CLI reports it', async () => {
    const state = world()
    await signedOutChat(state)

    expect(await state.handlers.signInAgent('claude')).toEqual({ outcome: 'started' })
    expect(state.signIns).toEqual(['claude'])
    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_IN)
    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_IN)
  })

  it('stays signed_out when the sign-in could not be started', async () => {
    const state = world()
    await signedOutChat(state)
    state.signInResult = { outcome: 'failed', reason: 'No terminal program was found to run the sign-in in.' }

    expect(await state.handlers.signInAgent('claude')).toEqual(state.signInResult)

    expect(await state.handlers.agentStatus('claude')).toMatchObject({ state: 'signed_out' })
  })

  it('does not count a sign-in for an agent that is not connected', async () => {
    const state = world()
    await signedOutChat(state)

    expect(await state.handlers.signInAgent('cursor')).toMatchObject({ outcome: 'not_connected' })

    expect(await state.handlers.agentStatus('claude')).toMatchObject({ state: 'signed_out' })
    expect(state.signIns).toEqual([])
  })
})
