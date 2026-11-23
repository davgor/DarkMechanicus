// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ForgeProvisionStatus } from '../../shared/desktop/forgeSetup'
import { AppHarness } from './__mocks__/appHarness'
import { agentView, chatRecord } from './__mocks__/fixtures'
import { codePath, fakeForgeSetup, forgeMember, forgeWorld, reactRecipe, repository, setupProject, workflowHash } from './__mocks__/forgeSetup'
import { settle } from './__mocks__/settle'

afterEach(cleanup)

function harness() {
  window.localStorage.clear()
  const h = new AppHarness()
  const setup = fakeForgeSetup()
  const add = vi.fn(async () => undefined)
  Object.assign(h.dm, { forgeSetup: setup, forge: {
    add, status: async () => ({ last: null, error: null }),
    memberStatus: async () => ({ readiness: 'ready', syncing: false, error: null }), sync: vi.fn()
  } })
  h.github.account = { login: 'fixture', name: 'Fixture' }
  h.dm.agents = [agentView({ id: 'codex', kind: 'codex' })]
  h.dm.agentStatuses.codex = { state: 'signed_in', reason: 'Ready' }
  return { h, setup, add }
}

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const type = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } })

async function startWorld() {
  click('Add a Forge World')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Create a Forge World…' }))
  await settle()
  return within(screen.getByRole('dialog', { name: 'Create a Forge World' }))
}

it('cancels world creation without publication when the native checkout picker is cancelled', async () => {
  const { h, setup } = harness()
  h.mount()
  await settle()
  const dialog = await startWorld()
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
  expect(setup.provision).not.toHaveBeenCalled()

  const reopened = await startWorld()
  type('World repository name', 'world')
  fireEvent.click(reopened.getByRole('button', { name: 'Create' }))
  await settle()
  expect(setup.provision).toHaveBeenCalledExactlyOnceWith({ world: { kind: 'new', name: 'world' } })
  expect(reopened.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(false)
  expect(h.dm.folders).toEqual([])
})

it('resumes a published code repository by its existing intent with no second create', async () => {
  const { h, setup } = harness()
  const partial: ForgeProvisionStatus = {
    id: 'provision_1', request: { world: { kind: 'new', name: 'world' }, code: { name: 'code', recipeId: reactRecipe.id, visibility: 'private' }, agent: 'codex' },
    phase: 'code-checkout', state: 'needs-attention', world: forgeWorld.path, message: 'GitHub published code, but the local disk is full.'
  }
  setup.provision.mockResolvedValueOnce(partial)
  setup.resumeProvision.mockImplementation(async () => {
    h.dm.folders = [forgeWorld, forgeMember]
    return { ...partial, state: 'complete', phase: 'complete', member: forgeMember.path, message: null }
  })
  h.mount()
  await settle()
  const dialog = await startWorld()
  type('World repository name', 'world')
  fireEvent.click(dialog.getByRole('checkbox', { name: 'Create a code repository' }))
  type('Code repository name', 'code')
  type('Setup agent', 'codex')
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  expect(await dialog.findByText('GitHub published code, but the local disk is full.')).toBeTruthy()
  expect(dialog.queryByRole('button', { name: 'Create' })).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'Resume creation' }))
  await settle()
  expect(setup.provision).toHaveBeenCalledExactlyOnceWith(partial.request)
  expect(setup.resumeProvision).toHaveBeenCalledExactlyOnceWith(partial.id)
  expect(await screen.findByRole('heading', { name: 'Alpha', level: 1 })).toBeTruthy()
})

function openMember(h: AppHarness) {
  h.dm.folders = [forgeWorld, forgeMember]
  h.git.targets.set(forgeMember.path, { kind: 'available', path: codePath, displayPath: '~/code/alpha', repository })
  h.dm.chats.chats = [chatRecord({ id: 'chat_onboarding', folder: forgeMember.path, title: 'Set up Alpha', agent: 'codex', role: 'planner' })]
  window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: forgeMember.path, epicId: null }))
  h.mount()
}

it('prepares standards in the existing Forge onboarding chat and leaves installation to an explicit action', async () => {
  const { h, setup } = harness()
  openMember(h)
  await settle()
  expect(await screen.findByRole('heading', { name: 'Environment setup' })).toBeTruthy()
  expect(setup.prepare).not.toHaveBeenCalled()
  expect(setup.run).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('tab', { name: 'Delivery Standards' }))
  await settle()
  click('Prepare with agent')
  await settle()
  expect(setup.prepare).toHaveBeenCalledExactlyOnceWith(forgeMember.path)
  expect(h.dm.chats.callsOf('create')).toEqual([])
  expect(window.localStorage.getItem('dm.selection')).toContain('chat_onboarding')
  expect(setup.run).not.toHaveBeenCalled()
})

it('shows a stale YAML refusal without opening a terminal or running the newer revision automatically', async () => {
  const { h, setup } = harness()
  setup.run.mockRejectedValueOnce(new Error('Workflow changed after review. Reload the saved workflow.'))
  openMember(h)
  await settle()
  click('Set up environment')
  const confirmation = within(screen.getByRole('dialog', { name: 'Set up environment' }))
  expect(setup.run).not.toHaveBeenCalled()
  fireEvent.click(confirmation.getByRole('button', { name: 'Run setup' }))
  await settle()
  expect(screen.getByRole('alert').textContent).toContain('Workflow changed after review.')
  expect(setup.run).toHaveBeenCalledExactlyOnceWith(forgeMember.path, workflowHash)
  expect(window.localStorage.getItem('dm.selection')).not.toContain('chat_onboarding')
})

