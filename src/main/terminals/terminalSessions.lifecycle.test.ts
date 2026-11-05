/**
 * A chat terminal's life after its first start (`docs/design/chat-shells.md`, "Resume" and "No idle stop"): Start
 * again resumes the CLI's session once it exists (Claude's `--resume <id>`, `a8s resume`), a resume the CLI refuses
 * is followed by a new session on request, and a PTY with no input and no output runs on, for days, with its grant
 * renewed every hour. On the fake PTY host and the fake clock; Claude's session file is on the real disk, in the
 * rig's scratch home folder.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import { ompFilePaths } from './ompSession'
import type { ChatRecord } from '../../shared/agents/chat'
import type { FakePty } from './__mocks__/fakePtyHost'
import { CUSTOM_AGENT, claudeSessionFile, eventually, recorder, sessionIdNumber, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'
import type { TerminalEvent } from './terminalSessions'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const OLD_SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  rig.cleanup()
})

/** The flag and value that pick the session: `['--session-id', id]` or `['--resume', id]`. */
function claudeSession(pty: FakePty): string[] {
  const args = pty.spec.args as string[]
  const at = args.findIndex((arg) => arg === '--session-id' || arg === '--resume')
  return args.slice(at, at + 2)
}

/** The PTY ends, and the exit has been told. */
async function exitAndSettle(pty: FakePty, exit: { exitCode: number; signal: number | null } = { exitCode: 0, signal: null }): Promise<void> {
  pty.exit(exit)
  // The exit is told once the screen has flushed, which is asynchronous: wait for it, not a fixed 5 ms.
  await eventually(() => !rig.sessions.busy(), 'the exit to be told')
}

function stored(chat: ChatRecord): ChatRecord | undefined {
  return rig.reopenedStore().listChats(rig.repo).find((candidate) => candidate.id === chat.id)
}

function exitOf(events: TerminalEvent[]): TerminalEvent | undefined {
  return events.find((event) => event.kind === 'exited')
}

describe('terminal sessions: Claude Code session ids', () => {
  it('starts a new chat on a session id it generates, stored on the chat before the spawn', async () => {
    const chat = rig.newChat()

    const { pty } = await startTerminal(rig, chat)

    expect(claudeSession(pty)).toEqual(['--session-id', sessionIdNumber(1)])
    expect(rig.host.sessionStoredAtSpawn).toEqual([sessionIdNumber(1)])
    expect(stored(chat)?.sessionId).toBe(sessionIdNumber(1))
  })

  it('starts again on the same --session-id while Claude has not written the session, and with --resume once it has', async () => {
    const chat = rig.newChat()
    const first = await startTerminal(rig, chat)
    // Exited at the folder-trust prompt: no session was written.
    await exitAndSettle(first.pty, { exitCode: 1, signal: 0 })

    const second = await startTerminal(rig, chat)
    expect(claudeSession(second.pty)).toEqual(['--session-id', sessionIdNumber(1)])
    claudeSessionFile(rig, sessionIdNumber(1), true)
    await exitAndSettle(second.pty)

    const third = await startTerminal(rig, chat)
    expect(claudeSession(third.pty)).toEqual(['--resume', sessionIdNumber(1)])
    expect(rig.host.sessionStoredAtSpawn).toEqual([sessionIdNumber(1), sessionIdNumber(1), sessionIdNumber(1)])
  })

  it('resumes a chat’s stored id only when its session exists, and never starts it with --session-id once it does', async () => {
    const chat = rig.store.updateChat(rig.newChat(), { sessionId: OLD_SESSION })
    const fresh = await startTerminal(rig, chat)
    expect(claudeSession(fresh.pty)).toEqual(['--session-id', OLD_SESSION])
    await exitAndSettle(fresh.pty)

    claudeSessionFile(rig, OLD_SESSION, true)
    const resumed = await startTerminal(rig, chat)

    expect(claudeSession(resumed.pty)).toEqual(['--resume', OLD_SESSION])
    expect(stored(chat)?.sessionId).toBe(OLD_SESSION)
  })

  it('replaces a stored id that is not a UUID with a new one, stored before the spawn', async () => {
    const chat = rig.store.updateChat(rig.newChat(), { sessionId: 'sdk-session; rm -rf ~' })

    const { pty } = await startTerminal(rig, chat)

    expect(claudeSession(pty)).toEqual(['--session-id', sessionIdNumber(1)])
    expect(rig.host.sessionStoredAtSpawn).toEqual([sessionIdNumber(1)])
  })

  it('tells whether the exit was of a resumed session', async () => {
    const chat = rig.newChat()
    const heard = recorder()
    const first = await startTerminal(rig, chat, heard.listener)
    claudeSessionFile(rig, sessionIdNumber(1), true)
    await exitAndSettle(first.pty, { exitCode: 0, signal: null })
    expect(exitOf(heard.events)).toEqual({ kind: 'exited', exitCode: 0, signal: null, message: null, resumed: false })

    const again = recorder()
    const second = await startTerminal(rig, chat, again.listener)
    await exitAndSettle(second.pty, { exitCode: 0, signal: null })

    expect(exitOf(again.events)).toEqual({ kind: 'exited', exitCode: 0, signal: null, message: null, resumed: true })
  })
})

