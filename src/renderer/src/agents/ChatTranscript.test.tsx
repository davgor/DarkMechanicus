// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDLE_STOP_CODE, type ChatItem } from '../../../shared/agents/chat'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { COPIED_MS, CopyContext } from '../agentChat/CopyButton'
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

const at = (seconds: number): string => new Date(Date.parse(AT) + seconds * 1_000).toISOString()
const call = (id: string, seconds: number): ChatItem =>
  ({ id, at: at(seconds), kind: 'tool_call', name: id, input: { command: id }, status: 'completed', resultSummary: 'ok' })
/** 3 tool calls, an intermediate text, then the final reply 28m 51s after the message. */
const turn: ChatItem[] = [
  { id: 'u', at: at(0), kind: 'user_message', text: 'Fix the build' },
  call('Read', 10),
  { id: 'mid', at: at(20), kind: 'assistant_text', text: 'Looking at the config' },
  call('Edit', 30),
  call('Bash', 40),
  { id: 'final', at: at(1_731), kind: 'assistant_text', text: 'The build passes now.' }
]

function showLive(entries: ChatItem[], status: 'idle' | 'busy'): HTMLElement {
  render(<ChatTranscript agentName="Claude Code" folder="/repo" entries={entries} status={status} />)
  return screen.getByRole('log', { name: 'Transcript' })
}

const toolNames = (root: HTMLElement): string[] =>
  within(root).queryAllByRole('listitem', { name: /^Tool call: / }).map((row) => row.getAttribute('aria-label') ?? '')

describe('ChatTranscript: each ended turn’s work behind one disclosure', () => {
  it('shows one “Worked for” row and the final reply of an idle chat’s turn, with its tool cards hidden', () => {
    const log = showLive(turn, 'idle')

    const toggle = within(log).getByRole('button', { name: /^Worked for 28m 51s/ })
    expect(toggle.textContent).toBe('Worked for 28m 51s›')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toolNames(log)).toEqual([])
    expect(within(log).queryByText('Looking at the config')).toBe(null)
    expect(within(log).getByText('The build passes now.')).toBeTruthy()
    const rows = Array.from(log.querySelectorAll(':scope > ol > li'))
    expect(rows.map((row) => row.className)).toEqual(['chat-msg chat-msg-user', 'chat-work', 'chat-msg chat-msg-assistant'])
  })

  it('reveals the hidden items in their order on a click, and folds them again', () => {
    const log = showLive(turn, 'idle')
    const toggle = within(log).getByRole('button', { name: /^Worked for/ })

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const work = within(log).getByRole('list', { name: 'Work' })
    expect(toggle.getAttribute('aria-controls')).toBe(work.id)
    expect(toolNames(work)).toEqual(['Tool call: Read', 'Tool call: Edit', 'Tool call: Bash'])
    const texts = Array.from(work.querySelectorAll(':scope > li')).map((row) => row.getAttribute('aria-label') ?? row.textContent)
    expect(texts).toEqual(['Tool call: Read', expect.stringContaining('Looking at the config'), 'Tool call: Edit', 'Tool call: Bash'])
    expect(within(work).queryByText('The build passes now.')).toBe(null)

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toolNames(log)).toEqual([])
  })

  it('leaves the live turn of a busy chat open', () => {
    const log = showLive(turn, 'busy')

    expect(within(log).queryByRole('button', { name: /^Worked for/ })).toBe(null)
    expect(toolNames(log)).toEqual(['Tool call: Read', 'Tool call: Edit', 'Tool call: Bash'])
  })
})

describe('ChatTranscript: what a folded turn never hides', () => {
  it('keeps an error and a stop notice visible under a “Stopped after” row', () => {
    const log = showLive([
      { id: 'u', at: at(0), kind: 'user_message', text: 'Run it' },
      call('Bash', 60),
      { id: 'err', at: at(90), kind: 'error', code: 'tool_failed', message: 'Bash failed' },
      { id: 'stop', at: at(182), kind: 'turn_stopped' }
    ], 'idle')

    expect(within(log).getByRole('button', { name: /^Stopped after 3m 02s/ })).toBeTruthy()
    expect(within(log).getByRole('article', { name: 'Error' }).textContent).toContain('Bash failed')
    expect(within(log).getByText('You stopped this turn before the agent finished.')).toBeTruthy()
    expect(toolNames(log)).toEqual([])
  })

  it('opens the turn that holds a thread a RevealThreadContext request names', () => {
    const entries: ChatItem[] = [
      { id: 'u', at: at(0), kind: 'user_message', text: 'Delegate it' },
      { id: 'spawn', at: at(1), kind: 'tool_call', name: 'Task', input: { description: 'Work' }, status: 'completed', resultSummary: null },
      { id: 'th', at: at(2), kind: 'thread', parentItemId: 'spawn', label: 'Worker', state: 'done' },
      { id: 'inner', at: at(3), kind: 'assistant_text', text: 'Inside the worker', threadId: 'th' },
      { id: 'final', at: at(4), kind: 'assistant_text', text: 'Delegated.' }
    ]
    Element.prototype.scrollIntoView = vi.fn()
    render(
      <RevealThreadContext.Provider value={{ path: new Set(['th']), target: 'th', nonce: 1, handled: new Map() }}>
        <ChatTranscript agentName="Claude Code" folder="/repo" entries={entries} status="idle" />
      </RevealThreadContext.Provider>
    )

    expect(screen.getByRole('button', { name: /^Worked for 4s/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Inside the worker')).toBeTruthy()
    delete (Element.prototype as Partial<Element>).scrollIntoView
  })
})
