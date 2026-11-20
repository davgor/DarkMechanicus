// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../shared/agents/chat'
import { FakeChatMail, mailMessage } from '../__mocks__/fakeChatMail'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalHandle, FakeTerminals } from '../__mocks__/fakeTerminals'
import { chatRecord } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { AgentInbox, MAIL_ALERT_COALESCE_MS } from './AgentInbox'
import { createLiveTerminals, LiveTerminalsContext, type LiveTerminals } from './liveTerminals'
import { AgentMailContext, createAgentMailStore, type AgentMailStore } from './useAgentMail'

const CHAT = chatRecord({ id: 'chat_a', folder: '/a', title: 'Skitarii A', agent: 'omp', endpointId: 'ep_a' })
const OTHER = chatRecord({ id: 'chat_b', folder: '/a', title: 'Skitarii B', agent: 'omp', endpointId: 'ep_b' })
const PEER = chatRecord({ id: 'chat_peer', folder: '/a', title: 'Peer chat', agent: 'omp', endpointId: 'ep_peer' })
/** The same chat id in another folder, with the endpoint of a sender: never this folder's chat. */
const FAR = chatRecord({ id: 'chat_peer', folder: '/b', title: 'Far chat', agent: 'omp', endpointId: 'ep_far' })

const MESSAGES = [
  mailMessage({ seq: 1, acknowledgedAt: '2026-11-15T10:05:00.000Z', expiresAt: '2026-11-22T10:05:00.000Z', body: 'first' }),
  mailMessage({ seq: 2, from: { endpointId: 'ep_gone', name: 'Gone chat', deleted: true }, body: 'from a deleted chat' }),
  mailMessage({ seq: 3, from: { endpointId: 'ep_far', name: 'Far chat', deleted: false }, inReplyTo: 'msg_sent_9', body: 'a reply' })
]

let mail: FakeChatMail
let terminals: FakeTerminals
let store: AgentMailStore
let live: LiveTerminals
let scheduler: ManualScheduler
let opened: string[]

beforeEach(() => {
  const dm = new FakeDm()
  terminals = new FakeTerminals()
  dm.terminals = terminals
  mail = new FakeChatMail()
  dm.chats.mail = mail
  window.dm = dm
  store = createAgentMailStore(mail)
  live = createLiveTerminals()
  mail.onEvent(store.push)
  scheduler = new ManualScheduler()
  opened = []
  mail.put({ folder: '/a', chatId: 'chat_a', humanSeenSeq: 1, unseenCount: 2, pendingCount: 2, retainedCount: 3 })
  mail.setMessages('/a', 'chat_a', MESSAGES)
})

afterEach(cleanup)

function inbox(chat: ChatRecord = CHAT): JSX.Element {
  return (
    <AgentMailContext.Provider value={store}>
      <LiveTerminalsContext.Provider value={live}>
        <AgentInbox folder="/a" chat={chat} peers={[CHAT, OTHER, PEER, FAR]} scheduler={scheduler} onOpenChat={(chatId) => opened.push(chatId)} />
      </LiveTerminalsContext.Provider>
    </AgentMailContext.Provider>
  )
}

async function show(chat: ChatRecord = CHAT): Promise<RenderResult> {
  await act(async () => store.track(['/a']))
  const mounted = render(inbox(chat))
  await settle()
  return mounted
}

const messagesButton = (): HTMLElement => screen.getByRole('button', { name: /^Messages:/ })
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Messages to Skitarii A' })
const message = (name: string): HTMLElement => within(dialog()).getByRole('listitem', { name })

async function openInbox(): Promise<void> {
  fireEvent.click(messagesButton())
  await settle()
}

