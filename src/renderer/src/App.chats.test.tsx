// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { agentView, chatRecord, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

const OLD = chatRecord({ id: 'chat_old', folder: '/a', title: 'Old plan', agent: 'claude', model: 'opus', updatedAt: '2026-03-01T10:00:00.000Z' })
const NEW = chatRecord({ id: 'chat_new', folder: '/a', title: 'Newest run', agent: 'claude', model: 'sonnet', role: 'planner', updatedAt: '2026-03-02T10:00:00.000Z' })

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.dm.folders = [
    folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' }),
    folderView({ path: '/s', name: 'setup-me', displayPath: '~/code/setup-me', initialized: false })
  ]
  h.dm.chats.chats = [OLD, NEW]
})

afterEach(() => {
  cleanup()
})

const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))
const workspace = (): ReturnType<typeof within> => within(screen.getByRole('main', { name: 'Workspace' }))
const onFolderHome = (): boolean => screen.queryByRole('heading', { level: 1, name: 'alpha' }) !== null
const openChatTitle = (): string | null => document.querySelector('.terminal-pane h1')?.textContent ?? null

async function mount(): Promise<void> {
  h.mount()
  await settle()
}

function connectClaude(signedIn = true): void {
  h.dm.agents = [agentView({ kind: 'claude' })]
  h.dm.agentStatuses.claude = { state: signedIn ? 'signed_in' : 'signed_out', reason: 'x' }
}

describe('App Agents block', () => {
  it('lists the initialized folder\'s chats newest first, and none under a folder that is not initialized', async () => {
    await mount()
    const titles = Array.from(document.querySelectorAll('.chat-row-title')).map((element) => element.textContent)
    expect(titles).toEqual(['Newest run', 'Old plan'])
    expect(sidebar().getAllByRole('button', { name: /^Agents, / })).toHaveLength(1)
    expect(sidebar().queryByRole('button', { name: 'New chat in setup-me' })).toBeNull()
    expect(h.dm.chats.callsOf('list')).toEqual([['/a']])
  })

  it('opens a chat in the main area, marked in the sidebar, and keeps it open across a reload', async () => {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: /^Old plan/ }))
    await settle()
    expect(openChatTitle()).toBe('Old plan')
    expect(onFolderHome()).toBe(false)
    expect(sidebar().getByRole('button', { name: /^Old plan/ }).getAttribute('aria-current')).toBe('true')
    cleanup()
    await mount()
    expect(openChatTitle()).toBe('Old plan')
  })

  it('says it is loading the chat, not the folders, while the folder of a stored chat is still being listed', async () => {
    window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: '/a', epicId: null, chatId: 'chat_old' }))
    const gate = h.dm.chats.hold('list')
    await mount()
    expect(screen.getByRole('status').textContent).toBe('Loading chat…')
    gate.resolve()
    await settle()
    expect(screen.queryByText('Loading chat…')).toBeNull()
    expect(openChatTitle()).toBe('Old plan')
  })

  it('falls back to the folder home when the stored chat is gone', async () => {
    window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: '/a', epicId: null, chatId: 'chat_deleted' }))
    await mount()
    expect(openChatTitle()).toBeNull()
    expect(onFolderHome()).toBe(true)
  })

  it('goes back to the folder when the folder is chosen in the sidebar', async () => {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: /^Old plan/ }))
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: 'alpha ~/code/alpha' }))
    await settle()
    expect(onFolderHome()).toBe(true)
  })
})

describe('App new chat', () => {
  async function clickNewChat(): Promise<void> {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'New chat in alpha' }))
    await settle()
  }

  it('creates the chat with the folder default agent, as an orchestrator that may save and with no model, and opens its terminal with no dialog', async () => {
    h.dm.agents = [agentView({ kind: 'codex' }), agentView({ kind: 'claude' })]
    h.dm.agentStatuses.codex = { state: 'signed_in', reason: 'x' }
    h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'x' }
    h.dm.folderDefaults['/a'] = 'claude'
    await clickNewChat()
    expect(h.dm.chats.callsOf('create')).toEqual([[{ folder: '/a', agent: 'claude', model: null, role: 'orchestrator', allowSave: true }]])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(openChatTitle()).toBe('New chat')
    const titles = Array.from(document.querySelectorAll('.chat-row-title')).map((element) => element.textContent)
    expect(titles[0]).toBe('New chat')
    const open = document.querySelector('.chat-row-main[aria-current="true"] .chat-row-title')
    expect(open?.textContent).toBe('New chat')
  })

  it('uses a signed-out folder default all the same', async () => {
    h.dm.agents = [agentView({ kind: 'codex' }), agentView({ kind: 'claude' })]
    h.dm.agentStatuses.codex = { state: 'signed_in', reason: 'x' }
    h.dm.agentStatuses.claude = { state: 'signed_out', reason: 'x' }
    h.dm.folderDefaults['/a'] = 'claude'
    await clickNewChat()
    expect(h.dm.chats.callsOf('create')[0]?.[0]).toMatchObject({ agent: 'claude' })
  })

  it('uses the first agent that can chat when the folder default is not connected', async () => {
    h.dm.agents = [agentView({ kind: 'claude' }), agentView({ kind: 'codex' })]
    h.dm.agentStatuses.claude = { state: 'signed_out', reason: 'x' }
    h.dm.agentStatuses.codex = { state: 'signed_in', reason: 'x' }
    h.dm.folderDefaults['/a'] = 'cursor'
    await clickNewChat()
    expect(h.dm.chats.callsOf('create')).toEqual([[{ folder: '/a', agent: 'codex', model: null, role: 'orchestrator', allowSave: true }]])
    expect(openChatTitle()).toBe('New chat')
  })

  it('uses the first agent that can chat when the folder has no default', async () => {
    connectClaude()
    await clickNewChat()
    expect(h.dm.chats.callsOf('create')[0]?.[0]).toMatchObject({ agent: 'claude' })
  })

  it('opens the add-agent pane and creates no chat when no agent is connected', async () => {
    await clickNewChat()
    expect(h.dm.chats.callsOf('create')).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(workspace().getByRole('heading', { level: 1, name: 'Add an agent' })).toBeTruthy()
  })
})

