/**
 * The folder a chat's terminal runs in: a moved, deleted or untracked folder is refused before anything is done
 * for the start (no sign-in check, no file, no grant), and a PTY whose folder goes away while it runs is stopped
 * at the next minute's check, or at once when an attach finds it, with the folder's `not_found` message.
 */
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CUSTOM_AGENT, eventually, recorder, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

const AGAIN = 'Track the folder again to keep using this chat.'
const MINUTE = 60_000

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  rig.cleanup()
})

function moveFolder(): void {
  renameSync(rig.repo, join(rig.root, 'moved'))
}

describe('terminal sessions: a folder that went away is refused before a start', () => {
  const cases: [string, () => void, string][] = [
    ['moved', moveFolder, 'is gone: it was moved or deleted'],
    ['deleted', () => rmSync(rig.repo, { recursive: true }), 'is gone: it was moved or deleted'],
    ['untracked', () => rig.tracked.delete(rig.repo), 'is no longer tracked']
  ]

  for (const [what, change, reason] of cases) {
    it(`refuses a ${what} folder with its not_found message, before any check, file or grant`, async () => {
      const chat = rig.newChat()
      change()

      const answer = await rig.sessions.attach(chat)

      expect(answer).toEqual({ state: 'refused', message: `The folder ${rig.repo} ${reason}. ${AGAIN}` })
      expect([rig.steps, rig.host.spawns, rig.sessions.busy()]).toEqual([[], [], false])
      expect(existsSync(join(rig.userData, 'agents', 'instructions', `${chat.id}.md`))).toBe(false)
    })
  }
})

describe('terminal sessions: a folder that goes away while a start is under way', () => {
  it('refuses the start when the folder moves during the sign-in check, before any grant', async () => {
    const held = rig.holdAuth()
    const heard = recorder()
    expect(await rig.sessions.attach(rig.newChat(), heard.listener)).toEqual({ state: 'checking' })

    moveFolder()
    held.open({ state: 'signed_in', reason: 'Signed in.' })
    await eventually(() => heard.events.length > 0, 'the start to end')

    const message = `The folder ${rig.repo} is gone: it was moved or deleted. ${AGAIN}`
    expect(heard.events).toEqual([{ kind: 'not_started', state: 'refused', message }])
    expect([rig.steps, rig.host.spawns]).toEqual([['auth'], []])
  })

  it('revokes the grant and starts nothing when the folder is untracked while the grant is issued', async () => {
    const held = rig.holdGrant()
    const chat = rig.newChat(CUSTOM_AGENT.id)
    const attaching = rig.sessions.attach(chat)
    await eventually(() => rig.grantsAsked > 0, 'the grant to be asked for')

    rig.tracked.delete(rig.repo)
    held.open()

    expect(await attaching).toEqual({ state: 'refused', message: `The folder ${rig.repo} is no longer tracked. ${AGAIN}` })
    await eventually(() => rig.revoked.length > 0, 'the revoke')
    expect([rig.steps, rig.host.spawns]).toEqual([['grant:gr_1', 'revoke:gr_1'], []])
  })
})

describe('terminal sessions: a running PTY whose folder goes away', () => {
  it('is stopped at the next check, within a minute, with the not_found message, and its grant revoked', async () => {
    const chat = rig.newChat()
    const heard = recorder()
    const { pty } = await startTerminal(rig, chat, heard.listener)
    moveFolder()

    rig.clock.advance(MINUTE - 1)
    expect([rig.killed, rig.revoked]).toEqual([[], []])
    rig.clock.advance(1)
    expect([rig.killed.map((tree) => tree.pid), rig.revoked]).toEqual([[pty.pid], ['gr_1']])

    pty.exit({ exitCode: 0, signal: 9 })
    await eventually(() => heard.events.some((event) => event.kind === 'exited'), 'the stop to be told')
    const message = `The folder ${rig.repo} is gone: it was moved or deleted. ${AGAIN}`
    expect(heard.events.at(-1)).toEqual({ kind: 'exited', exitCode: 0, signal: 9, message, resumed: false })
    expect(rig.clock.pending).toBe(0)
    expect(await rig.sessions.attach(chat)).toEqual({ state: 'refused', message })
  })

  it('is stopped when its folder is untracked, and keeps running while the folder stays', async () => {
    const { pty } = await startTerminal(rig, rig.newChat())

    rig.clock.advance(5 * MINUTE)
    expect(rig.killed).toEqual([])
    rig.tracked.delete(rig.repo)
    rig.clock.advance(MINUTE)

    expect([rig.killed.map((tree) => tree.pid), rig.revoked]).toEqual([[pty.pid], ['gr_1']])
  })

  it('is stopped at once when an attach finds its folder gone', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)
    moveFolder()

    const answer = await rig.sessions.attach(chat)

    expect(answer).toEqual({ state: 'refused', message: `The folder ${rig.repo} is gone: it was moved or deleted. ${AGAIN}` })
    expect([rig.killed.map((tree) => tree.pid), rig.revoked]).toEqual([[pty.pid], ['gr_1']])
  })
})