describe('terminal sessions: Autonomous sessions', () => {
  it('starts with a8s start until the person has typed into the chat, then resumes with a8s resume', async () => {
    const chat = rig.newChat('autonomous')
    const untouched = await startTerminal(rig, chat)
    expect((untouched.pty.spec.args as string[]).slice(0, 2)).toEqual(['start', rig.repo])
    await exitAndSettle(untouched.pty)

    const typed = await startTerminal(rig, chat)
    expect((typed.pty.spec.args as string[]).slice(0, 2)).toEqual(['start', rig.repo])
    rig.sessions.write(chat.id, 'hello\r')
    rig.sessions.write(chat.id, 'more\r')
    expect(stored(chat)?.sessionStarted).toBe(true)
    await exitAndSettle(typed.pty)

    const later = await startTerminal(rig, chat)
    expect((later.pty.spec.args as string[])[0]).toBe('resume')
    expect(later.pty.spec.args).not.toContain('start')
  })

  it('does not mark a Claude chat started by its input: its session file decides', async () => {
    const chat = rig.newChat()
    await startTerminal(rig, chat)

    rig.sessions.write(chat.id, '\r')

    expect(stored(chat)?.sessionStarted).toBeUndefined()
  })
})

describe('terminal sessions: a resume the CLI refuses, and a new session', () => {
  it('keeps what the CLI said on the screen, tells the exit as resumed, and a new-session attach starts on a new id it stores', async () => {
    const chat = rig.store.updateChat(rig.newChat(), { sessionId: OLD_SESSION })
    claudeSessionFile(rig, OLD_SESSION, true)
    const heard = recorder()
    const refused = await startTerminal(rig, chat, heard.listener)
    expect(claudeSession(refused.pty)).toEqual(['--resume', OLD_SESSION])
    refused.pty.emitData(`No conversation found with session ID: ${OLD_SESSION}\r\n`)
    await exitAndSettle(refused.pty, { exitCode: 1, signal: 0 })
    expect(heard.events.map((event) => event.kind)).toEqual(['started', 'output', 'exited'])
    expect(exitOf(heard.events)).toMatchObject({ exitCode: 1, resumed: true })

    const { pty } = await startTerminal(rig, chat, undefined, { newSession: true })

    expect(claudeSession(pty)).toEqual(['--session-id', sessionIdNumber(1)])
    expect(rig.host.sessionStoredAtSpawn.at(-1)).toBe(sessionIdNumber(1))
    expect(stored(chat)?.sessionId).toBe(sessionIdNumber(1))
  })

  it('answers an attach whose own start exited before the answer with the last screen and the exit, and starts nothing more', async () => {
    // A custom CLI has no sign-in check, so the attach waits for the start itself.
    const chat = rig.newChat(CUSTOM_AGENT.id)
    rig.host.onSpawn = (pty) => {
      queueMicrotask(() => {
        pty.emitData('No conversation found with session ID: 7c9e6679\r\n')
        pty.exit({ exitCode: 1, signal: 0 })
      })
    }
    const heard = recorder()

    const answer = await rig.sessions.attach(chat, heard.listener)
    expect(heard.events).toEqual([])
    await settle()

    expect(answer).toMatchObject({ state: 'running', pid: rig.host.last().pid })
    expect(answer.state === 'running' ? answer.snapshot : '').toContain('No conversation found with session ID')
    expect(rig.host.spawns).toHaveLength(1)
    expect(heard.events).toEqual([{ kind: 'exited', exitCode: 1, signal: 0, message: null, resumed: false }])
    expect(rig.revoked).toEqual(['gr_1'])
  })
})

