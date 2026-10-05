// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { approvalRequest, assistantText, userMessage } from './__mocks__/chatViewKit'
import { agentView, chatRecord, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

const CHAT = chatRecord({ id: 'chat_a', folder: '/a', title: 'Fix the build', agent: 'claude', model: 'opus', updatedAt: '2026-03-01T10:00:00.000Z' })

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
  h.dm.agents = [agentView({ kind: 'claude' })]
  h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'ok' }
  h.dm.chats.chats = [CHAT]
  h.dm.chats.transcripts[CHAT.id] = [userMessage('u1', 'Why is CI red?'), assistantText('a1', 'The **lockfile** is stale.')]
  h.dm.chats.modelLists = {
    claude: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' }
    ]
  }
})

afterEach(cleanup)

const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))

async function openChat(): Promise<void> {
  h.mount()
  await settle()
  fireEvent.click(sidebar().getByRole('button', { name: /^Fix the build/ }))
  await settle()
}

describe('App chat view', () => {
  it('opens the chat in the main area with its stored transcript and a composer', async () => {
    await openChat()
    expect(h.dm.chats.callsOf('open')).toEqual([[{ folder: '/a', chatId: 'chat_a' }]])
    expect(screen.getByRole('heading', { level: 1, name: 'Fix the build' })).toBeTruthy()
    expect(within(screen.getByRole('log', { name: 'Transcript' })).getByText('Why is CI red?')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy()
  })

  it('shows a sent message, and keeps a turn that is still running in the open chat while the sidebar reloads', async () => {
    await openChat()
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Try again' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter' })
    await settle()
    expect(within(screen.getByRole('log', { name: 'Transcript' })).getByText('Try again')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(true)
    act(() => h.dm.chats.finishTurn('chat_a'))
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('shows the new model on the chat’s sidebar row after a switch', async () => {
    await openChat()
    expect(sidebar().getByRole('button', { name: /^Fix the build/ }).textContent).toContain('Claude Code · opus')
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'sonnet' } })
    await settle()
    expect(sidebar().getByRole('button', { name: /^Fix the build/ }).textContent).toContain('Claude Code · sonnet')
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('sonnet')
  })

  it('starts each chat from its own stored transcript when another is opened', async () => {
    h.dm.chats.chats = [CHAT, chatRecord({ id: 'chat_b', folder: '/a', title: 'Other chat', updatedAt: '2026-03-02T10:00:00.000Z' })]
    h.dm.chats.transcripts.chat_b = [userMessage('u9', 'A different question')]
    await openChat()
    fireEvent.click(sidebar().getByRole('button', { name: /^Other chat/ }))
    await settle()
    const log = within(screen.getByRole('log', { name: 'Transcript' }))
    expect(log.getByText('A different question')).toBeTruthy()
    expect(log.queryByText('Why is CI red?')).toBeNull()
  })
})

describe('App waiting chats', () => {
  const folderRow = (): HTMLElement => sidebar().getByRole('button', { name: /^alpha/ })

  beforeEach(() => {
    h.dm.chats.transcripts[CHAT.id] = [userMessage('u1', 'Install it'), approvalRequest('q1')]
  })

  it('flags the chat in the Agents block and on the collapsed folder, and clears both once the request is answered', async () => {
    await openChat()
    expect(sidebar().getByText('Needs approval')).toBeTruthy()

    fireEvent.click(sidebar().getByRole('button', { name: 'Collapse alpha' }))
    expect(within(folderRow()).getByText('1 waiting')).toBeTruthy()
    fireEvent.click(sidebar().getByRole('button', { name: 'Expand alpha' }))

    fireEvent.click(within(screen.getByRole('article', { name: 'Approval request: Run a command' })).getByRole('button', { name: 'Allow once' }))
    await settle()

    expect(h.dm.chats.callsOf('answerApproval')).toEqual([[{ folder: '/a', chatId: 'chat_a', requestId: 'q1', decision: 'allow_once' }]])
    expect(sidebar().queryByText('Needs approval')).toBeNull()
    fireEvent.click(sidebar().getByRole('button', { name: 'Collapse alpha' }))
    expect(sidebar().queryByText(/waiting/)).toBeNull()
  })

  it('flags a chat when its agent asks while the person is elsewhere, and keeps the flag off the chat that is not asking', async () => {
    h.dm.chats.transcripts[CHAT.id] = [userMessage('u1', 'Install it')]
    await openChat()
    expect(sidebar().queryByText('Needs approval')).toBeNull()
    act(() => h.dm.chats.emitItem(CHAT.id, approvalRequest('q2')))
    await settle()
    expect(sidebar().getByText('Needs approval')).toBeTruthy()
  })
})
