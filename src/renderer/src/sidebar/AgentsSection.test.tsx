// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { AgentAuthStatus, AgentKind, AgentView } from '../../../shared/desktop/api'
import type { AgentStatuses } from '../agents/useAgents'
import { AgentsSection } from './AgentsSection'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const claude = agentView({ kind: 'claude', version: '2.1.4' })
const codex = agentView({ kind: 'codex', version: null, executablePath: '/usr/local/bin/codex' })

interface Calls {
  added: number
  selected: AgentKind[]
  statuses: [AgentKind, AgentAuthStatus][]
}

function renderSection(agents: AgentView[], statuses: AgentStatuses = {}, selected: AgentKind | null = null): Calls {
  const calls: Calls = { added: 0, selected: [], statuses: [] }
  render(
    <AgentsSection
      agents={agents}
      statuses={statuses}
      selected={selected}
      onAdd={() => {
        calls.added += 1
      }}
      onSelect={(kind) => calls.selected.push(kind)}
      onStatus={(kind, status) => calls.statuses.push([kind, status])}
    />
  )
  return calls
}

describe('AgentsSection head', () => {
  it('has an AGENTS eyebrow and a ghost + button labelled Add an agent', () => {
    const calls = renderSection([])
    expect(screen.getByText('AGENTS')).toBeTruthy()
    const add = screen.getByRole('button', { name: 'Add an agent' })
    expect(add.className).toContain('btn-ghost')
    expect(add.querySelector('[data-icon="plus"]')).toBeTruthy()
    fireEvent.click(add)
    expect(calls.added).toBe(1)
  })
})

describe('AgentsSection sign-in', () => {
  const signedOut: AgentAuthStatus = { state: 'signed_out', reason: 'Not signed in.' }
  const unknown: AgentAuthStatus = { state: 'unknown', reason: 'The status command did not answer.' }

  it('warns about a signed-out agent and offers Sign in on its row, without opening its page', async () => {
    const calls = renderSection([claude, codex], { claude: { state: 'signed_in', reason: 'Signed in.' }, codex: signedOut })
    const [first, second] = within(screen.getByRole('list')).getAllByRole('listitem') as HTMLElement[]
    expect(within(first as HTMLElement).queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(within(second as HTMLElement).getByText('Signed out').closest('.agent-state')?.className).toContain('tone-warn')
    fireEvent.click(within(second as HTMLElement).getByRole('button', { name: 'Sign in' }))
    await settle()
    expect(dm.agentCallsOf('signInAgent')).toEqual([['codex']])
    expect(calls.selected).toEqual([])
  })

  it('shows an unknown state with its reason and Check again, and passes on what the check finds', async () => {
    const calls = renderSection([claude], { claude: unknown })
    expect(screen.getByText('The status command did not answer.')).toBeTruthy()
    dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await settle()
    expect(calls.statuses).toEqual([['claude', { state: 'signed_in', reason: 'Signed in.' }]])
  })

  it('offers nothing while the state is still being asked', () => {
    renderSection([claude])
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
  })
})

describe('AgentsSection list', () => {
  it('explains how to add an agent when there are none', () => {
    renderSection([])
    expect(screen.getByText('No agents yet. Use + to add one.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists each connected agent with its name, version and sign-in state', () => {
    renderSection([claude, codex], {
      claude: { state: 'signed_in', reason: 'Signed in.' },
      codex: { state: 'signed_out', reason: 'Not signed in.' }
    })
    expect(screen.queryByText('No agents yet. Use + to add one.')).toBeNull()
    const [first, second] = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(within(first as HTMLElement).getByText('Claude Code')).toBeTruthy()
    expect(within(first as HTMLElement).getByText('v2.1.4')).toBeTruthy()
    expect(within(first as HTMLElement).getByText('Signed in')).toBeTruthy()
    expect(within(second as HTMLElement).getByText('Codex')).toBeTruthy()
    expect(within(second as HTMLElement).getByText('Version unknown')).toBeTruthy()
    expect(within(second as HTMLElement).getByText('Signed out')).toBeTruthy()
  })

  it('says the sign-in state is being checked until it arrives', () => {
    renderSection([claude])
    expect(screen.getByText('Checking sign-in…')).toBeTruthy()
  })

  it('opens the page of the agent whose row is chosen', () => {
    const calls = renderSection([claude, codex])
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    expect(calls.selected).toEqual(['codex'])
  })

  it('marks the agent whose page is open', () => {
    renderSection([claude, codex], {}, 'codex')
    expect(screen.getByRole('button', { name: /Codex/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: /Claude Code/ }).getAttribute('aria-current')).toBeNull()
  })
})
