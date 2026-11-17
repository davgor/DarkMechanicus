// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { conversationMessage } from '../epic/__mocks__/fixtures'
import { chatRecord } from '../__mocks__/fixtures'
import { FakeChats } from '../__mocks__/fakeChats'
import { FakeBackend } from '../epic/__mocks__/fakeBackend'
import { ConversationPanel, type ConversationPanelProps } from './ConversationPanel'
import { MAX_COMMENT_LENGTH } from './conversationView'

const TARGET = { epicId: 'ep_1', ticketId: 'tk_202' }
const FOLDER_KEY = '00000000000000000000000000000001'

function message(id: string, body: string, createdAt: string, desktop = false) {
  return conversationMessage(1, 0, body, {
    id,
    createdAt,
    author: desktop ? { role: 'desktop', label: 'Desktop' } : { role: 'worker', label: 'worker-a' }
  })
}

function renderPanel(loader: ConversationPanelProps['messages'], chats = new FakeChats(), patch: Partial<ConversationPanelProps> = {}): FakeChats {
  const backend = new FakeBackend()
  backend.chats = chats
  window.dm = backend
  render(
    <ConversationPanel
      folderPath="/repo"
      target={TARGET}
      messages={loader}
      reloadKey={0}
      canSend
      folderKey={FOLDER_KEY}
      onOpenChat={() => undefined}
      {...patch}
    />
  )
  return chats
}

function routedChats(): FakeChats {
  const chats = new FakeChats()
  chats.chats = [chatRecord({ id: 'chat_1', folder: '/repo', title: 'DM-696 worker', conversation: { epicId: 'ep_1' } })]
  return chats
}

afterEach(cleanup)

describe('ConversationPanel thread', () => {
  it('renders existing messages oldest first', async () => {
    renderPanel(() => Promise.resolve([
      message('new', 'Newest', '2026-01-02T00:00:00.000Z'),
      message('old', 'Oldest', '2026-01-01T00:00:00.000Z')
    ]))
    const items = within(await screen.findByRole('list', { name: 'Conversation' })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent?.includes('Oldest'))).toEqual([true, false])
  })

  it('sends to the target, reloads, and shows the delivered label', async () => {
    const chats = routedChats()
    let loads = 0
    renderPanel(() => {
      loads += 1
      return Promise.resolve(loads === 1 ? [] : [message('cm_fake_1', 'Please continue', '2026-01-01T00:00:00.000Z', true)])
    }, chats)
    await screen.findByText("Talking to DM-696 worker (conversation chat)")
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Please continue' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Delivered to DM-696 worker')).toBeTruthy()
    expect(chats.calls.find((call) => call.method === 'sendConversationMessage')?.args).toEqual([
      { folder: '/repo', target: TARGET, body: 'Please continue' }
    ])
    expect(loads).toBe(2)
  })

  it('shows a failed delivery problem', async () => {
    let loads = 0
    renderPanel(() => {
      loads += 1
      return Promise.resolve(loads === 1 ? [] : [message('cm_fake_1', 'Can you hear me?', '2026-01-01T00:00:00.000Z', true)])
    })
    await screen.findByText('No agent is active: sending opens a new orchestrator chat')
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Can you hear me?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('No conversation chat is configured in this fake.')
    expect(await screen.findByText('Not delivered: No conversation chat is configured in this fake.')).toBeTruthy()
  })
})

describe('ConversationPanel composer and destination', () => {
  it('disables Send for empty and too-long messages', async () => {
    renderPanel(() => Promise.resolve([]))
    await screen.findByText('No messages yet.')
    const field = screen.getByRole('textbox', { name: 'Message' })
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'Ready' } })
    expect(send.disabled).toBe(false)
    fireEvent.change(field, { target: { value: 'x'.repeat(MAX_COMMENT_LENGTH + 1) } })
    expect(send.disabled).toBe(true)
  })

  it('opens the receiving chat', async () => {
    const opened: string[] = []
    renderPanel(() => Promise.resolve([]), routedChats(), { onOpenChat: (chatId) => opened.push(chatId) })
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }))
    await waitFor(() => expect(opened).toEqual(['chat_1']))
  })
})
