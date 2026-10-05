// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { assistantText, mountChatView, toolCall, transcript, userMessage } from '../__mocks__/chatViewKit'

afterEach(cleanup)

const AT = '2026-03-01T10:00:00.000Z'

const callRow = (name: string): HTMLElement => screen.getByRole('listitem', { name })

describe('ChatView tool calls', () => {
  it('shows each call collapsed, with its name, summary and status, and no result yet', async () => {
    await mountChatView([
      toolCall('t1', { name: 'Bash', input: { command: 'npm test --run' }, resultSummary: 'Exit code 0\n12 passed' }),
      toolCall('t2', { name: 'Edit', input: { file_path: '/src/a.ts' }, status: 'failed', resultSummary: 'Old string not found' })
    ])
    const first = within(callRow('Tool call: Bash'))
    expect(first.getByText('npm test --run')).toBeTruthy()
    expect(first.getByText('Done')).toBeTruthy()
    expect(first.getByRole('button', { name: /Bash/ }).getAttribute('aria-expanded')).toBe('false')
    expect(within(callRow('Tool call: Edit')).getByText('Failed')).toBeTruthy()
    expect(screen.queryByText(/12 passed/)).toBeNull()
    expect(screen.queryByText('Old string not found')).toBeNull()
  })

  it('expands to the input and the result, and collapses again', async () => {
    await mountChatView([toolCall('t1', { input: { command: 'npm test', cwd: '/a' }, resultSummary: 'Exit code 0\n12 passed' })])
    const button = within(callRow('Tool call: Bash')).getByRole('button', { name: /Bash/ })
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const row = within(callRow('Tool call: Bash'))
    expect(row.getByText('cwd')).toBeTruthy()
    expect(row.getByText('/a')).toBeTruthy()
    expect(row.getByText(/12 passed/).textContent).toBe('Exit code 0\n12 passed')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/12 passed/)).toBeNull()
  })

  it('says what a call that has no result yet, or none at all, is waiting for', async () => {
    await mountChatView([
      toolCall('t1', { name: 'Grep', status: 'running', resultSummary: null }),
      toolCall('t2', { name: 'Read', resultSummary: null }),
      toolCall('t3', { name: 'Write', status: 'denied', resultSummary: 'Declined' })
    ])
    fireEvent.click(within(callRow('Tool call: Grep')).getByRole('button'))
    fireEvent.click(within(callRow('Tool call: Read')).getByRole('button'))
    expect(within(callRow('Tool call: Grep')).getByText('Running')).toBeTruthy()
    expect(within(callRow('Tool call: Grep')).getByText('Waiting for the result…')).toBeTruthy()
    expect(within(callRow('Tool call: Read')).getByText('No result was reported.')).toBeTruthy()
    expect(within(callRow('Tool call: Write')).getByText('Denied')).toBeTruthy()
  })
})

const NOTICE_ITEMS: ChatItem[] = [
  { id: 'm1', at: AT, kind: 'model_change', from: 'opus', to: 'sonnet' },
  { id: 'c1', at: AT, kind: 'context_reset', reason: 'compact' },
  { id: 'c2', at: AT, kind: 'context_reset', reason: 'session_lost', message: 'The earlier Claude Code session could not be resumed (gone).' },
  { id: 'e1', at: AT, kind: 'error', message: 'Claude Code is signed out.', code: 'signed_out' },
  { id: 'r1', at: AT, kind: 'approval_request', requestId: 'req', category: 'command', tool: 'Bash', summary: 'Run npm install' },
  { id: 'd1', at: AT, kind: 'approval_decision', requestId: 'req', decision: 'deny' }
]

describe('ChatView notices', () => {
  it('shows model changes, context resets and an answered approval inline, with the model names the agent offers', async () => {
    await mountChatView(NOTICE_ITEMS)
    expect(transcript().getByText('Model changed from Opus to Sonnet. It takes effect from the next turn.')).toBeTruthy()
    expect(transcript().getByText('The earlier conversation was compacted.')).toBeTruthy()
    expect(transcript().getByText('The earlier Claude Code session could not be resumed (gone).')).toBeTruthy()
    const approval = within(transcript().getByRole('article', { name: 'Approval request: Run a command' }))
    expect(approval.getByText('Run npm install')).toBeTruthy()
    expect(approval.getByText('Denied')).toBeTruthy()
  })

  it('shows a stopped turn after the message it stopped, as stored, and when it arrives while the chat is open', async () => {
    const { dm } = await mountChatView([userMessage('u1', 'Please fix it'), { id: 's1', at: AT, kind: 'turn_stopped' }])
    const rows: HTMLElement[] = transcript().getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Please fix it'), 'You stopped this turn before the agent finished.'])

    act(() => dm.chats.emitItem('chat_1', userMessage('u2', 'Try again')))
    act(() => dm.chats.emitItem('chat_1', { id: 's2', at: AT, kind: 'turn_stopped' }))
    expect(transcript().getAllByText('You stopped this turn before the agent finished.')).toHaveLength(2)
  })

  it('shows a tool call that was cancelled as Cancelled, not Running', async () => {
    await mountChatView([toolCall('t1', { name: 'Bash', status: 'cancelled', resultSummary: null })])
    const row = within(callRow('Tool call: Bash'))
    expect(row.getByText('Cancelled')).toBeTruthy()
    expect(row.queryByText('Running')).toBeNull()
  })

  it('shows an error with its reason and code', async () => {
    await mountChatView(NOTICE_ITEMS)
    const error = within(transcript().getByRole('article', { name: 'Error' }))
    expect(error.getByText('Claude Code is signed out.')).toBeTruthy()
    expect(error.getByText('signed_out')).toBeTruthy()
  })

  it('tells the person from the agent', async () => {
    await mountChatView([userMessage('u1', 'Please fix it'), assistantText('a1', 'Done.')])
    expect(within(screen.getByRole('article', { name: 'You' })).getByText('Please fix it')).toBeTruthy()
    expect(within(screen.getByRole('article', { name: 'Assistant' })).getByText('Done.')).toBeTruthy()
  })
})
