// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { assistantText, composer, mountChatView, REF, transcript, userMessage } from '../__mocks__/chatViewKit'
import { settle } from '../__mocks__/settle'

afterEach(cleanup)

const type = (text: string): void => {
  fireEvent.change(composer(), { target: { value: text } })
}

const sendButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Send' })

describe('ChatView composer', () => {
  it('sends on Enter and clears the box, then shows the message', async () => {
    const { dm } = await mountChatView([])
    type('Fix the lockfile')
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await settle()
    expect(dm.chats.callsOf('send')).toEqual([[{ ...REF, text: 'Fix the lockfile' }]])
    expect(composer().value).toBe('')
    expect(transcript().getByText('Fix the lockfile')).toBeTruthy()
  })

  it('sends with the Send button too', async () => {
    const { dm } = await mountChatView([])
    type('Hello')
    fireEvent.click(sendButton())
    await settle()
    expect(dm.chats.callsOf('send')).toEqual([[{ ...REF, text: 'Hello' }]])
  })

  it('keeps Shift+Enter for a new line: it neither sends nor is stopped from adding one', async () => {
    const { dm } = await mountChatView([])
    type('line one')
    const notPrevented = fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true })
    await settle()
    expect(notPrevented).toBe(true)
    expect(dm.chats.callsOf('send')).toEqual([])
    expect(composer().value).toBe('line one')
  })

  it('does not send while an input method is composing', async () => {
    const { dm } = await mountChatView([])
    type('かな')
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true })
    await settle()
    expect(dm.chats.callsOf('send')).toEqual([])
  })

})

describe('ChatView composer limits', () => {
  it('sends nothing for an empty or blank message', async () => {
    const { dm } = await mountChatView([])
    expect(sendButton().disabled).toBe(true)
    type('   \n ')
    expect(sendButton().disabled).toBe(true)
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await settle()
    expect(dm.chats.callsOf('send')).toEqual([])
  })

  it('says why a message was not sent, and puts it back in the box', async () => {
    const { dm } = await mountChatView([])
    dm.chats.failures.send = { code: 'not_found', message: 'Claude Code is not connected.' }
    type('Hello')
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Claude Code is not connected.')
    expect(composer().value).toBe('Hello')
    expect(composer().disabled).toBe(false)
  })
})

describe('ChatView while a turn runs', () => {
  it('disables the input and offers Stop from the moment a message is sent', async () => {
    const { dm } = await mountChatView([])
    type('Go')
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await settle()
    expect(dm.chats.running.has('chat_1')).toBe(true)
    expect(composer().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('calls chats:stop from Stop, and enables the input again once the turn has ended', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'long job')], { running: true })
    expect(composer().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await settle()
    expect(dm.chats.callsOf('stop')).toEqual([[REF]])
    act(() => dm.chats.finishTurn('chat_1'))
    expect(composer().disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(sendButton()).toBeTruthy()
  })

  it('follows the turn the main process reports, however it began', async () => {
    const { dm } = await mountChatView([])
    act(() => dm.chats.emit({ type: 'turn', chatId: 'chat_1', running: true }))
    expect(composer().disabled).toBe(true)
    act(() => dm.chats.emitItem('chat_1', assistantText('a1', 'All done.')))
    act(() => dm.chats.finishTurn('chat_1'))
    expect(composer().disabled).toBe(false)
  })

  it('says why Stop did not work, and stays stoppable', async () => {
    const { dm } = await mountChatView([], { running: true })
    dm.chats.failures.stop = { code: 'internal', message: 'The agent did not answer.' }
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('The agent did not answer.')
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps a half-written message while the turn runs', async () => {
    const { dm } = await mountChatView([])
    type('next question')
    act(() => dm.chats.emit({ type: 'turn', chatId: 'chat_1', running: true }))
    expect(composer().value).toBe('next question')
    expect(composer().disabled).toBe(true)
  })
})
