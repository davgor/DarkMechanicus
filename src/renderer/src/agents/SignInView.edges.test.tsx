// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalAttachment } from '../../../shared/agents/terminalApi'
import type { AgentAuthStatus, AgentId, CommandResult } from '../../../shared/desktop/api'
import { deferred } from '../__mocks__/deferred'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalKit } from '../__mocks__/fakeTerminalKit'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { SignInView } from './SignInView'

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' }
const ENDED = { exitCode: 0, signal: null, message: null, resumed: false }

let dm: FakeDm
let terminals: FakeTerminals
let kit: FakeTerminalKit
let statuses: AgentAuthStatus[]
let signedIn: number

beforeEach(() => {
  dm = new FakeDm()
  terminals = new FakeTerminals()
  dm.terminals = terminals
  window.dm = dm
  kit = new FakeTerminalKit()
  statuses = []
  signedIn = 0
})

afterEach(() => {
  cleanup()
})

async function open(): Promise<{ unmount(): void }> {
  const request = { agent: 'claude', name: 'Claude Code', onStatus: (status: AgentAuthStatus) => statuses.push(status), onSignedIn: () => (signedIn += 1) }
  const view = render(<SignInView request={request} kit={kit} scheduler={new ManualScheduler()} onBack={() => {}} />)
  await settle()
  return view
}

const notice = (): string | null => screen.queryByRole('status')?.textContent ?? null

/** Makes the next sign-in wait until the returned gate opens, then answer as the fake does. */
function holdSignIn(): { open(): void } {
  const gate = deferred()
  const answer = terminals.signIn.bind(terminals)
  terminals.signIn = async (agentId: AgentId): Promise<CommandResult<TerminalAttachment>> => {
    await gate.promise
    return answer(agentId)
  }
  return { open: gate.resolve }
}

describe('SignInView: when main fails to answer', () => {
  it('says why a sign-in request failed outright, with Sign in again', async () => {
    terminals.signIn = async () => {
      throw new Error('The window lost its connection to main.')
    }
    await open()

    expect(notice()).toBe('The window lost its connection to main.')
    expect(kit.views).toEqual([])
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  })

  it('says the terminal could not be shown when main answers no running login and gives no reason', async () => {
    terminals.signInOutcomes.claude = { state: 'refused' }
    await open()

    expect(notice()).toBe('The terminal could not be shown.')
    expect(kit.views).toEqual([])
  })

  it('says why the status check failed once the login ended', async () => {
    dm.agentStatus = async () => {
      throw new Error('The status check timed out.')
    }
    await open()

    terminals.latestSignIn().emitExit(ENDED)
    await settle()

    expect(notice()).toBe('The status check timed out.')
    expect([statuses, signedIn]).toEqual([[], 0])
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  })
})

describe('SignInView: once it is hidden', () => {
  it('closes a login main answered after the view was hidden, and mounts nothing', async () => {
    const held = holdSignIn()
    const shown = await open()

    shown.unmount()
    held.open()
    await settle()

    expect(terminals.latestSignIn().closed).toBe(true)
    expect(kit.views).toEqual([])
  })

  it('reports a status that arrives after the view was hidden, but signs nothing in', async () => {
    dm.agentStatuses.claude = SIGNED_IN
    const status = dm.holdAgent('agentStatus')
    const shown = await open()
    terminals.latestSignIn().emitExit(ENDED)
    await settle()

    shown.unmount()
    status.resolve()
    await settle()

    expect([statuses, signedIn]).toEqual([[SIGNED_IN], 0])
  })
})

describe('SignInView: focus', () => {
  it('focuses the login terminal when its frame is clicked', async () => {
    await open()
    const before = kit.latest().focused

    fireEvent.click(screen.getByTestId('sign-in-terminal-host'))

    expect(kit.latest().focused).toBe(before + 1)
  })
})
