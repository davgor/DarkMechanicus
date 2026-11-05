// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentModels } from '../../../shared/agents/models'
import { agentView } from '../__mocks__/fixtures'
import { AgentChoice, ModelChoice } from './NewChatFields'

afterEach(cleanup)

const signedIn = { state: 'signed_in', reason: '' } as const
const signedOut = { state: 'signed_out', reason: '' } as const

interface Calls {
  chosen: string[]
  added: number
}

function choice(props: Partial<Parameters<typeof AgentChoice>[0]> = {}): Calls {
  const calls: Calls = { chosen: [], added: 0 }
  render(
    <AgentChoice
      agents={[]}
      statuses={{}}
      value={null}
      onChange={(id) => calls.chosen.push(id)}
      onAddAgent={() => (calls.added += 1)}
      onAgentStatus={() => undefined}
      {...props}
    />
  )
  return calls
}

describe('AgentChoice', () => {
  it('offers each ready agent as a radio with its version, checked for the chosen one, and reports a pick', () => {
    const claude = agentView({ kind: 'claude', version: '2.1.4' })
    const omp = agentView({ kind: 'omp', version: null })
    const calls = choice({ agents: [claude, omp], statuses: { claude: signedIn, omp: signedIn }, value: 'omp' })

    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((radio) => radio.checked)).toEqual([false, true])
    expect(screen.getByText('v2.1.4')).toBeTruthy()
    expect(screen.getByText('Version unknown')).toBeTruthy()
    fireEvent.click(radios[0]!)
    expect(calls.chosen).toEqual(['claude'])
  })

  it('says no agent is ready, in its own words when a caller has them, and offers no radio', () => {
    choice({ agents: [agentView({ kind: 'claude' })], statuses: { claude: signedOut } })
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByText('No agent is ready to chat yet. Connect one and sign in to start a chat.')).toBeTruthy()
    cleanup()

    choice({ emptyText: 'Nothing to run on.' })
    expect(screen.getByText('Nothing to run on.')).toBeTruthy()
  })

  it('lists what cannot chat yet: a built-in that is not connected offers Add, a signed-out one offers Sign in, a custom CLI is named with its sign-in state', () => {
    const calls = choice({
      agents: [agentView({ kind: 'claude' }), agentView({ kind: 'omp' }), agentView({ kind: 'custom', displayName: 'My CLI' })],
      statuses: { claude: signedIn, omp: signedOut }
    })

    const list = screen.getByRole('list')
    const rows = within(list).getAllByRole('listitem')
    const row = (name: string): HTMLElement => rows.find((candidate) => within(candidate).queryByText(name) !== null)!
    // Claude is ready, so it is not listed; the other three built-ins are not connected.
    expect(within(list).queryByText('Claude Code')).toBeNull()
    for (const name of ['Codex', 'Cursor', 'Autonomous']) {
      expect(within(row(name)).getByText('Not connected')).toBeTruthy()
      expect(within(row(name)).getByRole('button', { name: `Add ${name}` })).toBeTruthy()
    }
    expect(within(row('Skitarii')).getByText('Signed out')).toBeTruthy()
    expect(within(row('Skitarii')).queryByText('Not connected')).toBeNull()
    expect(within(row('Skitarii')).getByRole('group', { name: 'Sign in to Skitarii' })).toBeTruthy()
    expect(within(row('Skitarii')).queryByRole('button', { name: 'Add Skitarii' })).toBeNull()
    expect(within(row('My CLI')).queryByText('Not connected')).toBeNull()
    expect(within(row('My CLI')).getByText('Checking sign-in…')).toBeTruthy()
    fireEvent.click(within(row('Codex')).getByRole('button', { name: 'Add Codex' }))
    expect(calls.added).toBe(1)
  })

  it('lists nothing as unavailable when every built-in is connected and ready', () => {
    const kinds = ['claude', 'codex', 'cursor', 'autonomous', 'omp'] as const
    choice({ agents: kinds.map((kind) => agentView({ kind })), statuses: Object.fromEntries(kinds.map((kind) => [kind, signedIn])) })

    expect(screen.queryByText('Not available')).toBeNull()
    expect(screen.getAllByRole('radio')).toHaveLength(5)
  })
})

function model(models: AgentModels, value = '', valid = true): string[] {
  const changes: string[] = []
  render(<ModelChoice models={models} value={value} valid={valid} onChange={(next) => changes.push(next)} />)
  return changes
}

describe('ModelChoice', () => {
  it('picks from a list for an agent with curated models, and shows nothing else', () => {
    const changes = model({ kind: 'list', models: [{ id: 'default', label: 'Default (recommended)' }, { id: 'opus', label: 'Opus' }] }, 'default')

    const select = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Default (recommended)', 'Opus'])
    expect(select.value).toBe('default')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText('The CLI picks its own model.')).toBeNull()
    fireEvent.change(select, { target: { value: 'opus' } })
    expect(changes).toEqual(['opus'])
  })

  it('takes a typed id for an agent with free models, and says so when the id is not valid', () => {
    const changes = model({ kind: 'free' }, 'provider/model')

    const input = screen.getByRole('textbox', { name: 'Model' }) as HTMLInputElement
    expect(input.value).toBe('provider/model')
    expect(input.getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText(/Leave it empty for the agent’s default model/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(input, { target: { value: 'x' } })
    expect(changes).toEqual(['x'])
    cleanup()

    model({ kind: 'free' }, '-bad', false)
    expect(screen.getByRole('textbox', { name: 'Model' }).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toMatch(/A model id holds only letters, digits/)
    expect(screen.queryByText(/Leave it empty/)).toBeNull()
  })

  it('leaves the model to the CLI for an agent that picks its own', () => {
    model({ kind: 'cli' })

    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toBe('CLI default')
    expect(screen.getByText('The CLI picks its own model.')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