describe('App new chat clicks', () => {
  it('creates one chat for two quick clicks, and another for a click after the first is created', async () => {
    connectClaude()
    await mount()
    const button = sidebar().getByRole('button', { name: 'New chat in alpha' })
    fireEvent.click(button)
    fireEvent.click(button)
    await settle()
    expect(h.dm.chats.callsOf('create')).toHaveLength(1)
    fireEvent.click(sidebar().getByRole('button', { name: 'New chat in alpha' }))
    await settle()
    expect(h.dm.chats.callsOf('create')).toHaveLength(2)
  })
})

describe('App chats waiting on a sign-in', () => {
  const AT = '2026-03-01T10:00:00.000Z'

  function stickOnLogin(): void {
    h.dm.chats.chats = [chatRecord({ ...OLD, cutShortMessageId: 'u1' }), NEW]
    h.dm.chats.transcripts.chat_old = [
      { id: 'u1', at: AT, kind: 'user_message', text: 'Fix the build' },
      { id: 'auth_1', at: AT, kind: 'auth_required', agent: 'claude', message: 'Please run /login.' }
    ]
    connectClaude(false)
  }

  it('shows the waiting badge in the Agents block and on the collapsed folder, and clears it once signed in', async () => {
    stickOnLogin()
    await mount()
    expect(within(sidebar().getByRole('button', { name: /^Old plan/ })).getByText('Needs sign-in')).toBeTruthy()
    expect(within(sidebar().getByRole('button', { name: /^Newest run/ })).queryByText('Needs sign-in')).toBeNull()
    fireEvent.click(sidebar().getByRole('button', { name: 'Collapse alpha' }))
    expect(within(sidebar().getByRole('button', { name: /^alpha/ })).getByText('1 waiting')).toBeTruthy()

    // The window asks the CLI's status again when it regains focus, where a sign-in finished in a terminal shows.
    h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'x' }
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(sidebar().queryByText(/waiting/)).toBeNull()
    fireEvent.click(sidebar().getByRole('button', { name: 'Expand alpha' }))
    expect(sidebar().queryByText('Needs sign-in')).toBeNull()
  })
})

describe('App rename and delete', () => {
  it('renames a chat from its row menu, in the sidebar and in the open chat', async () => {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: /^Old plan/ }))
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: 'Actions for Old plan' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fix the build' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }))
    await settle()
    expect(h.dm.chats.callsOf('rename')).toEqual([[{ folder: '/a', chatId: 'chat_old', title: 'Fix the build' }]])
    expect(openChatTitle()).toBe('Fix the build')
    expect(sidebar().getByRole('button', { name: /^Fix the build/ })).toBeTruthy()
  })

  it('asks before deleting, and an open chat that is deleted falls back to the folder home', async () => {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: /^Old plan/ }))
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: 'Actions for Old plan' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.getByRole('dialog', { name: 'Delete this chat?' })).toBeTruthy()
    expect(h.dm.chats.callsOf('delete')).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }))
    await settle()
    expect(h.dm.chats.callsOf('delete')).toEqual([[{ folder: '/a', chatId: 'chat_old' }]])
    expect(h.dm.chats.chats.map((chat) => chat.id)).toEqual(['chat_new'])
    expect(sidebar().queryByText('Old plan')).toBeNull()
    expect(openChatTitle()).toBeNull()
    expect(onFolderHome()).toBe(true)
  })

  it('keeps the chat that is open when another chat is deleted', async () => {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: /^Old plan/ }))
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: 'Actions for Newest run' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }))
    await settle()
    expect(openChatTitle()).toBe('Old plan')
  })
})
