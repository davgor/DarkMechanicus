// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ForgeProvisionStatus } from '../../shared/desktop/forgeSetup'
import { AppHarness } from './__mocks__/appHarness'
import { deferred } from './__mocks__/deferred'
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
  expect(setup.provision).toHaveBeenCalledExactlyOnceWith({ world: { kind: 'new', name: 'world' } }, expect.any(String))
  expect(reopened.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(false)
  expect(h.dm.folders).toEqual([])
})

it('resumes a published code repository by its existing intent with no second create', async () => {
  const { h, setup } = harness()
  const partial: ForgeProvisionStatus = {
    id: 'provision_1', request: { world: { kind: 'new', name: 'world' }, code: { name: 'code', recipeId: reactRecipe.id, visibility: 'private' }, agent: 'codex' },
    phase: 'code-checkout', state: 'needs-attention', world: forgeWorld.path, message: 'GitHub published code, but the local disk is full.'
  }
  setup.provision.mockImplementationOnce(async (_request, id) => ({ ...partial, id }))
  setup.resumeProvision.mockImplementation(async id => {
    h.dm.folders = [forgeWorld, forgeMember]
    return { ...partial, id, state: 'complete', phase: 'complete', member: forgeMember.path, message: null }
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
  expect(setup.provision).toHaveBeenCalledExactlyOnceWith(partial.request, expect.any(String))
  expect(setup.resumeProvision).toHaveBeenCalledExactlyOnceWith(setup.provision.mock.calls[0][1])
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
  expect(setup.run).toHaveBeenCalledExactlyOnceWith(forgeMember.path, workflowHash, codePath)
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

it('stores the onboarding default on a Forge World before any imported project exists', async () => {
  const { h, setup } = harness()
  h.dm.folders = [forgeWorld]
  h.mount()
  await settle()
  const preferred = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Preferred agent for new imports' })
  expect(preferred.value).toBe('')
  expect(preferred.disabled).toBe(false)
  fireEvent.change(preferred, { target: { value: 'codex' } })
  await settle()
  expect(h.dm.agentCalls.filter(call => call.method === 'setFolderDefaultAgent').map(call => call.args[0])).toEqual([
    { folder: forgeWorld.path, agentId: 'codex' }
  ])
  expect(preferred.value).toBe('codex')
  expect(setup.prepare).not.toHaveBeenCalled()
  expect(setup.run).not.toHaveBeenCalled()
})

it('creates a private code repository in the selected Forge World', async () => {
  const { h, setup } = harness()
  h.dm.folders = [forgeWorld]
  h.mount()
  await settle()
  click('New code repository')
  const dialog = within(await screen.findByRole('dialog', { name: 'Create a code repository' }))
  await settle()
  expect(dialog.queryByLabelText('World repository name')).toBeNull()
  type('Code repository name', 'new-code')
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  await settle()
  expect(setup.provision).toHaveBeenCalledExactlyOnceWith({
    world: { kind: 'existing', folder: forgeWorld.path },
    code: { name: 'new-code', visibility: 'private', recipeId: reactRecipe.id }
  }, expect.any(String))
})

it('offers the recorded creation intent when the first response was lost', async () => {
  const { h, setup } = harness()
  const request = { world: { kind: 'new' as const, name: 'world' } }
  const historical: ForgeProvisionStatus = {
    id: 'historic_completed', request, state: 'complete', phase: 'complete', message: null, world: '/another-account/world'
  }
  const unrelated: ForgeProvisionStatus = {
    id: 'other_provision', request: { world: { kind: 'new', name: 'other-world' } },
    state: 'needs-attention', phase: 'world-checkout', message: 'Another world is waiting for checkout.'
  }
  setup.provision.mockImplementationOnce(async () => {
    setup.provisioning.mockResolvedValue([historical, unrelated])
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
  const id = setup.provision.mock.calls[0][1]
  expect(id).toMatch(/^[a-f0-9-]{36}$/i)
  fireEvent.click(dialog.getByRole('button', { name: 'Close' }))
  const recovering = await startWorld()
  expect(recovering.getByRole('button', { name: 'Check progress' })).toBeTruthy()
  expect(recovering.queryByRole('button', { name: 'Create' })).toBeNull()
  expect(recovering.queryByRole('button', { name: 'Resume creation' })).toBeNull()
  setup.provisioning.mockResolvedValue([historical, unrelated, {
    ...historical, id, state: 'needs-attention', phase: 'world-remote', message: 'Verified the existing remote repository.'
  }])
  fireEvent.click(recovering.getByRole('button', { name: 'Check progress' }))
  expect(await recovering.findByText('Verified the existing remote repository.')).toBeTruthy()
  expect(recovering.getByRole('button', { name: 'Resume creation' })).toBeTruthy()
  expect(recovering.queryByRole('button', { name: 'Create' })).toBeNull()
  expect(recovering.queryByText('Another world is waiting for checkout.')).toBeNull()
  fireEvent.click(recovering.getByRole('button', { name: 'Close' }))

  const reopened = await startWorld()
  expect(reopened.getByRole('button', { name: 'View creation for other-world' })).toBeTruthy()
  fireEvent.click(reopened.getByRole('button', { name: 'View creation for world' }))
  expect(reopened.getByText('Verified the existing remote repository.')).toBeTruthy()
  expect(reopened.queryByRole('button', { name: 'Create' })).toBeNull()
  expect(setup.provision).toHaveBeenCalledExactlyOnceWith(request, id)
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

it('lets native creation decide whether a saved name belongs to the current account', async () => {
  const { h, setup } = harness()
  setup.provisioning.mockResolvedValue([{
    id: 'unrecoverable_world', request: { world: { kind: 'new', name: 'already-named' } },
    state: 'needs-attention', phase: 'world-remote', message: 'A different GitHub repository has this name.'
  }])
  setup.provision.mockResolvedValueOnce({ state: 'refused', message: 'This account already has a saved creation. Resume it instead.' })
  h.mount()
  await settle()
  const dialog = await startWorld()
  expect(dialog.getByText('A different GitHub repository has this name.')).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'New creation' }))
  type('World repository name', 'Already-Named')
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  expect(await dialog.findByText('This account already has a saved creation. Resume it instead.')).toBeTruthy()
  expect(dialog.getByLabelText<HTMLInputElement>('World repository name').value).toBe('Already-Named')
  // A changed account is checked in main. The old saved entry has no account information.
  h.github.account = { login: 'another-account', name: 'Another account' }
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  await settle()
  expect(setup.provision.mock.calls).toEqual([
    [{ world: { kind: 'new', name: 'Already-Named' } }, expect.any(String)],
    [{ world: { kind: 'new', name: 'Already-Named' } }, expect.any(String)]
  ])
  expect(setup.provision.mock.calls[0][1]).not.toBe(setup.provision.mock.calls[1][1])
  fireEvent.click(dialog.getByRole('button', { name: 'Saved creations' }))
  expect(dialog.getByText('A different GitHub repository has this name.')).toBeTruthy()
  expect(dialog.getByRole('button', { name: 'Resume creation' })).toBeTruthy()
  expect(setup.resumeProvision).not.toHaveBeenCalled()
})

it('keeps a failed setup dispatch visible without opening its execution chat', async () => {
  const { h, setup } = harness()
  setup.run.mockResolvedValueOnce({ state: 'opened', chatId: 'chat_onboarding', message: null, run: {
    state: 'failed', workflowSha256: workflowHash, chatId: 'chat_failed_setup'
  } })
  openMember(h)
  h.dm.chats.chats.push(chatRecord({ id: 'chat_failed_setup', folder: forgeMember.path, title: 'Failed setup', agent: 'codex', role: 'planner' }))
  await settle()
  click('Set up environment')
  click('Run setup')
  expect(await screen.findByText('Setup could not be sent to the setup agent.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Open setup chat' })).toBeNull()
  expect(window.localStorage.getItem('dm.selection')).not.toContain('chat_failed_setup')
  expect(h.dm.chats.callsOf('create')).toEqual([])
})

it('requires a fresh setup confirmation when the verified checkout changes', async () => {
  const { h, setup } = harness()
  openMember(h)
  await settle()
  click('Set up environment')
  const dialog = within(screen.getByRole('dialog', { name: 'Set up environment' }))
  expect(dialog.getByText(codePath)).toBeTruthy()
  h.git.targets.set(forgeMember.path, { kind: 'available', path: '/code/alpha-replaced', displayPath: '~/code/alpha-replaced', repository })
  act(() => h.scheduler.fireIntervals(5000))
  await settle()
  expect(dialog.getByText('The code checkout changed. Review the current checkout before running setup.')).toBeTruthy()
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Run setup' }).disabled).toBe(true)
  expect(setup.run).not.toHaveBeenCalled()
  h.git.targets.set(forgeMember.path, { kind: 'available', path: codePath, displayPath: '~/code/alpha', repository })
  act(() => h.scheduler.fireIntervals(5000))
  await settle()
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Run setup' }).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
  click('Set up environment')
  const current = within(screen.getByRole('dialog', { name: 'Set up environment' }))
  expect(current.getByText(codePath)).toBeTruthy()
  h.dm.chats.chats.push(chatRecord({ id: 'chat_setup', folder: forgeMember.path, title: 'Run Alpha setup', agent: 'codex', role: 'planner' }))
  fireEvent.click(current.getByRole('button', { name: 'Run setup' }))
  await settle()
  expect(setup.run).toHaveBeenCalledExactlyOnceWith(forgeMember.path, workflowHash, codePath)
  expect(window.localStorage.getItem('dm.selection')).toContain('chat_setup')
  expect(h.dm.chats.callsOf('create')).toEqual([])
})

it('does not present an older active setup chat as a new dispatch', async () => {
  const { h, setup } = harness()
  setup.run.mockResolvedValueOnce({ state: 'opened', chatId: 'chat_onboarding', message: 'An earlier setup attempt is still active.', run: {
    state: 'submitted', workflowSha256: 'f'.repeat(64), chatId: 'chat_older_setup'
  } })
  openMember(h)
  h.dm.chats.chats.push(chatRecord({ id: 'chat_older_setup', folder: forgeMember.path, title: 'Earlier setup', agent: 'codex', role: 'planner' }))
  await settle()
  click('Set up environment')
  click('Run setup')
  expect(await screen.findByText('An earlier setup attempt is still active.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open setup chat' })).toBeTruthy()
  expect(window.localStorage.getItem('dm.selection')).not.toContain('chat_older_setup')
  expect(setup.run).toHaveBeenCalledExactlyOnceWith(forgeMember.path, workflowHash, codePath)
})

it('stops loading when the recipe book has no eligible code recipe', async () => {
  const { h, setup } = harness()
  const worldRecipe = { ...reactRecipe, kind: 'world' as const, id: 'world', title: 'Forge World' }
  setup.recipebook.mockResolvedValue({ sha256: 'c'.repeat(64), value: { version: 1, recipes: [worldRecipe] } })
  h.mount()
  await settle()
  const dialog = await startWorld()
  type('World repository name', 'world')
  fireEvent.click(dialog.getByRole('checkbox', { name: 'Create a code repository' }))
  type('Code repository name', 'code')
  expect(dialog.getByText('No code recipes are available.')).toBeTruthy()
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(true)
  expect(setup.provision).not.toHaveBeenCalled()
})

it('lands on a newly created standalone world and leaves its project list empty', async () => {
  const { h, setup } = harness()
  setup.provision.mockImplementationOnce(async (request, id) => {
    h.dm.folders = [forgeWorld]
    return { id, request, world: forgeWorld.path, phase: 'complete', state: 'complete', message: null }
  })
  h.mount()
  await settle()
  const dialog = await startWorld()
  type('World repository name', 'world-only')
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  expect(await screen.findByRole('heading', { level: 1, name: forgeWorld.name })).toBeTruthy()
  expect(window.localStorage.getItem('dm.selection')).toContain(forgeWorld.path)
  expect(setup.provision).toHaveBeenCalledExactlyOnceWith({ world: { kind: 'new', name: 'world-only' } }, expect.any(String))
  fireEvent.click(screen.getByRole('tab', { name: 'Delivery Standards' }))
  expect(screen.getByText('No managed projects.')).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Epics' }))
  expect(screen.getByRole('button', { name: 'Recipe book' })).toBeTruthy()
  expect(setup.prepare).not.toHaveBeenCalled()
})

it('uses the bundled conversion recipe for a legacy world and respects its chosen visibility', async () => {
  const { h, setup } = harness()
  h.dm.folders = [forgeWorld]
  setup.recipebook.mockResolvedValueOnce(null)
  h.mount()
  await settle()
  click('New code repository')
  const dialog = within(await screen.findByRole('dialog', { name: 'Create a code repository' }))
  await settle()
  expect(setup.recipebook.mock.calls).toEqual([[forgeWorld.path], []])
  type('Code repository name', 'desktop-client')
  type('Recipe', 'electron')
  type('Code repository visibility', 'public')
  expect(dialog.getByText('Conversion required. The repository will need a verified Electron build and launch.')).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  await settle()
  expect(setup.provision).toHaveBeenCalledExactlyOnceWith({ world: { kind: 'existing', folder: forgeWorld.path },
    code: { recipeId: 'electron', name: 'desktop-client', visibility: 'public' } }, expect.any(String))
})

it('offers only incomplete creation jobs belonging to the selected existing world', async () => {
  const { h, setup } = harness()
  h.dm.folders = [forgeWorld]
  function pending(id: string, folder: string, name: string): ForgeProvisionStatus {
    return { id, request: { world: { kind: 'existing', folder }, code: { name, visibility: 'private', recipeId: reactRecipe.id } },
      phase: 'code-checkout', state: 'needs-attention', message: name + ' has a saved checkout.' }
  }
  setup.provisioning.mockResolvedValue([
    pending('first', forgeWorld.path, 'first-code'), pending('second', forgeWorld.path, 'second-code'),
    pending('other', '/another-world', 'other-code'),
    { ...pending('completed', forgeWorld.path, 'already-created'), phase: 'complete', state: 'complete' }
  ])
  setup.resumeProvision.mockImplementation(async () => pending('second', forgeWorld.path, 'second-code'))
  h.mount()
  await settle()
  click('New code repository')
  const dialog = within(await screen.findByRole('dialog', { name: 'Create a code repository' }))
  expect(await dialog.findByRole('button', { name: 'View creation for first-code' })).toBeTruthy()
  expect(dialog.queryByRole('button', { name: 'View creation for other-code' })).toBeNull()
  expect(dialog.queryByRole('button', { name: 'View creation for already-created' })).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'View creation for second-code' }))
  expect(dialog.getByText('second-code has a saved checkout.')).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Resume creation' }))
  await settle()
  expect(setup.resumeProvision).toHaveBeenCalledExactlyOnceWith('second')
  expect(setup.provision).not.toHaveBeenCalled()
})

