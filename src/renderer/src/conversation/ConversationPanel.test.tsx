// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationMessage } from '../epic/__mocks__/fixtures'
import { chatRecord } from '../__mocks__/fixtures'
import { FakeChats } from '../__mocks__/fakeChats'
import { FakeBackend } from '../epic/__mocks__/fakeBackend'
import { ConversationPanel, type ConversationPanelProps } from './ConversationPanel'
import { MAX_COMMENT_LENGTH, type ConversationMessage } from './conversationView'
import type { ConversationStateResult } from '../../../shared/agents/chatApi'

const TARGET = { epicId: 'ep_1', ticketId: 'tk_202' }
const FOLDER_KEY = '00000000000000000000000000000001'

function message(id: string, body: string, createdAt: string, desktop = false) {
  return conversationMessage(1, 0, body, {
    id,
    createdAt,
    author: desktop ? { role: 'desktop', label: 'Desktop' } : { role: 'worker', label: 'worker-a' }
  })
}

interface PendingMessages {
  promise: Promise<readonly ConversationMessage[]>
  resolve(messages: readonly ConversationMessage[]): void
  reject(error: Error): void
}

/** A controlled load; the renderer's ES2022 lib does not include Promise.withResolvers. */
function pendingMessages(): PendingMessages {
  let resolve: PendingMessages['resolve'] = () => undefined
  let reject: PendingMessages['reject'] = () => undefined
  const promise = new Promise<readonly ConversationMessage[]>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
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

describe('ConversationPanel edge failures', () => {
  it('shows a load failure while keeping a read-only conversation non-editable', async () => {
    renderPanel(() => Promise.reject(new Error('Comments are temporarily unavailable.')), new FakeChats(), { canSend: false })

    expect((await screen.findByRole('alert')).textContent).toBe('Comments are temporarily unavailable.')
    expect(screen.getByText('This conversation is read-only.')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
  })

  it('keeps the draft when main refuses the send', async () => {
    const chats = new FakeChats()
    chats.failures.sendConversationMessage = { code: 'invalid_state', message: 'The conversation is no longer writable.' }
    renderPanel(() => Promise.resolve([]), chats)
    await screen.findByText('No messages yet.')
    const field = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement

    fireEvent.change(field, { target: { value: 'Please preserve this draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect((await screen.findByRole('alert')).textContent).toBe('The conversation is no longer writable.')
    expect(field.value).toBe('Please preserve this draft')
  })
})

describe('ConversationPanel stale loads', () => {
  it('does not replace the current thread when an earlier target finishes loading', async () => {
    const { promise: earlier, resolve: resolveEarlier } = pendingMessages()
    const backend = new FakeBackend()
    window.dm = backend
    const view = render(
      <ConversationPanel
        folderPath="/repo" target={TARGET} messages={() => earlier} reloadKey={0}
        canSend folderKey={FOLDER_KEY} onOpenChat={() => undefined}
      />
    )
    view.rerender(
      <ConversationPanel
        folderPath="/repo" target={{ cardId: 'kc_current' }}
        messages={() => Promise.resolve([message('current', 'Current thread', '2026-01-02T00:00:00.000Z')])}
        reloadKey={0} canSend folderKey={FOLDER_KEY} onOpenChat={() => undefined}
      />
    )
    await screen.findByText('Current thread')

    await act(async () => {
      resolveEarlier([message('earlier', 'Stale thread', '2026-01-01T00:00:00.000Z')])
      await earlier
    })

    expect(screen.queryByText('Stale thread')).toBeNull()
    expect(screen.getByText('Current thread')).toBeTruthy()
  })

})

describe('ConversationPanel stale load errors', () => {
  it('does not show an error from a target that is no longer selected', async () => {
    const { promise: earlier, reject: rejectEarlier } = pendingMessages()
    const backend = new FakeBackend()
    window.dm = backend
    const view = render(
      <ConversationPanel
        folderPath="/repo" target={TARGET} messages={() => earlier} reloadKey={0}
        canSend folderKey={FOLDER_KEY} onOpenChat={() => undefined}
      />
    )
    view.rerender(
      <ConversationPanel
        folderPath="/repo" target={{ epicId: 'ep_current' }}
        messages={() => Promise.resolve([message('current', 'Current thread', '2026-01-02T00:00:00.000Z')])}
        reloadKey={0} canSend folderKey={FOLDER_KEY} onOpenChat={() => undefined}
      />
    )
    await screen.findByText('Current thread')

    await act(async () => {
      rejectEarlier(new Error('Stale failure'))
      await Promise.resolve()
    })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Current thread')).toBeTruthy()
  })
})

it.each([
  { before: null, after: 'delivered', problem: null, label: 'Delivered to DM-696 worker' },
  { before: null, after: 'pending', problem: 'Sign in to the recipient.', label: 'Pending delivery: Sign in to the recipient.' },
  { before: 'Sign in to the recipient.', after: 'delivered', problem: null, label: 'Delivered to DM-696 worker' }
] as const)('refreshes an open conversation from $before to $after without sending or replacing props', async ({ before, after, problem, label }) => {
  const chats = routedChats()
  let state: ConversationStateResult = {
    chat: { id: 'chat_1', title: 'DM-696 worker', via: 'conversation' },
    deliveries: { cm_observed: { chatId: 'chat_1', state: 'pending', problem: before, chatExists: true } }
  }
  chats.conversationState = async () => ({ ok: true, data: state })
  const load = vi.fn(async () => [message('cm_observed', 'Durable person request', '2026-01-01T00:00:00.000Z', true)])
  renderPanel(load, chats)
  const initial = before === null ? 'Pending automatic delivery' : `Pending delivery: ${before}`
  await screen.findByText(initial)
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Unsent draft stays here' } })
  state = { ...state, deliveries: { cm_observed: { chatId: 'chat_1', state: after, problem, chatExists: true } } }
  await act(async () => chats.emit({ type: 'chats_changed', folder: '/another-repo', chatId: 'chat_1' }))
  expect(load).toHaveBeenCalledTimes(1)
  expect(screen.getByText(initial)).toBeTruthy()
  await act(async () => chats.emit({ type: 'chats_changed', folder: '/repo', chatId: 'chat_1' }))
  expect(await screen.findByText(label)).toBeTruthy()
  expect(load).toHaveBeenCalledTimes(2)
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('Unsent draft stays here')
  expect(chats.calls.some((call) => call.method === 'sendConversationMessage')).toBe(false)
  expect(chats.subscribers()).toBe(1)
  cleanup()
  expect(chats.subscribers()).toBe(0)
})
