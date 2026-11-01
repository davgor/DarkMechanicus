// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { IDLE_STOP_CODE, type ChatItem } from '../../../shared/agents/chat'
import { ChatTranscript } from './ChatTranscript'

afterEach(cleanup)

const AT = '2026-03-01T10:00:00.000Z'

function show(entries: ChatItem[]): HTMLElement {
  render(<ChatTranscript agentName="Claude Code" folder="/repo" entries={entries} />)
  return screen.getByRole('log', { name: 'Transcript' })
}

const asked: ChatItem = {
  id: 'q',
  at: AT,
  kind: 'approval_request',
  requestId: 'req_1',
  category: 'command',
  tool: 'Bash',
  summary: 'Run npm install',
  input: { command: 'npm install' }
}

describe('ChatTranscript: what was said', () => {
  it('shows what the person wrote as plain text and what the agent wrote as Markdown, never as markup', () => {
    const log = show([
      { id: 'u', at: AT, kind: 'user_message', text: '<b>Fix</b> the build' },
      { id: 'a', at: AT, kind: 'assistant_text', text: '<img src=x onerror="alert(1)"> **Done**' }
    ])

    expect(within(log).getByRole('article', { name: 'You' }).textContent).toContain('<b>Fix</b> the build')
    expect(within(log).getByRole('article', { name: 'Assistant' }).querySelector('strong')?.textContent).toBe('Done')
    expect(log.querySelector('b')).toBe(null)
    expect(log.querySelector('img')).toBe(null)
  })

  it('shows a tool call by its tool, folded until it is opened', () => {
    const log = show([{ id: 't', at: AT, kind: 'tool_call', name: 'Bash', input: { command: 'npm test' }, status: 'completed', resultSummary: 'ok' }])

    const row = within(log).getByRole('listitem', { name: 'Tool call: Bash' })
    expect(within(row).getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('ChatTranscript: approvals are records', () => {
  it('shows a request with the decision stored for it, and nothing to answer', () => {
    const log = show([asked, { id: 'd', at: AT, kind: 'approval_decision', requestId: 'req_1', decision: 'allow_once' }])

    const card = within(log).getByRole('article', { name: 'Approval request: Run a command' })
    expect(within(card).getByText('npm install')).toBeTruthy()
    expect(within(card).getByText('Allowed once')).toBeTruthy()
    expect(within(log).queryByRole('button')).toBe(null)
    expect(within(log).queryByRole('group', { name: 'Answer' })).toBe(null)
  })

  it('shows a request main reported cancelled as cancelled, and one with no decision as not answered', () => {
    const cancelled = show([asked, { id: 'd', at: AT, kind: 'approval_decision', requestId: 'req_1', decision: 'cancelled' }])
    expect(within(cancelled).getByText('Cancelled')).toBeTruthy()
    cleanup()

    const undecided = show([asked])
    expect(within(undecided).getByText('Not answered')).toBeTruthy()
    expect(within(undecided).queryByRole('button')).toBe(null)
  })

  it('words a decision whose request is not in the transcript as a notice', () => {
    const log = show([{ id: 'd', at: AT, kind: 'approval_decision', requestId: 'gone', decision: 'deny' }])

    expect(within(log).getByText('Approval answered: denied.')).toBeTruthy()
  })
})

describe('ChatTranscript: notices and errors', () => {
  it('shows a lost sign-in, a model change, a reset and a stopped turn as notices, with nothing to sign in or retry', () => {
    const log = show([
      { id: 'auth', at: AT, kind: 'auth_required', agent: 'claude', message: 'Please run /login.' },
      { id: 'm1', at: AT, kind: 'model_change', from: null, to: 'opus' },
      { id: 'm2', at: AT, kind: 'model_change', from: 'opus', to: 'sonnet' },
      { id: 'r', at: AT, kind: 'context_reset', reason: 'compact' },
      { id: 's', at: AT, kind: 'turn_stopped' }
    ])

    expect(within(log).getByText('Claude Code was signed out: Please run /login.')).toBeTruthy()
    expect(within(log).getByText('Model set to opus.')).toBeTruthy()
    expect(within(log).getByText('Model changed from opus to sonnet.')).toBeTruthy()
    expect(within(log).getByText('The earlier conversation was compacted.')).toBeTruthy()
    expect(within(log).getByText('You stopped this turn before the agent finished.')).toBeTruthy()
    expect(within(log).queryByRole('button')).toBe(null)
  })

  it('titles a problem with the account and gives its advice, and shows an idle stop as a notice', () => {
    const log = show([
      { id: 'p', at: AT, kind: 'error', message: 'Your account is on hold.', problem: 'account_on_hold' },
      { id: 'i', at: AT, kind: 'error', message: 'The agent was stopped after it sat idle.', code: IDLE_STOP_CODE }
    ])

    const problem = within(log).getByRole('article', { name: 'Account on hold' })
    expect(within(problem).getByText(/Signing in again will not change this/)).toBeTruthy()
    expect(within(log).queryByRole('article', { name: 'Error' })).toBe(null)
    expect(within(log).getByText('The agent was stopped after it sat idle.').closest('li')?.className).toBe('chat-notice')
  })

  it('titles any other failure Error, with its code and no advice', () => {
    const log = show([{ id: 'e', at: AT, kind: 'error', message: 'The CLI crashed.', code: 'process_exit' }])

    const error = within(log).getByRole('article', { name: 'Error' })
    expect(error.querySelector('.chat-error-text')?.textContent).toBe('The CLI crashed.')
    expect(error.querySelector('.chat-error-code')?.textContent).toBe('process_exit')
    expect(error.querySelector('.chat-error-advice')).toBe(null)
  })
})

describe('ChatTranscript: subagent threads', () => {
  it('shows a subagent under the call that started it, and its own items once opened', () => {
    const log = show([
      { id: 'spawn', at: AT, kind: 'tool_call', name: 'Task', input: { description: 'Work DM-9' }, status: 'completed', resultSummary: null },
      { id: 'th', at: AT, kind: 'thread', parentItemId: 'spawn', label: 'Worker DM-9', state: 'done' },
      { id: 'inner', at: AT, kind: 'assistant_text', text: 'Inside the worker', threadId: 'th' }
    ])

    const thread = within(log).getByRole('listitem', { name: 'Thread: Worker DM-9' })
    expect(within(log).queryByText('Inside the worker')).toBe(null)
    fireEvent.click(within(thread).getByRole('button', { name: /Worker DM-9/ }))
    expect(within(thread).getByText('Inside the worker')).toBeTruthy()
  })
})
