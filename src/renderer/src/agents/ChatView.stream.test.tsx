// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { assistantText, composer, mountChatView, REF, toolCall, transcript, userMessage } from '../__mocks__/chatViewKit'
import { settle } from '../__mocks__/settle'

afterEach(cleanup)

const assistantMessages = (): HTMLElement[] => screen.queryAllByRole('article', { name: 'Assistant' })

describe('ChatView reopening a chat', () => {
  it('asks for the chat and shows its stored transcript, Markdown rendered', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'Why is CI red?'), assistantText('a1', 'It is the **lockfile**.\n\n- regenerate it')])
    expect(dm.chats.callsOf('open')).toEqual([[REF]])
    expect(transcript().getByText('Why is CI red?')).toBeTruthy()
    expect(transcript().getByText('lockfile').tagName).toBe('STRONG')
    expect(transcript().getByText('regenerate it').tagName).toBe('LI')
  })

  it('says the chat is empty when nothing is stored', async () => {
    await mountChatView([])
    expect(screen.getByText('No messages yet. Write the first one below.')).toBeTruthy()
  })

  it('says it is loading until the transcript arrives', async () => {
    const { gate } = await mountChatView([userMessage('u1', 'hello there')], { holdOpen: true })
    expect(screen.getByText('Loading the conversation…')).toBeTruthy()
    expect(screen.queryByText('hello there')).toBeNull()
    gate?.resolve()
    await settle()
    expect(screen.queryByText('Loading the conversation…')).toBeNull()
    expect(screen.getByText('hello there')).toBeTruthy()
  })

  it('says why a chat could not be opened, and opens it again on request', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'back again')], { openFails: { code: 'not_found', message: 'Chat not found.' } })
    expect(screen.getByRole('alert').textContent).toContain('Chat not found.')
    expect(screen.queryByText('back again')).toBeNull()
    delete dm.chats.failures.open
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(screen.getByText('back again')).toBeTruthy()
    expect(dm.chats.callsOf('open')).toHaveLength(2)
  })
})

describe('ChatView streaming', () => {
  it('renders streamed deltas as one growing message, then the stored text in its place', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'hi')])
    act(() => dm.chats.emit({ type: 'turn', chatId: 'chat_1', running: true }))
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'a1', delta: 'Hel' }))
    expect(assistantMessages()).toHaveLength(1)
    expect(assistantMessages()[0]?.textContent).toContain('Hel')
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'a1', delta: 'lo wor' }))
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'a1', delta: 'ld' }))
    expect(assistantMessages()).toHaveLength(1)
    expect(assistantMessages()[0]?.textContent).toContain('Hello world')
    act(() => dm.chats.emitItem('chat_1', assistantText('a1', 'Hello world!')))
    expect(assistantMessages()).toHaveLength(1)
    expect(assistantMessages()[0]?.textContent).toContain('Hello world!')
  })

  it('keeps a streaming message before the tool call that came after it began', async () => {
    const { dm } = await mountChatView([])
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'a1', delta: 'Let me look' }))
    act(() => dm.chats.emitItem('chat_1', toolCall('t1', { status: 'running', resultSummary: null })))
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'a1', delta: ' at the log.' }))
    const rows = transcript()
      .getAllByRole('listitem')
      .map((row: HTMLElement) => row.textContent ?? '')
    expect(rows[0]).toContain('Let me look at the log.')
    expect(rows[1]).toContain('Bash')
  })

  it('updates a tool call in place as it goes from running to done', async () => {
    const { dm } = await mountChatView([])
    act(() => dm.chats.emitItem('chat_1', toolCall('t1', { status: 'running', resultSummary: null })))
    expect(transcript().getByText('Running')).toBeTruthy()
    act(() => dm.chats.emitItem('chat_1', toolCall('t1', { status: 'completed' })))
    expect(transcript().queryByText('Running')).toBeNull()
    expect(transcript().getAllByText('Done')).toHaveLength(1)
    expect(transcript().getAllByText('Bash')).toHaveLength(1)
  })

})

describe('ChatView live items and other chats', () => {
  it('ignores what other chats push', async () => {
    const { dm } = await mountChatView([])
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'elsewhere', itemId: 'a1', delta: 'not here' }))
    act(() => dm.chats.emitItem('elsewhere', assistantText('a2', 'nor here')))
    act(() => dm.chats.emit({ type: 'turn', chatId: 'elsewhere', running: true }))
    expect(assistantMessages()).toHaveLength(0)
    expect(composer().disabled).toBe(false)
  })

  it('keeps what was pushed while the transcript was loading, once, on top of the stored items', async () => {
    const { dm, gate } = await mountChatView([userMessage('u1', 'before')], { holdOpen: true })
    act(() => dm.chats.emitItem('chat_1', assistantText('a1', 'while loading')))
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'a2', delta: 'streaming' }))
    gate?.resolve()
    await settle()
    expect(transcript().getAllByText('before')).toHaveLength(1)
    expect(transcript().getAllByText('while loading')).toHaveLength(1)
    expect(transcript().getAllByText('streaming')).toHaveLength(1)
  })

  it('shows what the person sent at once, and stops listening to the push channel when it closes', async () => {
    const { dm } = await mountChatView([])
    fireEvent.change(composer(), { target: { value: 'hello agent' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    await settle()
    expect(transcript().getAllByText('hello agent')).toHaveLength(1)
    cleanup()
    expect(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'a1', delta: 'late' })).not.toThrow()
  })
})
