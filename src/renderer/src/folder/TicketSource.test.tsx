// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SourceCheckoutApi } from '../../../shared/desktop/sourceCheckout'
import { folderView } from '../__mocks__/fixtures'
import { idleSourceCheckout } from '../__mocks__/idleSourceCheckout'
import { settle } from '../__mocks__/settle'
import { TicketSource } from './TicketSource'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const project = folderView({ path: '/code', initialized: false })
const world = folderView({ path: '/world', forgeWorld: { version: 1, owner: 'owner', syncMinutes: 5, projects: [] } })
const member = folderView({ path: '/world/Code', forgeParent: world.path, name: 'Tracked code' })

function show(folder: typeof project, sourceCheckout: SourceCheckoutApi = idleSourceCheckout()) {
  const projects = new Map<string, { world: string; repository: string }>()
  const intervals = new Map<string, number>()
  const sources = new Map<string, string>()
  const visits: { path: string; ticketStore?: string }[] = []
  const published = new Map<string, string>()
  const api = {
    status: vi.fn().mockResolvedValue({ last: 1 }), add: async (world: string, repository: string, folder: string) => { projects.set(folder, { world, repository }) }, sync: vi.fn(),
    interval: async (root: string, minutes: number) => { intervals.set(root, minutes) },
    convert: async (root: string, source: string) => { sources.set(source, root) }, pickConvert: vi.fn(), restore: vi.fn(), connect: vi.fn(async (source: string, remote: string, publish: boolean) => {
      if (publish) published.set(remote, source)
      return world.path
    }), create: vi.fn()
  }
  const open = async (path: string) => { visits.push({ path, ticketStore: sources.get(project.path) }) }
  const initialize = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('dm', { forge: api, sourceCheckout })
  vi.stubGlobal('github', { getAccount: async () => ({ ok: true, data: { login: 'owner' } }), onAccountChanged: () => () => {}, listRepositories: async () => ({ ok: true, data: [{ fullName: 'owner/Code' }] }) })
  render(<TicketSource folder={folder} folders={[project, world, member]} status={null} open={open} initialize={initialize} />)
  return { api, visits, published, initialize, projects, intervals, sources, sourceCheckout }
}