describe('AgentInbox: counts', () => {
  it('shows unseen-by-you and unacknowledged-by-its-agent apart, and nothing for a chat without a mailbox', async () => {
    await show()
    expect(messagesButton().getAttribute('aria-label')).toBe('Messages: 2 unseen by you, 2 unacknowledged by its agent')
    cleanup()
    await show(OTHER)
    expect(screen.queryByRole('button', { name: /^Messages/ })).toBeNull()
  })

  it('keeps compact, separate visible counters and full accessible meanings on the actual header action', async () => {
    await show()
    const button = messagesButton()
    expect(button.querySelectorAll('.mail-count')).toHaveLength(2)
    expect(Array.from(button.querySelectorAll('.mail-count')).map((node) => node.textContent)).toEqual(['2 unseen', '2 awaiting agent'])
    expect(button.getAttribute('aria-label')).toBe('Messages: 2 unseen by you, 2 unacknowledged by its agent')
  })

  it('keeps human-unseen and agent-unacknowledged counters independent as either reaches zero', async () => {
    await show()
    act(() => mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 0, pendingCount: 1 }, true))
    expect(Array.from(messagesButton().querySelectorAll('.mail-count')).map((node) => [node.textContent, node.classList.contains('is-unseen'), node.classList.contains('is-pending')])).toEqual([
      ['0 unseen', false, false],
      ['1 awaiting agent', false, true]
    ])
    act(() => mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 1, pendingCount: 0 }, true))
    expect(Array.from(messagesButton().querySelectorAll('.mail-count')).map((node) => [node.textContent, node.classList.contains('is-unseen'), node.classList.contains('is-pending')])).toEqual([
      ['1 unseen', true, false],
      ['0 awaiting agent', false, false]
    ])
  })

  it('announces new mail once per burst, politely, without moving focus', async () => {
    await show()
    const outside = document.body.appendChild(document.createElement('button'))
    outside.focus()
    act(() => {
      mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 3 }, true)
      mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 4 }, true)
    })
    expect(scheduler.timeouts()).toEqual([MAIL_ALERT_COALESCE_MS])
    expect(screen.getByTestId('mail-alert').textContent).toBe('')
    act(() => scheduler.fireTimeouts())
    expect(screen.getByTestId('mail-alert').textContent).toBe('4 messages unseen by you')
    expect(screen.getByTestId('mail-alert').getAttribute('aria-live')).toBe('polite')
    expect(document.activeElement).toBe(outside)
  })
})

describe('AgentInbox: reading', () => {
  it('reads messages as data: sender, stable id, time, reply, seen and acknowledged states; reading changes nothing', async () => {
    await show()
    await openInbox()
    const first = message('Message 1 from Peer chat')
    expect(within(first).getByText('ep_peer')).toBeTruthy()
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-15T10:00:00.000Z')
    expect(within(first).getByText('Seen by you')).toBeTruthy()
    expect(within(first).getByText(/^Acknowledged by its agent/)).toBeTruthy()
    const reply = message('Message 3 from Far chat')
    expect(reply.textContent).toContain('Reply to message msg_sent_9 this chat sent')
    expect(within(reply).getByText('Unseen by you')).toBeTruthy()
    expect(within(reply).getByText('Unacknowledged by its agent')).toBeTruthy()
    expect(mail.calls.map((call) => call.method)).toEqual(['snapshot', 'read'])
    expect(mail.calls[1].args).toEqual([{ folder: '/a', chatId: 'chat_a', limit: 50 }])
  })

  it('keeps hostile text inert: escape sequences, OSC links, markup and direction overrides are shown, never acted on', async () => {
    const hostile = '\x1b]8;;https://evil.example\x07click\x1b]8;;\x07 <img src=x onerror="alert(1)"><a href="https://evil.example">link</a>\u202Eevil\x1b[2J\x7f'
    mail.setMessages('/a', 'chat_a', [mailMessage({ seq: 4, from: { endpointId: 'ep_x', name: '<b>Boss</b>\x1b[31m', deleted: false }, body: hostile })])
    await show()
    await openInbox()
    const item = message('Message 4 from <b>Boss</b>␛[31m')
    expect(item.querySelector('img, a, b, script')).toBeNull()
    const body = item.querySelector('pre')?.textContent ?? ''
    expect(body).toContain('␛]8;;https://evil.example␇click')
    expect(body).toContain('<img src=x onerror="alert(1)">')
    expect(body).toContain('<U+202E>evil␛[2J␡')
    expect(['\u001b', '\u0007', '\u202e', '\u007f'].filter((char) => body.includes(char))).toEqual([])
  })
})

