/**
 * How the Codex adapter ends a turn whose sign-in was rejected: one `auth_required` item, a clean end
 * of the turn, and no process left running. The recordings are built from the Codex source, not
 * captured from a running Codex; `__mocks__/codexSignedOut.ts` names where each shape comes from.
 */
import { describe, expect, it } from 'vitest'
import type { ChatAdapter, ChatAdapterEvent, ChatAdapterStartOptions, ChatItem } from '../../../shared/agents/chat'
import { replayTransport, step, type ReplayTransport, type Step } from '../__mocks__/codexReplay'
import {
  EXPIRED_MESSAGE,
  NEW_THREAD,
  NO_LOGIN_MESSAGE,
  RESUME_THREAD,
  REVOKED_MESSAGE,
  THREAD,
  TURN,
  failedTurn,
  failedTurnAfterText,
  reloginRefusal
} from '../__mocks__/codexSignedOut'
import { AT, REPO } from '../__mocks__/fakeChatAdapter'
import { createCodexAdapter } from './codex'

const OPTIONS: ChatAdapterStartOptions = {
  chatId: 'chat_1',
  folder: REPO,
  model: null,
  role: 'orchestrator',
  allowSave: false,
  sessionId: null,
  darkMechanicus: { command: 'node', args: ['/app/out/main/mcp.js', '--role', 'orchestrator', '--label', 'Codex · Run'], env: {} }
}

interface Rig {
  adapter: ChatAdapter
  events: ChatAdapterEvent[]
  transports: ReplayTransport[]
  items(): ChatItem[]
  authItems(): ChatItem[]
}

/** One recorded process per script, started in order; `start` has been called on the adapter. */
async function started(scripts: Step[][], options: Partial<ChatAdapterStartOptions> = {}): Promise<Rig> {
  const transports = scripts.map((script) => replayTransport(script))
  let connects = 0
  let ids = 0
  const events: ChatAdapterEvent[] = []
  const adapter = createCodexAdapter('/bin/codex', {
    connect: () => {
      const next = transports[connects]
      connects += 1
      if (next === undefined) {
        throw new Error('The test recorded no more connections.')
      }
      return next
    },
    newId: () => `n${(ids += 1)}`,
    now: () => AT,
    clientVersion: '9.9.9'
  })
  await adapter.start({ ...OPTIONS, ...options }, (event) => events.push(event))
  const items = (): ChatItem[] => events.flatMap((event) => (event.type === 'item' ? [event.item] : []))
  return { adapter, events, transports, items, authItems: () => items().filter((item) => item.kind === 'auth_required') }
}

function authItem(message: string): ChatItem {
  return { id: expect.stringMatching(/^codex_auth_/) as unknown as string, at: AT, kind: 'auth_required', agent: 'codex', message }
}

function transportOf(rig: Rig, index = 0): ReplayTransport {
  return rig.transports[index] as ReplayTransport
}

/** The handshake alone: what is recorded before a `thread/start` or `thread/resume` the server refuses. */
const INITIALIZE_ONLY: Step[] = NEW_THREAD.slice(0, 3)

const COMPLETED_TURN: Step[] = [
  step.expect('turn/start', { threadId: THREAD }),
  step.reply({ turn: { id: TURN, items: [], status: 'inProgress', error: null } }),
  step.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, items: [], status: 'completed', error: null } })
]