async function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
  await settle()
}
function enter(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

it('tracks searched repositories, converts projects and configures sync from the world', async () => {
  const { api, visits, projects, intervals, sources } = show(world)
  await settle()
  expect(screen.getByRole('status').textContent).toContain('Last synced')
  await click('Tracked code')
  expect(visits.map(v => v.path)).toEqual([member.path])
  await click('Find GitHub repositories')
  expect(document.querySelector('datalist option')?.getAttribute('value')).toBe('owner/Code')
  enter('GitHub repository', 'owner/Code')
  await click('Add repository')
  expect(projects.get('Code')).toEqual({ world: world.path, repository: 'owner/Code' })
  enter('Project folder', 'Alias')
  await click('Add repository')
  expect(projects.get('Alias')).toEqual(projects.get('Code'))
  enter('Project', project.path)
  await click('Move tickets to Forge World')
  expect(sources.get(project.path)).toBe(world.path)
  await click('Choose a local repository to convert')
  expect(api.pickConvert).toHaveBeenCalledWith(world.path)
  enter('Interval in minutes', '12')
  await click('Save interval')
  expect(intervals.get(world.path)).toBe(12)
  api.sync.mockRejectedValue(new Error('origin unreachable'))
  await click('Sync now')
  expect(screen.getByRole('status').textContent).toBe('origin unreachable')
})

it('initializes each store and distinguishes publishing from connecting', async () => {
  const { api, visits, initialize, sources } = show(project)
  await click('Start with SQLite only')
  await click('Start with self-contained repo')
  expect(initialize.mock.calls).toEqual([['db'], ['repo']])
  enter('Ticket repository', world.path)
  await click('Use Forge World storage')
  expect(sources.get(project.path)).toBe(world.path)
  enter('GitHub repository', 'owner/world')
  await click('Open existing Forge World')
  await click('Publish private Forge World')
  expect(api.connect.mock.calls).toEqual([[project.path, 'owner/world', false], [project.path, 'owner/world', true]])
  expect(visits.map(v => v.path)).toEqual([world.path, world.path])
  await click('Use this repository as a Forge World')
  expect(api.create).toHaveBeenCalledWith(project.path)
})

it('creates a private Forge World and migrates the current project before opening it', async () => {
  const { published, visits, sources } = show({ ...project, initialized: true })
  const create = screen.getByRole('option', { name: /Create a Forge World/ }) as HTMLOptionElement
  enter('Ticket repository', create.value)
  await settle()
  expect((screen.getByLabelText('GitHub repository') as HTMLInputElement).value).toBe('owner/Forge-World-owner')
  await click('Create and migrate')
  expect(published.get('owner/Forge-World-owner')).toBe(project.path)
  expect(sources.get(project.path)).toBe(world.path)
  expect(visits).toEqual([{ path: world.path, ticketStore: world.path }])
})

it('keeps the published world selected when migration fails', async () => {
  const { api, visits, published } = show(project)
  const convert = vi.spyOn(api, 'convert').mockRejectedValueOnce(new Error('Commit the ticket records first'))
  enter('Ticket repository', (screen.getByRole('option', { name: /Create a Forge World/ }) as HTMLOptionElement).value)
  enter('GitHub repository', 'owner/new-world')
  await click('Create and migrate')
  expect(screen.getByRole('status').textContent).toBe('Commit the ticket records first')
  expect((screen.getByLabelText('Ticket repository') as HTMLSelectElement).value).toBe(world.path)
  expect(visits).toEqual([])
  expect(published.get('owner/new-world')).toBe(project.path)
  convert.mockRestore()
})

it('opens a restored code checkout and stays on the member when the picker is cancelled', async () => {
  const { api, visits } = show(member)
  await click('Open Forge World')
  api.restore.mockResolvedValueOnce(project.path).mockResolvedValueOnce(null)
  await click('Move to SQLite only')
  await click('Move to self-contained repo')
  expect(api.restore.mock.calls).toEqual([[member.path, 'db'], [member.path, 'repo']])
  expect(visits.map(v => v.path)).toEqual([world.path, project.path])
})

it('uses the native recovery source dialog and displays the selected code checkout from a Forge member', async () => {
  const { sourceCheckout, visits } = show(member)
  const pick = vi.spyOn(sourceCheckout, 'pick').mockResolvedValueOnce({ outcome: 'cancelled' }).mockResolvedValueOnce({
    outcome: 'associated', folder: member, added: false,
    checkout: { status: 'available', target: { kind: 'darkmechanicus_source', projectId: 'pj_fixture', projectName: 'Dark Mechanicus' },
      local: { path: '/local/dm-code', displayPath: '/local/dm-code', projectPath: member.path, associatedAt: '2026-01-01T00:00:00.000Z' },
      problem: null, message: null, recovery: null }
  })
  await click('Choose Dark Mechanicus source checkout…')
  expect(screen.queryByText('/local/dm-code')).toBeNull()
  await click('Choose Dark Mechanicus source checkout…')
  expect(screen.getByText('/local/dm-code')).toBeTruthy()
  expect(pick.mock.calls).toEqual([[], []])
  expect(visits).toEqual([])
})

it('keeps the tracked member when a missing code checkout is followed by a refused picker choice', async () => {
  const checkout = idleSourceCheckout()
  vi.spyOn(checkout, 'get').mockResolvedValue({
    status: 'unavailable', target: null, local: null, problem: 'missing',
    message: 'The selected code checkout moved.', recovery: 'Choose its new location.'
  })
  const pick = vi.spyOn(checkout, 'pick').mockResolvedValue({
    outcome: 'refused', problem: 'not_dm_source', message: 'This is a Forge World ticket folder.',
    recovery: 'Choose the linked code checkout.'
  })
  const { visits } = show(member, checkout)
  expect(await screen.findByText('The selected code checkout moved.')).toBeTruthy()
  await click('Choose Dark Mechanicus source checkout…')
  expect(screen.getByRole('status').textContent).toBe('This is a Forge World ticket folder. Choose the linked code checkout.')
  expect(screen.getByText('The selected code checkout moved.')).toBeTruthy()
  expect(pick).toHaveBeenCalledExactlyOnceWith()
  expect(visits).toEqual([])
})
