// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { agentView, chatRecord, epicSummary, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

afterEach(cleanup)

it('opens a Forge World on ticket controls and routes each Kanban branch to its project', async () => {
  window.localStorage.clear()
  const h = new AppHarness()
  const root = folderView({ path: '/world', name: 'Forge World codex', initialized: false, forgeWorld: {
    version: 1, owner: 'codex', syncMinutes: 5, projects: [{ folder: 'Alpha', repository: 'https://github.com/codex/Alpha.git' }]
  } })
  const member = folderView({ path: '/world/Alpha', name: 'Alpha', forgeParent: root.path })
  h.dm.folders = [root, member]
  Object.assign(h.dm, { forge: { memberStatus: async () => ({ readiness: 'ready', syncing: false, error: null }), status: vi.fn().mockResolvedValue({ last: null, error: null }), sync: vi.fn().mockResolvedValue(undefined) } })
  h.epics[member.path] = [epicSummary({ title: 'Forge backlog', status: 'backlog' })]
  h.mount()
  await settle()
  const nav = within(screen.getByRole('navigation', { name: 'Folders and epics' }))
  fireEvent.click(nav.getByRole('button', { name: new RegExp('^' + root.name + ' ') }))
  await settle()
  expect(screen.getByRole('tab', { name: 'Ticket source control' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('button', { name: 'Add repository' })).toBeTruthy()
  expect((screen.getByLabelText('Interval in minutes') as HTMLInputElement).value).toBe('5')
  const toggle = nav.getByRole('button', { name: /(?:Expand|Collapse) Forge World codex/ })
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
  await settle()
  fireEvent.click(nav.getByRole('button', { name: 'Kanban, 0 open cards' }))
  await settle()
  expect(window.localStorage.getItem('dm.selection')).toContain(member.path)
  expect(screen.getByRole('heading', { name: 'Kanban' })).toBeTruthy()
  expect(window.dm.forge?.sync).not.toHaveBeenCalled()
})

it('creates and reopens a world agent with its root identity without polling a root project database', async () => {
  window.localStorage.clear()
  const h = new AppHarness()
  const root = folderView({ path: '/world', name: 'Mars', initialized: false, forgeWorld: { version: 1, owner: 'codex', projects: [], syncMinutes: 5 } })
  h.dm.folders = [root]
  h.dm.agents = [agentView({ kind: 'claude' })]
  h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'Ready' }
  h.dm.chats.chats = [chatRecord({ folder: '/other', title: 'Other project' })]
  Object.assign(h.dm, { forge: { status: async () => ({ last: null, error: null }), sync: async () => undefined } })
  h.mount()
  await settle()
  const worlds = within(screen.getByRole('region', { name: 'Forge Worlds' }))
  expect(worlds.queryByText('Other project')).toBeNull()
  fireEvent.click(worlds.getByRole('button', { name: 'New chat in Mars' }))
  await settle()
  const dialog = within(screen.getByRole('dialog', { name: 'Start a new chat' }))
  fireEvent.change(dialog.getByRole('textbox', { name: 'First prompt' }), { target: { value: 'Plan across this world' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Start' }))
  await settle()
  expect(h.dm.chats.callsOf('create')[0]?.[0]).toMatchObject({ folder: '/world', firstPrompt: 'Plan across this world' })
  const selected = JSON.parse(window.localStorage.getItem('dm.selection') ?? '{}') as { folderPath?: string; chatId?: string }
  expect(selected.folderPath).toBe('/world')
  expect(selected.chatId).toBeTruthy()
  expect(document.querySelector('.terminal-pane h1')).toBeTruthy()
  expect(h.dm.commandCalls.filter(call => call.folder === '/world')).toEqual([])
  cleanup()
  h.mount()
  await settle()
  expect(document.querySelector('.terminal-pane h1')).toBeTruthy()
  expect(h.dm.chats.callsOf('list')).toContainEqual(['/world'])
})

it('reveals a collapsed world when its project chat is opened from the global agent list', async () => {
  window.localStorage.clear()
  const h = new AppHarness()
  const root = folderView({ path: '/world', name: 'Mars', initialized: false, forgeWorld: { version: 1, owner: 'codex', projects: [], syncMinutes: 5 } })
  const member = folderView({ path: '/world/alpha', name: 'Alpha', forgeParent: root.path })
  h.dm.folders = [root, member]
  h.dm.agents = [agentView({ kind: 'claude' })]
  h.dm.chats.chats = [chatRecord({ folder: member.path, title: 'Build Alpha' })]
  Object.assign(h.dm, { forge: { status: async () => ({ last: null, error: null }), sync: async () => undefined } })
  window.localStorage.setItem('dm.sidebar.expanded', JSON.stringify({ 'folder:/world': false }))
  h.mount()
  await settle()
  expect(screen.getByRole('button', { name: 'Expand Mars' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Chats of Claude Code' }))
  fireEvent.click(screen.getByRole('button', { name: /^Build Alpha/ }))
  await settle()
  expect(screen.getByRole('button', { name: 'Collapse Mars' })).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Forge Worlds' })).getByRole('button', { name: /^Build Alpha/ }).getAttribute('aria-current')).toBe('true')
})
