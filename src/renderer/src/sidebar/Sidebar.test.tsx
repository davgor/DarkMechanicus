// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeExpansion } from '../__mocks__/fakeExpansion'
import { agentView, chatSummary, EPIC_A, epicSummary, folderView } from '../__mocks__/fixtures'
import type { AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import type { ChatListState } from '../agents/useChats'
import type { EpicListState } from '../app/useEpicLists'
import { Sidebar } from './Sidebar'

afterEach(cleanup)

const alpha = folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })
const beta = folderView({ path: '/b', name: 'beta', displayPath: '~/code/beta', initialized: false })

const NO_CHATS: ComponentProps<typeof Sidebar>['chats'] = {
  lists: {},
  onNew: () => undefined,
  onOpen: () => undefined,
  onRename: () => Promise.resolve(true),
  onDelete: () => Promise.resolve(true)
}

interface Calls {
  track: number
  addAgent: number
  agents: string[]
  folders: string[]
  epics: string[]
  untrackRequests: string[]
  newChats: string[]
  chats: string[]
}

function renderSidebar(
  folders: TrackedFolderView[],
  lists: Record<string, EpicListState> = {},
  agents: AgentView[] = [],
  chatLists: Record<string, ChatListState> = {}
): Calls {
  const calls: Calls = { track: 0, addAgent: 0, agents: [], folders: [], epics: [], untrackRequests: [], newChats: [], chats: [] }
  render(
    <Sidebar
      version="0.4.0"
      folders={folders}
      lists={lists}
      selection={{ folderPath: null, epicId: null }}
      agents={agents}
      agentStatuses={{}}
      expansion={new FakeExpansion()}
      footer={<div>footer content</div>}
      onTrack={() => {
        calls.track += 1
      }}
      onAddAgent={() => {
        calls.addAgent += 1
      }}
      onSelectAgent={(kind) => calls.agents.push(kind)}
      onAgentStatus={() => undefined}
      onSelectFolder={(path) => calls.folders.push(path)}
      onSelectEpic={(path, id) => calls.epics.push(`${path}:${id}`)}
      onRequestUntrack={(folder) => calls.untrackRequests.push(folder.path)}
      chats={{
        lists: chatLists,
        onNew: (path) => calls.newChats.push(path),
        onOpen: (path, id) => calls.chats.push(`${path}:${id}`),
        onRename: () => Promise.resolve(true),
        onDelete: () => Promise.resolve(true)
      }}
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

  it('shows the tech-priest as a decorative 1x/2x image beside the brand name', () => {
    renderSidebar([])
    const brand = document.querySelector('.sidebar-brand')
    const image = brand?.querySelector('img')
    expect(image).toBeTruthy()
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.getAttribute('src')).toMatch(/brand-icon-32.*\.png$/)
    const sources = (image?.getAttribute('srcset') ?? '').split(',').map((entry) => entry.trim())
    expect(sources).toHaveLength(2)
    expect(sources[0]).toMatch(/brand-icon-32.*\.png 1x$/)
    expect(sources[1]).toMatch(/brand-icon-64.*\.png 2x$/)
    expect(brand?.querySelector('[data-icon="hex"]')).toBeNull()
  })

  it('puts the tagline directly under the brand name, as visible text', () => {
    renderSidebar([])
    const tagline = screen.getByText('All hail the machine spirit')
    expect(tagline.textContent).toBe('All hail the machine spirit')
    expect(tagline.className).toContain('brand-tagline')
    const name = screen.getByText('DARK MECHANICUS')
    // Name and tagline stack in one column beside the image; the version sits in the same block.
    const column = name.closest('.brand-text')
    expect(column).toBeTruthy()
    expect(name.nextElementSibling).toBe(tagline)
    expect(column?.contains(screen.getByLabelText('Application version 0.4.0'))).toBe(true)
    expect(column?.previousElementSibling?.tagName).toBe('IMG')
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
  it('asks the shell to confirm when the folder menu item is chosen', () => {
    const calls = renderSidebar([alpha], { '/a': listOf('Shipping') })
    fireEvent.click(screen.getByRole('button', { name: 'Actions for alpha' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop tracking folder' }))
    expect(calls.untrackRequests).toEqual(['/a'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Sidebar agents', () => {
  it('puts the AGENTS section above FOLDERS, each with its own + button', () => {
    renderSidebar([alpha])
    const agentsHead = screen.getByText('AGENTS')
    const foldersHead = screen.getByText('FOLDERS')
    expect(agentsHead.compareDocumentPosition(foldersHead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add an agent' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Track a folder' })).toBeTruthy()
  })

  it('shows the empty note for agents beside the one for folders', () => {
    renderSidebar([])
    expect(screen.getByText('No agents yet. Use + to add one.')).toBeTruthy()
    expect(screen.getByText('No folders yet. Use + to track one.')).toBeTruthy()
  })

  it('forwards the + button and an agent choice', () => {
    const calls = renderSidebar([alpha], {}, [agentView({ kind: 'claude' })])
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }))
    expect(calls.addAgent).toBe(1)
    expect(calls.agents).toEqual(['claude'])
    expect(calls.track).toBe(0)
  })

  it('does not highlight a folder while an agents pane is open', () => {
    render(
      <Sidebar
        version="0.4.0"
        folders={[alpha]}
        lists={{}}
        selection={{ folderPath: '/a', epicId: null, agentPane: { kind: 'add' } }}
        agents={[]}
        agentStatuses={{}}
        expansion={new FakeExpansion()}
        footer={null}
        onTrack={() => undefined}
        onAddAgent={() => undefined}
        onSelectAgent={() => undefined}
        onAgentStatus={() => undefined}
        onSelectFolder={() => undefined}
        onSelectEpic={() => undefined}
        onRequestUntrack={() => undefined}
        chats={NO_CHATS}
      />
    )
    expect(document.querySelector('.is-selected')).toBeNull()
  })
})

describe('Sidebar chats', () => {
  const lists = {
    '/a': { status: 'ready', chats: [chatSummary({ id: 'chat_1', title: 'Fix the build', folder: '/a' })] }
  } satisfies Record<string, ChatListState>

  it('gives each folder its own chats, and none to a folder that is not initialized', () => {
    renderSidebar([alpha, beta], {}, [], lists)
    expect(screen.getByText('Fix the build')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Agents, / })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'New chat in beta' })).toBeNull()
  })

  it('shows a loading note for a folder whose chats have not arrived', () => {
    renderSidebar([alpha])
    expect(screen.getByText('Loading chats…')).toBeTruthy()
  })

  it('reports the new chat and the opened chat with their folder', () => {
    const calls = renderSidebar([alpha], {}, [], lists)
    fireEvent.click(screen.getByRole('button', { name: 'New chat in alpha' }))
    fireEvent.click(screen.getByRole('button', { name: /^Fix the build/ }))
    expect(calls.newChats).toEqual(['/a'])
    expect(calls.chats).toEqual(['/a:chat_1'])
  })

  it('keeps the AGENTS section and the Agents block apart: the section adds agents, the block starts chats', () => {
    const calls = renderSidebar([alpha], {}, [], lists)
    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
    expect(calls.addAgent).toBe(1)
    expect(calls.newChats).toEqual([])
  })
})