it('keeps link-only import separate from setup while showing incomplete detection on its member', async () => {
  const { h, setup, add } = harness()
  const incomplete = setupProject({ state: 'needs-discovery', onboarding: { state: 'preparing', chatId: null, message: null } })
  const file = incomplete.value!
  file.value.detection = { detectorVersion: 1, status: 'unsupported', reason: 'no-node-manifest', source: null, facts: [] }
  setup.project.mockResolvedValue(incomplete)
  h.dm.folders = [forgeWorld, forgeMember]
  h.mount()
  await settle()
  type('GitHub repository', 'fixture/new-repo')
  click('Add repository')
  await settle()
  expect(add).toHaveBeenCalledExactlyOnceWith(forgeWorld.path, 'fixture/new-repo', 'new-repo')
  expect(setup.prepare).not.toHaveBeenCalled()
  expect(setup.run).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: /^Alpha / }))
  expect(await screen.findByText('No supported Node manifest was found.')).toBeTruthy()
  expect(screen.getByText('Onboarding agent is preparing the workflow.')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Set up environment' }).disabled).toBe(true)
})

it('offers the recorded creation intent when the first response was lost', async () => {
  const { h, setup } = harness()
  const request = { world: { kind: 'new' as const, name: 'world' } }
  const partial: ForgeProvisionStatus = {
    id: 'provision_lost', request, state: 'needs-attention', phase: 'world-remote', message: 'Verified the existing remote repository.'
  }
  const unrelated: ForgeProvisionStatus = {
    ...partial, id: 'other_provision', request: { world: { kind: 'new', name: 'other-world' } },
    message: 'Another world is waiting for checkout.'
  }
  setup.provision.mockImplementationOnce(async () => {
    setup.provisioning.mockResolvedValue([unrelated])
    throw new Error('The creation response was interrupted.')
  })
  h.mount()
  await settle()
  const dialog = await startWorld()
  type('World repository name', 'world')
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  await settle()
  expect(dialog.getByRole('button', { name: 'Check progress' })).toBeTruthy()
  expect(dialog.queryByRole('button', { name: 'Create' })).toBeNull()
  expect(dialog.queryByText('Another world is waiting for checkout.')).toBeNull()
  setup.provisioning.mockResolvedValue([unrelated, partial])
  fireEvent.click(dialog.getByRole('button', { name: 'Check progress' }))
  expect(await dialog.findByText('Verified the existing remote repository.')).toBeTruthy()
  expect(dialog.getByRole('button', { name: 'Resume creation' })).toBeTruthy()
  expect(dialog.queryByRole('button', { name: 'Create' })).toBeNull()
  expect(dialog.queryByText('Another world is waiting for checkout.')).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'Close' }))

  const reopened = await startWorld()
  expect(reopened.getByRole('button', { name: 'View creation for other-world' })).toBeTruthy()
  fireEvent.click(reopened.getByRole('button', { name: 'View creation for world' }))
  expect(reopened.getByText('Verified the existing remote repository.')).toBeTruthy()
  expect(reopened.queryByRole('button', { name: 'Create' })).toBeNull()
  expect(setup.provision).toHaveBeenCalledExactlyOnceWith(request)
})

it('keeps local workflow edits when an import refresh changed the saved revision', async () => {
  const { h, setup } = harness()
  setup.saveWorkflow.mockRejectedValueOnce(new Error('Workflow changed on disk.'))
  openMember(h)
  await settle()
  click('Edit workflow')
  type('Setup notes', 'Use our new local database profile.')
  click('Save workflow')
  await settle()
  expect(await screen.findByText('Workflow changed on disk.')).toBeTruthy()
  expect(screen.getByLabelText<HTMLTextAreaElement>('Setup notes').value).toBe('Use our new local database profile.')
  expect(setup.saveWorkflow).toHaveBeenCalledExactlyOnceWith(forgeMember.path, {
    expectedSha256: workflowHash, workflow: { state: 'configured', steps: reactRecipe.steps },
    notes: 'Use our new local database profile.'
  })
  expect(setup.run).not.toHaveBeenCalled()
})

it('keeps creation editable after a definite refusal before publication', async () => {
  const { h, setup } = harness()
  setup.provision.mockResolvedValueOnce({ state: 'refused', message: 'Choose a different repository name.' })
  h.mount()
  await settle()
  const dialog = await startWorld()
  type('World repository name', 'reserved-name')
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  expect(await dialog.findByText('Choose a different repository name.')).toBeTruthy()
  expect(dialog.getByLabelText<HTMLInputElement>('World repository name').value).toBe('reserved-name')
  const reads = setup.provisioning.mock.calls.length
  type('World repository name', 'updated-world')
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  await settle()
  expect(setup.provision.mock.calls.map(([request]) => request.world)).toEqual([
    { kind: 'new', name: 'reserved-name' }, { kind: 'new', name: 'updated-world' }
  ])
  expect(setup.provisioning).toHaveBeenCalledTimes(reads)
  expect(setup.resumeProvision).not.toHaveBeenCalled()
})
