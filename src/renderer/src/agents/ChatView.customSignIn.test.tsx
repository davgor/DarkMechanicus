// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import type { BoundFunctions, queries } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import { CHAT, REF, assistantText, composer, mountChatView, userMessage } from '../__mocks__/chatViewKit'
import type { Mounted } from '../__mocks__/chatViewKit'
import { chatRecord } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'

afterEach(cleanup)

const CUSTOM_ID = 'cu_01m65kwqqeyajbj5bnq81gngrb'
const AT = '2026-03-01T10:00:00.000Z'
const WORDS = 'My Claude is signed out. Sign in, then retry.'
const UNCHECKED: AgentAuthStatus = { state: 'unchecked', reason: 'Dark Mechanicus cannot check the sign-in of a custom CLI.' }
const OUTSIDE = 'Sign in to My Claude outside the app, then Retry.'

const authRequired = (cutShort?: boolean): ChatItem => ({ id: 'auth_1', at: AT, kind: 'auth_required', agent: CUSTOM_ID, message: WORDS, ...(cutShort === undefined ? {} : { cutShort }) })
const CUSTOM_CHAT = chatRecord({ ...CHAT, agent: CUSTOM_ID, model: null })

/** Scope type for one part of the screen. */
type Scope = BoundFunctions<typeof queries>

const card = (): Scope => within(screen.getByRole('article', { name: 'Signed out of My Claude' }))

/** A custom agent's chat that is open when its CLI says the sign-in is gone. */
async function signedOutLive(cutShort?: boolean): Promise<Mounted> {
  const mounted = await mountChatView([userMessage('u1', 'Fix the build')], { chat: CUSTOM_CHAT, agentStatus: UNCHECKED, agentDisplayName: 'My Claude' })
  act(() => mounted.dm.chats.emitItem('chat_1', authRequired(cutShort)))
  return mounted
}

describe('ChatView: a custom agent signed out', () => {
  it('has no Sign in button, and says to sign in outside the app, then Retry', async () => {
    await signedOutLive(true)
    expect(card().getByText(WORDS)).toBeTruthy()
    expect(card().queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(card().getByText(OUTSIDE)).toBeTruthy()
    expect(card().getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByText('Signed out of My Claude. Sign in above to keep chatting.')).toBeTruthy()
  })

  it('sends the cut-short message again from Retry, once, and says the turn was retried', async () => {
    const { dm } = await signedOutLive(true)
    dm.chats.chats = [chatRecord({ ...CUSTOM_CHAT, cutShortMessageId: 'u1' })]
    const retry = card().getByRole('button', { name: 'Retry' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    await settle()
    expect(dm.chats.callsOf('retryTurn')).toEqual([[REF]])
    expect(card().getByText('Turn retried. My Claude is answering your message again.')).toBeTruthy()
    expect(card().queryByRole('button')).toBeNull()
    act(() => dm.chats.emitItem('chat_1', assistantText('a1', 'Fixed.')))
    act(() => dm.chats.finishTurn('chat_1'))
    expect(composer().disabled).toBe(false)
  })

  it('says why a retry was refused and keeps Retry', async () => {
    const { dm } = await signedOutLive(true)
    dm.chats.failures.retryTurn = { code: 'internal', message: 'The CLI did not start.' }
    fireEvent.click(card().getByRole('button', { name: 'Retry' }))
    await settle()
    expect(card().getByRole('alert').textContent).toContain('The CLI did not start.')
    expect((card().getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false)
  })

})

describe('ChatView: a custom agent no longer connected', () => {
  it('names it generically on the signed-out card and the composer line', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'Fix the build')], { chat: CUSTOM_CHAT, agentStatus: UNCHECKED })
    act(() => dm.chats.emitItem('chat_1', authRequired(true)))
    expect(screen.getByRole('article', { name: 'Signed out of Custom agent' })).toBeTruthy()
    expect(screen.getByText('Signed out of Custom agent. Sign in above to keep chatting.')).toBeTruthy()
  })
})

describe('ChatView: a custom agent’s Retry without a cut-short turn, and after reopening', () => {
  it('lets the chat go on from Retry when no turn was cut short, without asking main to resend anything', async () => {
    const { dm } = await signedOutLive(false)
    expect(composer().disabled).toBe(true)
    fireEvent.click(card().getByRole('button', { name: 'Retry' }))
    await settle()
    expect(dm.chats.callsOf('retryTurn')).toEqual([])
    expect(card().queryByRole('button')).toBeNull()
    expect(composer().disabled).toBe(false)
  })

  it('offers the same outside-the-app Retry in a chat opened after the sign-in was lost', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'Fix the build'), authRequired(true)], {
      chat: chatRecord({ ...CUSTOM_CHAT, cutShortMessageId: 'u1' }),
      agentStatus: UNCHECKED,
      agentDisplayName: 'My Claude'
    })
    expect(card().queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(card().getByText(OUTSIDE)).toBeTruthy()
    fireEvent.click(card().getByRole('button', { name: 'Retry' }))
    await settle()
    expect(dm.chats.callsOf('retryTurn')).toEqual([[REF]])
  })
})
