/**
 * What a terminal is given on its first start besides its command line (`docs/design/chat-shells.md`, "The
 * orchestrator chat Start run opens"): the orchestrator kickoff, which goes only with the chat's first start
 * (`kickoffSent` on the record), never with a resume; and the launch's `pasteFirst`, written once as one bracketed
 * paste and Enter after the CLI's first screen has gone quiet for a second. Claude Code takes the kickoff as its
 * positional prompt; every other CLI has it pasted. Also `start`, what Start run waits on. On the fake PTY host and
 * the fake clock.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import type { FakePty } from './__mocks__/fakePtyHost'
import { eventually, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

const SECOND = 1_000
/** How long after the paste its Enter goes. */
const ENTER_DELAY = 500
const KICKOFF = 'Run this Dark Mechanicus epic as its orchestrator.\n\nEpic: Agent chats (ep_1)\nRun: rn_2'

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  rig.cleanup()
})

/** What a person pasting `text` into the pane sends, as xterm.js sends it: newlines as CR, between the paste marks; then Enter. */
function pasteOf(text: string): string[] {
  return [`\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`, '\r']
}

function stored(chat: ChatRecord): ChatRecord | undefined {
  return rig.reopenedStore().listChats(rig.repo).find((candidate) => candidate.id === chat.id)
}

/** What a TUI writes to turn bracketed paste on, once its input is live. */
const PASTE_ON = '\x1b[?2004h'

/** The CLI draws `data` with its input live (bracketed paste on), and the screen has taken it. */
async function draw(pty: FakePty, data: string): Promise<void> {
  pty.emitData(`${PASTE_ON}${data}`)
  await settle()
}

async function startRun(chat: ChatRecord): Promise<FakePty> {
  const started = await rig.sessions.start(chat, { kickoff: KICKOFF })
  expect(started).toEqual({ state: 'running', pid: rig.host.last().pid })
  return rig.host.last()
}

describe('terminal sessions: the kickoff goes with the first start only', () => {
  it('gives Claude Code the kickoff as its positional prompt, stores kickoffSent before the spawn, and pastes nothing', async () => {
    const chat = rig.newOrchestrator('rn_2')

    const pty = await startRun(chat)

    expect((pty.spec.args as string[]).at(-1)).toBe(KICKOFF)
    expect(rig.host.kickoffSentAtSpawn).toEqual([true])
    await draw(pty, 'Claude Code')
    rig.clock.advance(10 * SECOND)
    expect(pty.written).toEqual([])
  })

  it('never sends it again: not with Start again, and not when a later start asks for it again', async () => {
    const chat = rig.newOrchestrator('rn_2')
    const first = await startRun(chat)
    first.exit({ exitCode: 0, signal: null })
    await settle()

    const again = await startTerminal(rig, chat)
    again.pty.exit({ exitCode: 0, signal: null })
    await settle()
    await rig.sessions.start(chat, { kickoff: KICKOFF })

    expect(again.pty.spec.args).not.toContain(KICKOFF)
    expect(rig.host.spawns.map((pty) => (pty.spec.args as string[]).includes(KICKOFF))).toEqual([true, false, false])
    expect(rig.host.kickoffSentAtSpawn).toEqual([true, true, true])
  })

  it('waits for the CLI to turn bracketed paste on, however long it is quiet before, even when the sequence is split', async () => {
    const pty = await startRun(rig.newOrchestrator('rn_2', 'autonomous'))
    // Autonomous prints its banner, then is quiet for seconds while it starts, before its input is live.
    pty.emitData('AUTONOMOUS v0.79.0')
    await settle()
    rig.clock.advance(10 * SECOND)
    expect(pty.written).toEqual([])

    const timersBefore = rig.clock.pending
    pty.emitData(PASTE_ON.slice(0, 4))
    pty.emitData(`${PASTE_ON.slice(4)}> `)
    // The screen parses asynchronously: wait until it has taken the sequence and set the settle timer, not a fixed 5 ms.
    await eventually(() => rig.clock.pending > timersBefore, 'the settle timer once paste is on')
    rig.clock.advance(SECOND + ENTER_DELAY)
    expect(pty.written).toEqual(pasteOf(KICKOFF))
  })
})

