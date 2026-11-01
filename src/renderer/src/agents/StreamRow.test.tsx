// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { TranscriptEntry } from './chatViewModel'
import { StreamApproval, StreamBody } from './StreamRow'
import { streamRows, type StreamRow } from './threadStream'

afterEach(cleanup)

const AT = '2026-03-01T10:00:00.000Z'

/** The one row a single entry becomes in the chat's own thread. */
function rowOf(entry: TranscriptEntry): Exclude<StreamRow, { kind: 'approval' }> {
  const [row] = streamRows([entry], null)
  if (row === undefined || row.kind === 'approval') {
    throw new Error('Expected a row that is not an approval.')
  }
  return row
}

const call = (patch: Partial<Extract<ChatItem, { kind: 'tool_call' }>>): ChatItem => ({
  id: 'c',
  at: AT,
  kind: 'tool_call',
  name: 'Bash',
  input: { command: 'npm test' },
  status: 'completed',
  resultSummary: 'ok',
  ...patch
})

describe('StreamBody', () => {
  it('shows what a person wrote as plain text, who wrote it, and what the agent wrote as Markdown', () => {
    const { container, rerender } = render(<StreamBody row={rowOf({ id: 'u', at: AT, kind: 'user_message', text: '<b>Run</b> it' })} />)
    expect(screen.getByText('You')).toBeTruthy()
    expect(screen.getByText('<b>Run</b> it').tagName).toBe('P')
    expect(container.querySelector('b')).toBe(null)

    rerender(<StreamBody row={rowOf({ id: 'a', at: AT, kind: 'assistant_text', text: 'Some `code`' })} />)
    expect(screen.getByText('Assistant')).toBeTruthy()
    expect(container.querySelector('.md code')?.textContent).toBe('code')
  })

  it('shows a call by its tool, the input that says what it does and its status; a Dark Mechanicus call by what it did alone', () => {
    const { container, rerender } = render(<StreamBody row={rowOf(call({}))} />)
    expect(screen.getByText('Bash')).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()

    rerender(<StreamBody row={rowOf(call({ name: 'mcp__darkmechanicus__submit_attempt', input: { attemptId: 'x' }, resultSummary: '{"key":"DM-7"}' }))} />)
    expect(screen.getByText('submitted DM-7')).toBeTruthy()
    expect(container.querySelector('.ts-summary')).toBe(null)
  })

  it('shows a subagent by its label and state, with an hourglass while it works', () => {
    const running: ChatItem = { id: 't', at: AT, kind: 'thread', parentItemId: 'p', label: 'Worker DM-9', state: 'running' }
    const { container, rerender } = render(<StreamBody row={rowOf(running)} />)
    expect(screen.getByText('Worker DM-9')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    expect(container.querySelector('.chat-hourglass')).not.toBe(null)

    rerender(<StreamBody row={rowOf({ ...running, state: 'done' })} />)
    expect(screen.getByText('Done')).toBeTruthy()
    expect(container.querySelector('.chat-hourglass')).toBe(null)
  })

  it('shows an error as plain text', () => {
    render(<StreamBody row={rowOf({ id: 'e', at: AT, kind: 'error', message: 'The <agent> stopped' })} />)

    expect(screen.getByText('The <agent> stopped').tagName).toBe('P')
  })
})

describe('StreamApproval', () => {
  it('shows an approval of an old chat as a record with its stored decision, and offers nothing to answer', () => {
    const asked: ChatItem = { id: 'r', at: AT, kind: 'approval_request', requestId: 'q1', category: 'command', tool: 'Bash', summary: 'Run it', input: { command: 'npm test' } }
    const answered: ChatItem = { id: 'd', at: AT, kind: 'approval_decision', requestId: 'q1', decision: 'allow_once' }
    const cancelled: ChatItem = { id: 'd', at: AT, kind: 'approval_decision', requestId: 'q1', decision: 'cancelled' }
    const approvalOf = (items: ChatItem[]): Extract<StreamRow, { kind: 'approval' }> => {
      const [row] = streamRows(items, null)
      if (row?.kind !== 'approval') throw new Error('Expected an approval row.')
      return row
    }
    const show = (row: Extract<StreamRow, { kind: 'approval' }>): JSX.Element => (
      <StreamApproval row={row} entry={{ at: row.at, row, stream: { rows: [row], error: null, folder: '/a' } }} />
    )

    const { rerender } = render(show(approvalOf([asked, answered])))
    expect(screen.getByRole('article', { name: /^Approval request/ })).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()
    expect(screen.getByText('Allowed once')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()

    rerender(show(approvalOf([asked, cancelled])))
    expect(screen.getByText('Cancelled')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
