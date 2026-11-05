/**
 * The terminal session manager at its edges: the defaults it falls back on when a dependency is left out (Node's
 * timers, random session ids, errors dropped), dependencies that fail (a sign-in check, a revoke, a renewal, a tree
 * kill), a start cancelled while its grant is still being issued, and calls that come at the wrong moment (an attach
 * while a stop is under way or just as the PTY exits, a quit while a renewal is under way, a start after quit, input
 * for a chat with no PTY).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CUSTOM_AGENT, eventually, gate, recorder, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'
import type { TerminalEvent } from './terminalSessions'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DELETED = 'The chat was deleted, so its terminal was stopped.'
const AGENT_REMOVED = "The chat's agent was removed, so its terminal was stopped."
const QUITTING = 'The app is quitting, so the terminal was stopped.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  vi.useRealTimers()
  rig.cleanup()
})

function exitOf(events: TerminalEvent[]): TerminalEvent | undefined {
  return events.find((event) => event.kind === 'exited')
}

function errorMessages(): string[] {
  return rig.errors.map((error) => (error instanceof Error ? error.message : String(error)))
}

describe('terminal sessions: defaults', () => {
  it('renews the grant on Node timers when none are given, and leaves no timer behind once the PTY has exited', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'], shouldAdvanceTime: true })
    rig.cleanup()
    rig = terminalRig({ deps: () => ({ timers: undefined }) })
    const heard = recorder()
    const { pty } = await startTerminal(rig, rig.newChat(CUSTOM_AGENT.id), heard.listener)

    // A minute short, not a millisecond: the fake timers also run on with real time.
    vi.advanceTimersByTime(HOUR - MINUTE)
    expect(rig.renewed).toEqual([])
    vi.advanceTimersByTime(MINUTE)
    expect([rig.renewed, pty.kills, rig.revoked]).toEqual([['gr_1'], 0, []])
    pty.exit({ exitCode: 0, signal: null })
    await eventually(() => exitOf(heard.events) !== undefined, 'the exit to be told')

    expect(exitOf(heard.events)).toEqual({ kind: 'exited', exitCode: 0, signal: null, message: null, resumed: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs a PTY with nothing to keep the computer awake when none is given', async () => {
    rig.cleanup()
    rig = terminalRig({ deps: () => ({ keepAwake: undefined }) })
    const heard = recorder()
    const { pty } = await startTerminal(rig, rig.newChat(CUSTOM_AGENT.id), heard.listener)

    pty.exit({ exitCode: 0, signal: null })
    await eventually(() => exitOf(heard.events) !== undefined, 'the exit to be told')

    expect([rig.awake, rig.errors]).toEqual([0, []])
  })

  it('starts Claude Code on a random session id when no generator is given', async () => {
    rig.cleanup()
    rig = terminalRig({ deps: () => ({ newSessionId: undefined }) })
    const chat = rig.newChat()

    const { pty } = await startTerminal(rig, chat)

    const args = pty.spec.args as string[]
    const sessionId = args[args.indexOf('--session-id') + 1] ?? ''
    expect(sessionId).toMatch(UUID)
    expect(rig.reopenedStore().getChat(chat)?.sessionId).toBe(sessionId)
  })

  it('keeps telling other listeners when one throws and no error handler is given', async () => {
    rig.cleanup()
    rig = terminalRig({ deps: () => ({ onError: undefined }) })
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const heard = recorder()
    const { pty } = await startTerminal(rig, chat, () => {
      throw new Error('The view is gone.')
    })
    await rig.sessions.attach(chat, heard.listener)

    pty.emitData('still here')
    await eventually(() => heard.events.length > 0, 'the output to be heard')

    expect(heard.events).toEqual([{ kind: 'output', data: 'still here' }])
  })
})

describe('terminal sessions: dependencies that fail', () => {
  it('starts a built-in CLI when its sign-in check fails rather than answers', async () => {
    rig.cleanup()
    rig = terminalRig({
      deps: () => ({
        checkAuth: async () => {
          throw new Error('The status check timed out.')
        }
      })
    })

    const { pid } = await startTerminal(rig, rig.newChat())

    expect(rig.host.spawns.map((pty) => pty.pid)).toEqual([pid])
  })

  it('reports a revoke that fails, and still tells the exit and frees the chat', async () => {
    rig.cleanup()
    rig = terminalRig({
      deps: (base) => ({
        revokeChatGrant: async (grantId) => {
          base.revoked.push(grantId)
          throw new Error('The grant store is locked.')
        }
      })
    })
    const heard = recorder()
    const { pty } = await startTerminal(rig, rig.newChat(CUSTOM_AGENT.id), heard.listener)

    pty.exit({ exitCode: 2, signal: null })
    await eventually(() => !rig.sessions.busy(), 'the chat to be free')

    expect(exitOf(heard.events)).toEqual({ kind: 'exited', exitCode: 2, signal: null, message: null, resumed: false })
    expect([rig.revoked, errorMessages()]).toEqual([['gr_1'], ['The grant store is locked.']])
  })

  it('reports a tree kill that fails, and starts the chat again afterwards', async () => {
    rig.cleanup()
    rig = terminalRig({
      deps: () => ({
        killTree: async () => {
          throw new Error('ps is missing.')
        }
      })
    })
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const first = await startTerminal(rig, chat)

    first.pty.exit()
    await eventually(() => errorMessages().length > 0, 'the kill to fail')
    const second = await startTerminal(rig, chat)

    expect(errorMessages()).toEqual(['ps is missing.'])
    expect(second.pid).not.toBe(first.pid)
    expect(rig.host.spawns).toHaveLength(2)
  })
})

describe('terminal sessions: grant renewals', () => {
  it('reports a renewal that fails, keeps the PTY running, and renews again the next hour', async () => {
    rig.cleanup()
    let renewals = 0
    rig = terminalRig({
      deps: () => ({
        renewChatGrant: async () => {
          renewals += 1
          throw new Error('The grant store is locked.')
        }
      })
    })
    const { pty } = await startTerminal(rig, rig.newChat(CUSTOM_AGENT.id))

    rig.clock.advance(2 * HOUR)
    await settle()

    expect([renewals, pty.kills, rig.revoked]).toEqual([2, 0, []])
    expect(errorMessages()).toEqual(['The grant store is locked.', 'The grant store is locked.'])
  })

  it('holds the quit until a renewal under way has settled', async () => {
    rig.cleanup()
    const renewal = gate<void>()
    rig = terminalRig({ deps: () => ({ renewChatGrant: () => renewal.promise }) })
    const { pty } = await startTerminal(rig, rig.newChat(CUSTOM_AGENT.id))
    rig.clock.advance(HOUR)
    let quit = false

    const quitting = rig.sessions.dispose().then(() => {
      quit = true
    })
    pty.exit({ exitCode: 0, signal: 9 })
    await settle()
    expect([quit, rig.sessions.busy()]).toEqual([false, true])
    renewal.open()
    await quitting

    expect([quit, rig.sessions.busy(), rig.revoked]).toEqual([true, false, ['gr_1']])
  })
})

describe('terminal sessions: starts cancelled part way', () => {
  it('revokes a grant issued after its start was cancelled by a delete, and spawns nothing', async () => {
    const grant = rig.holdGrant()
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const attaching = rig.sessions.attach(chat)
    await eventually(() => rig.grantsAsked === 1, 'the grant to be asked for')
    let removed = false

    await rig.sessions.deleteChat(chat, async () => {
      removed = true
    })
    expect(await attaching).toEqual({ state: 'failed', message: DELETED })
    expect([removed, rig.revoked]).toEqual([true, []])
    grant.open()
    await eventually(() => rig.revoked.length > 0, 'the late grant to be revoked')

    expect(rig.revoked).toEqual(['gr_1'])
    expect(rig.host.spawns).toEqual([])
  })

  it('cancels a sign-in check under way when its agent is removed, telling the waiting view why', async () => {
    const auth = rig.holdAuth()
    const chat = rig.newChat()
    const heard = recorder()
    expect(await rig.sessions.attach(chat, heard.listener)).toEqual({ state: 'checking' })

    await rig.sessions.endAgent('claude')
    await eventually(() => heard.events.length > 0, 'the start to end')
    auth.open({ state: 'signed_in', reason: 'Signed in.' })
    await settle()

    expect(heard.events).toEqual([{ kind: 'not_started', state: 'failed', message: AGENT_REMOVED }])
    expect([rig.host.spawns, rig.sessions.busy()]).toEqual([[], false])
  })

  it('pastes nothing into a CLI that exits before it turns bracketed paste on, and leaves no timer behind', async () => {
    const chat = rig.newOrchestrator('rn_2', 'autonomous')
    const started = await rig.sessions.start(chat, { kickoff: 'Run the epic.' })
    const pty = rig.host.last()
    expect(started).toEqual({ state: 'running', pid: pty.pid })

    pty.exit({ exitCode: 1, signal: null })
    await settle()
    rig.clock.advance(MINUTE)

    expect(pty.written).toEqual([])
    expect(rig.clock.pending).toBe(0)
    expect(rig.reopenedStore().getChat(chat)?.kickoffSent).toBeUndefined()
  })
})

describe('terminal sessions: attaches at awkward moments', () => {
  it('refuses an attach while a stop is under way, saying why, and starts again once the PTY has exited', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const { pty } = await startTerminal(rig, chat)
    // The folder watch stops it; the folder is tracked again before the PTY has exited.
    rig.tracked.delete(rig.repo)
    rig.clock.advance(MINUTE)
    rig.tracked.add(rig.repo)
    const message = `The folder ${rig.repo} is no longer tracked. Track the folder again to keep using this chat.`

    expect(await rig.sessions.attach(chat)).toEqual({ state: 'refused', message })
    pty.exit({ exitCode: 0, signal: 9 })
    await settle()
    const again = await startTerminal(rig, chat)

    expect(again.pid).not.toBe(pty.pid)
  })

  it('answers an attach with no listener for a CLI that exits as it starts with its last screen, without starting it again', async () => {
    rig.host.onSpawn = (pty) => {
      queueMicrotask(() => {
        pty.emitData('error: unknown flag\r\n')
        pty.exit({ exitCode: 1, signal: null })
      })
    }

    const answer = await rig.sessions.attach(rig.newChat(CUSTOM_AGENT.id))

    expect(answer).toMatchObject({ state: 'running', pid: rig.host.last().pid })
    expect(answer.state === 'running' ? answer.snapshot : '').toContain('error: unknown flag')
    expect(rig.host.spawns).toHaveLength(1)
  })

  it('starts a new PTY for an attach that arrives just as the last one exits, once that exit has been told', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const heard = recorder()
    const first = await startTerminal(rig, chat, heard.listener)

    first.pty.exit()
    const answer = await rig.sessions.attach(chat)

    const second = rig.host.last()
    expect(second.pid).not.toBe(first.pid)
    expect(answer).toMatchObject({ state: 'running', pid: second.pid })
    expect(exitOf(heard.events)).toMatchObject({ kind: 'exited', exitCode: 0 })
  })
})

describe('terminal sessions: Start run and deletes at the edges', () => {
  it('answers Start run with the PTY already running, and starts no other', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const { pid } = await startTerminal(rig, chat)

    expect(await rig.sessions.start(chat, { kickoff: 'Run the epic.' })).toEqual({ state: 'running', pid })
    expect(rig.host.spawns).toHaveLength(1)
  })

  it('refuses Start run for a chat the store does not have, and fails it once the app is quitting', async () => {
    const missing = { folder: rig.repo, id: 'ch_missing' }

    expect(await rig.sessions.start(missing, { kickoff: 'Run the epic.' })).toEqual({ state: 'refused', message: `No chat ch_missing in ${rig.repo}.` })
    await rig.sessions.dispose()
    expect(await rig.sessions.start(rig.newChat(CUSTOM_AGENT.id), { kickoff: 'Run the epic.' })).toEqual({ state: 'failed', message: QUITTING })
    expect(rig.host.spawns).toEqual([])
  })

  it('leaves the delete of a chat it does not have to the store', async () => {
    let removed = false

    await rig.sessions.deleteChat({ folder: rig.repo, id: 'ch_missing' }, async () => {
      removed = true
    })

    expect(removed).toBe(true)
  })

  it('drops input and sizes for a chat whose PTY is not running yet', async () => {
    const auth = rig.holdAuth()
    const chat = rig.newChat()
    await rig.sessions.attach(chat)

    rig.sessions.write(chat.id, 'early')
    rig.sessions.resize(chat.id, 120, 40)
    auth.open({ state: 'signed_in', reason: 'Signed in.' })
    const { pty } = await startTerminal(rig, chat)

    expect([pty.written, pty.sizes]).toEqual([[], []])
  })
})
