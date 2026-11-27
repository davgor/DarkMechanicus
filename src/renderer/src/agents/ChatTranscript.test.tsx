// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDLE_STOP_CODE, type ChatItem } from '../../../shared/agents/chat'
import { mailEntry } from '../__mocks__/fakeChatMail'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { COPIED_MS, CopyContext } from '../agentChat/CopyButton'
import type { MailLine } from '../agentChat/useAgentChat'
import { ChatTranscript } from './ChatTranscript'
import { RevealThreadContext } from './revealThread'

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

const REPLY = '**Done** — run `npm test`'

/** The transcript over a clipboard that records what it is given, timed by a manual scheduler. */
function showCopyable(entries: ChatItem[]): { log: HTMLElement; written: string[]; scheduler: ManualScheduler } {
  const written: string[] = []
  const scheduler = new ManualScheduler()
  const writeText = (text: string): Promise<void> => {
    written.push(text)
    return Promise.resolve()
  }
  render(
    <CopyContext.Provider value={{ writeText, scheduler }}>
      <ChatTranscript agentName="Claude Code" folder="/repo" entries={entries} />
    </CopyContext.Provider>
  )
  return { log: screen.getByRole('log', { name: 'Transcript' }), written, scheduler }
}

/** Clicks a Copy, then lets the clipboard's promise settle. */
async function copy(button: HTMLElement): Promise<void> {
  fireEvent.click(button)
  await act(async () => { await Promise.resolve() })
}

describe('ChatTranscript: Copy', () => {
  it("copies an agent reply's raw Markdown, not its rendered text, and reads Copied for 1.5 s", async () => {
    const { log, written, scheduler } = showCopyable([{ id: 'a', at: AT, kind: 'assistant_text', text: REPLY }])
    const reply = within(log).getByRole('article', { name: 'Assistant' })
    expect(reply.textContent).not.toContain('**')
    const button = within(reply.closest('li')!).getByRole('button', { name: 'Copy' })
    expect(button.closest('.chat-msg-actions')).not.toBe(null)

    await copy(button)

    expect(written).toEqual([REPLY])
    expect(button.textContent).toBe('Copied')
    expect(scheduler.timeouts()).toEqual([COPIED_MS])
    act(() => scheduler.fireTimeouts(1_500))
    expect(button.textContent).toBe('Copy')
  })

  it("copies the person's message as they wrote it, from their bubble", async () => {
    const { log, written } = showCopyable([{ id: 'u', at: AT, kind: 'user_message', text: 'Fix **the** build\n  then test' }])
    const bubble = within(log).getByRole('article', { name: 'You' })

    await copy(within(bubble.closest('li')!).getByRole('button', { name: 'Copy' }))

    expect(written).toEqual(['Fix **the** build\n  then test'])
  })

  it("copies only a reply's code block when its own Copy is used", async () => {
    const { log, written } = showCopyable([{ id: 'a', at: AT, kind: 'assistant_text', text: 'Run:\n\n```sh\nnpm test\n```' }])
    const block = log.querySelector('.md-code-block') as HTMLElement

    await copy(within(block).getByRole('button', { name: 'Copy' }))

    expect(written).toEqual(['npm test'])
  })
})