it('requires sign-in for creation and reports a catalog error without blocking world-only creation', async () => {
  const { h, setup } = harness()
  h.github.account = null
  setup.recipebook.mockRejectedValueOnce(new Error('The recipe catalog is unavailable.'))
  h.mount()
  await settle()
  const dialog = await startWorld()
  type('World repository name', 'world')
  expect(dialog.getByText('Sign in to GitHub to create repositories')).toBeTruthy()
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('checkbox', { name: 'Create a code repository' }))
  expect(dialog.getByText('The recipe catalog is unavailable.')).toBeTruthy()
  act(() => h.github.changeAccount({ login: 'fixture', name: 'Fixture' }))
  type('Code repository name', 'desktop-client')
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(true)
  fireEvent.click(dialog.getByRole('checkbox', { name: 'Create a code repository' }))
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(false)
  expect(setup.provision).not.toHaveBeenCalled()
})

it('rechecks an unavailable creation journal before sending a new request', async () => {
  const { h, setup } = harness()
  setup.provisioning.mockRejectedValueOnce(new Error('The creation journal is unavailable.'))
  h.mount()
  await settle()
  const dialog = await startWorld()
  expect(dialog.getByText('The creation journal is unavailable.')).toBeTruthy()
  expect(dialog.queryByRole('button', { name: 'Create' })).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'Check progress' }))
  expect(await dialog.findByLabelText('World repository name')).toBeTruthy()
  type('World repository name', 'world')
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(false)
  expect(setup.provision).not.toHaveBeenCalled()
})

