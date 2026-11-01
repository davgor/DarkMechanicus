/**
 * Ending terminals: the held quit (`disposeBeforeQuit` over the manager's `busy` and `dispose`) waits until every
 * PTY tree has exited, for at most five seconds, and starts nothing after; deleting a chat or removing its agent
 * kills its PTY.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRef } from '../agents/chatStore'
import { disposeBeforeQuit, type QuitApp } from '../quitDisposal'
import { CUSTOM_AGENT, eventually, gate, recorder, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'
import { endingTerminals } from './terminalSessions'

/** The quit's bound, as `src/main/index.ts` passes it. */
const QUIT_BOUND_MS = 5_000

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  rig.cleanup()
})

/** Electron's `app` as the quit sees it, with the bound's timer held by the test. */
class FakeApp implements QuitApp {
  quits = 0
  prevented = 0
  readonly timers: { callback: () => void; ms: number }[] = []
  private listener: ((event: { preventDefault(): void }) => void) | null = null

  on(_eventName: 'before-quit', listener: (event: { preventDefault(): void }) => void): this {
    this.listener = listener
    return this
  }

  quit(): void {
    this.quits += 1
    this.beforeQuit()
  }

  /** The person quits (or the app quits again). */
  beforeQuit(): void {
    this.listener?.({
      preventDefault: () => {
        this.prevented += 1
      }
    })
  }
}

function holdQuit(app: FakeApp): void {
  disposeBeforeQuit(app, {
    busy: () => rig.sessions.busy(),
    dispose: () => rig.sessions.dispose(),
    release: () => {},
    timeoutMs: QUIT_BOUND_MS,
    timer: {
      set: (callback, ms) => {
        app.timers.push({ callback, ms })
      }
    }
  })
}

describe('terminal sessions: quit', () => {
  it('holds the quit until every PTY has reported its exit, even when the tree kills settle first', async () => {
    rig.cleanup()
    // Kills that report at once: only waiting for each PTY's own exit holds the quit now.
    rig = terminalRig({ killSettlesAtOnce: true })
    const one = await startTerminal(rig, rig.newChat())
    const two = await startTerminal(rig, rig.newChat(CUSTOM_AGENT.id))
    const app = new FakeApp()
    holdQuit(app)

    app.beforeQuit()
    expect([app.prevented, rig.killed.map((tree) => tree.pid)]).toEqual([1, [one.pid, two.pid]])
    one.pty.exit({ exitCode: 0, signal: 9 })
    await settle()
    expect(app.quits).toBe(0)
    two.pty.exit({ exitCode: 0, signal: 9 })
    await eventually(() => app.quits > 0, 'the quit')

    expect([app.quits, [...rig.revoked].sort()]).toEqual([1, ['gr_1', 'gr_2']])
  })

  it('quits after five seconds when a PTY tree does not exit', async () => {
    await startTerminal(rig, rig.newChat())
    const app = new FakeApp()
    holdQuit(app)

    app.beforeQuit()
    await settle()
    expect([app.quits, app.timers.map((timer) => timer.ms)]).toEqual([0, [QUIT_BOUND_MS]])
    app.timers[0]?.callback()
    await eventually(() => app.quits > 0, 'the bounded quit')

    expect(rig.revoked).toEqual(['gr_1'])
  })

  it('lets the quit straight through when no terminal runs', () => {
    const app = new FakeApp()
    holdQuit(app)

    app.beforeQuit()

    expect([app.prevented, app.quits]).toEqual([0, 0])
  })

  it('cancels a start in its sign-in check without waiting for the check, and starts nothing after', async () => {
    const held = rig.holdAuth()
    const chat = rig.newChat('autonomous')
    const heard = recorder()
    expect(await rig.sessions.attach(chat, heard.listener)).toEqual({ state: 'checking' })
    expect(rig.sessions.busy()).toBe(true)

    await rig.sessions.dispose()
    held.open({ state: 'signed_in', reason: 'Signed in.' })
    await settle()

    const quitting = 'The app is quitting, so the terminal was stopped.'
    expect(heard.events).toEqual([{ kind: 'not_started', state: 'failed', message: quitting }])
    expect(await rig.sessions.attach(chat)).toEqual({ state: 'failed', message: quitting })
    expect([rig.steps, rig.host.spawns, rig.sessions.busy()]).toEqual([['auth'], [], false])
  })
})

describe('terminal sessions: deleting a chat', () => {
  it('kills the PTY of a chat being deleted, and deletes the chat only once the kill has settled', async () => {
    const chat = rig.newChat()
    const heard = recorder()
    const { pty } = await startTerminal(rig, chat, heard.listener)
    const deleted: string[] = []
    const chats = endingTerminals(
      {
        deleteChat: async (ref: ChatRef) => {
          deleted.push(`${ref.id}, exited: ${String(pty.exited)}`)
        }
      },
      rig.sessions
    )

    const deleting = chats.deleteChat(chat)
    expect(rig.killed.map((tree) => tree.pid)).toEqual([pty.pid])
    await settle()
    expect(deleted).toEqual([])
    pty.exit({ exitCode: 0, signal: 9 })
    await deleting
    await eventually(() => heard.events.some((event) => event.kind === 'exited'), 'the stop to be told')

    expect(deleted).toEqual([`${chat.id}, exited: true`])
    expect(rig.revoked).toEqual(['gr_1'])
    expect(heard.events.at(-1)).toMatchObject({ kind: 'exited', message: 'The chat was deleted, so its terminal was stopped.' })
  })
})

describe('terminal sessions: removing an agent', () => {
  it("kills a removed agent's PTY through endAgent itself, before it exits", async () => {
    const custom = await startTerminal(rig, rig.newChat(CUSTOM_AGENT.id))
    const claude = await startTerminal(rig, rig.newChat())

    const removing = rig.sessions.endAgent(CUSTOM_AGENT.id)
    expect([rig.killed.map((tree) => tree.pid), custom.pty.kills, rig.revoked]).toEqual([[custom.pid], 1, ['gr_1']])
    let settled = false
    void removing.then(() => (settled = true))
    await settle()
    expect(settled).toBe(false)
    custom.pty.exit({ exitCode: 0, signal: 9 })
    await removing

    expect(claude.pty.kills).toBe(0)
  })
})

describe('terminal sessions: starts while a chat is being deleted', () => {
  it('cancels the start of a chat being deleted, before its grant', async () => {
    const held = rig.holdAuth()
    const chat = rig.newChat()
    await rig.sessions.attach(chat)

    await rig.sessions.deleteChat(chat, async () => {})
    held.open({ state: 'signed_in', reason: 'Signed in.' })
    await settle()

    expect([rig.steps, rig.host.spawns, rig.sessions.busy()]).toEqual([['auth'], [], false])
  })

  it('starts nothing for the chat while its record is being removed, nor after', async () => {
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const { pty } = await startTerminal(rig, chat)
    const removal = gate<void>()
    const deleting = rig.sessions.deleteChat(chat, async () => {
      await removal.promise
      rig.store.deleteChat(chat)
    })
    pty.exit({ exitCode: 0, signal: 9 })
    await settle()

    const during = await rig.sessions.attach(chat)
    removal.open()
    await deleting
    const after = await rig.sessions.attach(chat)

    expect(during).toEqual({ state: 'refused', message: 'The chat was deleted, so its terminal was stopped.' })
    expect(after).toEqual({ state: 'refused', message: `No chat ${chat.id} in ${rig.repo}.` })
    expect([rig.host.spawns.length, rig.grantsAsked]).toEqual([1, 1])
  })
})
