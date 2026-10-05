// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeExpansion } from '../__mocks__/fakeExpansion'
import { EPIC_A, EPIC_B, EPIC_C, chatSummary, epicSummary, folderView } from '../__mocks__/fixtures'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { AgentStatuses } from '../agents/useAgents'
import type { ChatListState } from '../agents/useChats'
import type { EpicListState } from '../app/useEpicLists'
import type { Selection } from '../app/selection'
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
  selection?: Selection
  expansion?: FakeExpansion
  chats?: ChatListState
  statuses?: AgentStatuses
}

interface Calls {
  folders: string[]
  epics: string[]
  stops: string[]
  newChats: string[]
  chats: string[]
  expansion: FakeExpansion
}

function row(setup: Setup, calls: Calls): JSX.Element {
  const folder = setup.folder ?? folderView({ path: '/a', name: 'alpha' })
  return (
    <FolderRow
      folder={folder}
      list={setup.list ?? ready()}
      selection={setup.selection ?? { folderPath: null, epicId: null }}
      expansion={calls.expansion}
      chats={setup.chats ?? { status: 'ready', chats: [] }}
      statuses={setup.statuses ?? {}}
      onSelectFolder={(path) => calls.folders.push(path)}
      onSelectEpic={(path, id) => calls.epics.push(`${path}:${id}`)}
      onNewChat={(path) => calls.newChats.push(path)}
      onOpenChat={(path, id) => calls.chats.push(`${path}:${id}`)}
      onRenameChat={() => Promise.resolve(true)}
      onDeleteChat={() => Promise.resolve(true)}
      onStopTracking={(target) => calls.stops.push(target.path)}
    />
  )
}

function newCalls(setup: Setup): Calls {
  return { folders: [], epics: [], stops: [], newChats: [], chats: [], expansion: setup.expansion ?? new FakeExpansion() }
}

function renderRow(setup: Setup = {}): Calls {
  const calls = newCalls(setup)
  render(row(setup, calls))
  return calls
}

