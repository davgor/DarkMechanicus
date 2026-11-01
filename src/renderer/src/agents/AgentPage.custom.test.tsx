// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { BoundFunctions, queries } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { AgentView } from '../../../shared/desktop/api'
import { AgentPage } from './AgentPage'
import { useAgents } from './useAgents'

/** Queries bound to one part of the screen. */
type Scope = BoundFunctions<typeof queries>

let dm: FakeDm
let errors: string[]

beforeEach(() => {
  errors = []
  dm = new FakeDm()
  window.dm = dm
  dm.agentStatuses[custom.id] = { state: 'unchecked', reason: 'Dark Mechanicus cannot check the sign-in of a custom CLI.' }
})

afterEach(cleanup)

const custom = agentView({
  kind: 'custom',
  id: 'cu_01m65kwqqeyajbj5bnq81gngrb',
  displayName: 'My Codex',
  executablePath: '/opt/tools/codex',
  args: ['app-server', '{folder}'],
  version: null,
  connectedVia: 'custom'
})

/** The same CLI as the v3 migration leaves a row saved for Codex app-server: its arguments need review. */
const flagged: AgentView = { ...custom, needsReview: true }

/** The page of the agent as the shell shows it: the connected one from the list, so an edit shows up. */
function Page({ agent }: { agent: AgentView }): JSX.Element {
  const agents = useAgents((error) => errors.push((error as Error).message))
  return <AgentPage agent={agents.agents.find((candidate) => candidate.id === agent.id) ?? agent} agents={agents} />
}

async function mount(agent: AgentView = custom): Promise<void> {
  dm.agents = [agent]
  render(<Page agent={agent} />)
  await settle()
}

const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }))
}
const valueOf = (label: string): string | undefined => screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? undefined
const editForm = (): Scope => within(screen.getByRole('form', { name: 'Edit My Codex' }))
const argumentValues = (form: Scope): string[] =>
  form.queryAllByRole('textbox', { name: /^Argument \d+$/ }).map((input) => (input as HTMLInputElement).value)

describe('AgentPage: a custom agent’s details', () => {
  it('shows its name, executable, arguments and how it was connected, and no protocol', async () => {
    await mount()
    expect(screen.getByRole('heading', { level: 1, name: 'My Codex' })).toBeTruthy()
    expect(screen.queryByText('Protocol', { selector: 'dt' })).toBeNull()
    expect(screen.queryByText(/Codex app-server|Claude Code SDK|ACP/)).toBeNull()
    expect(valueOf('Executable')).toBe('/opt/tools/codex')
    expect(valueOf('Arguments')).toBe('app-server {folder}')
    expect(valueOf('Version')).toBe('Version unknown')
    expect(valueOf('Connected')).toMatch(/^Added as a custom CLI/)
  })

  it('says when it has no arguments', async () => {
    await mount({ ...custom, args: [] })
    expect(valueOf('Arguments')).toBe('None')
  })

  it('offers Edit and Remove, and no Review arguments, Sign in, Find again or Update', async () => {
    await mount()
    expect(valueOf('Sign-in')).toMatch(/Sign-in not checked/)
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
    for (const name of ['Review arguments', 'Sign in', 'Find again', 'Update']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByRole('note', { name: 'Review needed' })).toBeNull()
  })

})

describe('AgentPage: editing a custom agent', () => {
  it('edits with the current name and arguments, and no protocol', async () => {
    await mount()
    press('Edit')
    const form = editForm()
    expect((form.getByLabelText('Name') as HTMLInputElement).value).toBe('My Codex')
    expect(argumentValues(form)).toEqual(['app-server', '{folder}'])
    expect(form.queryByRole('radio')).toBeNull()
    expect((form.getByRole('checkbox', { name: /Choose another executable/ }) as HTMLInputElement).checked).toBe(false)
  })

  it('saves exactly the id, name, arguments and no repick, and shows the change', async () => {
    dm.customOutcomes = [{ outcome: 'connected', agent: { ...custom, displayName: 'Codex (work)', args: ['app-server'] } }]
    await mount()
    press('Edit')
    const form = editForm()
    fireEvent.change(form.getByLabelText('Name'), { target: { value: ' Codex (work) ' } })
    fireEvent.click(form.getByRole('button', { name: 'Remove argument 2' }))
    fireEvent.click(form.getByRole('button', { name: 'Save' }))
    await settle()
    expect(dm.agentCallsOf('updateCustomAgent')).toEqual([[{ id: custom.id, name: 'Codex (work)', args: ['app-server'], repick: false }]])
    expect(screen.queryByRole('form', { name: /^Edit/ })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'Codex (work)' })).toBeTruthy()
    expect(screen.getByText('Saved Codex (work)')).toBeTruthy()
  })

  it('asks main to pick another executable when that is ticked', async () => {
    await mount()
    press('Edit')
    const form = editForm()
    fireEvent.click(form.getByRole('checkbox', { name: /Choose another executable/ }))
    fireEvent.click(form.getByRole('button', { name: 'Save' }))
    await settle()
    expect(dm.agentCallsOf('updateCustomAgent')).toEqual([[{ id: custom.id, name: 'My Codex', args: ['app-server', '{folder}'], repick: true }]])
  })

})

