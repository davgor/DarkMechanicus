// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import { CheckAgain, SIGN_IN_POLL_MS, SignInPrompt } from './SignInPrompt'

let dm: FakeDm

const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'Claude Code says you are not logged in.' }
const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Signed in.' }
const UNKNOWN: AgentAuthStatus = { state: 'unknown', reason: 'The status command did not answer.' }

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  dm.agentStatuses.claude = SIGNED_OUT
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }))
}

/** Lets `ms` of fake time pass and the requests it starts finish. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function startSignIn(props: Partial<Parameters<typeof SignInPrompt>[0]> = {}): Promise<void> {
  render(<SignInPrompt kind="claude" {...props} />)
  press('Sign in')
  await settle()
}

describe('SignInPrompt starting', () => {
  it('offers Sign in for the agent and starts the CLI’s own sign-in naming only the kind', async () => {
    render(<SignInPrompt kind="claude" />)
    expect(screen.getByRole('group', { name: 'Sign in to Claude Code' })).toBeTruthy()
    expect(dm.agentCallsOf('signInAgent')).toEqual([])
    press('Sign in')
    await settle()
    expect(dm.agentCallsOf('signInAgent')).toEqual([['claude']])
  })

  it('says where to finish signing in and offers Dismiss instead of a second Sign in', async () => {
    await startSignIn()
    expect(screen.getByText('Sign-in started')).toBeTruthy()
    expect(screen.getByText(/terminal window/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('does not start a second sign-in while the first is starting', async () => {
    const hold = dm.holdAgent('signInAgent')
    render(<SignInPrompt kind="claude" />)
    press('Sign in')
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true)
    hold.resolve()
    await settle()
    expect(dm.agentCallsOf('signInAgent')).toEqual([['claude']])
  })

  it('shows why a sign-in could not start and keeps Sign in available', async () => {
    dm.signInOutcomes = [{ outcome: 'failed', reason: 'No terminal could be opened.' }]
    await startSignIn()
    expect(screen.getByText('Could not start sign-in')).toBeTruthy()
    expect(screen.getByText('No terminal could be opened.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('shows a call that was rejected, and frees the button', async () => {
    dm.signInAgent = () => Promise.reject(new Error('ipc closed'))
    await startSignIn()
    expect(screen.getByRole('alert').textContent).toContain('ipc closed')
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('can be disabled while another action on the agent is running', () => {
    render(<SignInPrompt kind="claude" disabled />)
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('SignInPrompt checking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('does not ask for the status before the sign-in has started', async () => {
    render(<SignInPrompt kind="claude" />)
    await wait(SIGN_IN_POLL_MS * 3)
    expect(dm.agentCallsOf('agentStatus')).toEqual([])
  })

  it('re-checks the status on every interval while the agent is still signed out, and reports each answer', async () => {
    const seen: AgentAuthStatus[] = []
    await startSignIn({ onStatus: (status) => seen.push(status) })
    await wait(SIGN_IN_POLL_MS)
    await wait(SIGN_IN_POLL_MS)
    expect(dm.agentCallsOf('agentStatus')).toEqual([['claude'], ['claude']])
    expect(seen).toEqual([SIGNED_OUT, SIGNED_OUT])
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('keeps checking while the state is unknown and when a check fails, until the agent is signed in', async () => {
    dm.agentStatuses.claude = UNKNOWN
    const done = vi.fn()
    await startSignIn({ onSignedIn: done })
    await wait(SIGN_IN_POLL_MS)
    dm.agentStatus = () => Promise.reject(new Error('ipc closed'))
    await wait(SIGN_IN_POLL_MS)
    dm.agentStatus = () => Promise.resolve(SIGNED_IN)
    await wait(SIGN_IN_POLL_MS)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('says it is signed in, tells the host once, and stops asking', async () => {
    const done = vi.fn()
    const seen: AgentAuthStatus[] = []
    await startSignIn({ onSignedIn: done, onStatus: (status) => seen.push(status) })
    dm.agentStatuses.claude = SIGNED_IN
    await wait(SIGN_IN_POLL_MS)
    expect(screen.getByRole('status').textContent).toContain('Signed in to Claude Code')
    expect(done).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([SIGNED_IN])
    await wait(SIGN_IN_POLL_MS * 4)
    expect(dm.agentCallsOf('agentStatus')).toEqual([['claude']])
    expect(done).toHaveBeenCalledTimes(1)
  })

})

describe('SignInPrompt overlap and stopping', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('does not start a check while the previous one is still waiting for its answer', async () => {
    await startSignIn()
    const hold = dm.holdAgent('agentStatus')
    await wait(SIGN_IN_POLL_MS * 3)
    expect(dm.agentCallsOf('agentStatus')).toHaveLength(1)
    hold.resolve()
    await wait(SIGN_IN_POLL_MS)
    expect(dm.agentCallsOf('agentStatus')).toHaveLength(2)
  })

  it('stops checking when dismissed, and offers Sign in again', async () => {
    await startSignIn()
    await wait(SIGN_IN_POLL_MS)
    press('Dismiss')
    await wait(SIGN_IN_POLL_MS * 4)
    expect(dm.agentCallsOf('agentStatus')).toHaveLength(1)
    expect(screen.queryByText('Sign-in started')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('ignores an answer that arrives after it was dismissed', async () => {
    const done = vi.fn()
    await startSignIn({ onSignedIn: done })
    const hold = dm.holdAgent('agentStatus')
    dm.agentStatuses.claude = SIGNED_IN
    await wait(SIGN_IN_POLL_MS)
    press('Dismiss')
    hold.resolve()
    await wait(SIGN_IN_POLL_MS)
    expect(done).not.toHaveBeenCalled()
  })

  it('stops checking when it is removed from the screen', async () => {
    const view = render(<SignInPrompt kind="claude" />)
    press('Sign in')
    await settle()
    await wait(SIGN_IN_POLL_MS)
    view.unmount()
    await wait(SIGN_IN_POLL_MS * 4)
    expect(dm.agentCallsOf('agentStatus')).toHaveLength(1)
  })
})

describe('CheckAgain', () => {
  it('shows why the state is unknown and asks once when pressed, reporting the answer', async () => {
    const seen: AgentAuthStatus[] = []
    dm.agentStatuses.claude = SIGNED_IN
    render(<CheckAgain kind="claude" reason={UNKNOWN.reason} onStatus={(status) => seen.push(status)} />)
    expect(screen.getByText('The status command did not answer.')).toBeTruthy()
    expect(dm.agentCallsOf('agentStatus')).toEqual([])
    press('Check again')
    await settle()
    expect(dm.agentCallsOf('agentStatus')).toEqual([['claude']])
    expect(seen).toEqual([SIGNED_IN])
  })

  it('is busy while the check is out, so it cannot be pressed twice', async () => {
    const hold = dm.holdAgent('agentStatus')
    render(<CheckAgain kind="claude" reason={UNKNOWN.reason} />)
    press('Check again')
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(true)
    hold.resolve()
    await settle()
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(false)
    expect(dm.agentCallsOf('agentStatus')).toHaveLength(1)
  })

  it('says when the check itself failed', async () => {
    dm.agentStatus = () => Promise.reject(new Error('ipc closed'))
    render(<CheckAgain kind="claude" reason={UNKNOWN.reason} />)
    press('Check again')
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('ipc closed')
  })
})