describe('FolderRow header', () => {
  it('shows the folder name and display path', () => {
    renderRow()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('~/code/alpha')).toBeTruthy()
  })

  it('shows the full name and canonical path as tooltips', () => {
    renderRow()
    expect(screen.getByText('alpha').getAttribute('title')).toBe('alpha')
    expect(screen.getByText('~/code/alpha').getAttribute('title')).toBe('/a')
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

describe('FolderRow Agents block', () => {
  const chats = (): ChatListState => ({
    status: 'ready',
    chats: [
      chatSummary({ id: 'chat_old', title: 'Old plan', updatedAt: '2026-03-01T10:00:00.000Z' }),
      chatSummary({ id: 'chat_new', title: 'Newest run', updatedAt: '2026-03-03T10:00:00.000Z' })
    ]
  })
  const rowTitles = (): string[] => Array.from(document.querySelectorAll('.chat-row-title')).map((el) => el.textContent ?? '')

  it('shows the folder\'s chats newest first under an initialized folder, below the epic buckets', () => {
    renderRow({ chats: chats() })
    expect(rowTitles()).toEqual(['Newest run', 'Old plan'])
    const completed = screen.getByRole('button', { name: 'Completed, 1 epic' })
    const agents = screen.getByRole('button', { name: 'Agents, 2 chats' })
    expect(completed.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the block while the epics are still loading', () => {
    renderRow({ chats: chats(), list: { status: 'loading', epics: [], error: null } })
    expect(screen.getByText('Loading epics…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Agents, 2 chats' })).toBeTruthy()
  })

  it('shows no Agents block for a folder that is not initialized, or is unavailable', () => {
    renderRow({ chats: chats(), folder: folderView({ path: '/s', name: 'setup-me', initialized: false }) })
    expect(screen.queryByRole('button', { name: /^Agents/ })).toBeNull()
    cleanup()
    renderRow({ chats: chats(), folder: folderView({ path: '/m', name: 'gone', available: false }) })
    expect(screen.queryByRole('button', { name: /^Agents/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New chat in gone' })).toBeNull()
  })

  it('hides the block with its folder, and remembers its own collapse state', () => {
    renderRow({ chats: chats(), expansion: new FakeExpansion({ collapsedFolders: ['/a'] }) })
    expect(screen.queryByRole('button', { name: /^Agents/ })).toBeNull()
    cleanup()
    const calls = renderRow({ chats: chats(), expansion: new FakeExpansion({ collapsedAgents: ['/a'] }) })
    expect(rowTitles()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Agents, 2 chats' }))
    expect(calls.expansion.toggled).toEqual(['agents:/a'])
  })

})

describe('FolderRow waiting chats', () => {
  const waiting = (): ChatListState => ({
    status: 'ready',
    chats: [chatSummary({ id: 'chat_a', title: 'Asks', pending: 1 }), chatSummary({ id: 'chat_b', title: 'Also asks', pending: 3 }), chatSummary({ id: 'chat_c', title: 'Quiet' })]
  })
  const collapsed = (): FakeExpansion => new FakeExpansion({ collapsedFolders: ['/a'] })

  it('flags a collapsed folder whose chats are waiting, counting the chats and not the requests', () => {
    renderRow({ chats: waiting(), expansion: collapsed() })
    const folder = screen.getByRole('button', { name: /^alpha/ })
    expect(within(folder).getByText('2 waiting')).toBeTruthy()
    expect(folder.textContent).toContain('~/code/alpha')
  })

  it('leaves the folder row alone while it is open, since the Agents block shows the chats', () => {
    renderRow({ chats: waiting() })
    expect(screen.getByRole('button', { name: FOLDER_BUTTON })).toBeTruthy()
    expect(screen.getAllByText('Needs approval')).toHaveLength(2)
    expect(screen.queryByText('2 waiting')).toBeNull()
  })

  it('shows no badge on a collapsed folder when nothing is waiting', () => {
    renderRow({ chats: { status: 'ready', chats: [chatSummary({ id: 'chat_c', title: 'Quiet' })] }, expansion: collapsed() })
    expect(screen.getByRole('button', { name: FOLDER_BUTTON })).toBeTruthy()
    expect(screen.queryByText(/waiting/)).toBeNull()
  })
})

describe('FolderRow chats waiting on a sign-in', () => {
  const chats: ChatListState = {
    status: 'ready',
    chats: [chatSummary({ id: 'chat_a', title: 'Stuck on login', agent: 'claude', cutShortMessageId: 'u1' }), chatSummary({ id: 'chat_c', title: 'Quiet', agent: 'claude' })]
  }
  const SIGNED_OUT: AgentStatuses = { claude: { state: 'signed_out', reason: 'Not signed in.' } }
  const SIGNED_IN: AgentStatuses = { claude: { state: 'signed_in', reason: 'Signed in.' } }
  const collapsed = (): FakeExpansion => new FakeExpansion({ collapsedFolders: ['/a'] })

  it('flags a collapsed folder with the same waiting badge as an approval, saying what it waits for', () => {
    renderRow({ chats, statuses: SIGNED_OUT, expansion: collapsed() })
    const folder = screen.getByRole('button', { name: /^alpha/ })
    const badge = within(folder).getByText('1 waiting')
    expect(badge.className).toBe('waiting-badge')
    expect(badge.getAttribute('title')).toBe('1 chat waiting for your sign-in')
  })

  it('clears once the agent is signed in', () => {
    const setup = { chats, statuses: SIGNED_OUT }
    const calls = newCalls({ ...setup, expansion: collapsed() })
    const view = render(row(setup, calls))
    expect(screen.getByText('1 waiting')).toBeTruthy()
    view.rerender(row({ ...setup, statuses: SIGNED_IN }, calls))
    expect(screen.queryByText(/waiting/)).toBeNull()
  })

  it('leaves the folder row alone while it is open, since the Agents block shows the chat', () => {
    renderRow({ chats, statuses: SIGNED_OUT })
    expect(screen.queryByText('1 waiting')).toBeNull()
    expect(screen.getByText('Needs sign-in')).toBeTruthy()
  })
})

describe('FolderRow chat actions', () => {
  const chats = (): ChatListState => ({
    status: 'ready',
    chats: [
      chatSummary({ id: 'chat_old', title: 'Old plan', updatedAt: '2026-03-01T10:00:00.000Z' }),
      chatSummary({ id: 'chat_new', title: 'Newest run', updatedAt: '2026-03-03T10:00:00.000Z' })
    ]
  })

  it('starts a new chat in this folder and opens a chat of this folder', () => {
    const calls = renderRow({ chats: chats() })
    fireEvent.click(screen.getByRole('button', { name: 'New chat in alpha' }))
    fireEvent.click(screen.getByRole('button', { name: /^Old plan/ }))
    expect(calls.newChats).toEqual(['/a'])
    expect(calls.chats).toEqual(['/a:chat_old'])
  })

  it('highlights the open chat and not the folder', () => {
    renderRow({ chats: chats(), selection: { folderPath: '/a', epicId: null, chatId: 'chat_new' } })
    expect(screen.getByRole('button', { name: /^Newest run/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: FOLDER_BUTTON }).getAttribute('aria-current')).toBeNull()
  })

  it('does not highlight a chat of another folder', () => {
    renderRow({ chats: chats(), selection: { folderPath: '/other', epicId: null, chatId: 'chat_new' } })
    expect(screen.getByRole('button', { name: /^Newest run/ }).getAttribute('aria-current')).toBeNull()
  })
})
