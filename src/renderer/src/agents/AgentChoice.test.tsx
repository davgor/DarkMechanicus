// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { chatModelOptions, type AgentModels } from '../../../shared/agents/models'
import hostCatalog from '../../../main/agentChat/__fixtures__/omp/models.json'
import type { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { AgentChoice, ModelChoice } from './NewChatFields'
import { startModel, useAgentModelChoice, type AgentModelChoice } from './useAgentModelChoice'

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
  const choice: AgentModelChoice = {
    agent: 'claude', models, value, model: value === '' ? null : value, thinking: null, valid,
    chooseAgent: () => undefined, chooseModel: (next) => { changes.push(next) }
  }
  render(<ModelChoice choice={choice} folder={null} />)
  return changes
}

/** An OMP agent's model choice as Start run uses it (`useAgentModelChoice`), with what a start request would carry. */
function SkitariiChoice(): JSX.Element {
  const choice = useAgentModelChoice([agentView({ kind: 'omp' })], { omp: signedIn })
  return (
    <>
      <ModelChoice choice={choice} folder="C:/Repo" />
      <output aria-label="Request">{JSON.stringify(startModel(choice))}</output>
    </>
  )
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

describe('ModelChoice: a Skitarii agent', () => {
  it('offers an OMP agent its catalog, featured then More, and yields provider/id and the effort chosen, or nothing for Default', async () => {
    const dm = new FakeDm()
    const api = dm.agentChat as FakeAgentChat
    api.modelsResult = { ok: true, data: chatModelOptions(hostCatalog) }
    window.dm = dm
    render(<SkitariiChoice />)
    await settle()
    const request = (): string | null => screen.getByRole('status', { name: 'Request' }).textContent
    const menu = (): HTMLElement => screen.getByRole('menu', { name: 'Model and effort' })
    const item = (name: string): HTMLElement =>
      within(menu()).getAllByRole('menuitemradio').find((entry) => entry.querySelector('.model-picker-name')?.textContent === name)!

    expect(api.callsOf('models')).toEqual([[{ folder: 'C:/Repo', agentId: 'omp' }]])
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(request()).toBe('{"model":null}')
    fireEvent.click(screen.getByRole('button', { name: 'Model: Default' }))
    expect(item('Default').getAttribute('aria-checked')).toBe('true')
    expect(within(within(menu()).getByRole('group', { name: 'Claude' })).getAllByRole('menuitemradio').map((entry) => entry.querySelector('.model-picker-name')?.textContent))
      .toEqual(['Fable 5.2', 'Haiku 5.5', 'Mythos 5.2', 'Opus 5.5', 'Sonnet 5.5'])
    expect(within(menu()).getByRole('menuitem', { name: 'More models' })).toBeTruthy()
    fireEvent.click(item('Sonnet 5.5'))
    fireEvent.click(within(within(menu()).getByRole('group', { name: 'Effort' })).getByRole('menuitemradio', { name: 'Low' }))
    await settle()
    expect(request()).toBe('{"model":"anthropic/claude-sonnet-5-5","thinking":"low"}')
    expect(screen.getByRole('button', { name: 'Model: Sonnet 5.5 · Low' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Model: Sonnet 5.5 · Low' }))
    fireEvent.click(item('Default'))
    await settle()
    expect(request()).toBe('{"model":null}')
  })
})
