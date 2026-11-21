// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { epicSummary, folderView } from './__mocks__/fixtures'
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
  Object.assign(h.dm, { forge: { status: vi.fn().mockResolvedValue({ last: null, error: null }), sync: vi.fn().mockResolvedValue(undefined) } })
  h.epics[member.path] = [epicSummary({ title: 'Forge backlog', status: 'backlog' })]
  h.mount()
  await settle()
  const nav = within(screen.getByRole('navigation', { name: 'Folders and epics' }))
  fireEvent.click(nav.getByRole('button', { name: root.name }))
  await settle()
  expect(screen.getByRole('tab', { name: 'Ticket source control' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('button', { name: 'Add repository' })).toBeTruthy()
  expect((screen.getByLabelText('Interval in minutes') as HTMLInputElement).value).toBe('5')
  const toggle = nav.getByRole('button', { name: /(?:Expand|Collapse) Forge World codex/ })
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
  await settle()
  const kanban = nav.getByText('Kanban', { selector: 'summary' })
  fireEvent.click(kanban)
  const board = within(kanban.parentElement!).getByRole('button', { name: 'Alpha' })
  fireEvent.click(board)
  await settle()
  expect(window.localStorage.getItem('dm.selection')).toContain(member.path)
})