describe('terminal sessions: new sessions', () => {
  it('starts Autonomous with a8s start again after a new session, which clears the started flag', async () => {
    const chat = rig.store.updateChat(rig.newChat('autonomous'), { sessionStarted: true })
    const resumed = await startTerminal(rig, chat)
    expect((resumed.pty.spec.args as string[])[0]).toBe('resume')
    await exitAndSettle(resumed.pty, { exitCode: 1, signal: 0 })

    await startTerminal(rig, chat, undefined, { newSession: true })

    expect((rig.host.last().spec.args as string[]).slice(0, 2)).toEqual(['start', rig.repo])
    expect(stored(chat)?.sessionStarted).toBe(false)
  })

  it('clears nothing when the chat’s CLI is still running: the attach joins it', async () => {
    const chat = rig.newChat()
    const { pid } = await startTerminal(rig, chat)

    const answer = await rig.sessions.attach(chat, undefined, { newSession: true })

    expect(answer).toMatchObject({ state: 'running', pid })
    expect([rig.host.spawns.length, stored(chat)?.sessionId]).toEqual([1, sessionIdNumber(1)])
  })
})

describe('terminal sessions: no idle stop', () => {
  it('keeps a PTY with no input and no output running for 10 days, renewing its grant every hour', async () => {
    const chat = rig.newChat()
    const heard = recorder()
    const { pty } = await startTerminal(rig, chat, heard.listener)

    rig.clock.advance(HOUR - 1)
    expect(rig.renewed).toEqual([])
    rig.clock.advance(1)
    expect(rig.renewed).toEqual(['gr_1'])
    rig.clock.advance(10 * DAY - HOUR)
    await settle()

    expect([pty.kills, rig.revoked, exitOf(heard.events)]).toEqual([0, [], undefined])
    expect(rig.renewed).toEqual(Array.from({ length: 240 }, () => 'gr_1'))
  })

  it('renews nothing once the PTY has exited, and leaves no timer behind', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)
    rig.clock.advance(2 * HOUR)

    await exitAndSettle(pty)
    rig.clock.advance(5 * HOUR)

    expect([rig.renewed, rig.revoked, rig.clock.pending]).toEqual([['gr_1', 'gr_1'], ['gr_1'], 0])
  })

  it('renews the grant a start again issued, not the one revoked with the last PTY', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)
    await exitAndSettle(pty)

    await startTerminal(rig, chat)
    rig.clock.advance(HOUR)

    expect([rig.revoked, rig.renewed]).toEqual([['gr_1'], ['gr_2']])
  })
})

