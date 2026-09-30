// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { EPIC_A, EPIC_B, EPIC_C, epicSummary, folderView, runSummary } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
})

afterEach(cleanup)

const alpha = folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })
const beta = folderView({ path: '/b', name: 'beta', displayPath: '~/code/beta' })

function seed(): void {
  h.dm.folders = [alpha]
  h.epics['/a'] = [
    epicSummary({ id: EPIC_A, title: 'Planning slice', status: 'in_progress', run: runSummary() }),
    epicSummary({ id: EPIC_B, title: 'Backlog idea', status: 'backlog', hasDraft: true }),
    epicSummary({ id: EPIC_C, title: 'Old work', status: 'completed', completedAt: '2026-03-15T12:00:00.000Z' })
  ]
}

const stub = (): string | null => screen.getByTestId('epic-stub').textContent
const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))

describe('App sidebar buckets', () => {
  it('shows In progress, Backlog and Completed in order with counts', async () => {
    seed()
    h.mount()
    await settle()
    const labels = Array.from(document.querySelectorAll('.bucket-header')).map((el) => el.getAttribute('aria-label'))
    expect(labels).toEqual(['In progress, 1 epic', 'Backlog, 1 epic', 'Completed, 1 epic'])
  })

  it('shows status lines and badges on the rows', async () => {
    seed()
    h.mount()
    await settle()
    expect(sidebar().getByText('Running · Sprint 2/3')).toBeTruthy()
    expect(sidebar().getByText('draft')).toBeTruthy()
    expect(sidebar().queryByText('Old work')).toBeNull()
  })

  it('opens an epic from the sidebar and highlights its row', async () => {
    seed()
    h.mount()
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: /Planning slice/ }))
    await settle()
    expect(stub()).toBe(`alpha|${EPIC_A}|0`)
    expect(sidebar().getByRole('button', { name: /Planning slice/ }).getAttribute('aria-current')).toBe('true')
    expect(sidebar().getByRole('button', { name: /Backlog idea/ }).getAttribute('aria-current')).toBeNull()
  })

  it('opens another epic requested by the epic view', async () => {
    seed()
    h.mount()
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: /Planning slice/ }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'stub open other' }))
    await settle()
    expect(stub()).toBe(`alpha|${EPIC_B}|0`)
  })

  it('reveals the completed bucket when a completed epic is opened from the folder home', async () => {
    seed()
    h.mount()
    await settle()
    expect(sidebar().getByRole('button', { name: 'Completed, 1 epic' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: /Old work/ }))
    await settle()
    expect(stub()).toBe(`alpha|${EPIC_C}|0`)
    expect(sidebar().getByRole('button', { name: 'Completed, 1 epic' }).getAttribute('aria-expanded')).toBe('true')
    expect(sidebar().getByRole('button', { name: /Old work/ }).getAttribute('aria-current')).toBe('true')
  })
})

describe('App sidebar persistence', () => {
  it('remembers collapsed buckets and folders across reloads', async () => {
    seed()
    const first = h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Backlog, 1 epic' }))
    fireEvent.click(screen.getByRole('button', { name: 'Completed, 1 epic' }))
    first.unmount()
    h.mount()
    await settle()
    expect(screen.getByRole('button', { name: 'Backlog, 1 epic' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Completed, 1 epic' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'In progress, 1 epic' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('remembers a collapsed folder', async () => {
    seed()
    const first = h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse alpha' }))
    expect(screen.queryByRole('button', { name: /In progress/ })).toBeNull()
    first.unmount()
    h.mount()
    await settle()
    expect(screen.getByRole('button', { name: 'Expand alpha' })).toBeTruthy()
  })

  it('restores the last selected epic', async () => {
    seed()
    const first = h.mount()
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: /Backlog idea/ }))
    first.unmount()
    h.mount()
    await settle()
    expect(stub()).toBe(`alpha|${EPIC_B}|0`)
  })
})

describe('App multiple folders', () => {
  it('only loads the epics of folders that are expanded or selected', async () => {
    h.dm.folders = [alpha, beta]
    h.epics['/a'] = []
    h.epics['/b'] = []
    window.localStorage.setItem('dm.sidebar.expanded', JSON.stringify({ 'folder:/b': false }))
    h.mount()
    await settle()
    expect(new Set(h.dm.callsOf('listEpics').map((call) => call.folder))).toEqual(new Set(['/a']))
  })

  it('selects a folder to show its home', async () => {
    h.dm.folders = [alpha, beta]
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'beta ~/code/beta' }))
    await settle()
    expect(screen.getByRole('heading', { level: 1, name: 'beta' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'beta ~/code/beta' }).getAttribute('aria-current')).toBe('true')
  })
})

describe('App stop tracking', () => {
  it('confirms, then stops tracking and selects what remains', async () => {
    h.dm.folders = [alpha, beta]
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop tracking folder' }))
    expect(screen.getByRole('dialog', { name: 'Stop tracking alpha?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop tracking' }))
    await settle()
    expect(h.dm.folders.map((f) => f.path)).toEqual(['/b'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'alpha ~/code/alpha' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'beta' })).toBeTruthy()
  })

  it('leaves the folder tracked when canceled', async () => {
    h.dm.folders = [alpha]
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop tracking folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(h.dm.folders).toHaveLength(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('can also be done from the unavailable-folder view', async () => {
    h.dm.folders = [folderView({ path: '/gone', name: 'gone', displayPath: '~/gone', available: false })]
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Stop tracking folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop tracking' }))
    await settle()
    expect(h.dm.folders).toEqual([])
    expect(screen.getByRole('heading', { name: 'Track a folder to get started' })).toBeTruthy()
  })
})