it('shows only matching progress while publication is held and waits for the definitive refusal', async () => {
  const { h, setup } = harness()
  const publish = deferred()
  const progress = deferred()
  setup.provision.mockImplementationOnce(() => publish.promise.then(() => ({ state: 'refused', message: 'Review the publishing account.' })))
  h.mount()
  await settle()
  const dialog = await startWorld()
  type('World repository name', 'world')
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  const [request, id] = setup.provision.mock.calls[0]
  setup.provisioning.mockImplementationOnce(() => progress.promise.then(() => [
    { id: 'unrelated', request, phase: 'complete', state: 'complete', message: null },
    { id, request, phase: 'world-remote', state: 'running', message: null }
  ]))
  act(() => h.scheduler.fireIntervals(1200))
  act(() => h.scheduler.fireIntervals(1200))
  expect(setup.provisioning).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(dialog.queryByRole('button', { name: 'Create' })).toBeNull()
  progress.resolve()
  expect(await dialog.findByText('Ticket repository publication')).toBeTruthy()
  publish.resolve()
  expect(await dialog.findByText('Review the publishing account.')).toBeTruthy()
  expect(dialog.getByLabelText<HTMLInputElement>('World repository name').value).toBe('world')
  expect(setup.provision).toHaveBeenCalledTimes(1)
})

