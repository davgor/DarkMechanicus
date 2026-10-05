// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { agentView, chatRecord, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'
import { SIGN_IN_POLL_MS } from './agents/SignInPrompt'

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
  h.dm.chats.modelLists = {
    claude: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' }
    ]
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))
const workspace = (): ReturnType<typeof within> => within(screen.getByRole('main', { name: 'Workspace' }))
const onFolderHome = (): boolean => screen.queryByRole('heading', { level: 1, name: 'alpha' }) !== null
const openChatTitle = (): string | null => document.querySelector('.chat-view h1')?.textContent ?? null

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
    expect(screen.queryByRole('status')).toBeNull()
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
  async function openDialog(): Promise<ReturnType<typeof within>> {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'New chat in alpha' }))
    await settle()
    return within(screen.getByRole('dialog', { name: 'New chat in alpha' }))
  }

  it('creates the chat with the agent, model and role chosen, then opens it and lists it first', async () => {
    connectClaude()
    const dialog = await openDialog()
    fireEvent.change(dialog.getByLabelText('Model'), { target: { value: 'sonnet' } })
    fireEvent.change(dialog.getByLabelText('Role'), { target: { value: 'reviewer' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Start chat' }))
    await settle()
    expect(h.dm.chats.callsOf('create')).toEqual([[{ folder: '/a', agent: 'claude', model: 'sonnet', role: 'reviewer', allowSave: false }]])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(openChatTitle()).toBe('New chat')
    const facts = within(workspace().getByRole('list', { name: 'Chat details' }))
    expect((workspace().getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('sonnet')
    expect(facts.getByText('Reviewer')).toBeTruthy()
    const titles = Array.from(document.querySelectorAll('.chat-row-title')).map((element) => element.textContent)
    expect(titles[0]).toBe('New chat')
    const open = document.querySelector('.chat-row-main[aria-current="true"] .chat-row-title')
    expect(open?.textContent).toBe('New chat')
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

    // Signing in from the chat's own card: the main process says so once the CLI's status does.
    fireEvent.click(sidebar().getByRole('button', { name: 'Expand alpha' }))
    fireEvent.click(sidebar().getByRole('button', { name: /^Old plan/ }))
    await settle()
    vi.useFakeTimers()
    fireEvent.click(workspace().getByRole('button', { name: 'Sign in' }))
    await settle()
    h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'x' }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)
    })
    act(() => h.dm.chats.emit({ type: 'agent_auth', chatId: 'chat_old', agent: 'claude', state: 'signed_in' }))
    await settle()
    expect(sidebar().queryByText('Needs sign-in')).toBeNull()
    fireEvent.click(sidebar().getByRole('button', { name: 'Collapse alpha' }))
    expect(sidebar().queryByText(/waiting/)).toBeNull()
    expect(workspace().getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})

describe('App new chat choices', () => {
  async function openDialog(): Promise<ReturnType<typeof within>> {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'New chat in alpha' }))
    await settle()
    return within(screen.getByRole('dialog', { name: 'New chat in alpha' }))
  }

  it('sends Allow save as chosen for an orchestrator', async () => {
    connectClaude()
    const dialog = await openDialog()
    fireEvent.click(dialog.getByRole('checkbox', { name: /Allow save/ }))
    fireEvent.click(dialog.getByRole('button', { name: 'Start chat' }))
    await settle()
    expect(h.dm.chats.callsOf('create')[0]?.[0]).toMatchObject({ role: 'orchestrator', allowSave: false })
  })

  it('lists an agent that is signed out with Sign in, and offers it once signed in, without leaving the dialog', async () => {
    connectClaude(false)
    const dialog = await openDialog()
    expect(dialog.queryAllByRole('radio')).toHaveLength(0)
    vi.useFakeTimers()
    fireEvent.click(dialog.getByRole('button', { name: 'Sign in' }))
    await settle()
    expect(h.dm.agentCallsOf('signInAgent')).toEqual([['claude']])
    h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'x' }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)
    })
    await settle()
    expect(dialog.getByRole('radio', { name: /Claude Code/ })).toBeTruthy()
    expect((dialog.getByRole('button', { name: 'Start chat' }) as HTMLButtonElement).disabled).toBe(false)
    // The Agents list in the sidebar shows what the prompt found, too.
    expect(within(screen.getByRole('region', { name: 'Agents' })).getByText('Signed in')).toBeTruthy()
  })

  it('sends a person with no agent to the add-agent pane', async () => {
    const dialog = await openDialog()
    fireEvent.click(dialog.getByRole('button', { name: 'Add Claude Code' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(workspace().getByRole('heading', { level: 1, name: 'Add an agent' })).toBeTruthy()
  })

  it('closes without creating a chat when cancelled', async () => {
    connectClaude()
    const dialog = await openDialog()
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(h.dm.chats.callsOf('create')).toEqual([])
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
