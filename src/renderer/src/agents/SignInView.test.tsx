// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalKit } from '../__mocks__/fakeTerminalKit'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { SignInRequest } from './signInContext'
import { SignInView } from './SignInView'

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' }
const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'Claude Code reports it is not signed in.' }
const ENDED = { exitCode: 0, signal: null, message: null, resumed: false }

let dm: FakeDm
let terminals: FakeTerminals
let kit: FakeTerminalKit
let statuses: AgentAuthStatus[]
let signedIn: number
let backs: number

beforeEach(() => {
  dm = new FakeDm()
  terminals = new FakeTerminals()
  dm.terminals = terminals
  window.dm = dm
  kit = new FakeTerminalKit()
  statuses = []
  signedIn = 0
  backs = 0
})

afterEach(() => {
  cleanup()
})

async function open(request: Partial<SignInRequest> = {}): Promise<{ unmount(): void }> {
  const full: SignInRequest = {
    agent: 'claude',
    name: 'Claude Code',
    onStatus: (status) => statuses.push(status),
    onSignedIn: () => (signedIn += 1),
    ...request
  }
  const view = render(<SignInView request={full} kit={kit} scheduler={new ManualScheduler()} onBack={() => (backs += 1)} />)
  await settle()
  return view
}

const view = (): ReturnType<typeof within> => within(screen.getByRole('region', { name: 'Sign in to Claude Code' }))
const notice = (): string | null => screen.queryByRole('status')?.textContent ?? null

describe('SignInView: the login terminal in this window', () => {
  it("asks main for the agent's sign-in naming only its id, and shows its terminal, focused, with Back", async () => {
    await open()

    expect(terminals.signIns).toEqual(['claude'])
    expect(view().getByRole('heading', { level: 1, name: 'Sign in to Claude Code' })).toBeTruthy()
    expect(view().getByRole('button', { name: 'Back' })).toBeTruthy()
    expect(kit.views).toHaveLength(1)
    expect(kit.latest().host).toBe(screen.getByTestId('sign-in-terminal-host'))
    expect(kit.latest().focused).toBe(1)
    expect(notice()).toMatch(/own sign-in runs below/)
  })

  it('carries what the login prints to the screen, and what the person types to the login', async () => {
    await open()
    const handle = terminals.latestSignIn()

    handle.emitOutput('Paste code here: ')
    kit.latest().type('abc-123\r')

    expect(kit.latest().written).toEqual(['Paste code here: '])
    expect(handle.writes).toEqual(['abc-123\r'])
    expect(handle.resizes).toEqual([[100, 30]])
  })

  it('leaves with Back, closing the terminal so main stops the login', async () => {
    const shown = await open()
    fireEvent.click(view().getByRole('button', { name: 'Back' }))
    expect(backs).toBe(1)

    shown.unmount()

    expect(terminals.latestSignIn().closed).toBe(true)
    expect(kit.latest().disposed).toBe(true)
    expect(dm.agentCallsOf('agentStatus')).toEqual([])
  })
})

describe('SignInView: once the login ends', () => {
  it('checks the status again and reports signed in, keeping the login’s last screen', async () => {
    dm.agentStatuses.claude = SIGNED_IN
    await open()

    terminals.latestSignIn().emitExit(ENDED)
    await settle()

    expect(dm.agentCallsOf('agentStatus')).toEqual([['claude']])
    expect([statuses, signedIn]).toEqual([[SIGNED_IN], 1])
    expect(notice()).toBe('Signed in to Claude Code.')
    expect(kit.latest().disposed).toBe(false)
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull()
  })

  it('says what the status says when it is still not signed in, and Sign in again starts a fresh login', async () => {
    dm.agentStatuses.claude = SIGNED_OUT
    await open()
    terminals.latestSignIn().emitExit({ ...ENDED, exitCode: 1 })
    await settle()

    expect([statuses, signedIn]).toEqual([[SIGNED_OUT], 0])
    expect(notice()).toBe(SIGNED_OUT.reason)

    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    await settle()

    expect(terminals.signIns).toEqual(['claude', 'claude'])
    expect(kit.views).toHaveLength(2)
    expect(kit.views[0]?.disposed).toBe(true)
  })

  it('checks nothing for a login main stopped, and says why', async () => {
    await open()

    terminals.latestSignIn().emitExit({ ...ENDED, signal: 9, message: 'The agent was removed, so its sign-in was stopped.' })
    await settle()

    expect(dm.agentCallsOf('agentStatus')).toEqual([])
    expect(notice()).toBe('The agent was removed, so its sign-in was stopped.')
  })

  it('says why a sign-in could not start, with Sign in again', async () => {
    terminals.signInOutcomes.claude = { state: 'failed', message: 'The PTY helper cannot run.' }
    await open()

    expect(notice()).toBe('The PTY helper cannot run.')
    expect(kit.views).toEqual([])
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  })

  it('shows a refusal in main’s words', async () => {
    terminals.signInOutcomes.claude = { error: 'Claude Code is not connected.' }
    await open()

    expect(notice()).toBe('Claude Code is not connected.')
  })
})