describe('AgentInbox: loading and late answers', () => {
  it('says it is loading, then shows a failure with Try again', async () => {
    await show()
    mail.hold('read')
    await openInbox()
    expect(within(dialog()).getByRole('status').textContent).toBe('Loading messages…')
    mail.failures.read = { code: 'invalid_state', message: 'The mailbox is not open.' }
    await act(async () => mail.release('read', true))
    await settle()
    expect(within(dialog()).getByRole('alert').textContent).toBe('Could not load messages: The mailbox is not open.')
    delete mail.failures.read
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(message('Message 1 from Peer chat')).toBeTruthy()
  })

  it('drops a late page of another chat: an answer for A never shows once the inbox is B’s', async () => {
    mail.put({ folder: '/a', chatId: 'chat_b', unseenCount: 0 })
    mail.setMessages('/a', 'chat_b', [mailMessage({ seq: 1, body: 'for B' })])
    const mounted = await show()
    mail.hold('read')
    await openInbox()
    mounted.rerender(inbox(OTHER))
    await settle()
    await act(async () => mail.release('read'))
    await settle()
    await act(async () => mail.release('read', true))
    await settle()
    const shown = Array.from(screen.getByRole('dialog').querySelectorAll('pre')).map((pre) => pre.textContent)
    expect(shown).toEqual(['for B'])
  })
})

describe('AgentInbox: empty inbox', () => {
  it('says how long acknowledged messages are kept, and offers nothing to mark seen', async () => {
    mail.put({ folder: '/a', chatId: 'chat_a', retentionDays: 3 })
    mail.setMessages('/a', 'chat_a', [])
    await show()
    await openInbox()
    expect(within(dialog()).getByText('No messages retained. Acknowledged messages are kept 3 days.')).toBeTruthy()
    expect(within(dialog()).queryByRole('button', { name: 'Mark shown messages seen' })).toBeNull()
    expect(within(dialog()).queryByRole('button', { name: 'Load more messages' })).toBeNull()
  })

  it('falls back to the default retention once the chat’s mailbox is gone', async () => {
    mail.setMessages('/a', 'chat_a', [])
    await show()
    await openInbox()
    act(() => mail.remove('/a', 'chat_a'))
    expect(within(dialog()).getByText('No messages retained. Acknowledged messages are kept 7 days.')).toBeTruthy()
  })

  it('shows a read that never answers as the app not answering, with Try again', async () => {
    vi.spyOn(mail, 'read').mockRejectedValueOnce(new Error('ipc closed'))
    await show()
    await openInbox()
    expect(within(dialog()).getByRole('alert').textContent).toBe('Could not load messages: The app did not answer.')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(message('Message 1 from Peer chat')).toBeTruthy()
  })
})

/** 52 retained messages: one page of 50 and two more. */
const MANY = Array.from({ length: 52 }, (_, index) => mailMessage({ seq: index + 1, body: `m${index + 1}` }))
const loadMore = (): HTMLElement => within(dialog()).getByRole('button', { name: 'Load more messages' })
const shownBodies = (): string[] => Array.from(dialog().querySelectorAll('pre')).map((pre) => pre.textContent ?? '')

describe('AgentInbox: paging', () => {
  it('reads the next page after the last one, up to the first page’s horizon, so a new arrival waits for Refresh', async () => {
    mail.setMessages('/a', 'chat_a', MANY)
    await show()
    await openInbox()
    expect(shownBodies()).toHaveLength(50)
    mail.setMessages('/a', 'chat_a', [...MANY, mailMessage({ seq: 53, body: 'arrived later' })])
    mail.hold('read')
    fireEvent.click(loadMore())
    await settle()
    expect(loadMore().getAttribute('aria-busy')).toBe('true')
    await act(async () => mail.release('read', true))
    await settle()
    expect(mail.calls.at(-1)?.args).toEqual([{ folder: '/a', chatId: 'chat_a', afterSeq: 50, throughSeq: 52, limit: 50 }])
    expect(shownBodies()).toEqual(MANY.map((item) => item.body))
    expect(within(dialog()).queryByRole('button', { name: 'Load more messages' })).toBeNull()
  })

  it('keeps the shown pages when the next page fails, and reads it again on another click', async () => {
    mail.setMessages('/a', 'chat_a', MANY)
    await show()
    await openInbox()
    mail.failures.read = { code: 'invalid_state', message: 'The mailbox is not open.' }
    fireEvent.click(loadMore())
    await settle()
    expect(shownBodies()).toHaveLength(50)
    expect(loadMore().getAttribute('aria-busy')).toBeNull()
    delete mail.failures.read
    fireEvent.click(loadMore())
    await settle()
    expect(shownBodies()).toHaveLength(52)
  })
})