describe('AgentPage: a custom agent marked for review', () => {
  const reviewForm = (): Scope => within(screen.getByRole('form', { name: 'Review arguments for My Codex' }))

  it('says why it does not start, and offers Review arguments in place of Edit', async () => {
    await mount(flagged)
    const note = within(screen.getByRole('note', { name: 'Review needed' }))
    expect(note.getByText(/saved before chats ran in a terminal/)).toBeTruthy()
    expect(note.getByText(/No chat starts it until you review/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review arguments' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
  })

  it('reviews with the stored name and arguments, which can be edited, and sends them as an edit', async () => {
    dm.customOutcomes = [{ outcome: 'connected', agent: { ...custom, args: ['{folder}'], needsReview: false } }]
    await mount(flagged)
    press('Review arguments')
    const form = reviewForm()
    expect((form.getByLabelText('Name') as HTMLInputElement).value).toBe('My Codex')
    expect(argumentValues(form)).toEqual(['app-server', '{folder}'])
    fireEvent.click(form.getByRole('button', { name: 'Remove argument 1' }))
    fireEvent.click(form.getByRole('button', { name: 'Confirm arguments' }))
    await settle()
    expect(dm.agentCallsOf('updateCustomAgent')).toEqual([[{ id: custom.id, name: 'My Codex', args: ['{folder}'], repick: false }]])
    expect(screen.queryByRole('form', { name: /^Review arguments/ })).toBeNull()
    expect(screen.queryByRole('note', { name: 'Review needed' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(valueOf('Arguments')).toBe('{folder}')
  })

  it('stays marked when the review is cancelled', async () => {
    await mount(flagged)
    press('Review arguments')
    fireEvent.click(reviewForm().getByRole('button', { name: 'Cancel' }))
    expect(dm.agentCallsOf('updateCustomAgent')).toEqual([])
    expect(screen.getByRole('note', { name: 'Review needed' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review arguments' })).toBeTruthy()
  })
})

describe('AgentPage: an edit main refuses or the person cancels', () => {
  it('shows main’s refusal reason in the form and keeps it open', async () => {
    dm.customOutcomes = [{ outcome: 'refused', code: 'failed', reason: 'Another custom CLI is already called Codex.' }]
    await mount()
    press('Edit')
    fireEvent.change(editForm().getByLabelText('Name'), { target: { value: 'Codex' } })
    fireEvent.click(editForm().getByRole('button', { name: 'Save' }))
    await settle()
    expect(editForm().getByText('Not saved')).toBeTruthy()
    expect(editForm().getByText('Another custom CLI is already called Codex.')).toBeTruthy()
    expect((editForm().getByLabelText('Name') as HTMLInputElement).value).toBe('Codex')
  })

  it('cannot save without a name, and Cancel leaves everything as it was', async () => {
    await mount()
    press('Edit')
    fireEvent.change(editForm().getByLabelText('Name'), { target: { value: '  ' } })
    expect((editForm().getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(editForm().getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: /^Edit/ })).toBeNull()
    expect(dm.agentCallsOf('updateCustomAgent')).toEqual([])
  })

})

describe('AgentPage: removing a custom agent', () => {
  it('removes it by its id after the usual confirmation', async () => {
    await mount()
    press('Remove')
    const dialog = within(screen.getByRole('dialog', { name: 'Remove My Codex?' }))
    expect(dialog.getByText(/stays installed/)).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: 'Remove' }))
    await settle()
    expect(dm.agentCallsOf('removeAgent')).toEqual([[custom.id]])
    expect(errors).toEqual([])
  })
})
