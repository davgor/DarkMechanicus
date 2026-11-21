// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { TicketSource } from './TicketSource'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const project = folderView({ path: '/code', initialized: false })
const world = folderView({ path: '/world', forgeWorld: { version: 1, owner: 'owner', syncMinutes: 5, projects: [] } })
const member = folderView({ path: '/world/Code', forgeParent: world.path, name: 'Tracked code' })

function show(folder: typeof project) {
  const api = {
    status: vi.fn().mockResolvedValue({ last: 1 }), add: vi.fn(), sync: vi.fn(), interval: vi.fn(),
    convert: vi.fn(), pickConvert: vi.fn(), restore: vi.fn(), connect: vi.fn().mockResolvedValue(world.path), create: vi.fn()
  }
  const open = vi.fn().mockResolvedValue(undefined)
  const initialize = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('dm', { forge: api })
  vi.stubGlobal('github', { listRepositories: async () => ({ ok: true, data: [{ fullName: 'owner/Code' }] }) })
  render(<TicketSource folder={folder} folders={[project, world, member]} status={null} open={open} initialize={initialize} />)
  return { api, open, initialize }
}

async function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
  await settle()
}
function enter(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

it('tracks searched repositories, converts projects and configures sync from the world', async () => {
  const { api, open } = show(world)
  await settle()
  expect(screen.getByRole('status').textContent).toContain('Last synced')
  await click('Tracked code')
  expect(open).toHaveBeenCalledWith(member.path)
  await click('Find GitHub repositories')
  expect(document.querySelector('datalist option')?.getAttribute('value')).toBe('owner/Code')
  enter('GitHub repository', 'owner/Code')
  await click('Add repository')
  expect(api.add).toHaveBeenCalledWith(world.path, 'owner/Code', 'Code')
  enter('Project folder', 'Alias')
  await click('Add repository')
  expect(api.add).toHaveBeenCalledWith(world.path, 'owner/Code', 'Alias')
  enter('Project', project.path)
  await click('Move tickets to Forge World')
  expect(api.convert).toHaveBeenCalledWith(world.path, project.path)
  await click('Choose a local repository to convert')
  expect(api.pickConvert).toHaveBeenCalledWith(world.path)
  enter('Interval in minutes', '12')
  await click('Save interval')
  expect(api.interval).toHaveBeenCalledWith(world.path, 12)
  api.sync.mockRejectedValue(new Error('origin unreachable'))
  await click('Sync now')
  expect(screen.getByRole('status').textContent).toBe('origin unreachable')
})

it('initializes each store and distinguishes publishing from connecting', async () => {
  const { api, open, initialize } = show(project)
  await click('Start with SQLite only')
  await click('Start with self-contained repo')
  expect(initialize.mock.calls).toEqual([['db'], ['repo']])
  enter('Ticket repository', world.path)
  await click('Use Forge World storage')
  expect(api.convert).toHaveBeenCalledWith(world.path, project.path)
  enter('GitHub repository', 'owner/world')
  await click('Open existing Forge World')
  await click('Publish private Forge World')
  expect(api.connect.mock.calls).toEqual([[project.path, 'owner/world', false], [project.path, 'owner/world', true]])
  expect(open).toHaveBeenCalledWith(world.path)
  await click('Use this repository as a Forge World')
  expect(api.create).toHaveBeenCalledWith(project.path)
})

it('opens a restored code checkout and stays on the member when the picker is cancelled', async () => {
  const { api, open } = show(member)
  await click('Open Forge World')
  api.restore.mockResolvedValueOnce(project.path).mockResolvedValueOnce(null)
  await click('Move to SQLite only')
  await click('Move to self-contained repo')
  expect(api.restore.mock.calls).toEqual([[member.path, 'db'], [member.path, 'repo']])
  expect(open.mock.calls).toEqual([[world.path], [project.path]])
})
