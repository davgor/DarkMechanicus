/**
 * How the Cursor adapter ends a turn whose sign-in was rejected: one `auth_required` item, a clean end
 * of the turn, and no process left running. The recordings come from Cursor's forum report and the
 * Agent Client Protocol specification, not from a running Cursor CLI; `__mocks__/cursorSignedOut.ts`
 * says where each shape is from.
 */
import { describe, expect, it } from 'vitest'
import type { ChatAdapter, ChatAdapterEvent, ChatAdapterStartOptions, ChatItem } from '../../../shared/agents/chat'
import { CLIENT_VERSION, DM_SERVER, FOLDER, handshake, newSession, prompt, say, turnEnd } from '../__mocks__/cursorRecordings'
import {
  AUTH_REQUIRED,
  SESSION,
  SIGN_IN_PROMPT,
  authenticateRefused,
  loadRefused,
  newSessionRefused,
  promptRefused,
  signedInAgain,
  staleProcess
} from '../__mocks__/cursorSignedOut'
import { ReplayAcpAgents, type Frame } from '../__mocks__/replayAcpAgent'
import { createCursorAdapter } from './cursor'

const AT = '2026-01-01T00:00:00.000Z'

interface Rig {
  adapter: ChatAdapter
  agents: ReplayAcpAgents
  events: ChatAdapterEvent[]
  start(overrides?: Partial<ChatAdapterStartOptions>): Promise<void>
  items(): ChatItem[]
  authItems(): ChatItem[]
  /** Whether each process the adapter started was killed, in the order they started. */
  killed(): boolean[]
  /** Every recorded exchange was followed to the letter, and every process but the last `alive` ones was killed. */
  expectReplayedAndGone(alive?: number): void
}

function rig(...recordings: Frame[][]): Rig {
  const agents = new ReplayAcpAgents(...recordings)
  const events: ChatAdapterEvent[] = []
  let ids = 0
  const adapter = createCursorAdapter('/opt/cursor/agent', {
    platform: 'linux',
    inspect: () => 'ok',
    transport: agents.factory,
    run: () => Promise.reject(new Error('no process runner in this test')),
    newId: () => `id_${(ids += 1)}`,
    now: () => AT,
    timers: { set: () => null, clear: () => {} },
    cancelGraceMs: 7_000,
    clientVersion: CLIENT_VERSION
  })
  const items = (): ChatItem[] => events.flatMap((event) => (event.type === 'item' ? [event.item] : []))
  const options: ChatAdapterStartOptions = {
    chatId: 'chat_1',
    folder: FOLDER,
    model: null,
    role: 'orchestrator',
    allowSave: false,
    sessionId: null,
    darkMechanicus: DM_SERVER
  }
  return {
    adapter,
    agents,
    events,
    start: (overrides = {}) => adapter.start({ ...options, ...overrides }, (event) => events.push(event)),
    items,
    authItems: () => items().filter((item) => item.kind === 'auth_required'),
    killed: () => agents.processes.map((process) => process.killed),
    expectReplayedAndGone(alive = 0) {
      expect(agents.problems).toEqual([])
      expect(agents.finished()).toBe(true)
      expect(agents.processes.slice(0, agents.processes.length - alive).every((process) => process.killed)).toBe(true)
    }
  }
}

function authItem(message: string): ChatItem {
  return { id: expect.any(String) as unknown as string, at: AT, kind: 'auth_required', agent: 'cursor', message }
}

