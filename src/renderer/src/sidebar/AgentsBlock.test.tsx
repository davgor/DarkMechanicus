// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSummary } from '../../../shared/agents/chatApi'
import { chatSummary, folderView } from '../__mocks__/fixtures'
import type { AgentStatuses } from '../agents/useAgents'
import type { ChatListState } from '../agents/useChats'
import { AgentsBlock } from './AgentsBlock'

afterEach(cleanup)

const OLD = chatSummary({ id: 'chat_old', title: 'Old plan', agent: 'claude', model: 'opus', updatedAt: '2026-03-01T10:00:00.000Z' })
const NEW = chatSummary({ id: 'chat_new', title: 'Newest run', agent: 'codex', model: null, updatedAt: '2026-03-03T10:00:00.000Z' })
const MID = chatSummary({ id: 'chat_mid', title: 'Middle chat', agent: 'cursor', model: 'composer', updatedAt: '2026-03-02T10:00:00.000Z' })

const ready = (chats: ChatSummary[]): ChatListState => ({ status: 'ready', chats })

interface Setup {
  list?: ChatListState
  statuses?: AgentStatuses
  expanded?: boolean
  selectedChatId?: string | null
}

interface Calls {
  toggles: number
  newChats: number
  opened: string[]
  renamed: [string, string][]
  deleted: string[]
}

function block(setup: Setup, calls: Calls): JSX.Element {
  return (
    <AgentsBlock
      folder={folderView({ path: '/a', name: 'alpha' })}
      list={setup.list ?? ready([OLD, NEW, MID])}
      statuses={setup.statuses ?? {}}
      expanded={setup.expanded ?? true}
      selectedChatId={setup.selectedChatId ?? null}
      onToggle={() => {
        calls.toggles += 1
      }}
      onNewChat={() => {
        calls.newChats += 1
      }}
      onOpenChat={(id) => calls.opened.push(id)}
      onRenameChat={(chat, title) => {
        calls.renamed.push([chat.id, title])
        return Promise.resolve(true)
      }}
      onDeleteChat={(chat) => {
        calls.deleted.push(chat.id)
        return Promise.resolve(true)
      }}
    />
  )
}

function renderBlock(setup: Setup = {}): Calls {
  const calls: Calls = { toggles: 0, newChats: 0, opened: [], renamed: [], deleted: [] }
  render(block(setup, calls))
  return calls
}

const rowTitles = (): string[] =>
  Array.from(document.querySelectorAll('.chat-row-title')).map((element) => element.textContent ?? '')

describe('AgentsBlock listing', () => {
  it('lists the chats newest first, each with its title, agent and model', () => {
    renderBlock()
    expect(rowTitles()).toEqual(['Newest run', 'Middle chat', 'Old plan'])
    const row = screen.getByRole('button', { name: /^Old plan/ })
    expect(within(row).getByText('Claude Code · opus')).toBeTruthy()
    expect(screen.getByText('Codex · Default model')).toBeTruthy()
    expect(screen.getByText('Cursor · composer')).toBeTruthy()
  })

  it('shows a collapsible header with the number of chats', () => {
    const calls = renderBlock()
    const header = screen.getByRole('button', { name: 'Agents, 3 chats' })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(header)
    expect(calls.toggles).toBe(1)
  })

  it('hides the chats while collapsed, and says so in the header', () => {
    renderBlock({ expanded: false })
    expect(screen.getByRole('button', { name: 'Agents, 3 chats' }).getAttribute('aria-expanded')).toBe('false')
    expect(rowTitles()).toEqual([])
  })

  it('counts one chat in the singular', () => {
    renderBlock({ list: ready([OLD]) })
    expect(screen.getByRole('button', { name: 'Agents, 1 chat' })).toBeTruthy()
  })

  it('invites a first chat when the folder has none', () => {
    renderBlock({ list: ready([]) })
    expect(screen.getByText('No chats yet. Use + to start one.')).toBeTruthy()
  })

  it('shows a loading note before the first answer, and keeps the chats it has when a refresh failed', () => {
    renderBlock({ list: { status: 'loading', chats: [] } })
    expect(screen.getByText('Loading chats…')).toBeTruthy()
    cleanup()
    renderBlock({ list: { status: 'error', chats: [OLD] } })
    expect(screen.getByText('Could not refresh chats')).toBeTruthy()
    expect(rowTitles()).toEqual(['Old plan'])
  })
})

describe('AgentsBlock waiting chats', () => {
  const WAITING = chatSummary({ id: 'chat_wait', title: 'Needs a yes', updatedAt: '2026-03-04T10:00:00.000Z', pending: 2 })

  it('flags the chat that has a pending request on its row, and no other', () => {
    renderBlock({ list: ready([OLD, WAITING]) })
    expect(within(screen.getByRole('button', { name: /^Needs a yes/ })).getByText('Needs approval')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /^Old plan/ })).queryByText('Needs approval')).toBeNull()
    expect(screen.getAllByText('Needs approval')).toHaveLength(1)
  })

  it('shows no badge once nothing is pending', () => {
    renderBlock({ list: ready([OLD, { ...WAITING, pending: 0 }]) })
    expect(screen.queryByText('Needs approval')).toBeNull()
    expect(screen.queryByText(/waiting/)).toBeNull()
  })

  it('shows how many chats are waiting in the header while the chats are hidden, and says so in its name', () => {
    renderBlock({ expanded: false, list: ready([OLD, WAITING, { ...NEW, pending: 1 }]) })
    const header = screen.getByRole('button', { name: 'Agents, 3 chats, 2 waiting for approval' })
    expect(within(header).getByText('2 waiting')).toBeTruthy()
    expect(screen.queryByText('Needs approval')).toBeNull()
  })

  it('leaves the header badge to the rows while they are shown', () => {
    renderBlock({ list: ready([OLD, WAITING]) })
    expect(screen.queryByText('1 waiting')).toBeNull()
    expect(screen.getByRole('button', { name: 'Agents, 2 chats, 1 waiting for approval' })).toBeTruthy()
  })
})

