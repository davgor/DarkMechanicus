/**
 * The idle stop of a chat that carries a run or a Kanban card (`docs/design/chat-shells.md`, "Idle stop"): an
 * orchestrator watching a held lease is not idle. Once its PTY has gone 10 minutes with no input and no output, the
 * lease is read every minute, and each read that finds it held counts as activity, so the chat is stopped 10 minutes
 * after the last one that did. On the fake PTY host and the fake clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eventually, gate, recorder, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'
import type { TerminalEvent } from './terminalSessions'

const MINUTE = 60_000
const IDLE = 'Stopped after 10 minutes idle.'

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  rig.cleanup()
})

/** Moves the clock on a minute at a time, letting each lease read answer before the next minute. */
async function minutes(count: number): Promise<void> {
  for (let minute = 0; minute < count; minute += 1) {
    rig.clock.advance(MINUTE)
    await settle()
  }
}

function exitOf(events: TerminalEvent[]): TerminalEvent | undefined {
  return events.find((event) => event.kind === 'exited')
}

describe('terminal sessions: idle stop while a lease is held', () => {
  it('keeps an orchestrator chat running past 10 quiet minutes while its run holds a lease, reading it every minute', async () => {
    rig.leases.held.add('rn_1')
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))

    await minutes(30)

    expect(pty.kills).toBe(0)
    // One read at minute 10, then one a minute through minute 30.
    expect(rig.leases.calls).toEqual(Array.from({ length: 21 }, () => 'leaseHeld rn_1'))
  })

  it('stops it 10 minutes after the last read that found the lease held: tree killed, grant revoked, and the exit says why', async () => {
    const heard = recorder()
    rig.leases.held.add('rn_1')
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'), heard.listener)
    await minutes(15)

    rig.leases.held.delete('rn_1')
    await minutes(9)
    expect([pty.kills, rig.revoked]).toEqual([0, []])
    await minutes(1)
    expect([pty.kills, rig.revoked]).toEqual([1, ['gr_1']])
    pty.exit({ exitCode: 0, signal: 9 })
    await eventually(() => !rig.sessions.busy(), 'the exit to be told')

    expect(exitOf(heard.events)).toEqual({ kind: 'exited', exitCode: 0, signal: 9, message: IDLE, resumed: false })
    expect(rig.clock.pending).toBe(0)
  })

  it('does the same for a chat Play opened for a Kanban card', async () => {
    rig.leases.held.add('kc_1')
    const { pty } = await startTerminal(rig, rig.newCardChat('kc_1'))
    await minutes(20)
    expect(pty.kills).toBe(0)

    rig.leases.held.delete('kc_1')
    await minutes(10)

    expect(pty.kills).toBe(1)
    expect(new Set(rig.leases.calls)).toEqual(new Set(['leaseHeld kc_1']))
  })

  it('counts output after a held lease as activity again: the next read waits for 10 more quiet minutes', async () => {
    rig.leases.held.add('rn_1')
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))
    await minutes(12)
    pty.emitData('worker done\r\n')
    await settle()
    rig.leases.held.delete('rn_1')

    await minutes(9)
    expect([pty.kills, rig.leases.calls.length]).toEqual([0, 3])
    await minutes(1)

    expect([pty.kills, rig.leases.calls.length]).toEqual([1, 4])
  })
})

describe('terminal sessions: idle stop with no lease held', () => {
  it('stops an orchestrator chat whose run holds no lease after 10 quiet minutes, as any chat', async () => {
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))

    await minutes(9)
    expect(pty.kills).toBe(0)
    await minutes(1)

    expect([pty.kills, rig.leases.calls]).toEqual([1, ['leaseHeld rn_1']])
  })

  it('reads no lease for a chat that carries no run and no card', async () => {
    const { pty } = await startTerminal(rig, rig.newChat())

    rig.clock.advance(10 * MINUTE)

    expect([pty.kills, rig.leases.calls]).toEqual([1, []])
  })

  it('counts a lease read that fails as no lease: the chat is stopped and the error reported', async () => {
    rig.cleanup()
    const failure = new Error('database is locked')
    rig = terminalRig({
      deps: () => ({
        leaseHeld: async () => {
          throw failure
        }
      })
    })
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))

    await minutes(10)

    expect([pty.kills, rig.errors]).toEqual([1, [failure]])
  })

  it('sets nothing more once the PTY has exited while a lease read was under way, and the quit waits for the read', async () => {
    rig.cleanup()
    const read = gate<boolean>()
    let reads = 0
    rig = terminalRig({
      deps: () => ({
        leaseHeld: async () => {
          reads += 1
          return read.promise
        }
      })
    })
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))
    rig.clock.advance(10 * MINUTE)
    expect(reads).toBe(1)

    pty.exit({ exitCode: 0, signal: null })
    await settle()
    expect(rig.sessions.busy()).toBe(true)
    read.open(true)
    await eventually(() => !rig.sessions.busy(), 'the lease read to settle')

    expect([pty.kills, rig.clock.pending]).toEqual([0, 0])
  })
})
