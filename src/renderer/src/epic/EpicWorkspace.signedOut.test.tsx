// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import { SIGNED_OUT_PAUSE_REASON } from '../../../shared/domain/status'
import { chatRecord } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { SIGN_IN_POLL_MS } from '../agents/SignInPrompt'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { fakeOrchestration, readyAgent } from './__mocks__/fakeOrchestration'
import { runView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'Claude Code asked to sign in again.' }
const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Signed in.' }
const orchestrator = chatRecord({ id: 'chat_9', agent: 'claude', title: 'Orchestrator · Planning vertical slice', runId: 'rn_2' })

/** A run the main process paused because its orchestrator's agent lost its sign-in. */
const pausedForSignIn = (): FakeBackend => new FakeBackend(scenario({ run: runView({ state: 'paused', pauseReason: SIGNED_OUT_PAUSE_REASON }) }))

function hostWith(status: AgentAuthStatus | undefined, chats = [orchestrator]): ReturnType<typeof fakeOrchestration> {
  const { agent } = readyAgent('claude')
  return fakeOrchestration({ agents: [agent], statuses: status === undefined ? {} : { claude: status }, chats })
}

const runBar = async (): Promise<ReturnType<typeof within>> => within(await screen.findByLabelText('Run'))
const resume = (bar: ReturnType<typeof within>): HTMLButtonElement => bar.getByRole('button', { name: 'Resume run' }) as HTMLButtonElement

describe('Run bar: paused because the orchestrator’s agent signed out', () => {
  it('reads Paused: <Agent> signed out and links to the orchestrator chat', async () => {
    const host = hostWith(SIGNED_OUT)
    renderWorkspace(pausedForSignIn(), { orchestration: host })
    const bar = await runBar()
    expect(bar.getByText('Paused: Claude Code signed out')).toBeTruthy()
    expect(bar.queryByText(/Orchestrated by/)).toBeNull()
    fireEvent.click(bar.getByRole('button', { name: 'Orchestrator · Planning vertical slice' }))
    expect(host.openedChats).toEqual(['chat_9'])
  })

  it('keeps Resume off while the agent is signed out, and says why', async () => {
    renderWorkspace(pausedForSignIn(), { orchestration: hostWith(SIGNED_OUT) })
    const bar = await runBar()
    expect(resume(bar).disabled).toBe(true)
    expect(resume(bar).title).toBe('Sign in to Claude Code first')
    expect(bar.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('keeps Resume off until the agent’s status is known', async () => {
    renderWorkspace(pausedForSignIn(), { orchestration: hostWith(undefined) })
    expect(resume(await runBar()).disabled).toBe(true)
  })

  it('enables Resume once the agent is signed in, and resumes the run', async () => {
    const backend = pausedForSignIn()
    renderWorkspace(backend, { orchestration: hostWith(SIGNED_IN) })
    const bar = await runBar()
    expect(bar.getByText('Paused: Claude Code signed out')).toBeTruthy()
    expect(bar.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(resume(bar).disabled).toBe(false)
    fireEvent.click(resume(bar))
    await waitFor(() => expect(backend.names()).toContain('resumeRun'))
  })

  it('turns Resume on when the agent’s state changes to signed in while the bar is shown', async () => {
    const host = hostWith(SIGNED_OUT)
    const harness = renderWorkspace(pausedForSignIn(), { orchestration: host })
    expect(resume(await runBar()).disabled).toBe(true)
    host.statuses = { claude: SIGNED_IN }
    harness.refresh(1)
    await waitFor(async () => expect(resume(await runBar()).disabled).toBe(false))
  })
})

describe('Run bar: signing in from the bar', () => {
  it('starts the agent’s sign-in and reports the status it finds, until the agent is signed in', async () => {
    const backend = pausedForSignIn()
    const host = hostWith(SIGNED_OUT)
    renderWorkspace(backend, { orchestration: host })
    const bar = await runBar()
    vi.useFakeTimers()
    backend.signInAgent = () => Promise.resolve({ outcome: 'started' })
    backend.agentStatus = () => Promise.resolve(SIGNED_IN)
    fireEvent.click(bar.getByRole('button', { name: 'Sign in' }))
    await settle()
    expect(bar.getByText('Sign-in started')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)
    })
    expect(host.reportedStatuses).toEqual([['claude', SIGNED_IN]])
  })

  it('asks again for a state that is unknown, giving the reason', async () => {
    renderWorkspace(pausedForSignIn(), { orchestration: hostWith({ state: 'unknown', reason: 'The status command did not answer.' }) })
    const bar = await runBar()
    expect(bar.getByText('The status command did not answer.')).toBeTruthy()
    expect(bar.getByRole('button', { name: 'Check again' })).toBeTruthy()
    expect(resume(bar).disabled).toBe(true)
  })
})

describe('Run bar: paused without a known signed-out agent', () => {
  it('says the orchestrator’s agent signed out when its chat is not known, and leaves Resume alone', async () => {
    renderWorkspace(pausedForSignIn(), { orchestration: hostWith(SIGNED_OUT, []) })
    const bar = await runBar()
    expect(bar.getByText('Paused: the orchestrator’s agent signed out')).toBeTruthy()
    expect(bar.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(resume(bar).disabled).toBe(false)
  })

  it('shows a run paused for another reason as before, with Resume on and the orchestrator’s link', async () => {
    const backend = new FakeBackend(scenario({ run: runView({ state: 'paused', pauseReason: 'branch changed' }) }))
    renderWorkspace(backend, { orchestration: hostWith(SIGNED_OUT) })
    const bar = await runBar()
    expect(bar.queryByText(/signed out/)).toBeNull()
    expect(bar.getByText('Orchestrated by Claude Code in')).toBeTruthy()
    expect(resume(bar).disabled).toBe(false)
  })
})
