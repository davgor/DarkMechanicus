/**
 * `paste`, Kick back's way into a chat's terminal (`docs/design/chat-shells.md`, "The card chat Play opens"): the text
 * goes into the chat's running PTY as one bracketed paste and Enter as a keypress of its own, after any paste still
 * waiting and once the CLI's input is live and its screen has settled; a chat with no PTY is started first, as an
 * attach starts it, never with the kickoff. On the fake PTY host and the fake clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import type { FakePty } from './__mocks__/fakePtyHost'
import { claudeSessionFile, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

const SECOND = 1_000
/** How long after a paste its Enter goes. */
const ENTER_DELAY = 500
/** What a TUI writes to turn bracketed paste on, once its input is live. */
const PASTE_ON = '\x1b[?2004h'
const KICKOFF = 'Carry this Dark Mechanicus Kanban card to Ready for review as its orchestrator.'
const MESSAGE = 'DM-42 was kicked back by a person: Cover the empty file.\nClaim it again.'

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  rig.cleanup()
})

/** What a person pasting `text` sends, as xterm.js sends it: newlines as CR, between the paste marks; then Enter. */
function pasteOf(text: string): string[] {
  return [`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`, '\r']
}

/** The CLI draws `data` with its input live (bracketed paste on), and the screen has taken it. */
async function draw(pty: FakePty, data: string): Promise<void> {
  pty.emitData(`${PASTE_ON}${data}`)
  await settle()
}

function stored(chat: ChatRecord): ChatRecord | undefined {
  return rig.reopenedStore().listChats(rig.repo).find((candidate) => candidate.id === chat.id)
}

describe('terminal sessions: paste into a running terminal', () => {
  it('pastes at once into a CLI whose screen has settled, then presses Enter as its own keypress half a second later', async () => {
    const chat = rig.newChat('claude')
    const { pty } = await startTerminal(rig, chat)
    await draw(pty, 'Claude Code')
    rig.clock.advance(5 * SECOND)

    expect(await rig.sessions.paste(chat, MESSAGE)).toEqual({ state: 'running', pid: pty.pid })

    expect(pty.written).toEqual(pasteOf(MESSAGE).slice(0, 1))
    rig.clock.advance(ENTER_DELAY - 1)
    expect(pty.written).toEqual(pasteOf(MESSAGE).slice(0, 1))
    rig.clock.advance(1)
    expect(pty.written).toEqual(pasteOf(MESSAGE))
    expect(rig.host.spawns).toHaveLength(1)
  })

  it('waits for a CLI that has not turned bracketed paste on yet, and for its screen to go quiet for a second', async () => {
    const chat = rig.newChat('claude')
    const { pty } = await startTerminal(rig, chat)
    pty.emitData('Starting…')
    await settle()

    await rig.sessions.paste(chat, MESSAGE)
    rig.clock.advance(10 * SECOND)
    expect(pty.written).toEqual([])

    await draw(pty, '> ')
    rig.clock.advance(SECOND - 1)
    expect(pty.written).toEqual([])
    rig.clock.advance(1 + ENTER_DELAY)
    expect(pty.written).toEqual(pasteOf(MESSAGE))
  })

  it('pastes a second after the screen last took output, not a second after the paste was asked for', async () => {
    const chat = rig.newChat('claude')
    const { pty } = await startTerminal(rig, chat)
    await draw(pty, 'Claude Code')
    rig.clock.advance(400)

    await rig.sessions.paste(chat, MESSAGE)
    rig.clock.advance(SECOND - 400 - 1)
    expect(pty.written).toEqual([])
    rig.clock.advance(1)
    expect(pty.written).toEqual(pasteOf(MESSAGE).slice(0, 1))
  })
})

describe('terminal sessions: pastes one after another', () => {
  it('queues behind a first paste still waiting: the kickoff and its Enter go first, then the text, never one inside the other', async () => {
    const chat = rig.newOrchestrator('rn_2', 'autonomous')
    await rig.sessions.start(chat, { kickoff: KICKOFF })
    const pty = rig.host.last()

    await rig.sessions.paste(chat, MESSAGE)
    await draw(pty, 'Autonomous')
    rig.clock.advance(SECOND)
    expect(pty.written).toEqual(pasteOf(KICKOFF).slice(0, 1))
    rig.clock.advance(ENTER_DELAY)
    expect(pty.written).toEqual(pasteOf(KICKOFF))
    expect(stored(chat)?.kickoffSent).toBe(true)

    // The CLI echoes the kickoff; the text waits until the screen is quiet again.
    pty.emitData('kickoff echoed')
    await settle()
    rig.clock.advance(SECOND - 1)
    expect(pty.written).toEqual(pasteOf(KICKOFF))
    rig.clock.advance(1 + ENTER_DELAY)
    expect(pty.written).toEqual([...pasteOf(KICKOFF), ...pasteOf(MESSAGE)])
  })

  it('pastes two texts one after the other, each with its own Enter', async () => {
    const chat = rig.newChat('claude')
    const { pty } = await startTerminal(rig, chat)
    await draw(pty, 'Claude Code')
    rig.clock.advance(SECOND)

    await rig.sessions.paste(chat, 'first')
    await rig.sessions.paste(chat, 'second')
    rig.clock.advance(ENTER_DELAY)
    rig.clock.advance(SECOND + ENTER_DELAY)

    expect(pty.written).toEqual([...pasteOf('first'), ...pasteOf('second')])
  })
})

