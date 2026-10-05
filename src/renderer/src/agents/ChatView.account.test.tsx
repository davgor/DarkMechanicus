// @vitest-environment jsdom
import { act, cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem, ErrorProblem } from '../../../shared/agents/chat'
import { composer, mountChatView, transcript, userMessage } from '../__mocks__/chatViewKit'

afterEach(cleanup)

const AT = '2026-03-01T10:00:00.000Z'
const errorItem = (problem: ErrorProblem | undefined, message: string): ChatItem => ({ id: 'e1', at: AT, kind: 'error', message, ...(problem === undefined ? {} : { problem }) })

interface Notice {
  problem: ErrorProblem
  title: string
}

const NOTICES: readonly Notice[] = [
  { problem: 'organization_not_allowed', title: 'Organization not allowed' },
  { problem: 'account_on_hold', title: 'Account on hold' },
  { problem: 'verification_required', title: 'Verification required' }
]

describe.each(NOTICES)('ChatView: an account problem ($problem)', ({ problem, title }) => {
  const WORDS = 'The CLI’s own words about the account.'
  const notice = (): ReturnType<typeof within> => within(transcript().getByRole('article', { name: title }))

  it('shows its own notice: what is wrong, the CLI’s words, and that signing in again does not help', async () => {
    await mountChatView([userMessage('u1', 'go'), errorItem(problem, WORDS)])

    expect(notice().getByText(title)).toBeTruthy()
    expect(notice().getByText(WORDS)).toBeTruthy()
    expect(notice().getByText(/Signing in again will not change this/)).toBeTruthy()
    expect(transcript().queryByRole('article', { name: 'Error' })).toBeNull()
  })

  it('offers no Sign in, no Retry and no signed-out card, and leaves the composer on', async () => {
    await mountChatView([userMessage('u1', 'go'), errorItem(problem, WORDS)])

    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.queryByRole('article', { name: /Signed out of/ })).toBeNull()
    expect(composer().disabled).toBe(false)
  })

  it('shows one that arrives while the chat is open', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'go')])

    act(() => dm.chats.emitItem('chat_1', errorItem(problem, WORDS)))

    expect(notice().getByText(WORDS)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })
})

describe('ChatView: errors that name no problem', () => {
  it('still show as a plain error with the code, as before', async () => {
    await mountChatView([{ id: 'e1', at: AT, kind: 'error', message: 'agent exited', code: 'exit_1' }])

    const error = within(transcript().getByRole('article', { name: 'Error' }))
    expect(error.getByText('agent exited')).toBeTruthy()
    expect(error.getByText('exit_1')).toBeTruthy()
    expect(error.queryByText(/Signing in again/)).toBeNull()
  })
})
