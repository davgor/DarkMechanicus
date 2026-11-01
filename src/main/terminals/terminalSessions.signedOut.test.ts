/**
 * An orchestrator chat's CLI that exits on its own (`docs/design/chat-shells.md`, "Sign-in detection"): main runs the
 * status command, and only when it says `signed_out` is a `running` or `paused` run the chat orchestrates paused with
 * the reason `signed_out` (which keeps the run's leases, so it is given only then). A quit, an idle stop, a deleted
 * chat, a folder stop and an ordinary `/exit` (the status still says signed in) pause nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FakePty } from './__mocks__/fakePtyHost'
import { CUSTOM_AGENT, eventually, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'

const SIGNED_OUT = { state: 'signed_out', reason: 'Claude Code reports it is not signed in.' } as const
const SIGNED_IN = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' } as const
const MINUTE = 60_000

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
  rig.runs.states['rn_1'] = 'running'
})

afterEach(() => {
  rig.cleanup()
})

/** How many sign-in checks ran after the start's own. */
function checksAfterStart(): number {
  return rig.steps.filter((step) => step === 'auth').length - 1
}

describe('terminal sessions: an orchestrator CLI that exits on its own', () => {
  it.each(['running', 'paused'] as const)('pauses its %s run with signed_out when the status command says signed out', async (state) => {
    rig.runs.states['rn_1'] = state
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))
    rig.auth.status = SIGNED_OUT

    pty.exit({ exitCode: 1, signal: null })
    await eventually(() => rig.runs.calls.length === 2, 'the run to be paused')

    expect(rig.runs.calls).toEqual(['getRun rn_1', 'pauseRun rn_1 signed_out'])
    expect(checksAfterStart()).toBe(1)
  })

  it('pauses nothing for an ordinary /exit: the status still says signed in', async () => {
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))
    rig.auth.status = SIGNED_IN

    pty.exit({ exitCode: 0, signal: null })
    await eventually(() => checksAfterStart() === 1, 'the status check')
    await settle()

    expect(rig.runs.calls).toEqual([])
  })

  it('pauses nothing when the status cannot tell', async () => {
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))
    rig.auth.status = { state: 'unknown', reason: 'Claude Code did not answer in time.' }

    pty.exit({ exitCode: 1, signal: null })
    await eventually(() => checksAfterStart() === 1, 'the status check')
    await settle()

    expect(rig.runs.calls).toEqual([])
  })

  it('leaves a run that is not running or paused as it is', async () => {
    rig.runs.states['rn_1'] = 'completed'
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))
    rig.auth.status = SIGNED_OUT

    pty.exit({ exitCode: 1, signal: null })
    await eventually(() => rig.runs.calls.length === 1, 'the run to be read')
    await settle()

    expect(rig.runs.calls).toEqual(['getRun rn_1'])
  })

  it('checks nothing for a chat that orchestrates no run, or a custom CLI with no status command', async () => {
    const worker = await startTerminal(rig, rig.newChat())
    const custom = await startTerminal(rig, rig.newOrchestrator('rn_1', CUSTOM_AGENT.id))
    const startChecks = rig.steps.filter((step) => step === 'auth').length
    rig.auth.status = SIGNED_OUT

    worker.pty.exit({ exitCode: 1, signal: null })
    custom.pty.exit({ exitCode: 1, signal: null })
    await settle()

    expect(rig.steps.filter((step) => step === 'auth')).toHaveLength(startChecks)
    expect(rig.runs.calls).toEqual([])
  })
})

describe('terminal sessions: an orchestrator CLI that main stopped', () => {
  beforeEach(() => {
    rig.auth.status = SIGNED_IN
  })

  /** Starts an orchestrator of rn_1, then makes the status say signed out, as it would for any later check. */
  async function startSignedOutLater(): Promise<{ pty: FakePty }> {
    const { pty } = await startTerminal(rig, rig.newOrchestrator('rn_1'))
    rig.auth.status = SIGNED_OUT
    return { pty }
  }

  it('pauses nothing at quit', async () => {
    await startSignedOutLater()

    const disposing = rig.sessions.dispose()
    rig.host.last().exit({ exitCode: 0, signal: 9 })
    await disposing
    await settle()

    expect([checksAfterStart(), rig.runs.calls]).toEqual([0, []])
  })

  it('pauses nothing after an idle stop', async () => {
    const { pty } = await startSignedOutLater()

    rig.clock.advance(10 * MINUTE)
    await eventually(() => pty.kills > 0, 'the idle stop')
    pty.exit({ exitCode: 0, signal: 9 })
    await settle()

    expect([checksAfterStart(), rig.runs.calls]).toEqual([0, []])
  })

  it('pauses nothing when its chat is deleted', async () => {
    const chat = rig.newOrchestrator('rn_1')
    const { pty } = await startTerminal(rig, chat)
    rig.auth.status = SIGNED_OUT

    const deleting = rig.sessions.deleteChat(chat, async () => {})
    pty.exit({ exitCode: 0, signal: 15 })
    await deleting
    await settle()

    expect([checksAfterStart(), rig.runs.calls]).toEqual([0, []])
  })

  it('pauses nothing when its folder goes away', async () => {
    const { pty } = await startSignedOutLater()

    rig.tracked.delete(rig.repo)
    rig.clock.advance(MINUTE)
    await eventually(() => pty.kills > 0, 'the folder stop')
    pty.exit({ exitCode: 0, signal: 9 })
    await settle()

    expect([checksAfterStart(), rig.runs.calls]).toEqual([0, []])
  })
})
