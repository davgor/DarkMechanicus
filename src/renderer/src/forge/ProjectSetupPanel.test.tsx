// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { codePath, fakeForgeSetup, forgeMember, setupProject, workflowHash } from '../__mocks__/forgeSetup'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ProjectSetupPanel } from './ProjectSetupPanel'

afterEach(cleanup)

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const write = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } })

function undoCheck(checkbox: HTMLInputElement): void {
  expect(checkbox.checked).toBe(false)
  fireEvent.click(checkbox)
  expect(checkbox.checked).toBe(true)
  fireEvent.click(checkbox)
  expect(checkbox.checked).toBe(false)
}

function fixture(api = fakeForgeSetup(), checkout: string | null = codePath, member = forgeMember.path) {
  const scheduler = new ManualScheduler()
  const openChat = vi.fn(async () => undefined)
  const view = render(<ProjectSetupPanel api={api} member={member} checkout={checkout} scheduler={scheduler} onOpenChat={openChat} />)
  return { api, openChat, view, poll: () => act(() => scheduler.fireIntervals(5000)) }
}

function revision(notes: string) {
  const next = setupProject()
  next.value!.sha256 = 'd'.repeat(64)
  next.value!.value.revision += 1
  next.value!.value.notes = notes
  return next
}

it('recovers a failed local read without dispatching and links only a confirmed onboarding chat', async () => {
  const api = fakeForgeSetup()
  api.project.mockRejectedValueOnce(new Error('The local workflow could not be read.'))
  api.project.mockResolvedValue(setupProject({ state: 'missing', value: null, onboarding: null }))
  api.prepare.mockResolvedValueOnce({ state: 'uncertain', chatId: 'unconfirmed', message: null })
  const { poll, openChat } = fixture(api, null)
  expect(await screen.findByText('The local workflow could not be read.')).toBeTruthy()
  click('Reload workflow')
  expect(await screen.findByText('No portable setup workflow yet.')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Set up environment' }).disabled).toBe(true)
  click('Prepare with agent')
  expect(await screen.findByText('Onboarding delivery is unconfirmed.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Open onboarding' })).toBeNull()
  expect(openChat).not.toHaveBeenCalled()
  api.project.mockResolvedValue(setupProject())
  poll()
  await settle()
  expect(openChat).not.toHaveBeenCalled()
  click('Open onboarding')
  await settle()
  expect(openChat).toHaveBeenCalledExactlyOnceWith('chat_onboarding')
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith(forgeMember.path)
  expect(api.run).not.toHaveBeenCalled()
})

it('opens the durable conversation when an explicit preparation succeeds', async () => {
  const api = fakeForgeSetup()
  api.project.mockResolvedValue(setupProject({ onboarding: null }))
  const { openChat } = fixture(api)
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare with agent' }))
  await settle()
  expect(openChat).toHaveBeenCalledExactlyOnceWith('chat_onboarding')
  expect(api.run).not.toHaveBeenCalled()
})

it('keeps a local draft visible when a poll reports a newer saved workflow and shows its YAML when requested', async () => {
  const { api, poll } = fixture()
  fireEvent.click(await screen.findByRole('button', { name: 'Edit workflow' }))
  write(screen.getByLabelText('Setup notes'), 'Keep my draft database instructions.')
  api.project.mockResolvedValue(revision('Updated installation notes from the repository.'))
  poll()
  expect(await screen.findByText('A newer workflow is saved. Your draft remains here for review.')).toBeTruthy()
  expect(screen.getByLabelText<HTMLTextAreaElement>('Setup notes').value).toBe('Keep my draft database instructions.')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save workflow' }).disabled).toBe(true)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  fireEvent.click(screen.getByText('Requirements and workflow · Revision 3'))
  const details = screen.getByText('Workflow YAML').closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  expect(screen.getByText(/notes: Updated installation notes from the repository/)).toBeTruthy()
  expect(api.saveWorkflow).not.toHaveBeenCalled()
})

it('does not let a delayed project read overwrite a newer successful save', async () => {
  const { api, poll } = fixture()
  const reading = deferred()
  const saving = deferred()
  fireEvent.click(await screen.findByRole('button', { name: 'Edit workflow' }))
  write(screen.getByLabelText('Setup notes'), 'Keep the agreed fresh setup.')
  api.project.mockImplementationOnce(() => reading.promise.then(() => setupProject()))
  api.saveWorkflow.mockImplementationOnce(() => saving.promise.then(() => revision('Keep the agreed fresh setup.')))
  poll()
  poll()
  expect(api.project).toHaveBeenCalledTimes(2)
  click('Save workflow')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.getByRole('dialog')).toBeTruthy()
  saving.resolve()
  expect(await screen.findByText('Requirements and workflow · Revision 3')).toBeTruthy()
  reading.resolve()
  await settle()
  expect(screen.queryByText('Requirements and workflow · Revision 2')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(api.saveWorkflow).toHaveBeenCalledTimes(1)
})

it('holds setup during a requirements refresh and ignores its failure after leaving the page', async () => {
  const api = fakeForgeSetup()
  const refreshing = deferred()
  api.refresh.mockImplementationOnce(async () => {
    await refreshing.promise
    throw new Error('The previous refresh lost its connection.')
  })
  const { poll, view } = fixture(api)
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh requirements' }))
  poll()
  expect(api.project).toHaveBeenCalledTimes(1)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Set up environment' }).disabled).toBe(true)
  expect(api.run).not.toHaveBeenCalled()
  view.unmount()
  api.project.mockResolvedValue(revision('The saved workflow after reopening.'))
  fixture(api)
  refreshing.resolve()
  expect(await screen.findByText('Requirements and workflow · Revision 3')).toBeTruthy()
  expect(screen.queryByText('The previous refresh lost its connection.')).toBeNull()
})