describe('AgentsBlock chats waiting on a sign-in', () => {
  const CUT = chatSummary({ id: 'chat_cut', title: 'Stuck on login', agent: 'claude', cutShortMessageId: 'u1', updatedAt: '2026-03-04T10:00:00.000Z' })
  const SIGNED_OUT: AgentStatuses = { claude: { state: 'signed_out', reason: 'Not signed in.' } }
  const SIGNED_IN: AgentStatuses = { claude: { state: 'signed_in', reason: 'Signed in.' } }

  it('flags the chat that a lost sign-in cut short on its row, with the same badge, and no other', () => {
    renderBlock({ list: ready([OLD, CUT]), statuses: SIGNED_OUT })
    const row = within(screen.getByRole('button', { name: /^Stuck on login/ }))
    expect(row.getByText('Needs sign-in').className).toBe('waiting-badge')
    expect(screen.getAllByText('Needs sign-in')).toHaveLength(1)
    expect(screen.queryByText('Needs approval')).toBeNull()
  })

  it('shows how many chats are waiting in the header while the chats are hidden, and says so in its name', () => {
    renderBlock({ expanded: false, list: ready([OLD, CUT, { ...NEW, pending: 1 }]), statuses: SIGNED_OUT })
    const header = screen.getByRole('button', { name: 'Agents, 3 chats, 2 waiting for approval or sign-in' })
    expect(within(header).getByText('2 waiting')).toBeTruthy()
  })

  it('names the sign-in alone when that is all they wait for', () => {
    renderBlock({ list: ready([OLD, CUT]), statuses: SIGNED_OUT })
    expect(screen.getByRole('button', { name: 'Agents, 2 chats, 1 waiting for sign-in' })).toBeTruthy()
  })

  it('clears once the agent is signed in', () => {
    const calls: Calls = { toggles: 0, newChats: 0, opened: [], renamed: [], deleted: [] }
    const setup = { list: ready([OLD, CUT]), statuses: SIGNED_OUT }
    const view = render(block(setup, calls))
    expect(screen.getByText('Needs sign-in')).toBeTruthy()
    view.rerender(block({ ...setup, statuses: SIGNED_IN }, calls))
    expect(screen.queryByText('Needs sign-in')).toBeNull()
    expect(screen.getByRole('button', { name: 'Agents, 2 chats' })).toBeTruthy()
  })
})

describe('AgentsBlock actions', () => {
  it('starts a new chat from the + in the header', () => {
    const calls = renderBlock()
    fireEvent.click(screen.getByRole('button', { name: 'New chat in alpha' }))
    expect(calls.newChats).toBe(1)
  })

  it('offers + even while collapsed or empty', () => {
    renderBlock({ expanded: false, list: ready([]) })
    expect(screen.getByRole('button', { name: 'New chat in alpha' })).toBeTruthy()
  })

  it('opens a chat when its row is pressed, and marks the open one', () => {
    const calls = renderBlock({ selectedChatId: 'chat_mid' })
    fireEvent.click(screen.getByRole('button', { name: /^Old plan/ }))
    expect(calls.opened).toEqual(['chat_old'])
    expect(screen.getByRole('button', { name: /^Middle chat/ }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: /^Old plan/ }).getAttribute('aria-current')).toBeNull()
  })
})

describe('AgentsBlock rename', () => {
  function openRename(): Calls {
    const calls = renderBlock()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Old plan' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    return calls
  }

  it('renames from the row menu through a dialog that starts with the current title', () => {
    const calls = openRename()
    const field = screen.getByLabelText('Title') as HTMLInputElement
    expect(field.value).toBe('Old plan')
    fireEvent.change(field, { target: { value: 'Fix the build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }))
    expect(calls.renamed).toEqual([['chat_old', 'Fix the build']])
  })

  it('does not rename when the dialog is cancelled, or the title is empty', () => {
    const calls = openRename()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '   ' } })
    expect((screen.getByRole('button', { name: 'Rename chat' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.renamed).toEqual([])
  })

  it('opens the same menu from a context click on the row', () => {
    renderBlock()
    fireEvent.contextMenu(screen.getByText('Old plan'))
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
  })
})

describe('AgentsBlock delete', () => {
  function openDelete(): Calls {
    const calls = renderBlock()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Old plan' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    return calls
  }

  it('asks first, and deletes nothing until the person confirms', () => {
    const calls = openDelete()
    const dialog = screen.getByRole('dialog', { name: 'Delete this chat?' })
    expect(within(dialog).getByText('Old plan')).toBeTruthy()
    expect(within(dialog).getByText(/removes the chat and its transcript from this computer/i)).toBeTruthy()
    expect(calls.deleted).toEqual([])
  })

  it('keeps the chat when the question is cancelled', () => {
    const calls = openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.deleted).toEqual([])
  })

  it('deletes the chat once confirmed', () => {
    const calls = openDelete()
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }))
    expect(calls.deleted).toEqual(['chat_old'])
  })
})
