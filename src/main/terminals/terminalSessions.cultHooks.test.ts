/**
 * The hooks a cult supervisor drives member terminals with (`cultMemberEntries`): grants attached to and detached from
 * a running PTY (revoked with it, or not), and `endChat`'s graceful end typing the exit keys at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eventually, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(async () => {
  await rig.sessions.dispose()
  rig.cleanup()
})

/** Ends the chat's terminal at once; its fake PTY exits when killed, as a killed tree does. */
async function endKilled(chatId: string): Promise<void> {
  const pty = rig.host.last()
  const ending = rig.sessions.endChat(chatId)
  await eventually(() => pty.kills === 1, 'the kill')
  pty.exit()
  await ending
}

describe('terminal sessions: grants of a running member terminal', () => {
  it('takes no grant for a chat without a running terminal, and none once its terminal is being stopped', async () => {
    const chat = rig.newChat()
    expect(rig.sessions.attachGrant(chat.id, 'gr_extra')).toBe(false)
    expect(rig.sessions.detachGrant(chat.id, 'gr_extra')).toBe(false)
    const { pty } = await startTerminal(rig, chat)
    const ending = rig.sessions.endChat(chat.id)
    expect(rig.sessions.attachGrant(chat.id, 'gr_late')).toBe(false)
    expect(rig.sessions.detachGrant(chat.id, 'gr_1')).toBe(false)
    pty.exit()
    await ending
    expect(rig.revoked).not.toContain('gr_late')
  })

  it('revokes an attached grant with the terminal, once even when attached twice', async () => {
    const chat = rig.newChat()
    await startTerminal(rig, chat)
    expect(rig.sessions.attachGrant(chat.id, 'gr_upgrade')).toBe(true)
    expect(rig.sessions.attachGrant(chat.id, 'gr_upgrade')).toBe(true)
    await endKilled(chat.id)
    expect(rig.revoked.filter((grantId) => grantId === 'gr_upgrade')).toEqual(['gr_upgrade'])
  })

  it('leaves a detached grant alone when the terminal ends, and detaches only a grant it holds', async () => {
    const chat = rig.newChat()
    await startTerminal(rig, chat)
    rig.sessions.attachGrant(chat.id, 'gr_upgrade')
    expect(rig.sessions.detachGrant(chat.id, 'gr_unknown')).toBe(false)
    expect(rig.sessions.detachGrant(chat.id, 'gr_upgrade')).toBe(true)
    expect(rig.sessions.detachGrant(chat.id, 'gr_upgrade')).toBe(false)
    await endKilled(chat.id)
    expect(rig.revoked).toContain('gr_1')
    expect(rig.revoked).not.toContain('gr_upgrade')
  })
})

describe('terminal sessions: ending a member terminal gracefully', () => {
  it('types the exit keys at once when no delay is given, and kills nothing when the CLI exits on its own', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)
    const ending = rig.sessions.endChat(chat.id, { input: '\u0004', withinMs: 10_000 })
    expect(pty.written).toContain('\u0004')
    pty.exit()
    await ending
    expect(pty.kills).toBe(0)
    expect(rig.clock.pending).toBe(0)
    expect(rig.sessions.generationOf(chat.id)).toBeNull()
  })

  it('reports a trusted exit request that fails, then kills the terminal once its time is up', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)
    const refused = new Error('The control file could not be written.')
    const ending = rig.sessions.endChat(chat.id, { request: () => Promise.reject(refused), input: '\u0004', inputAfterMs: 1_000, withinMs: 5_000 })
    await eventually(() => rig.errors.includes(refused), 'the refused request reported')
    rig.clock.advance(1_000)
    expect(pty.written).toContain('\u0004')
    expect(pty.kills).toBe(0)
    rig.clock.advance(4_000)
    await eventually(() => pty.kills === 1, 'the kill once the time is up')
    pty.exit()
    await ending
    expect(rig.revoked).toContain('gr_1')
  })

  it('ends a chat without a terminal at once', async () => {
    const chat = rig.newChat()
    await rig.sessions.endChat(chat.id, { input: '\u0004', withinMs: 5_000 })
    expect(rig.killed).toEqual([])
    expect(rig.clock.pending).toBe(0)
  })
})