it('keeps a late workflow save with the previous project after switching members', async () => {
  const { api, view } = fixture()
  const saving = deferred()
  api.saveWorkflow.mockImplementationOnce(() => saving.promise.then(() => revision('Saved in the previous project.')))
  fireEvent.click(await screen.findByRole('button', { name: 'Edit workflow' }))
  write(screen.getByLabelText('Setup notes'), 'Saved in the previous project.')
  click('Save workflow')
  view.unmount()
  const member = '/tickets/world/Beta'
  const next = revision('Workflow specific to the current project.')
  next.value!.value.revision = 4
  api.project.mockResolvedValue({ ...next, member })
  fixture(api, '/code/beta', member)
  expect(await screen.findByText('Requirements and workflow · Revision 4')).toBeTruthy()
  saving.resolve()
  await settle()
  expect(api.saveWorkflow.mock.calls[0][0]).toBe(forgeMember.path)
  expect(screen.getByText('Requirements and workflow · Revision 4')).toBeTruthy()
  expect(screen.queryByText('Saved in the previous project.')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['submitted', 'uncertain'] as const)('does not resend a %s execution', async state => {
  const api = fakeForgeSetup()
  api.project.mockResolvedValue(setupProject({ onboarding: { state: 'opened', chatId: 'chat_onboarding', message: null,
    run: { state, workflowSha256: workflowHash, chatId: 'execution_to_check' } } }))
  const { openChat } = fixture(api)
  await screen.findByText(state === 'submitted' ? 'Setup was sent. Check the setup chat for results on this computer.' : 'Setup delivery is unconfirmed.')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Set up environment' }).disabled).toBe(true)
  if (state === 'submitted') {
    click('Open setup chat')
    await settle()
    expect(openChat).toHaveBeenCalledExactlyOnceWith('execution_to_check')
  } else {
    expect(screen.queryByRole('button', { name: 'Open setup chat' })).toBeNull()
    expect(openChat).not.toHaveBeenCalled()
  }
  expect(api.run).not.toHaveBeenCalled()
})

it.each(['revision', 'other session'] as const)('requires re-review after a %s changes while setup is open', async reason => {
  const { api, poll } = fixture()
  fireEvent.click(await screen.findByRole('button', { name: 'Set up environment' }))
  const later = reason === 'revision' ? revision('New setup notes.') : setupProject({
    onboarding: { state: 'opened', chatId: 'chat_onboarding', message: null,
      run: { state: 'pending', workflowSha256: workflowHash, chatId: 'setup_elsewhere' } }
  })
  api.project.mockResolvedValue(later)
  poll()
  const dialog = within(screen.getByRole('dialog', { name: 'Set up environment' }))
  const notice = reason === 'revision' ? /The workflow changed/ : /Setup was already requested/
  expect(await dialog.findByText(notice)).toBeTruthy()
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Run setup' }).disabled).toBe(true)
  click('Cancel')
  expect(api.run).not.toHaveBeenCalled()
})

it('edits ordered commands and instructions with platform-specific choices before saving', async () => {
  const api = fakeForgeSetup()
  const fresh = setupProject({ state: 'needs-discovery' })
  delete fresh.value!.value.notes
  fresh.value!.value.workflow = { state: 'needs-discovery', basedOn: null, steps: [] }
  api.project.mockResolvedValue(fresh)
  api.saveWorkflow.mockImplementation(async (_member, edit) => {
    const updated = revision(edit.notes ?? '')
    updated.state = edit.workflow.state
    updated.value!.value.workflow = { ...updated.value!.value.workflow, ...edit.workflow }
    return updated
  })
  fixture(api)
  expect(await screen.findByText('No setup steps yet.')).toBeTruthy()
  click('Edit workflow')
  click('Add command')
  click('Add instruction')
  click('Add command')
  const [install, manual, discarded] = screen.getAllByText(/^Step \d$/).map(name => within(name.closest('fieldset')!))
  write(install.getByLabelText('Step title'), 'Install for Windows')
  write(install.getByLabelText('Program'), 'msiexec')
  const args = install.getByLabelText<HTMLTextAreaElement>('Arguments, one per line')
  write(args, '/i')
  write(args, '')
  expect(args.value).toBe('')
  write(args, '/i\n./setup.msi\n/quiet')
  fireEvent.click(install.getByRole('checkbox', { name: 'Windows' }))
  undoCheck(install.getByRole<HTMLInputElement>('checkbox', { name: 'Linux' }))
  write(manual.getByLabelText('Step title'), 'Ask before continuing')
  write(manual.getByLabelText('Instructions'), 'Confirm the user has a license.')
  undoCheck(manual.getByRole<HTMLInputElement>('checkbox', { name: 'macOS' }))
  fireEvent.click(manual.getByRole('button', { name: 'Move up' }))
  fireEvent.click(discarded.getByRole('button', { name: 'Remove step' }))
  undoCheck(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Setup steps are configured' }))
  click('Save workflow')
  await settle()
  const edit = api.saveWorkflow.mock.calls[0][1]
  expect(edit.workflow.state).toBe('needs-discovery')
  expect(edit.workflow.steps).toMatchObject([
    { kind: 'instruction', instruction: 'Confirm the user has a license.' },
    { kind: 'command', args: ['/i', './setup.msi', '/quiet'], platforms: ['win32'] }
  ])
  expect(edit.workflow.steps[0]).not.toHaveProperty('platforms')
  expect(screen.getByText('Confirm the user has a license.')).toBeTruthy()
  expect(screen.getByText('Windows')).toBeTruthy()
  expect(api.run).not.toHaveBeenCalled()
})
