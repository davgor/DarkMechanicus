import { describe, expect, it } from 'vitest'
import { createAgentAuthHandlers, type AgentAuthHandlers } from '../desktop/agentAuth'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { AgentAuthStatus, AgentKind, AgentSignInResult, AgentView } from '../../shared/desktop/api'
import { AT, fakeAdapters, memoryChatStore, REPO, type FakeAdapters } from './__mocks__/fakeChatAdapter'
import { createSessionManager, type SessionManager } from './sessionManager'
import { trackChatSignIn } from './signInHooks'

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' }
const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'Claude Code reports it is not signed in.' }
const UNKNOWN: AgentAuthStatus = { state: 'unknown', reason: 'Claude Code did not answer in time.' }

function connectedAgent(kind: AgentKind): AgentView {
  return { kind, executablePath: `/bin/${kind}`, version: '1.0.0', connectedVia: 'found', connectedAt: AT, lastProbed: AT }
}

interface World {
  sessions: SessionManager
  fakes: FakeAdapters
  /** The `agents:status` and `agents:signIn` handlers, as main wires them. */
  handlers: AgentAuthHandlers
  /** What the CLI's own status command says; the CLI can say "signed in" for a login that no longer works. */
  cliStatus: AgentAuthStatus
  /** What starting the CLI's sign-in answers. */
  signInResult: AgentSignInResult
  signIns: string[]
  /** What the sessions pushed to the renderer, in order. */
  pushed: ChatPushEvent[]
}

function world(): World {
  const fakes = fakeAdapters()
  const pushed: ChatPushEvent[] = []
  const sessions = createSessionManager({
    store: memoryChatStore(),
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['mcp.js', '--repo', folder], env: {} }),
    push: (event) => pushed.push(event),
    now: () => AT
  })
  const state: World = { sessions, fakes, handlers: undefined as never, cliStatus: SIGNED_IN, signInResult: { outcome: 'started' }, signIns: [], pushed }
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

const signedInEvents = (state: World): ChatPushEvent[] => state.pushed.filter((event) => event.type === 'agent_auth' && event.state === 'signed_in')

describe('the status the app shows, with what chats found out', () => {
  it('is what the CLI says while no chat found its sign-in gone', async () => {
    const state = world()

    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_IN)
  })

  it('says signed_out for the agent a chat found signed out while the CLI does not say signed in, and only for that agent', async () => {
    const state = world()
    await signedOutChat(state)
    state.cliStatus = UNKNOWN

    expect(await state.handlers.agentStatus('claude')).toMatchObject({ state: 'signed_out' })
    expect(await state.handlers.agentStatus('codex')).toEqual(UNKNOWN)
  })

  it('goes back to what the CLI says as soon as it says signed in, with no sign-in pressed in the app', async () => {
    const state = world()
    await signedOutChat(state)
    state.cliStatus = SIGNED_OUT
    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_OUT)

    // The person signed in from a terminal of their own.
    state.cliStatus = SIGNED_IN

    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_IN)
    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_IN)
    expect(state.signIns).toEqual([])
  })

  it('tells the opened chats that the agent is signed in, once, when a status check ends the flag', async () => {
    const state = world()
    await signedOutChat(state)
    expect(signedInEvents(state)).toEqual([])

    await state.handlers.agentStatus('claude')
    await state.handlers.agentStatus('claude')

    expect(signedInEvents(state)).toEqual([{ type: 'agent_auth', chatId: expect.any(String), agent: 'claude', state: 'signed_in' }])
  })

})

describe('the status the app shows, when the person signs in from the app', () => {
  it('goes back to what the CLI says once the person signed in from the app and the CLI reports it', async () => {
    const state = world()
    await signedOutChat(state)
    state.cliStatus = SIGNED_OUT

    expect(await state.handlers.signInAgent('claude')).toEqual({ outcome: 'started' })
    expect(state.signIns).toEqual(['claude'])
    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_OUT)
    state.cliStatus = SIGNED_IN
    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_IN)
    expect(await state.handlers.agentStatus('claude')).toEqual(SIGNED_IN)
  })

  it('stays signed_out when the sign-in could not be started and the CLI still says it is signed out', async () => {
    const state = world()
    await signedOutChat(state)
    state.cliStatus = SIGNED_OUT
    state.signInResult = { outcome: 'failed', reason: 'No terminal program was found to run the sign-in in.' }

    expect(await state.handlers.signInAgent('claude')).toEqual(state.signInResult)

    expect(await state.handlers.agentStatus('claude')).toMatchObject({ state: 'signed_out' })
    expect(signedInEvents(state)).toEqual([])
  })

  it('does not count a sign-in for an agent that is not connected', async () => {
    const state = world()
    await signedOutChat(state)
    state.cliStatus = SIGNED_OUT

    expect(await state.handlers.signInAgent('cursor')).toMatchObject({ outcome: 'not_connected' })

    expect(await state.handlers.agentStatus('claude')).toMatchObject({ state: 'signed_out' })
    expect(state.signIns).toEqual([])
  })
})
