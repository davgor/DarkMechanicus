// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AppHarness } from '../__mocks__/appHarness'
import { folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { TicketSource } from './TicketSource'

afterEach(cleanup)

it.each([false, true])('requires explicit force confirmation on the world-side=%s controls and leaves normal conversion unchanged', async worldSide => {
  const h = new AppHarness()
  const source = folderView({ path: '/source', name: 'Software' })
  const world = folderView({ path: '/world', name: 'Forge World Davgor', initialized: false, forgeWorld: { version: 1, owner: 'davgor', syncMinutes: 5, projects: [] } })
  const convert = vi.fn().mockResolvedValue(undefined)
  Object.assign(h.dm, { forge: { convert, status: async () => ({last:null,error:null}) } })
  render(<TicketSource folder={worldSide ? world : source} folders={[source,world]} status={null} initialize={async () => undefined} open={async () => undefined} />)
  await settle()
  fireEvent.change(screen.getByRole('combobox', { name: worldSide ? 'Project' : 'Ticket repository' }), {target:{value:worldSide ? source.path : world.path}})
  fireEvent.click(screen.getByRole('button', {name:'Force migrate…'}))
  const confirmation = screen.getByRole('dialog', {name:'Force migrate and restart unfinished work?'})
  expect(within(confirmation).getByText(/including previously accepted tickets/)).toBeTruthy()
  expect(within(confirmation).getByText(/Completed epics/)).toBeTruthy()
  expect(convert).not.toHaveBeenCalled()
  fireEvent.click(within(confirmation).getByRole('button', {name:'Cancel'}))
  expect(convert).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', {name:worldSide ? 'Move tickets to Forge World' : 'Use Forge World storage'}))
  await settle()
  expect(convert).toHaveBeenLastCalledWith(world.path, source.path)
  fireEvent.click(screen.getByRole('button', {name:'Force migrate…'}))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', {name:'Force migrate and restart'}))
  await settle()
  expect(convert).toHaveBeenLastCalledWith(world.path, source.path, {force:true})
})