describe('AgentInbox: navigation', () => {
  it('opens a same-folder sender only on click, a stopped one too, and never a deleted or another folder’s chat', async () => {
    await show()
    await openInbox()
    expect(opened).toEqual([])
    expect(within(message('Message 1 from Peer chat')).getByText('Terminal not seen running')).toBeTruthy()
    expect(within(message('Message 2 from Gone chat')).queryByRole('button')).toBeNull()
    expect(message('Message 2 from Gone chat').textContent).toContain('Gone chat (chat deleted)')
    expect(within(message('Message 3 from Far chat')).queryByRole('button')).toBeNull()
    expect(message('Message 3 from Far chat').textContent).toContain('Far chat (not a chat of this folder)')
    fireEvent.click(within(message('Message 1 from Peer chat')).getByRole('button', { name: 'Open chat Peer chat' }))
    expect(opened).toEqual(['chat_peer'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a running sender as running', async () => {
    live.hold('chat_peer', new FakeTerminalHandle())
    await show()
    await openInbox()
    expect(within(message('Message 1 from Peer chat')).getByText('Terminal running')).toBeTruthy()
  })
})

describe('AgentInbox: keyboard and seen', () => {
  it('moves focus into the inbox, closes on Escape and gives focus back to Messages', async () => {
    await show()
    messagesButton().focus()
    await openInbox()
    expect(dialog().contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(messagesButton())
  })

  it('marks seen up to the newest message shown, which moves only the person’s count', async () => {
    await show()
    await openInbox()
    const markSeen = within(dialog()).getByRole('button', { name: 'Mark shown messages seen' })
    markSeen.focus()
    fireEvent.click(markSeen)
    fireEvent.click(markSeen)
    await settle()
    expect(mail.calls.filter((call) => call.method === 'markSeen').map((call) => call.args)).toEqual([[{ folder: '/a', chatId: 'chat_a', throughSeq: 3 }]])
    expect(messagesButton().getAttribute('aria-label')).toBe('Messages: 0 unseen by you, 2 unacknowledged by its agent')
    expect(markSeen.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(markSeen)
    expect(within(message('Message 3 from Far chat')).getByText('Unacknowledged by its agent')).toBeTruthy()
    expect(mail.calls.map((call) => call.method)).toEqual(['snapshot', 'read', 'markSeen'])
    expect(terminals.calls).toEqual([])
    fireEvent.keyDown(markSeen, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('AgentInbox: failed and late actions', () => {
  it('reports a mark-seen request that never answers, keeps the count and lets the person try again', async () => {
    vi.spyOn(mail, 'markSeen').mockRejectedValueOnce(new Error('ipc closed'))
    await show()
    await openInbox()
    const markSeen = within(dialog()).getByRole('button', { name: 'Mark shown messages seen' })
    fireEvent.click(markSeen)
    await settle()
    expect(within(dialog()).getByRole('alert').textContent).toBe('Could not mark seen: The app did not answer.')
    expect(messagesButton().getAttribute('aria-label')).toBe('Messages: 2 unseen by you, 2 unacknowledged by its agent')
    expect(markSeen.getAttribute('aria-disabled')).toBe('false')
  })

  it('drops a mark-seen answer that comes after the inbox closed', async () => {
    await show()
    await openInbox()
    mail.hold('markSeen')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mark shown messages seen' }))
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    await act(async () => mail.release('markSeen', true))
    await settle()
    expect(messagesButton().getAttribute('aria-label')).toBe('Messages: 2 unseen by you, 2 unacknowledged by its agent')
    await openInbox()
    expect(within(dialog()).queryByRole('alert')).toBeNull()
  })
})

const wakeButton = (): HTMLElement => within(dialog()).getByRole('button', { name: 'Allow one inbox wake' })
const wakeRegion = (): HTMLElement => within(dialog()).getByRole('region', { name: 'Inbox wake' })
const wakeCalls = (): unknown[] => mail.calls.filter((call) => call.method === 'allowWake').map((call) => call.args[0])

describe('AgentInbox: one inbox wake', () => {
  it('discloses the cost and attempted-only meaning, and never starts a stopped chat', async () => {
    await show()
    await openInbox()
    const text = wakeRegion().textContent ?? ''
    expect(text).toContain('No wake allowed')
    expect(text).toContain('may spend model tokens')
    expect(text).toContain('one fixed, trusted reminder')
    expect(text).toContain('does not prove the agent read or processed anything')
    expect(text).toContain('It never starts a stopped chat')
    expect(text).toContain('can be used up without waking it; allow another then')
    expect(text).toContain('This window has not seen this chat’s terminal running; if it is stopped, nothing here starts it.')
    fireEvent.click(wakeButton())
    await settle()
    expect(terminals.calls).toEqual([])
  })

  it('arms one credit per click with the shown revision and a fresh nonce; a double click asks once', async () => {
    await show()
    await openInbox()
    fireEvent.click(wakeButton())
    fireEvent.click(wakeButton())
    await settle()
    const calls = wakeCalls() as { expectedRevision: number; requestNonce: string }[]
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ folder: '/a', chatId: 'chat_a', expectedRevision: 0 })
    expect(calls[0].requestNonce).toMatch(/^[A-Za-z0-9._:-]{1,128}$/)
    expect(wakeRegion().textContent).toContain('Wake allowed')
    expect(wakeButton().getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(wakeButton())
    await settle()
    expect(wakeCalls()).toHaveLength(1)
  })

  it('reports a wake request that never answers and reads the wake again, so it shows as it now stands', async () => {
    vi.spyOn(mail, 'allowWake').mockRejectedValueOnce(new Error('ipc closed'))
    await show()
    await openInbox()
    mail.put({ folder: '/a', chatId: 'chat_a', wake: { revision: 1, armed: true, armedAt: '2026-11-15T11:30:00.000Z', lastAttempt: null } })
    fireEvent.click(wakeButton())
    await settle()
    expect(within(dialog()).getByRole('alert').textContent).toBe('No wake was allowed: The app did not answer.')
    expect(mail.calls.at(-1)).toEqual({ method: 'state', args: [{ folder: '/a', chatId: 'chat_a' }] })
    expect(wakeRegion().textContent).toContain('Wake allowed')
  })
})

describe('AgentInbox: one inbox wake stays one', () => {
  it('cannot be re-armed by mail, by a consumed credit or by showing the chat again: only another click arms', async () => {
    const mounted = await show()
    await openInbox()
    fireEvent.click(wakeButton())
    await settle()
    act(() => {
      mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 5, pendingCount: 5 }, true)
      mail.put({ folder: '/a', chatId: 'chat_a', wake: { revision: 2, armed: false, armedAt: null, lastAttempt: { id: 'wk_1', at: '2026-11-15T12:00:00.000Z', outcome: 'attempted' } } }, true)
      mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 6, pendingCount: 6 }, true)
    })
    await settle()
    expect(wakeRegion().textContent).toContain('Wake attempted')
    expect(wakeRegion().textContent).toContain('That does not show its agent read or processed anything. No wake is allowed now.')
    mounted.unmount()
    render(inbox())
    await settle()
    await openInbox()
    expect(wakeCalls()).toHaveLength(1)
    fireEvent.click(wakeButton())
    await settle()
    expect(wakeCalls()).toHaveLength(2)
    expect(wakeCalls()[1]).toMatchObject({ expectedRevision: 2 })
  })

  it('reports a stale click as allowing nothing and shows the wake as it now stands', async () => {
    await show()
    await openInbox()
    mail.put({ folder: '/a', chatId: 'chat_a', wake: { revision: 4, armed: true, armedAt: '2026-11-15T11:30:00.000Z', lastAttempt: null } })
    fireEvent.click(wakeButton())
    await settle()
    expect(within(dialog()).getByRole('alert').textContent).toBe('No wake was allowed: The wake changed.')
    expect(wakeRegion().textContent).toContain('Wake allowed')
    expect(wakeButton().getAttribute('aria-disabled')).toBe('true')
  })

  it('disallows a wake once the chat’s mailbox is gone', async () => {
    await show()
    await openInbox()
    act(() => mail.remove('/a', 'chat_a'))
    expect(within(dialog()).getByText('This chat no longer has a mailbox.')).toBeTruthy()
    expect(wakeButton().getAttribute('aria-disabled')).toBe('true')
  })
})
