// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness
const world = folderView({ path: '/world', name: 'Mars', initialized: false, forgeWorld: { version: 1, owner: 'codex', projects: [], syncMinutes: 5 } })
beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.git.cloneParent = '/clones'
  Object.assign(h.dm, { forge: { status: async () => ({ last: null, error: null }) } })
})
afterEach(cleanup)

async function openAdd(): Promise<void> {
  h.mount()
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Add a Forge World' }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Add existing folder…', 'Clone repository…'])
}

it('offers the shared add menu before the first world and tracks existing worlds with explicit validation mode', async () => {
  await openAdd()
  h.dm.folders = [world]
  h.dm.pickQueue.push({ folder: world, added: true })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add existing folder…' }))
  await settle()
  expect(h.dm.pickModes).toEqual(['forge-world'])
  expect(screen.getByRole('button', { name: 'Actions for Mars' })).toBeTruthy()
})

it('surfaces a rejected non-world selection and does not add it to either list', async () => {
  await openAdd()
  h.dm.rejects.pickFolder = 'This folder is not a Forge World.'
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add existing folder…' }))
  await settle()
  expect(screen.getByText('This folder is not a Forge World.')).toBeTruthy()
  expect(h.dm.pickModes).toEqual(['forge-world'])
  expect(h.dm.folders).toEqual([])
  expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull()
})

async function startClone(): Promise<void> {
  fireEvent.click(screen.getByRole('menuitem', { name: 'Clone repository…' }))
  await settle()
  const dialog = within(screen.getByRole('dialog', { name: 'Clone a Forge World' }))
  fireEvent.click(dialog.getByRole('tab', { name: 'URL' }))
  fireEvent.change(dialog.getByLabelText('Repository URL or owner/repo'), { target: { value: 'codex/Mars' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Clone' }))
  await settle()
}

it('clones a validated world from the same menu and opens its normal folder page', async () => {
  const original = h.git.clone.bind(h.git)
  h.git.clone = async request => {
    const result = await original(request)
    if (!result.ok) return result
    h.dm.folders = [world]
    return { ok: true, data: world }
  }
  await openAdd()
  await startClone()
  expect(h.git.calls.find(call => call.method === 'clone')?.request).toMatchObject({ mode: 'forge-world', url: 'codex/Mars' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Mars', level: 1 })).toBeTruthy()
})

it('keeps a rejected clone out of the sidebar while displaying the validation error', async () => {
  h.git.cloneError = { code: 'invalid_input', message: 'The cloned repository is not a Forge World.' }
  await openAdd()
  await startClone()
  expect(screen.getByRole('alert').textContent).toContain('The cloned repository is not a Forge World.')
  expect(h.git.calls.find(call => call.method === 'clone')?.request).toMatchObject({ mode: 'forge-world' })
  expect(h.dm.folders).toEqual([])
  expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull()
})

it('removes a world through the shared folder actions menu without deleting its files', async () => {
  h.dm.folders = [world]
  h.mount()
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Mars' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Stop tracking folder' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Stop tracking Mars?' }))
  expect(dialog.getByText(/repository.*not touched/)).toBeTruthy()
  fireEvent.click(dialog.getByRole('button', { name: 'Stop tracking' }))
  await settle()
  expect(h.dm.calls.filter(call => call === 'untrackFolder')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Actions for Mars' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Add a Forge World' })).toBeTruthy()
})