describe('terminal sessions: keeping the computer awake', () => {
  it('holds the computer awake while each PTY runs, and lets it sleep once every one has exited', async () => {
    const heard = recorder()
    const first = await startTerminal(rig, rig.newChat(), heard.listener)
    const second = await startTerminal(rig, rig.newChat())
    expect(rig.awake).toBe(2)

    first.pty.exit()
    await eventually(() => exitOf(heard.events) !== undefined, 'the first exit to be told')
    expect(rig.awake).toBe(1)
    await exitAndSettle(second.pty)

    expect(rig.awake).toBe(0)
  })

  it('gives a stopped PTY’s hold back once, when it is stopped, not again at its exit', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)

    const deleting = rig.sessions.deleteChat(chat, async () => {})
    expect(rig.awake).toBe(0)
    pty.exit({ exitCode: 0, signal: 9 })
    await deleting

    expect(rig.awake).toBe(0)
  })
})

describe('terminal sessions: OMP, whose session id the CLI mints', () => {
  const OMP_SESSION = '01a19f51-856e-7612-8d38-0de416901104'

  function ompRig(): TerminalRig {
    rig.cleanup()
    rig = terminalRig({ agents: [builtInAgent('omp')] })
    return rig
  }

  function ompSessionFile(chat: ChatRecord): string {
    const { sessionDir } = ompFilePaths(rig.userData, chat.id)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, `2026-11-03T02-51-22-350Z_${OMP_SESSION}.jsonl`), '{}')
    return sessionDir
  }

  it('starts with no session, records none, and writes the overlay and the session folder first', async () => {
    const chat = ompRig().newChat('omp')
    const { pty } = await startTerminal(rig, chat)
    const args = pty.spec.args as string[]

    expect(args).toContain('--session-dir')
    expect(args).toContain('--config')
    expect(args).not.toContain('--resume')
    expect(stored(chat)?.sessionId ?? null).toBeNull()
  })

  it('resumes the session found in the chat’s folder, tells a refused resume as resumed, and a new session starts without it', async () => {
    const chat = ompRig().newChat('omp')
    const sessionDir = ompSessionFile(chat)
    const heard = recorder()
    const refused = await startTerminal(rig, chat, heard.listener)
    expect((refused.pty.spec.args as string[]).slice(-2)).toEqual(['--resume', OMP_SESSION])
    expect(stored(chat)?.sessionId).toBe(OMP_SESSION)
    refused.pty.emitData(`Error: Session "${OMP_SESSION}" not found.

`)
    await exitAndSettle(refused.pty, { exitCode: 1, signal: 0 })
    expect(exitOf(heard.events)).toMatchObject({ exitCode: 1, resumed: true })

    const { pty } = await startTerminal(rig, chat, undefined, { newSession: true })

    expect(pty.spec.args as string[]).not.toContain('--resume')
    expect(pty.spec.args as string[]).toContain(sessionDir)
    expect(stored(chat)?.sessionId ?? null).toBeNull()
  })
})

describe('terminal sessions: the Skitarii look of an OMP chat', () => {
  beforeEach(() => {
    rig.cleanup()
    rig = terminalRig({ agents: [builtInAgent('omp')] })
  })

  it('puts the Skitarii theme in the CLI’s own themes folder before it starts, and writes no config.yml there', async () => {
    const chat = rig.newChat('omp')
    await startTerminal(rig, chat)

    expect(existsSync(join(rig.root, '.omp', 'agent', 'themes', 'skitarii.json'))).toBe(true)
    expect(existsSync(join(rig.root, '.omp', 'agent', 'config.yml'))).toBe(false)
  })

  it('loads the Skitarii extension from the app with -e and installs nothing of it in the CLI’s own folder', async () => {
    const chat = rig.newChat('omp')
    const { pty } = await startTerminal(rig, chat)
    const args = pty.spec.args as string[]

    expect(args[args.indexOf('-e') + 1]).toBe('/app/resources/skitarii/extension/index.ts')
    expect(readdirSync(join(rig.root, '.omp', 'agent'))).toEqual(['themes'])
    expect(readdirSync(join(rig.root, '.omp', 'agent', 'themes'))).toEqual(['skitarii.json'])
  })
})
