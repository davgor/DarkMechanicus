// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { BoundFunctions, queries } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { AddAgentPane } from './AddAgentPane'
import { useAgents } from './useAgents'

/** Queries bound to one part of the screen. */
type Scope = BoundFunctions<typeof queries>

let dm: FakeDm
let errors: string[]

beforeEach(() => {
  errors = []
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

function Pane(): JSX.Element {
  const agents = useAgents((error) => errors.push((error as Error).message))
  return <AddAgentPane agents={agents} />
}

/** Mounts the add-agent pane and opens the Custom CLI form from its card. */
async function openForm(): Promise<Scope> {
  render(<Pane />)
  await settle()
  const card = within(screen.getByRole('article', { name: 'Custom CLI' }))
  fireEvent.click(card.getByRole('button', { name: 'Add a custom CLI' }))
  return within(screen.getByRole('form', { name: 'Custom CLI' }))
}

const type = (form: Scope, label: string, value: string): void => {
  fireEvent.change(form.getByLabelText(label), { target: { value } })
}
const argumentValues = (form: Scope): string[] =>
  form.queryAllByRole('textbox', { name: /^Argument \d+$/ }).map((input) => (input as HTMLInputElement).value)
const choose = async (form: Scope): Promise<void> => {
  fireEvent.click(form.getByRole('button', { name: 'Choose executable…' }))
  await settle()
}

const added = agentView({ kind: 'custom', id: 'cu_01m65kwqqeyajbj5bnq81gngrb', displayName: 'My Claude', version: null })

describe('CustomAgentForm: the fields', () => {
  it('asks for a name and arguments only: no protocol choice, and no arguments to start with', async () => {
    const form = await openForm()
    expect(form.queryAllByRole('radio')).toEqual([])
    expect(form.queryByText('Protocol')).toBeNull()
    expect(form.queryByText(/ACP|Codex app-server|Claude Code SDK/)).toBeNull()
    expect(form.getByLabelText('Name')).toBeTruthy()
    expect(argumentValues(form)).toEqual([])
    expect(form.getByText((_, element) => element?.textContent === 'An argument {folder} becomes the chat’s folder.' && element.tagName === 'P')).toBeTruthy()
  })

  it('adds and removes argument rows', async () => {
    const form = await openForm()
    fireEvent.click(form.getByRole('button', { name: 'Add argument' }))
    fireEvent.click(form.getByRole('button', { name: 'Add argument' }))
    type(form, 'Argument 1', '--model')
    type(form, 'Argument 2', '{folder}')
    expect(argumentValues(form)).toEqual(['--model', '{folder}'])
    fireEvent.click(form.getByRole('button', { name: 'Remove argument 1' }))
    expect(argumentValues(form)).toEqual(['{folder}'])
  })
})

describe('CustomAgentForm: sending', () => {
  it('sends exactly the name and arguments, and nothing else', async () => {
    const form = await openForm()
    type(form, 'Name', 'My Claude')
    fireEvent.click(form.getByRole('button', { name: 'Add argument' }))
    fireEvent.click(form.getByRole('button', { name: 'Add argument' }))
    type(form, 'Argument 1', '--model')
    type(form, 'Argument 2', 'haiku')
    await choose(form)
    expect(dm.agentCallsOf('addCustomAgent')).toEqual([[{ name: 'My Claude', args: ['--model', 'haiku'] }]])
    const [[request]] = dm.agentCallsOf('addCustomAgent') as [[object]]
    expect(Object.keys(request).sort()).toEqual(['args', 'name'])
  })

  it('trims the name and arguments and leaves out empty argument rows', async () => {
    const form = await openForm()
    type(form, 'Name', '  My Agent  ')
    fireEvent.click(form.getByRole('button', { name: 'Add argument' }))
    fireEvent.click(form.getByRole('button', { name: 'Add argument' }))
    fireEvent.click(form.getByRole('button', { name: 'Add argument' }))
    type(form, 'Argument 1', '   ')
    type(form, 'Argument 2', ' --verbose ')
    await choose(form)
    expect(dm.agentCallsOf('addCustomAgent')).toEqual([[{ name: 'My Agent', args: ['--verbose'] }]])
  })

  it('cannot choose an executable without a name', async () => {
    const form = await openForm()
    const button = form.getByRole('button', { name: 'Choose executable…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    type(form, 'Name', '   ')
    expect(button.disabled).toBe(true)
    await choose(form)
    expect(dm.agentCallsOf('addCustomAgent')).toEqual([])
  })

})

describe('CustomAgentForm: main’s answer', () => {
  it('shows main’s refusal reason inline and keeps what was typed', async () => {
    dm.customOutcomes = [{ outcome: 'refused', code: 'failed', reason: 'That file is not executable.' }]
    const form = await openForm()
    type(form, 'Name', 'My Agent')
    await choose(form)
    expect(form.getByText('Not connected')).toBeTruthy()
    expect(form.getByText('That file is not executable.')).toBeTruthy()
    expect((form.getByLabelText('Name') as HTMLInputElement).value).toBe('My Agent')
  })

  it('drops the refusal once the form is changed, since it was about what was sent', async () => {
    dm.customOutcomes = [{ outcome: 'refused', code: 'failed', reason: 'That file is not executable.' }]
    const form = await openForm()
    type(form, 'Name', 'My Agent')
    await choose(form)
    type(form, 'Name', 'My Agent 2')
    expect(form.queryByText('That file is not executable.')).toBeNull()
  })

  it('says nothing when the file dialog is closed without a pick', async () => {
    const form = await openForm()
    type(form, 'Name', 'My Agent')
    await choose(form)
    expect(form.queryByRole('status')).toBeNull()
  })

  it('lists the agent once main connects it, says so, and clears the form', async () => {
    dm.customOutcomes = [{ outcome: 'connected', agent: added }]
    const form = await openForm()
    type(form, 'Name', 'My Claude')
    await choose(form)
    expect(screen.getByText('Connected My Claude')).toBeTruthy()
    expect((form.getByLabelText('Name') as HTMLInputElement).value).toBe('')
  })

  it('closes from Cancel without sending anything', async () => {
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Custom CLI' })).toBeNull()
    expect(dm.agentCallsOf('addCustomAgent')).toEqual([])
  })
})