describe('ChatTranscript: the reading layout', () => {
  it('puts the person in a right-aligned bubble and the agent in plain text, with no speaker label shown', () => {
    const { log } = showCopyable([
      { id: 'u', at: AT, kind: 'user_message', text: 'Fix the build' },
      { id: 'a', at: AT, kind: 'assistant_text', text: REPLY }
    ])
    const user = within(log).getByRole('article', { name: 'You' })
    const assistant = within(log).getByRole('article', { name: 'Assistant' })

    expect(user.className).toBe('chat-bubble')
    expect(user.closest('li')?.className).toBe('chat-msg chat-msg-user')
    expect(assistant.className).toBe('')
    expect(assistant.closest('li')?.className).toBe('chat-msg chat-msg-assistant')
    expect(log.querySelectorAll('.chat-msg-who:not(.sr-only)').length).toBe(0)
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
  it('shows a subagent under the call that started it, and its own items once opened; a legacy thread is a Servitor, not its label', () => {
    const log = show([
      { id: 'spawn', at: AT, kind: 'tool_call', name: 'Task', input: { description: 'Work DM-9' }, status: 'completed', resultSummary: null },
      { id: 'th', at: AT, kind: 'thread', parentItemId: 'spawn', label: 'Worker DM-9', state: 'done' },
      { id: 'inner', at: AT, kind: 'assistant_text', text: 'Inside the worker', threadId: 'th' }
    ])

    const thread = within(log).getByRole('listitem', { name: 'Thread: Servitor-1' })
    expect(within(log).queryByText('Inside the worker')).toBe(null)
    expect(within(log).queryByText('Worker DM-9')).toBe(null)
    fireEvent.click(within(thread).getByRole('button', { name: /Servitor-1/ }))
    expect(within(thread).getByText('Inside the worker')).toBeTruthy()
  })

  it('opens every block on a RevealThreadContext path, through the memoized rows', () => {
    const entries: ChatItem[] = [
      { id: 'spawn', at: AT, kind: 'tool_call', name: 'Task', input: { description: 'Outer' }, status: 'running', resultSummary: null },
      { id: 'outer', at: AT, kind: 'thread', parentItemId: 'spawn', label: 'Outer worker', state: 'running' },
      { id: 'spawn-in', at: AT, kind: 'tool_call', threadId: 'outer', name: 'Task', input: { description: 'Inner' }, status: 'running', resultSummary: null },
      { id: 'inner', at: AT, kind: 'thread', threadId: 'outer', parentItemId: 'spawn-in', label: 'Inner reviewer', state: 'running' },
      { id: 'deep', at: AT, kind: 'assistant_text', text: 'Inside the reviewer', threadId: 'inner' }
    ]
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const reveal = { path: new Set(['outer', 'inner']), target: 'inner', nonce: 1, handled: new Map<string, number>() }
    const view = render(
      <RevealThreadContext.Provider value={reveal}>
        <ChatTranscript agentName="Claude Code" folder="/repo" entries={entries} />
      </RevealThreadContext.Provider>
    )
    const outer = screen.getByRole('listitem', { name: 'Thread: Servitor-1' })
    const inner = within(outer).getByRole('listitem', { name: 'Thread: Servitor-2' })
    expect(within(outer).getAllByRole('button', { name: /Servitor-1/ })[0].getAttribute('aria-expanded')).toBe('true')
    expect(within(inner).getByRole('button', { name: /Servitor-2/ }).getAttribute('aria-expanded')).toBe('true')
    expect(within(inner).getByText('Inside the reviewer')).toBeTruthy()
    expect(inner.getAttribute('data-thread-id')).toBe('inner')
    expect(scroll.mock.contexts).toEqual([inner])
    view.rerender(
      <RevealThreadContext.Provider value={{ ...reveal }}>
        <ChatTranscript agentName="Claude Code" folder="/repo" entries={entries} />
      </RevealThreadContext.Provider>
    )
    expect(scroll).toHaveBeenCalledTimes(1)
    delete (Element.prototype as Partial<Element>).scrollIntoView
  })
})

describe('ChatTranscript: mail cards', () => {
  const card = (id: string, direction: 'received' | 'sent'): MailLine => ({ kind: 'mail', id: `mail:${id}`, at: AT, mail: mailEntry({ id, direction }) })

  it('places each card before the row the stream put it before, and the rest last, passing on past a nested thread', () => {
    render(<ChatTranscript agentName="Skitarii" folder="/repo" entries={[
      { id: 'u', at: AT, kind: 'user_message', text: 'Plan it' },
      card('first', 'sent'),
      { id: 'spawn', at: AT, kind: 'tool_call', name: 'task', input: {}, status: 'completed', resultSummary: 'ok' },
      card('second', 'received'),
      { id: 'th', at: AT, kind: 'thread', parentItemId: 'spawn', label: 'Worker', state: 'done' },
      { id: 'a', at: AT, kind: 'assistant_text', text: 'Done' },
      card('last', 'received')
    ]} />)
    const rows = [...screen.getByRole('log', { name: 'Transcript' }).querySelectorAll(':scope > ol > li')]
      .map((row) => row.classList.contains('chat-mail') ? row.className.replace('chat-mail chat-mail-', 'mail ') : row.className.split(' ')[0])
    expect(rows).toEqual(['chat-msg', 'mail sent', 'chat-tool', 'chat-thread', 'mail received', 'chat-msg', 'mail received'])
  })
})