describe('Codex adapter: a rejected sign-in in a turn', () => {
  it('turns an expired login into one auth_required item and ends the turn without an error', async () => {
    const rig = await started([[...NEW_THREAD, ...failedTurn(EXPIRED_MESSAGE, 'unauthorized')]])

    await expect(rig.adapter.send('go')).resolves.toBeUndefined()

    expect(rig.items()).toEqual([authItem(EXPIRED_MESSAGE)])
    expect(transportOf(rig).remaining()).toEqual([])
  })

  it('leaves no process running for the turn', async () => {
    const rig = await started([[...NEW_THREAD, ...failedTurn(REVOKED_MESSAGE, 'unauthorized')]])

    await rig.adapter.send('go')

    expect(transportOf(rig).kills).toBe(1)
  })

  it('reads a 401 from the API (no login at all) as a rejected sign-in too', async () => {
    const rig = await started([[...NEW_THREAD, ...failedTurn(NO_LOGIN_MESSAGE, { httpConnectionFailed: { httpStatusCode: 401 } })]])

    await expect(rig.adapter.send('go')).resolves.toBeUndefined()

    expect(rig.items()).toEqual([authItem(NO_LOGIN_MESSAGE)])
    expect(transportOf(rig).kills).toBe(1)
  })

  it.each(['responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'])(
    'reads a 401 reported as %s the same way',
    async (kind) => {
      const rig = await started([[...NEW_THREAD, ...failedTurn(NO_LOGIN_MESSAGE, { [kind]: { httpStatusCode: 401 } })]])

      await rig.adapter.send('go')

      expect(rig.authItems()).toHaveLength(1)
    }
  )

  it('keeps what the turn said before the login was refused, and adds the item after it', async () => {
    const rig = await started([[...NEW_THREAD, ...failedTurnAfterText(EXPIRED_MESSAGE)]])

    await rig.adapter.send('go')

    expect(rig.items().map((item) => item.kind)).toEqual(['assistant_text', 'auth_required'])
  })

  it('starts a new process for the next turn and resumes the same thread, once the person signed in', async () => {
    const rig = await started([[...NEW_THREAD, ...failedTurn(EXPIRED_MESSAGE, 'unauthorized')], [...RESUME_THREAD, ...COMPLETED_TURN]])
    await rig.adapter.send('go')

    await expect(rig.adapter.send('go again')).resolves.toBeUndefined()

    expect(rig.authItems()).toHaveLength(1)
    expect(transportOf(rig, 1).remaining()).toEqual([])
  })
})

describe('Codex adapter: a sign-in refused before the turn runs', () => {
  it('reports it at the first message, not when the process starts, and kills the process that was refused', async () => {
    const refused = [...INITIALIZE_ONLY, step.expect('thread/start'), reloginRefusal(REVOKED_MESSAGE)]
    const rig = await started([refused, refused])

    expect(rig.items()).toEqual([])
    expect(transportOf(rig).kills).toBe(1)

    await expect(rig.adapter.send('go')).resolves.toBeUndefined()

    expect(rig.items()).toEqual([authItem(REVOKED_MESSAGE)])
    expect(transportOf(rig, 1).kills).toBe(1)
  })

  it('does not take a refused resume for a lost thread: no context reset, and the thread is resumed once signed in', async () => {
    const rig = await started(
      [
        [...INITIALIZE_ONLY, step.expect('thread/resume', { threadId: THREAD }), reloginRefusal(EXPIRED_MESSAGE)],
        [...RESUME_THREAD, ...COMPLETED_TURN]
      ],
      { sessionId: THREAD }
    )

    await rig.adapter.send('go')

    expect(rig.items()).toEqual([])
    expect(transportOf(rig, 1).remaining()).toEqual([])
  })

  it('reports a turn/start the app-server refuses with a re-login request', async () => {
    const rig = await started([[...NEW_THREAD, step.expect('turn/start'), reloginRefusal(EXPIRED_MESSAGE)]])

    await expect(rig.adapter.send('go')).resolves.toBeUndefined()

    expect(rig.items()).toEqual([authItem(EXPIRED_MESSAGE)])
    expect(transportOf(rig).kills).toBe(1)
  })

  it('still starts a thread normally when nothing was refused', async () => {
    const rig = await started([[...NEW_THREAD, ...COMPLETED_TURN]])

    await rig.adapter.send('go')

    expect(rig.items()).toEqual([])
    expect(transportOf(rig).kills).toBe(0)
  })
})

describe('Codex adapter: failures that are not a rejected sign-in', () => {
  it.each([
    ['usageLimitExceeded', 'You hit your usage limit'],
    ['serverOverloaded', 'Selected model is at capacity. Please try a different model.'],
    [{ httpConnectionFailed: { httpStatusCode: 500 } }, 'unexpected status 500 Internal Server Error: boom'],
    [{ httpConnectionFailed: { httpStatusCode: null } }, 'stream disconnected before completion']
  ])('still fails the turn for %j, and keeps the process', async (info, message) => {
    const rig = await started([[...NEW_THREAD, ...failedTurn(message, info)]])

    await expect(rig.adapter.send('go')).rejects.toThrow(message)

    expect(rig.items()).toEqual([])
    expect(transportOf(rig).kills).toBe(0)
  })

  it('still fails when a thread cannot start for a reason other than signing in', async () => {
    const rig = await started([[...INITIALIZE_ONLY, step.expect('thread/start'), step.fail(-32600, 'failed to load configuration: bad toml', { reason: 'config' })]]).catch(
      (error: unknown) => error
    )

    expect(rig).toBeInstanceOf(Error)
    expect((rig as Error).message).toContain('bad toml')
  })
})
