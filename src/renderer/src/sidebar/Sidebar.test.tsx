// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeExpansion } from '../__mocks__/fakeExpansion'
import { EPIC_A, epicSummary, folderView } from '../__mocks__/fixtures'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { EpicListState } from '../app/useEpicLists'
import { Sidebar } from './Sidebar'

afterEach(cleanup)

const alpha = folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })
const beta = folderView({ path: '/b', name: 'beta', displayPath: '~/code/beta', initialized: false })

interface Calls {
  track: number
  folders: string[]
  epics: string[]
  untracked: string[]
}

function renderSidebar(folders: TrackedFolderView[], lists: Record<string, EpicListState> = {}): Calls {
  const calls: Calls = { track: 0, folders: [], epics: [], untracked: [] }
  render(
    <Sidebar
      version="0.4.0"
      folders={folders}
      lists={lists}
      selection={{ folderPath: null, epicId: null }}
      expansion={new FakeExpansion()}
      footer={<div>footer content</div>}
      onTrack={() => {
        calls.track += 1
      }}
      onSelectFolder={(path) => calls.folders.push(path)}
      onSelectEpic={(path, id) => calls.epics.push(`${path}:${id}`)}
      onUntrack={(path) => calls.untracked.push(path)}
    />
  )
  return calls
}

const listOf = (title: string): EpicListState => ({
  status: 'ready',
  epics: [epicSummary({ id: EPIC_A, title })],
  error: null
})

describe('Sidebar chrome', () => {
  it('is a labeled region with the brand and version', () => {
    renderSidebar([])
    expect(screen.getByRole('complementary', { name: 'Tracked folders' })).toBeTruthy()
    expect(screen.getByText('DARK MECHANICUS')).toBeTruthy()
    expect(screen.getByLabelText('Application version 0.4.0').textContent).toBe('v0.4.0')
  })

  it('has a FOLDERS header with a track button', () => {
    const calls = renderSidebar([])
    expect(screen.getByText('FOLDERS')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Track a folder' }))
    expect(calls.track).toBe(1)
  })

  it('renders the footer slot', () => {
    renderSidebar([])
    expect(screen.getByText('footer content')).toBeTruthy()
  })

  it('explains how to add a folder when there are none', () => {
    renderSidebar([])
    expect(screen.getByText('No folders yet. Use + to track one.')).toBeTruthy()
  })
})

describe('Sidebar folders', () => {
  it('lists every tracked folder with its epics or setup state', () => {
    renderSidebar([alpha, beta], { '/a': listOf('Shipping') })
    expect(screen.getByRole('navigation', { name: 'Folders and epics' })).toBeTruthy()
    expect(screen.getByText('Shipping')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Setup required' })).toBeTruthy()
  })

  it('shows loading for a folder whose list has not arrived', () => {
    renderSidebar([alpha])
    expect(screen.getByText('Loading epics…')).toBeTruthy()
  })

  it('forwards folder and epic selection with the folder path', () => {
    const calls = renderSidebar([alpha], { '/a': listOf('Shipping') })
    fireEvent.click(screen.getByRole('button', { name: /Shipping/ }))
    fireEvent.click(screen.getByRole('button', { name: 'alpha ~/code/alpha' }))
    expect(calls.epics).toEqual([`/a:${EPIC_A}`])
    expect(calls.folders).toEqual(['/a'])
  })
})

describe('Sidebar stop tracking', () => {
  function askToStop(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Actions for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop tracking folder' }))
  }

  it('confirms first, explaining that repository data is untouched', () => {
    const calls = renderSidebar([alpha], { '/a': listOf('Shipping') })
    askToStop()
    const dialog = screen.getByRole('dialog', { name: 'Stop tracking alpha?' })
    expect(dialog.textContent).toContain('only removes the folder from this sidebar')
    expect(dialog.textContent).toContain('~/code/alpha')
    expect(calls.untracked).toEqual([])
  })

  it('untracks only after confirmation and closes the dialog', () => {
    const calls = renderSidebar([alpha], { '/a': listOf('Shipping') })
    askToStop()
    fireEvent.click(screen.getByRole('button', { name: 'Stop tracking' }))
    expect(calls.untracked).toEqual(['/a'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps tracking when canceled', () => {
    const calls = renderSidebar([alpha], { '/a': listOf('Shipping') })
    askToStop()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(calls.untracked).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps tracking when dismissed with Escape', () => {
    const calls = renderSidebar([alpha], { '/a': listOf('Shipping') })
    askToStop()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    expect(calls.untracked).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