describe('terminal sessions: paste into a chat with no running terminal', () => {
  it('starts the chat on its session, with no kickoff even when none was sent, and pastes once the screen has settled', async () => {
    const chat = rig.newOrchestrator('rn_2')
    const first = await startTerminal(rig, chat)
    claudeSessionFile(rig, stored(chat)?.sessionId ?? '', true)
    first.pty.exit({ exitCode: 0, signal: null })
    await settle()
    expect(stored(chat)?.kickoffSent).toBeUndefined()

    const answer = await rig.sessions.paste(chat, MESSAGE)
    const resumed = rig.host.last()

    expect(answer).toEqual({ state: 'running', pid: resumed.pid })
    expect(rig.host.spawns).toHaveLength(2)
    expect(resumed.spec.args).toEqual(expect.arrayContaining(['--resume']))
    expect((resumed.spec.args as string[]).join('\n')).not.toContain(KICKOFF)
    expect(rig.host.kickoffSentAtSpawn).toEqual([false, false])
    await draw(resumed, 'Claude Code')
    rig.clock.advance(SECOND + ENTER_DELAY)
    expect(resumed.written).toEqual(pasteOf(MESSAGE))
  })

  it('waits out a terminal being stopped and pastes into the one it starts again', async () => {
    const chat = rig.newChat('claude')
    const { pty } = await startTerminal(rig, chat)
    // The folder watch stops it; the folder is tracked again before the PTY has exited.
    rig.tracked.delete(rig.repo)
    rig.clock.advance(60 * SECOND)
    rig.tracked.add(rig.repo)
    expect(pty.kills).toBe(1)

    const answer = rig.sessions.paste(chat, MESSAGE)
    pty.exit({ exitCode: 0, signal: 9 })
    const restarted = await answer

    expect(rig.host.spawns).toHaveLength(2)
    expect(restarted).toEqual({ state: 'running', pid: rig.host.last().pid })
    await draw(rig.host.last(), 'Claude Code')
    rig.clock.advance(SECOND + ENTER_DELAY)
    expect(rig.host.last().written).toEqual(pasteOf(MESSAGE))
    expect(pty.written).toEqual([])
  })

})

describe('terminal sessions: a paste with no terminal to go into', () => {
  it('answers why when the chat cannot start, and starts no terminal for a chat that is gone', async () => {
    const chat = rig.newChat('claude')
    rig.auth.status = { state: 'signed_out', reason: 'Claude Code is signed out.' }
    expect(await rig.sessions.paste(chat, MESSAGE)).toEqual({ state: 'signed_out', message: 'Claude Code is signed out.' })

    rig.store.deleteChat(chat)
    expect(await rig.sessions.paste(chat, MESSAGE)).toMatchObject({ state: 'refused' })
    expect(rig.host.spawns).toEqual([])
  })

  it('answers failed, and does not start it over and over, when the CLI it starts exits at once', async () => {
    rig.host.onSpawn = (pty) => {
      queueMicrotask(() => {
        pty.exit({ exitCode: 1, signal: null })
      })
    }
    const chat = rig.newChat('claude')

    const answer = await rig.sessions.paste(chat, MESSAGE)

    expect(answer).toEqual({ state: 'failed', message: 'The terminal exited before the text could be pasted.' })
    expect(rig.host.spawns.length).toBeLessThanOrEqual(2)
  })
})

describe('terminal sessions: what a paste never does', () => {
  it('takes every control character out of the text, so nothing in it ends the paste early or acts as a key', async () => {
    const chat = rig.newChat('claude')
    const { pty } = await startTerminal(rig, chat)
    await draw(pty, 'Claude Code')
    rig.clock.advance(SECOND)

    await rig.sessions.paste(chat, 'Stop\x1b[201~\x03 here\x1b[A\x7f\x9b2J\tnow')

    expect(pty.written).toEqual(['\x1b[200~Stop[201~ here[A2J\tnow\x1b[201~'])
  })

  it('drops a waiting paste when the CLI exits before its input is live, and leaves no timer behind', async () => {
    const chat = rig.newChat('claude')
    const { pty } = await startTerminal(rig, chat)

    await rig.sessions.paste(chat, MESSAGE)
    pty.exit({ exitCode: 1, signal: null })
    await settle()
    rig.clock.advance(60 * SECOND)

    expect(pty.written).toEqual([])
    expect(rig.clock.pending).toBe(0)
    expect(rig.host.spawns).toHaveLength(1)
  })

  it('presses no Enter into a CLI that exits between the paste and its Enter', async () => {
    const chat = rig.newChat('claude')
    const { pty } = await startTerminal(rig, chat)
    await draw(pty, 'Claude Code')
    rig.clock.advance(SECOND)

    await rig.sessions.paste(chat, MESSAGE)
    pty.exit({ exitCode: 1, signal: null })
    await settle()
    rig.clock.advance(60 * SECOND)

    expect(pty.written).toEqual(pasteOf(MESSAGE).slice(0, 1))
    expect(rig.clock.pending).toBe(0)
  })
})