describe('terminal sessions: the kickoff pasted once the first screen settles', () => {
  it('pastes it into Autonomous once its first screen has gone quiet for a second, then presses Enter a moment later', async () => {
    const chat = rig.newOrchestrator('rn_2', 'autonomous')
    const pty = await startRun(chat)
    expect((pty.spec.args as string[]).join('\n')).not.toContain(KICKOFF)

    rig.clock.advance(30 * SECOND)
    expect(pty.written).toEqual([])
    await draw(pty, 'Autonomous 0.79.0\r\n> ')
    rig.clock.advance(SECOND - 1)
    expect(pty.written).toEqual([])
    rig.clock.advance(1)
    // Autonomous takes an Enter in the same write as the paste as part of it, so Enter is its own keypress.
    expect(pty.written).toEqual(pasteOf(KICKOFF).slice(0, 1))
    expect(stored(chat)?.kickoffSent).toBeUndefined()
    rig.clock.advance(ENTER_DELAY)

    expect(pty.written).toEqual(pasteOf(KICKOFF))
    expect(stored(chat)).toMatchObject({ kickoffSent: true, sessionStarted: true })
  })

  it('pastes once: what the CLI draws after the paste pastes nothing more', async () => {
    const pty = await startRun(rig.newOrchestrator('rn_2', 'autonomous'))
    await draw(pty, 'first screen')
    rig.clock.advance(SECOND)

    await draw(pty, 'the kickoff, echoed')
    rig.clock.advance(60 * SECOND)

    expect(pty.written).toEqual(pasteOf(KICKOFF))
  })

  it('waits while the screen keeps changing, and pastes a second after it stops', async () => {
    const pty = await startRun(rig.newOrchestrator('rn_2', 'autonomous'))
    await draw(pty, 'frame 1')
    for (let frame = 2; frame <= 6; frame += 1) {
      rig.clock.advance(SECOND / 2)
      await draw(pty, `frame ${frame}`)
    }
    expect(pty.written).toEqual([])

    rig.clock.advance(SECOND - 1)
    expect(pty.written).toEqual([])
    rig.clock.advance(1)
    expect(pty.written).toEqual(pasteOf(KICKOFF).slice(0, 1))
    rig.clock.advance(ENTER_DELAY)
    expect(pty.written).toEqual(pasteOf(KICKOFF))
  })
})

describe('terminal sessions: what is never pasted', () => {
  it('presses no Enter into a CLI that exits between the paste and the Enter, and keeps kickoffSent off', async () => {
    const chat = rig.newOrchestrator('rn_2', 'autonomous')
    const pty = await startRun(chat)
    await draw(pty, 'first screen')
    rig.clock.advance(SECOND)

    pty.exit({ exitCode: 1, signal: null })
    await settle()
    rig.clock.advance(60 * SECOND)

    expect(pty.written).toEqual(pasteOf(KICKOFF).slice(0, 1))
    expect(rig.clock.pending).toBe(0)
    expect(stored(chat)?.kickoffSent).toBeUndefined()
  })

  it('pastes nothing into a CLI that exits before its screen settles, leaves no timer behind, and keeps kickoffSent off', async () => {
    const chat = rig.newOrchestrator('rn_2', 'autonomous')
    const pty = await startRun(chat)
    await draw(pty, 'first screen')

    pty.exit({ exitCode: 1, signal: null })
    await settle()
    rig.clock.advance(60 * SECOND)

    expect(pty.written).toEqual([])
    expect(rig.clock.pending).toBe(0)
    expect(stored(chat)?.kickoffSent).toBeUndefined()
  })

  it('pastes nothing into a resumed Autonomous session', async () => {
    const chat = rig.store.updateChat(rig.newOrchestrator('rn_2', 'autonomous'), { sessionStarted: true })

    const pty = await startRun(chat)
    await draw(pty, 'resumed')
    rig.clock.advance(10 * SECOND)

    expect(pty.spec.args).toEqual(expect.arrayContaining(['resume']))
    expect(pty.written).toEqual([])
  })

  it('takes every control character out of a paste, so nothing in it ends the paste early or acts as a key', async () => {
    const kickoff = 'Run the epic\x1b[201~\x03\x1b[A now\x7f\x9b2J\tdone'
    await rig.sessions.start(rig.newOrchestrator('rn_2', 'autonomous'), { kickoff })
    const pty = rig.host.last()
    await draw(pty, 'first screen')
    rig.clock.advance(SECOND + ENTER_DELAY)

    expect(pty.written).toEqual(['\x1b[200~Run the epic[201~[A now2J\tdone\x1b[201~', '\r'])
  })
})

