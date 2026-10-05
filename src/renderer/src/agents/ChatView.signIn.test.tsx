// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import { CHAT, REF, assistantText, composer, mountChatView, userMessage } from '../__mocks__/chatViewKit'
import type { Mounted } from '../__mocks__/chatViewKit'
import { chatRecord } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { SIGN_IN_POLL_MS } from './SignInPrompt'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const AT = '2026-03-01T10:00:00.000Z'
const WORDS = 'Not logged in · Please run /login'
const authRequired = (id = 'auth_1'): ChatItem => ({ id, at: AT, kind: 'auth_required', agent: 'claude', message: WORDS })

const SIGNED_OUT: AgentAuthStatus = { state: 'signed_out', reason: 'Claude Code asked to sign in again.' }
const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Signed in.' }

/** The chat as the main process leaves it after a sign-in cut a turn short. */
const CUT_SHORT = chatRecord({ ...CHAT, cutShortMessageId: 'u1' })
const STUCK: ChatItem[] = [userMessage('u1', 'Fix the build'), authRequired()]

const card = (): ReturnType<typeof within> => within(screen.getByRole('article', { name: 'Signed out of Claude Code' }))
const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }))
}

async function stuck(agentStatus: AgentAuthStatus = SIGNED_OUT): Promise<Mounted> {
  return mountChatView(STUCK, { chat: CUT_SHORT, agentStatus })
}

/** Lets the sign-in prompt's next status check happen. */
async function nextCheck(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)
  })
}

describe('ChatView signed out', () => {
  it('shows the item as a Signed out of Claude Code card with the CLI’s words and Sign in', async () => {
    await stuck()
    expect(card().getByText(WORDS)).toBeTruthy()
    expect(card().getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(card().queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('starts the sign-in of the chat’s agent, naming only the kind', async () => {
    const { dm } = await stuck()
    press('Sign in')
    await settle()
    expect(dm.agentCallsOf('signInAgent')).toEqual([['claude']])
    expect(card().getByText('Sign-in started')).toBeTruthy()
  })

  it('disables the composer with a note while the agent is signed out', async () => {
    await stuck()
    expect(composer().disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Signed out of Claude Code. Sign in above to keep chatting.')).toBeTruthy()
  })

  it('shows a card that arrives while the chat is open, and disables the composer from then on', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'Fix the build')])
    expect(composer().disabled).toBe(false)
    act(() => dm.chats.emitItem('chat_1', authRequired()))
    expect(card().getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(composer().disabled).toBe(true)
  })

  it('follows the main process when it reports the agent signed out, and signed in again', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'Fix the build'), authRequired()], { agentStatus: SIGNED_IN })
    expect(composer().disabled).toBe(false)
    act(() => dm.chats.emit({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_out' }))
    expect(composer().disabled).toBe(true)
    expect(card().getByRole('button', { name: 'Sign in' })).toBeTruthy()
    act(() => dm.chats.emit({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_in' }))
    expect(composer().disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })

  it('says it is checking while the app asks whether the agent is still signed out', async () => {
    const { statusGate } = await mountChatView(STUCK, { chat: CUT_SHORT, agentStatus: SIGNED_OUT, holdAgentStatus: true })
    expect(screen.getByText('Checking whether Claude Code is signed in…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(composer().disabled).toBe(false)
    statusGate?.resolve()
    await settle()
    expect(card().getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })
})

describe('ChatView after signing in', () => {
  it('offers Retry once the status says signed in, and calls chats:retryTurn once', async () => {
    vi.useFakeTimers()
    const { dm } = await stuck()
    press('Sign in')
    await settle()
    dm.agentStatuses.claude = SIGNED_IN
    await nextCheck()
    expect(card().queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(composer().disabled).toBe(false)
    const retry = card().getByRole('button', { name: 'Retry' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    await settle()
    expect(dm.chats.callsOf('retryTurn')).toEqual([[REF]])
  })

  it('tells the shell what the sign-in prompt found, so the Agents list and the badges follow', async () => {
    vi.useFakeTimers()
    const { dm, reported } = await stuck()
    press('Sign in')
    await settle()
    dm.agentStatuses.claude = SIGNED_IN
    await nextCheck()
    expect(reported).toEqual([['claude', SIGNED_IN]])
  })

  it('shows that the turn was retried, and no Retry any more', async () => {
    const { dm } = await stuck(SIGNED_IN)
    expect(composer().disabled).toBe(false)
    press('Retry')
    await settle()
    expect(dm.chats.callsOf('retryTurn')).toEqual([[REF]])
    expect(card().getByText('Turn retried. Claude Code is answering your message again.')).toBeTruthy()
    expect(card().queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(composer().disabled).toBe(true)
    act(() => dm.chats.emitItem('chat_1', assistantText('a1', 'The build is fixed.')))
    act(() => dm.chats.finishTurn('chat_1'))
    expect(card().getByText(/Turn retried/)).toBeTruthy()
    expect(composer().disabled).toBe(false)
  })

  it('offers Retry when the main process reports the sign-in, without the prompt having seen it', async () => {
    const { dm } = await stuck()
    act(() => dm.chats.emit({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_in' }))
    expect(card().getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

})

describe('ChatView sign-in cards as records', () => {
  it('says why a retry was refused, and keeps Retry', async () => {
    const { dm } = await stuck(SIGNED_IN)
    dm.chats.failures.retryTurn = { code: 'conflict', message: 'Claude Code is still signed out. Sign in first.' }
    press('Retry')
    await settle()
    expect(card().getByRole('alert').textContent).toContain('Claude Code is still signed out. Sign in first.')
    expect((card().getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a signed-in chat whose message was already replaced as a record, with nothing to press', async () => {
    await mountChatView([userMessage('u1', 'Fix the build'), authRequired(), userMessage('u2', 'Never mind')], { agentStatus: SIGNED_IN })
    expect(card().getByText(WORDS)).toBeTruthy()
    expect(card().queryByRole('button')).toBeNull()
    expect(composer().disabled).toBe(false)
  })

  it('lets only the latest card act, and keeps the earlier ones as records', async () => {
    const items = [userMessage('u1', 'one'), authRequired('auth_1'), userMessage('u2', 'two'), authRequired('auth_2')]
    await mountChatView(items, { chat: chatRecord({ ...CHAT, cutShortMessageId: 'u2' }), agentStatus: SIGNED_OUT })
    const cards = screen.getAllByRole('article', { name: 'Signed out of Claude Code' })
    expect(cards).toHaveLength(2)
    expect(within(cards[0] as HTMLElement).queryByRole('button')).toBeNull()
    expect(within(cards[1] as HTMLElement).getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })
})
