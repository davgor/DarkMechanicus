// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { chatRecord, epicSummary, folderView } from '../__mocks__/fixtures'
import { cardSummary } from '../kanban/__mocks__/fixtures'
import { Sidebar, type SidebarProps } from './Sidebar'
import { useExpansion } from './useExpansion'

const world = folderView({ path: '/world', name: 'Mars', initialized: false, forgeWorld: { version: 1, owner: 'codex', projects: [{ folder: 'alpha', repository: 'https://github.com/codex/alpha.git' }], syncMinutes: 5 } })
const project = folderView({ path: '/world/alpha', name: 'Alpha', forgeParent: world.path })
const elsewhere = folderView({ path: '/elsewhere', name: 'Elsewhere' })
const rootChat = chatRecord({ id: 'chat_root', folder: world.path, title: 'World planning' })
const memberChat = chatRecord({ id: 'chat_member', folder: project.path, title: 'Project work' })
const otherChat = chatRecord({ id: 'chat_other', folder: elsewhere.path, title: 'Unrelated chat' })
const card = cardSummary({ id: 'kc_alpha', key: 'DM-21', title: 'Repair launch', lane: 'in_progress' })

beforeEach(() => { localStorage.clear(); window.dm = new FakeDm() })
afterEach(cleanup)

function setup(selection: SidebarProps['selection'] = { folderPath: null, epicId: null }) {
  const opened: string[] = []
  const created: string[] = []
  const cards: string[] = []
  function View(): JSX.Element {
    return <Sidebar version="0.1" folders={[world, project, elsewhere]} selection={selection}
      lists={{ [project.path]: { status: 'ready', epics: [epicSummary({ title: 'Ship Alpha' })], error: null } }}
      agents={[]} agentStatuses={{}} expansion={useExpansion()} footer={null}
      chats={{ lists: { [world.path]: { status: 'ready', chats: [rootChat] }, [project.path]: { status: 'ready', chats: [memberChat] }, [elsewhere.path]: { status: 'ready', chats: [otherChat] } }, onNew: path => created.push(path), onOpen: (path, id) => opened.push(`${path}:${id}`), onRename: async () => true, onDelete: async () => true }}
      agentChats={{ list: { status: 'ready', chats: [rootChat, memberChat, otherChat] }, onOpen: chat => opened.push(`global:${chat.id}`), onSummon: () => undefined, onRename: async () => true, onDelete: async () => true }}
      onTrack={() => undefined} onClone={() => undefined} onAddAgent={() => undefined} onSelectAgent={() => undefined} onAgentStatus={() => undefined}
      onSelectFolder={() => undefined} onSelectEpic={() => undefined} onRequestUntrack={() => undefined}
      kanbanCounts={{ [project.path]: 1 }} kanbanCards={{ [project.path]: [card] }} onSelectKanban={(path, id) => cards.push(`${path}:${id ?? 'board'}`)} />
  }
  const rendered = render(<View />)
  return { ...rendered, opened, created, cards }
}

describe('Forge sidebar navigation', () => {
  it('nests projects under their world using shared chevrons and persists each collapse', () => {
    const view = setup()
    const worlds = screen.getByRole('region', { name: 'Forge Worlds' })
    expect(within(worlds).getByText('Alpha').closest('.forge-projects')).toBeTruthy()
    expect(within(worlds).getByText('Ship Alpha')).toBeTruthy()
    expect(within(worlds).getByRole('button', { name: 'New chat in Mars' }).compareDocumentPosition(within(worlds).getByText('Alpha')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(worlds.querySelector('summary')).toBeNull()
    expect(within(worlds).getByRole('button', { name: 'Collapse Alpha' }).querySelector('[data-icon="chevron-down"]')).toBeTruthy()
    fireEvent.click(within(worlds).getByRole('button', { name: 'Collapse Alpha' }))
    expect(within(worlds).queryByText('Ship Alpha')).toBeNull()
    expect(within(worlds).getByText('World planning')).toBeTruthy()
    view.unmount()
    setup()
    expect(screen.getByRole('button', { name: 'Expand Alpha' })).toBeTruthy()
  })

  it('starts and opens root or project agents without leaking unrelated chats into the world', () => {
    const view = setup()
    const worlds = screen.getByRole('region', { name: 'Forge Worlds' })
    expect(within(worlds).queryByText('Unrelated chat')).toBeNull()
    expect(within(worlds).getAllByText('Project work')).toHaveLength(1)
    fireEvent.click(within(worlds).getByRole('button', { name: 'New chat in Mars' }))
    fireEvent.click(within(worlds).getByRole('button', { name: 'New chat in Alpha' }))
    fireEvent.click(within(worlds).getByText('World planning'))
    fireEvent.click(within(worlds).getByText('Project work'))
    expect(view.created).toEqual(['/world', '/world/alpha'])
    expect(view.opened).toEqual(['/world:chat_root', '/world/alpha:chat_member'])
  })

  it('opens a compact card in its project and keeps a separate board entry when collapsed', () => {
    const view = setup({ folderPath: project.path, epicId: null, kanban: true, kanbanCardId: card.id })
    const button = screen.getByRole('button', { name: /DM-21 Repair launch In progress/ })
    expect(button.getAttribute('aria-current')).toBe('true')
    fireEvent.click(button)
    expect(view.cards).toEqual(['/world/alpha:kc_alpha'])
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Kanban in Alpha' }))
    expect(screen.queryByText('Repair launch')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Kanban, 1 open card' }))
    expect(view.cards).toEqual(['/world/alpha:kc_alpha', '/world/alpha:board'])
  })
})
