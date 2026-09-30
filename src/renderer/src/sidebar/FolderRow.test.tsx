// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeExpansion } from '../__mocks__/fakeExpansion'
import { EPIC_A, EPIC_B, EPIC_C, epicSummary, folderView } from '../__mocks__/fixtures'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { EpicListState } from '../app/useEpicLists'
import { FolderRow } from './FolderRow'

afterEach(cleanup)

const FOLDER_BUTTON = 'alpha ~/code/alpha'

const ready = (epics = [
  epicSummary({ id: EPIC_A, title: 'Alpha work', status: 'in_progress' }),
  epicSummary({ id: EPIC_B, title: 'Beta work', status: 'backlog' }),
  epicSummary({ id: EPIC_C, title: 'Gamma work', status: 'completed', completedAt: '2026-03-15T12:00:00.000Z' })
]): EpicListState => ({ status: 'ready', epics, error: null })

interface Setup {
  folder?: TrackedFolderView
  list?: EpicListState
  selection?: { folderPath: string | null; epicId: string | null }
  expansion?: FakeExpansion
}

interface Calls {
  folders: string[]
  epics: string[]
  stops: string[]
  expansion: FakeExpansion
}

function renderRow(setup: Setup = {}): Calls {
  const folder = setup.folder ?? folderView({ path: '/a', name: 'alpha' })
  const calls: Calls = { folders: [], epics: [], stops: [], expansion: setup.expansion ?? new FakeExpansion() }
  render(
    <FolderRow
      folder={folder}
      list={setup.list ?? ready()}
      selection={setup.selection ?? { folderPath: null, epicId: null }}
      expansion={calls.expansion}
      onSelectFolder={(path) => calls.folders.push(path)}
      onSelectEpic={(path, id) => calls.epics.push(`${path}:${id}`)}
      onStopTracking={(target) => calls.stops.push(target.path)}
    />
  )
  return calls
}

describe('FolderRow header', () => {
  it('shows the folder name and display path', () => {
    renderRow()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('~/code/alpha')).toBeTruthy()
  })

  it('selects the folder from its name', () => {
    const calls = renderRow()
    fireEvent.click(screen.getByRole('button', { name: FOLDER_BUTTON }))
    expect(calls.folders).toEqual(['/a'])
  })

  it('toggles from the chevron and reports the state', () => {
    const calls = renderRow()
    const chevron = screen.getByRole('button', { name: 'Collapse alpha' })
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(chevron)
    expect(calls.expansion.toggled).toEqual(['folder:/a'])
  })

  it('offers to expand a collapsed folder and hides its contents', () => {
    renderRow({ expansion: new FakeExpansion({ collapsedFolders: ['/a'] }) })
    const chevron = screen.getByRole('button', { name: 'Expand alpha' })
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Alpha work')).toBeNull()
    expect(screen.queryByRole('button', { name: /In progress/ })).toBeNull()
  })

  it('highlights the folder while it is selected without an epic', () => {
    renderRow({ selection: { folderPath: '/a', epicId: null } })
    expect(screen.getByRole('button', { name: FOLDER_BUTTON }).getAttribute('aria-current')).toBe('true')
  })

  it('does not highlight the folder while one of its epics is selected', () => {
    renderRow({ selection: { folderPath: '/a', epicId: EPIC_A } })
    expect(screen.getByRole('button', { name: FOLDER_BUTTON }).getAttribute('aria-current')).toBeNull()
  })
})

describe('FolderRow buckets', () => {
  it('shows exactly three buckets in order with counts', () => {
    renderRow()
    const headers = Array.from(document.querySelectorAll('.bucket-header')).map((el) => el.getAttribute('aria-label'))
    expect(headers).toEqual(['In progress, 1 epic', 'Backlog, 1 epic', 'Completed, 1 epic'])
  })

  it('expands buckets according to the persisted state', () => {
    renderRow({ expansion: new FakeExpansion({ buckets: { '/a:completed': true, '/a:backlog': false } }) })
    expect(screen.getByText('Alpha work')).toBeTruthy()
    expect(screen.queryByText('Beta work')).toBeNull()
    expect(screen.getByText('Gamma work')).toBeTruthy()
  })

  it('toggles a bucket through the expansion state', () => {
    const calls = renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'Completed, 1 epic' }))
    expect(calls.expansion.toggled).toEqual(['bucket:/a:completed'])
  })

  it('opens an epic in its folder and highlights the selected one', () => {
    const calls = renderRow({ selection: { folderPath: '/a', epicId: EPIC_A } })
    expect(screen.getByRole('button', { name: /Alpha work/ }).getAttribute('aria-current')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /Beta work/ }))
    expect(calls.epics).toEqual([`/a:${EPIC_B}`])
  })

  it('does not highlight an epic of another folder', () => {
    renderRow({ selection: { folderPath: '/other', epicId: EPIC_A } })
    expect(screen.getByRole('button', { name: /Alpha work/ }).getAttribute('aria-current')).toBeNull()
  })
})

describe('FolderRow load states', () => {
  it('shows a loading note before the first response', () => {
    renderRow({ list: { status: 'loading', epics: [], error: null } })
    expect(screen.getByText('Loading epics…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /In progress/ })).toBeNull()
  })

  it('keeps the last known epics and says the refresh failed', () => {
    renderRow({ list: { ...ready(), status: 'error', error: 'boom' } })
    expect(screen.getByText('Could not refresh epics')).toBeTruthy()
    expect(screen.getByText('Alpha work')).toBeTruthy()
  })
})

describe('FolderRow special folders', () => {
  const setup = folderView({ path: '/s', name: 'setup-me', displayPath: '~/code/setup-me', initialized: false })

  it('shows a Setup required row that selects the folder', () => {
    const calls = renderRow({ folder: setup })
    fireEvent.click(screen.getByRole('button', { name: 'Setup required' }))
    expect(calls.folders).toEqual(['/s'])
    expect(screen.queryByRole('button', { name: /In progress/ })).toBeNull()
  })

  it('highlights the Setup row, not the header, when the folder is selected', () => {
    renderRow({ folder: setup, selection: { folderPath: '/s', epicId: null } })
    expect(screen.getByRole('button', { name: 'Setup required' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'setup-me ~/code/setup-me' }).getAttribute('aria-current')).toBeNull()
  })

  it('shows a missing folder as unavailable', () => {
    const calls = renderRow({ folder: folderView({ path: '/m', name: 'gone', available: false }) })
    fireEvent.click(screen.getByRole('button', { name: 'Folder unavailable' }))
    expect(calls.folders).toEqual(['/m'])
  })
})

describe('FolderRow actions menu', () => {
  it('stops tracking from the actions menu', () => {
    const calls = renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop tracking folder' }))
    expect(calls.stops).toEqual(['/a'])
  })

  it('opens the same menu from a context click on the row', () => {
    renderRow()
    fireEvent.contextMenu(screen.getByText('alpha'))
    expect(screen.getByRole('menuitem', { name: 'Stop tracking folder' })).toBeTruthy()
  })
})
