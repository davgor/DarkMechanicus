// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

const root = folderView({ path: '/world', name: 'Mars', initialized: false, forgeWorld: { version: 1, owner: 'codex', syncMinutes: 5, projects: [{ folder: 'Alpha', repository: 'https://github.com/codex/Alpha.git' }] } })
const member = folderView({ path: '/world/Alpha', name: 'Alpha', forgeParent: root.path })
afterEach(cleanup)

function harness(): AppHarness {
  window.localStorage.clear()
  const h = new AppHarness()
  h.dm.folders = [root, member]
  Object.assign(h.dm, { forge: { status: async () => ({ last: null, error: null }), memberStatus: async () => ({ readiness: 'ready', syncing: false, error: 'Offline ticket remote' }), sync: vi.fn() } })
  return h
}

it('keeps source and cached ticket views usable despite failed ticket sync', async () => {
  const h = harness()
  h.git.targets.set(member.path, { kind: 'available', path: '/code/Alpha', displayPath: '~/code/Alpha', repository: 'https://github.com/codex/Alpha.git' })
  h.mount()
  await settle()
  const nav = within(screen.getByRole('navigation', { name: 'Folders and epics' }))
  fireEvent.click(nav.getByRole('button', { name: /^Alpha / }))
  await settle()
  expect(screen.getByRole('heading', { name: 'Alpha', level: 1 })).toBeTruthy()
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Source control', 'Delivery Standards', 'Epics', 'Ticket source control'])
  expect(screen.getByRole('tab', { name: 'Source control' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByText('0 changed files')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open folder ~/code/Alpha' }))
  await settle()
  expect(h.dm.openedFolders).toEqual([{ folder: member.path, expectedPath: '/code/Alpha' }])
  expect(h.git.calls.filter(call => call.method === 'getState').at(-1)?.folder).toBe(member.path)
  fireEvent.click(screen.getByRole('tab', { name: 'Epics' }))
  await settle()
  expect(screen.getByText('Offline ticket remote')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'New epic' })).toBeTruthy()
  expect(window.dm.forge?.sync).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Open folder ~/code/Alpha' })).toBeTruthy()
  fireEvent.click(screen.getByRole('tab', { name: 'Source control' }))
  await settle()
  expect(screen.getByText('0 changed files')).toBeTruthy()
})

it('shows portable checkout directions without offering to initialize or eagerly clone the ticket folder', async () => {
  const h = harness()
  h.git.targets.set(member.path, { kind: 'unavailable', repository: 'https://github.com/codex/Alpha.git', reason: 'Code is not on this computer.', directions: 'Clone outside this Forge World and follow CONTRIBUTING.md.' })
  window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: member.path, epicId: null }))
  h.mount()
  await settle()
  expect(screen.getByRole('heading', { name: 'Code repository not available locally' })).toBeTruthy()
  expect(screen.getByText('Clone outside this Forge World and follow CONTRIBUTING.md.')).toBeTruthy()
  expect(screen.getByText(/An agent can clone/)).toBeTruthy()
  const workspace = within(screen.getByRole('main', { name: 'Workspace' }))
  fireEvent.click(workspace.getAllByRole('link', { name: 'https://github.com/codex/Alpha.git' })[0])
  await settle()
  expect(h.dm.opened).toEqual(['https://github.com/codex/Alpha.git'])
  expect(screen.queryByRole('button', { name: 'Initialize repository' })).toBeNull()
  expect(h.git.calls.filter(call => ['getState', 'initRepository', 'clone'].includes(call.method))).toEqual([])
})


it('opens the world source tab against the ticket repository and opens its displayed root folder', async () => {
  const h = harness()
  h.mount()
  await settle()
  fireEvent.click(screen.getByRole('tab', { name: 'Source control' }))
  await settle()
  expect(h.git.calls.filter(call => call.method === 'getState').at(-1)?.folder).toBe(root.path)
  fireEvent.click(screen.getByRole('button', { name: `Open folder ${root.displayPath}` }))
  await settle()
  expect(h.dm.openedFolders).toEqual([{ folder: root.path, expectedPath: root.path }])
})

it('refreshes the header and source view when an agent later supplies the local checkout', async () => {
  const h = harness()
  h.git.targets.set(member.path, { kind: 'unavailable', repository: 'https://github.com/codex/Alpha.git', reason: 'Not cloned yet.', directions: 'Clone outside the ticket repository.' })
  window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: member.path, epicId: null }))
  h.mount()
  await settle()
  expect(screen.queryByText('0 changed files')).toBeNull()
  h.git.targets.set(member.path, { kind: 'available', path: '/code/Alpha', displayPath: '~/code/Alpha' })
  act(() => h.scheduler.fireIntervals(5000))
  await settle()
  expect(screen.getByRole('button', { name: 'Open folder ~/code/Alpha' })).toBeTruthy()
  expect(screen.getByText('0 changed files')).toBeTruthy()
  expect(h.git.calls.filter(call => call.method === 'getTarget')).toHaveLength(2)
})