describe('terminal sessions: pasteFirst for a CLI with no instructions flag', () => {
  it('pastes Codex its instructions as its first prompt on a first start, and never again on a resume', async () => {
    rig.cleanup()
    rig = terminalRig({ agents: [builtInAgent('codex')] })
    const chat = rig.store.updateChat(rig.newChat('codex'), { sessionId: '019a0000-0000-7000-8000-000000000001' })

    const { pty } = await startTerminal(rig, chat)
    await draw(pty, 'OpenAI Codex')
    rig.clock.advance(SECOND + ENTER_DELAY)

    const instructions = readFileSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`), 'utf8')
    expect(pty.written).toEqual(pasteOf(instructions))
    expect(stored(chat)).toMatchObject({ sessionStarted: true })
    expect(stored(chat)?.kickoffSent).toBeUndefined()

    pty.exit({ exitCode: 0, signal: null })
    await settle()
    const resumed = await startTerminal(rig, chat)
    await draw(resumed.pty, 'OpenAI Codex')
    rig.clock.advance(SECOND + ENTER_DELAY)
    expect(resumed.pty.spec.args).toEqual(expect.arrayContaining(['resume']))
    expect(resumed.pty.written).toEqual([])
  })
})

describe('terminal sessions: start, what Start run waits on', () => {
  it('answers once the PTY runs, past a sign-in check that takes its time', async () => {
    const held = rig.holdAuth()
    const answer = rig.sessions.start(rig.newOrchestrator('rn_2', 'autonomous'), { kickoff: KICKOFF })
    await settle()
    expect(rig.host.spawns).toEqual([])

    held.open({ state: 'signed_in', reason: 'Signed in.' })

    expect(await answer).toEqual({ state: 'running', pid: rig.host.last().pid })
  })

  it('answers why nothing started: signed out, a folder refused, a spawn that failed', async () => {
    rig.auth.status = { state: 'signed_out', reason: 'Claude Code is signed out.' }
    expect(await rig.sessions.start(rig.newOrchestrator('rn_2'), { kickoff: KICKOFF })).toEqual({ state: 'signed_out', message: 'Claude Code is signed out.' })

    rig.auth.status = { state: 'signed_in', reason: 'Signed in.' }
    rig.host.failNextSpawn(new Error('posix_spawnp failed.'))
    expect(await rig.sessions.start(rig.newOrchestrator('rn_2'), { kickoff: KICKOFF })).toEqual({ state: 'failed', message: 'posix_spawnp failed.' })

    rig.tracked.delete(rig.repo)
    expect(await rig.sessions.start(rig.newOrchestrator('rn_2'), { kickoff: KICKOFF })).toMatchObject({ state: 'refused', message: expect.stringContaining(rig.repo) })
    expect(rig.host.spawns).toEqual([])
  })

  it('answers running for a CLI that starts and exits at once: the chat is the person\'s to read and start again', async () => {
    rig.host.onSpawn = (pty) => {
      queueMicrotask(() => {
        pty.exit({ exitCode: 1, signal: null })
      })
    }

    const answer = await rig.sessions.start(rig.newOrchestrator('rn_2'), { kickoff: KICKOFF })
    await settle()

    expect(answer).toEqual({ state: 'running', pid: rig.host.last().pid })
    expect(rig.revoked).toEqual(['gr_1'])
  })
})
