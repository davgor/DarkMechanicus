// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { SignInRecorder } from '../__mocks__/signInRecorder'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import { CheckAgain, SignInPrompt } from './SignInPrompt'

let dm: FakeDm
let recorder: SignInRecorder

const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'Claude Code says you are not logged in.' }
const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Signed in.' }
const UNKNOWN: AgentAuthStatus = { state: 'unknown', reason: 'The status command did not answer.' }

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  dm.agentStatuses.claude = SIGNED_OUT
  recorder = new SignInRecorder()
})

afterEach(() => {
  cleanup()
})

const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }))
}

const signInButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement

describe('SignInPrompt', () => {
  it('offers Sign in for the agent and opens its sign-in view naming only the agent id and its name', () => {
    const onStatus = (): void => undefined
    const onSignedIn = (): void => undefined
    render(recorder.wrap(<SignInPrompt agent="claude" name="Claude Code" onStatus={onStatus} onSignedIn={onSignedIn} />))
    expect(screen.getByRole('group', { name: 'Sign in to Claude Code' })).toBeTruthy()
    expect(recorder.requests).toEqual([])
    press('Sign in')
    expect(recorder.requests).toEqual([{ agent: 'claude', name: 'Claude Code', onStatus, onSignedIn }])
    expect(dm.agentCallsOf('agentStatus')).toEqual([])
  })

  it('passes the view’s end back to the screen: every status, and signed in once', () => {
    const seen: AgentAuthStatus[] = []
    let signedIn = 0
    render(
      recorder.wrap(
        <SignInPrompt
          agent="claude"
          name="Claude Code"
          onStatus={(status) => seen.push(status)}
          onSignedIn={() => {
            signedIn += 1
          }}
        />
      )
    )
    press('Sign in')
    recorder.finish(SIGNED_OUT)
    expect(seen).toEqual([SIGNED_OUT])
    expect(signedIn).toBe(0)
    recorder.finish(SIGNED_IN)
    expect(seen).toEqual([SIGNED_OUT, SIGNED_IN])
    expect(signedIn).toBe(1)
  })

  it('can be disabled while another action on the agent is running', () => {
    render(recorder.wrap(<SignInPrompt agent="claude" name="Claude Code" disabled />))
    expect(signInButton().disabled).toBe(true)
    press('Sign in')
    expect(recorder.requests).toEqual([])
  })

  it('cannot be pressed where no shell provides the sign-in view', () => {
    render(<SignInPrompt agent="claude" name="Claude Code" />)
    expect(signInButton().disabled).toBe(true)
  })
})

describe('CheckAgain', () => {
  it('shows why the state is unknown and asks once when pressed, reporting the answer', async () => {
    const seen: AgentAuthStatus[] = []
    dm.agentStatuses.claude = SIGNED_IN
    render(<CheckAgain agent="claude" name="Claude Code" reason={UNKNOWN.reason} onStatus={(status) => seen.push(status)} />)
    expect(screen.getByText('The status command did not answer.')).toBeTruthy()
    expect(dm.agentCallsOf('agentStatus')).toEqual([])
    press('Check again')
    await settle()
    expect(dm.agentCallsOf('agentStatus')).toEqual([['claude']])
    expect(seen).toEqual([SIGNED_IN])
  })

  it('is busy while the check is out, so it cannot be pressed twice', async () => {
    const hold = dm.holdAgent('agentStatus')
    render(<CheckAgain agent="claude" name="Claude Code" reason={UNKNOWN.reason} />)
    press('Check again')
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(true)
    hold.resolve()
    await settle()
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(false)
    expect(dm.agentCallsOf('agentStatus')).toHaveLength(1)
  })

  it('says when the check itself failed', async () => {
    dm.agentStatus = () => Promise.reject(new Error('ipc closed'))
    render(<CheckAgain agent="claude" name="Claude Code" reason={UNKNOWN.reason} />)
    press('Check again')
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('ipc closed')
  })
})