describe('Cursor adapter: a login that went stale in a running process', () => {
  it('turns the sign-in prompt Cursor answers with into one auth_required item and ends the turn without an error', async () => {
    const target = rig(staleProcess())
    await target.start()

    await expect(target.adapter.send('hello')).resolves.toBeUndefined()

    expect(target.authItems()).toEqual([authItem(SIGN_IN_PROMPT)])
  })

  it('leaves no process running for the turn', async () => {
    const target = rig(staleProcess())
    await target.start()

    await target.adapter.send('hello')

    target.expectReplayedAndGone()
    expect(target.killed()).toEqual([true])
  })

  it('keeps the assistant text Cursor wrote, so what was streamed to the person has a stored line', async () => {
    const target = rig(staleProcess())
    await target.start()

    await target.adapter.send('hello')

    expect(target.items().map((item) => item.kind)).toEqual(['assistant_text', 'auth_required'])
  })

  it('takes the sign-in prompt with or without its full stop, in any case', async () => {
    for (const reply of ['Please sign in to continue.', 'please sign in to continue', ' Please sign in to continue \n']) {
      const target = rig([...handshake(), ...newSession(3, SESSION), prompt(4, SESSION, 'hello'), say(SESSION, reply), turnEnd(4)])
      await target.start()

      await target.adapter.send('hello')

      expect(target.authItems()).toHaveLength(1)
    }
  })

  it('starts a new process for the next message that loads the stored session, once the person signed in', async () => {
    const target = rig(staleProcess(), signedInAgain())
    await target.start()
    await target.adapter.send('hello')

    await expect(target.adapter.send('hello again')).resolves.toBeUndefined()

    expect(target.authItems()).toHaveLength(1)
    target.expectReplayedAndGone(1)
  })

  it.each([
    ['text around it', 'I cannot do that. Please sign in to continue, then ask again.'],
    ['a different sentence', 'Please sign in with your work account.'],
    ['a longer answer', 'Sure.\n\nPlease sign in to continue is what Cursor says when you are logged out.']
  ])('does not take %s for a rejected sign-in', async (_name, reply) => {
    const target = rig([...handshake(), ...newSession(3, SESSION), prompt(4, SESSION, 'hello'), say(SESSION, reply), turnEnd(4)])
    await target.start()

    await target.adapter.send('hello')

    expect(target.authItems()).toEqual([])
    expect(target.agents.processes[0]?.killed).toBe(false)
  })
})

describe('Cursor adapter: a login the agent refuses', () => {
  it('reports a refused prompt as one auth_required item, with the agent words, and kills the process', async () => {
    const target = rig(promptRefused())
    await target.start()

    await expect(target.adapter.send('hello')).resolves.toBeUndefined()

    expect(target.authItems()).toEqual([authItem(AUTH_REQUIRED.message)])
    expect(target.agents.processes[0]?.killed).toBe(true)
  })

  it('holds a refusal at start until the first message, which tries again with a new process', async () => {
    const target = rig(authenticateRefused(), authenticateRefused())

    await target.start()
    expect(target.items()).toEqual([])
    expect(target.agents.processes[0]?.killed).toBe(true)

    await expect(target.adapter.send('hello')).resolves.toBeUndefined()

    expect(target.authItems()).toEqual([authItem(AUTH_REQUIRED.message)])
    target.expectReplayedAndGone()
  })

  it('treats a refused session/new the same way', async () => {
    const target = rig(newSessionRefused(), newSessionRefused())
    await target.start()

    await target.adapter.send('hello')

    expect(target.authItems()).toHaveLength(1)
    target.expectReplayedAndGone()
  })

  it('does not take a refused session/load for a lost session: no context reset, and the session is loaded once signed in', async () => {
    const target = rig(loadRefused(), signedInAgain())

    await target.start({ sessionId: SESSION })
    await target.adapter.send('hello again')

    expect(target.items().filter((item) => item.kind === 'context_reset')).toEqual([])
    expect(target.authItems()).toEqual([])
    target.expectReplayedAndGone(1)
  })

  it('still fails a turn the agent refuses for another reason', async () => {
    const other: Frame[] = [...handshake(), ...newSession(3, SESSION)]
    const failing = [...other, prompt(4, SESSION, 'hello'), { from: 'agent', message: { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'Internal error' } } } as Frame]
    const target = rig(failing)
    await target.start()

    await expect(target.adapter.send('hello')).rejects.toThrow('Internal error')

    expect(target.authItems()).toEqual([])
  })
})
