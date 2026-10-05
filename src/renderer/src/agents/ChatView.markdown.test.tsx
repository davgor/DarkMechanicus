// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { assistantText, mountChatView, toolCall, transcript, userMessage } from '../__mocks__/chatViewKit'

afterEach(cleanup)

const HOSTILE = [
  '<script>alert(1)</script>',
  '',
  '<img src=x onerror=alert(1)>',
  '',
  '[click](javascript:alert(1)) and [fine](https://example.com/docs)',
  '',
  '<iframe src="https://evil.example"></iframe>'
].join('\n')

const executable = (root: HTMLElement): number => root.querySelectorAll('script, img, iframe, object, embed, style, [onerror], [onclick]').length

describe('ChatView agent Markdown is not trusted', () => {
  it('shows a stored reply with raw HTML as text and creates no executable element', async () => {
    await mountChatView([assistantText('a1', HOSTILE)])
    const log = screen.getByRole('log', { name: 'Transcript' })
    expect(executable(log)).toBe(0)
    expect(log.textContent).toContain('<script>alert(1)</script>')
    expect(log.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('keeps only the allowed link clickable', async () => {
    await mountChatView([assistantText('a1', HOSTILE)])
    const links = [...screen.getByRole('log', { name: 'Transcript' }).querySelectorAll('a')]
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://example.com/docs'])
  })

  it('does the same for a reply that is still streaming', async () => {
    const { dm } = await mountChatView([])
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'a1', delta: '<script>alert(1)</script> and ' }))
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'a1', delta: '<img src=x onerror=alert(1)>' }))
    const log = screen.getByRole('log', { name: 'Transcript' })
    expect(executable(log)).toBe(0)
    expect(log.textContent).toContain('<script>alert(1)</script> and <img src=x onerror=alert(1)>')
  })

  it('shows the person’s own message, a tool result and an error as plain text too', async () => {
    await mountChatView([
      userMessage('u1', '<script>alert("me")</script>'),
      toolCall('t1', { resultSummary: '<img src=x onerror=alert(2)>', input: { command: '<script>alert(3)</script>' } }),
      { id: 'e1', at: '2026-03-01T10:00:00.000Z', kind: 'error', message: '<iframe src="https://evil.example"></iframe>' }
    ])
    fireEvent.click(within(screen.getByRole('listitem', { name: 'Tool call: Bash' })).getByRole('button'))
    const log = screen.getByRole('log', { name: 'Transcript' })
    expect(executable(log)).toBe(0)
    expect(transcript().getByText('<script>alert("me")</script>')).toBeTruthy()
    expect(transcript().getByText('<img src=x onerror=alert(2)>')).toBeTruthy()
    expect(transcript().getByText('<iframe src="https://evil.example"></iframe>')).toBeTruthy()
  })
})
