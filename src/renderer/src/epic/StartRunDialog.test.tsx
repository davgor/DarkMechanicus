// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAuthStatus, AgentKind, AgentView } from '../../../shared/desktop/api'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { SIGN_IN_POLL_MS } from '../agents/SignInPrompt'
import type { StartRunChoice } from './orchestration'
import { StartRunDialog } from './StartRunDialog'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  dm.chats.modelLists = {
    claude: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' }
    ],
    codex: [{ id: 'gpt-5', label: 'GPT-5' }]
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'ok' }
const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'no' }

const claude = agentView({ kind: 'claude' })
const codex = agentView({ kind: 'codex', executablePath: '/bin/codex', version: '0.9.1' })

interface Setup {
  agents?: AgentView[]
  statuses?: Partial<Record<AgentKind, AgentAuthStatus>>
  busy?: boolean
}

interface Calls {
  agent: StartRunChoice[]
  pending: number
  closed: number
  addAgent: number
}

/** The dialog over statuses it is told about, as the shell tells it: a status a sign-in prompt finds is kept. */
function Harness({ setup, calls }: { setup: Setup; calls: Calls }): JSX.Element {
  const [statuses, setStatuses] = useState(setup.statuses ?? { claude: SIGNED_IN, codex: SIGNED_IN })
  return (
    <StartRunDialog
      epicTitle="Agent chats"
      agents={setup.agents ?? [claude, codex]}
      statuses={statuses}
      busy={setup.busy ?? false}
      onRunWithAgent={(choice) => calls.agent.push(choice)}
      onLeavePending={() => {
        calls.pending += 1
      }}
      onAddAgent={() => {
        calls.addAgent += 1
      }}
      onAgentStatus={(kind, status) => setStatuses((previous) => ({ ...previous, [kind]: status }))}
      onClose={() => {
        calls.closed += 1
      }}
    />
  )
}

async function open(setup: Setup = {}): Promise<Calls> {
  const calls: Calls = { agent: [], pending: 0, closed: 0, addAgent: 0 }
  render(<Harness setup={setup} calls={calls} />)
  await settle()
  return calls
}

const dialog = (): ReturnType<typeof within> => within(screen.getByRole('dialog', { name: 'Start run' }))
const agentRadio = (name: string): HTMLInputElement => dialog().getByRole('radio', { name: new RegExp(name) })
const modelOptions = (): string[] =>
  Array.from((dialog().getByLabelText('Model') as HTMLSelectElement).options).map((option) => option.value)
const runWithAgent = (): HTMLButtonElement => dialog().getByRole('button', { name: 'Run with agent' }) as HTMLButtonElement
const leavePending = (): HTMLButtonElement => dialog().getByRole('button', { name: 'Leave pending' }) as HTMLButtonElement

describe('StartRunDialog: run with an agent', () => {
  it('offers only connected agents that are signed in, the first one chosen, with that agent’s models', async () => {
    await open({ agents: [claude, codex], statuses: { claude: SIGNED_OUT, codex: SIGNED_IN } })

    expect(dialog().getAllByRole('radio')).toHaveLength(1)
    expect(agentRadio('Codex').checked).toBe(true)
    expect(modelOptions()).toEqual(['gpt-5'])
  })

  it('shows the models of the agent that is picked', async () => {
    await open()
    expect(agentRadio('Claude Code').checked).toBe(true)
    expect(modelOptions()).toEqual(['opus', 'sonnet'])

    fireEvent.click(agentRadio('Codex'))
    await settle()

    expect(modelOptions()).toEqual(['gpt-5'])
  })

  it('starts the chosen agent on the chosen model', async () => {
    const calls = await open()
    fireEvent.change(dialog().getByLabelText('Model'), { target: { value: 'sonnet' } })

    fireEvent.click(runWithAgent())

    expect(calls.agent).toEqual([{ agent: 'claude', model: 'sonnet' }])
    expect(calls.pending).toBe(0)
  })

  it('starts the agent on its default model when it lists none', async () => {
    dm.chats.modelLists = {}
    const calls = await open()

    fireEvent.click(runWithAgent())

    expect(calls.agent).toEqual([{ agent: 'claude', model: null }])
  })

  it('says the orchestrator cannot save plans, and offers no role or Allow save choice', async () => {
    await open()

    expect(dialog().getByText(/cannot save plans/)).toBeTruthy()
    expect(dialog().queryByLabelText('Role')).toBeNull()
    expect(dialog().queryByRole('checkbox')).toBeNull()
  })
})

describe('StartRunDialog: leave pending', () => {
  it('leaves the run pending without choosing an agent', async () => {
    const calls = await open()

    fireEvent.click(leavePending())

    expect(calls.pending).toBe(1)
    expect(calls.agent).toEqual([])
  })

  it('says what pending means: an orchestrator you start yourself picks the run up', async () => {
    await open()

    expect(dialog().getByText(/external orchestrator/)).toBeTruthy()
  })
})

describe('StartRunDialog: no agent that is connected and signed in', () => {
  it('links to the add-agent pane, cannot run with an agent, and still leaves the run pending', async () => {
    const calls = await open({ agents: [], statuses: {} })

    expect(dialog().getByText('No agent is connected and signed in.')).toBeTruthy()
    expect(dialog().queryByLabelText('Model')).toBeNull()
    expect(runWithAgent().disabled).toBe(true)
    fireEvent.click(dialog().getByRole('button', { name: 'Add Claude Code' }))
    expect(calls.addAgent).toBe(1)

    expect(leavePending().disabled).toBe(false)
    fireEvent.click(leavePending())
    expect(calls.pending).toBe(1)
  })

  it('lists a connected agent that is signed out with Sign in, and cannot run with it', async () => {
    const calls = await open({ agents: [claude, codex], statuses: { claude: SIGNED_OUT, codex: SIGNED_IN } })

    const unavailable = within(dialog().getByRole('list', { name: 'Not available' }))
    expect(unavailable.getByText('Signed out')).toBeTruthy()
    expect(dialog().queryByRole('radio', { name: /Claude Code/ })).toBeNull()
    fireEvent.click(unavailable.getByRole('button', { name: 'Sign in' }))
    await settle()

    expect(dm.agentCallsOf('signInAgent')).toEqual([['claude']])
    expect(calls.closed).toBe(0)
  })

  it('makes the signed-out agent selectable once the status says signed in, without leaving the dialog', async () => {
    const calls = await open({ agents: [claude], statuses: { claude: SIGNED_OUT } })
    expect(runWithAgent().disabled).toBe(true)
    vi.useFakeTimers()
    fireEvent.click(dialog().getByRole('button', { name: 'Sign in' }))
    await settle()

    dm.agentStatuses.claude = SIGNED_IN
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)
    })
    await settle()

    expect(agentRadio('Claude Code').checked).toBe(true)
    expect(dialog().queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(modelOptions()).toEqual(['opus', 'sonnet'])
    expect(runWithAgent().disabled).toBe(false)
    fireEvent.click(runWithAgent())
    expect(calls.agent).toEqual([{ agent: 'claude', model: 'opus' }])
    expect(calls.closed).toBe(0)
  })
})

describe('StartRunDialog: busy and closing', () => {
  it('disables both choices while the run is being started', async () => {
    await open({ busy: true })

    expect([runWithAgent().disabled, leavePending().disabled]).toEqual([true, true])
  })

  it('closes from Cancel and from Escape', async () => {
    const calls = await open()

    fireEvent.click(dialog().getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(calls.closed).toBe(2)
  })
})