it('does not navigate to a successful creation receipt from a different request', async () => {
  const { h, setup } = harness()
  setup.provision.mockResolvedValueOnce({ id: 'another-operation', request: { world: { kind: 'new', name: 'world' } },
    world: '/some-other-world', phase: 'complete', state: 'complete', message: null })
  h.mount()
  await settle()
  const dialog = await startWorld()
  type('World repository name', 'world')
  fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
  expect(await dialog.findByText('The creation receipt did not match this request.')).toBeTruthy()
  expect(dialog.queryByRole('button', { name: 'Create' })).toBeNull()
  expect(window.localStorage.getItem('dm.selection') ?? '').not.toContain('/some-other-world')
})

it.each([null, 'The agent is waiting for attention.'])('reports an unconfirmed standards conversation without opening it (%s)', async message => {
  const { h, setup } = harness()
  setup.prepare.mockResolvedValueOnce({ state: 'uncertain', chatId: 'chat_onboarding', message })
  openMember(h)
  await settle()
  fireEvent.click(screen.getByRole('tab', { name: 'Delivery Standards' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare with agent' }))
  expect(await screen.findByText(message ?? 'Check Environment setup for onboarding progress.')).toBeTruthy()
  expect(window.localStorage.getItem('dm.selection')).not.toContain('chat_onboarding')
  expect(h.dm.chats.callsOf('create')).toEqual([])
  expect(setup.run).not.toHaveBeenCalled()
})
