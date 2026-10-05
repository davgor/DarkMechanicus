// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { ThreadBinding } from '../../../shared/agents/chatApi'
import type { AttemptTimelineView } from '../../../shared/domain/activity'
import type { RunView } from '../../../shared/domain/views'
import { approvalRequest, assistantText, mountChatView, REF, toolCall, transcript, userMessage } from '../__mocks__/chatViewKit'
import { settle } from '../__mocks__/settle'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const AT = '2026-03-01T10:00:00.000Z'
const RUN = 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb'
const ATTEMPT = 'at_01k8zq4a1b2c3d4e5f6g7h8j9k'
const TICKET = 'tk_01k8zq2m3n4p5q6r7s8t9v0w1x'
const EPIC = 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k'

const spawn = (id: string): ChatItem => toolCall(id, { name: 'Agent', input: { description: 'A worker', prompt: 'Do the ticket.' }, resultSummary: null })
const thread = (id: string, parentItemId: string, label: string, extra: { state?: 'running' | 'done' | 'failed'; threadId?: string } = {}): ChatItem => ({
  id,
  at: AT,
  kind: 'thread',
  parentItemId,
  label,
  state: extra.state ?? 'running',
  ...(extra.threadId === undefined ? {} : { threadId: extra.threadId })
})
const inThread = (item: ChatItem, threadId: string): ChatItem => ({ ...item, threadId }) as ChatItem

const blockOf = (label: string): HTMLElement => transcript().getByRole('listitem', { name: `Thread: ${label}` })

/** An orchestrator chat with two workers: DM-12 asked for something to be written, DM-13 is done. */
const TWO_WORKERS: ChatItem[] = [
  userMessage('u1', 'Run the epic.'),
  spawn('s1'),
  thread('th1', 's1', 'DM-12 worker'),
  inThread(assistantText('a1', 'I will **write** the tests.'), 'th1'),
  inThread(toolCall('t1', { name: 'Bash', input: { command: 'npm test' } }), 'th1'),
  spawn('s2'),
  thread('th2', 's2', 'DM-13 worker', { state: 'done' }),
  inThread(assistantText('a2', 'Everything passes.'), 'th2'),
  assistantText('a3', 'Both are started.')
]

describe('thread blocks (c1)', () => {
  it('shows each thread collapsed under the call that spawned it, with its label and state', async () => {
    await mountChatView(TWO_WORKERS)

    const first = blockOf('DM-12 worker')
    const second = blockOf('DM-13 worker')
    expect(within(first).getByText('Running')).toBeTruthy()
    expect(within(first).getByRole('button', { name: /DM-12 worker/ }).getAttribute('aria-expanded')).toBe('false')
    expect(within(second).getByText('Done')).toBeTruthy()
    expect(screen.queryByText(/I will/)).toBeNull()
    expect(screen.queryByText('npm test')).toBeNull()
    expect(screen.queryByText('Everything passes.')).toBeNull()

    const order = [...transcript().getAllByRole('listitem')].filter((row) => /Tool call: Agent|Thread: /.test(row.getAttribute('aria-label') ?? ''))
    expect(order.map((row) => row.getAttribute('aria-label'))).toEqual(['Tool call: Agent', 'Thread: DM-12 worker', 'Tool call: Agent', 'Thread: DM-13 worker'])
  })

  it('shows a running thread with an hourglass, and a failed one as failed', async () => {
    await mountChatView([spawn('s1'), thread('th1', 's1', 'Runs'), spawn('s2'), thread('th2', 's2', 'Breaks', { state: 'failed' })])

    expect(within(blockOf('Runs')).getByText('Running')).toBeTruthy()
    expect(blockOf('Runs').querySelector('[data-icon="hourglass"]')).not.toBeNull()
    expect(within(blockOf('Breaks')).getByText('Failed')).toBeTruthy()
    expect(blockOf('Breaks').querySelector('[data-icon="hourglass"]')).toBeNull()
  })

  it('expands to the thread\'s items, in order and rendered like the rest of the chat, and collapses again', async () => {
    await mountChatView(TWO_WORKERS)

    fireEvent.click(within(blockOf('DM-12 worker')).getByRole('button', { name: /DM-12 worker/ }))

    const open = within(blockOf('DM-12 worker'))
    expect(open.getByRole('button', { name: /DM-12 worker/ }).getAttribute('aria-expanded')).toBe('true')
    expect(open.getByText('write').tagName).toBe('STRONG')
    expect(open.getByRole('listitem', { name: 'Tool call: Bash' })).toBeTruthy()
    expect(screen.queryByText('Everything passes.')).toBeNull()
    // The main thread's own message is not inside the block.
    expect(open.queryByText('Both are started.')).toBeNull()
    expect(transcript().getByText('Both are started.')).toBeTruthy()

    fireEvent.click(open.getByRole('button', { name: /DM-12 worker/ }))
    expect(screen.queryByText('npm test')).toBeNull()
  })

  it('nests a thread a subagent started inside its block', async () => {
    await mountChatView([
      spawn('s1'),
      thread('outer', 's1', 'Outer'),
      inThread(spawn('s2'), 'outer'),
      thread('inner', 's2', 'Inner', { threadId: 'outer' }),
      inThread(assistantText('deep', 'Deep work.'), 'inner')
    ])

    fireEvent.click(within(blockOf('Outer')).getByRole('button', { name: /Outer/ }))
    expect(within(blockOf('Outer')).getByRole('listitem', { name: 'Thread: Inner' })).toBeTruthy()
    expect(screen.queryByText('Deep work.')).toBeNull()

    fireEvent.click(within(blockOf('Inner')).getByRole('button', { name: /Inner/ }))
    expect(within(blockOf('Outer')).getByText('Deep work.')).toBeTruthy()
  })
})

describe('thread blocks stream live', () => {
  it('routes the deltas of a thread into it, and the stored text replaces them in place', async () => {
    const { dm } = await mountChatView([spawn('s1'), thread('th1', 's1', 'Worker')])
    fireEvent.click(within(blockOf('Worker')).getByRole('button', { name: /Worker/ }))

    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'n1', delta: 'Writing the ', threadId: 'th1' }))
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'n1', delta: '**tests**', threadId: 'th1' }))

    const messages = within(blockOf('Worker')).getAllByRole('article', { name: 'Assistant' })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.textContent).toContain('Writing the tests')
    expect(screen.getAllByRole('article', { name: 'Assistant' })).toHaveLength(1)

    act(() => dm.chats.emitItem('chat_1', inThread(assistantText('n1', 'Tests written.'), 'th1')))
    expect(within(blockOf('Worker')).getAllByRole('article', { name: 'Assistant' })).toHaveLength(1)
    expect(within(blockOf('Worker')).getByText('Tests written.')).toBeTruthy()
  })

  it('shows what streamed while it was collapsed once it is opened, and follows the thread changing state', async () => {
    const { dm } = await mountChatView([spawn('s1'), thread('th1', 's1', 'Worker')])
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'n1', delta: 'Half done', threadId: 'th1' }))
    expect(screen.queryByText('Half done')).toBeNull()

    act(() => dm.chats.emitItem('chat_1', thread('th1', 's1', 'Worker', { state: 'done' })))
    expect(within(blockOf('Worker')).getByText('Done')).toBeTruthy()

    fireEvent.click(within(blockOf('Worker')).getByRole('button', { name: /Worker/ }))
    expect(within(blockOf('Worker')).getByText('Half done')).toBeTruthy()
  })

  it('shows a call a subagent made as it is stored and again as it finishes', async () => {
    const { dm } = await mountChatView([spawn('s1'), thread('th1', 's1', 'Worker')])
    fireEvent.click(within(blockOf('Worker')).getByRole('button', { name: /Worker/ }))

    act(() => dm.chats.emitItem('chat_1', inThread(toolCall('t1', { name: 'Grep', input: { pattern: 'x' }, status: 'running', resultSummary: null }), 'th1')))
    expect(within(within(blockOf('Worker')).getByRole('listitem', { name: 'Tool call: Grep' })).getByText('Running')).toBeTruthy()
    act(() => dm.chats.emitItem('chat_1', inThread(toolCall('t1', { name: 'Grep', input: { pattern: 'x' } }), 'th1')))
    expect(within(blockOf('Worker')).getAllByRole('listitem', { name: 'Tool call: Grep' })).toHaveLength(1)
    expect(within(blockOf('Worker')).getAllByText('Done').length).toBeGreaterThan(0)
  })
})

describe('approvals inside a thread', () => {
  const asked = (): ChatItem => ({ ...approvalRequest('req_1', { summary: 'Write a.txt' }), threadId: 'th1', threadLabel: 'Summarize a.txt' }) as ChatItem

  it('opens the block that holds a request waiting for an answer, names the thread on the card, and sends the answer', async () => {
    const { dm } = await mountChatView([spawn('s1'), thread('th1', 's1', 'Summarize a.txt'), asked()])

    const block = within(blockOf('Summarize a.txt'))
    expect(block.getByRole('button', { name: /Summarize a.txt/ }).getAttribute('aria-expanded')).toBe('true')
    expect(block.getAllByText('Needs your answer').length).toBeGreaterThan(0)
    const card = within(block.getByRole('article', { name: /Approval request/ }))
    expect(card.getByText(/Summarize a\.txt/)).toBeTruthy()

    fireEvent.click(card.getByRole('button', { name: 'Allow once' }))
    await settle()
    expect(dm.chats.callsOf('answerApproval')).toEqual([[{ ...REF, requestId: 'req_1', decision: 'allow_once' }]])
    expect(within(blockOf('Summarize a.txt')).getByText('Allowed once')).toBeTruthy()
  })

  it('opens a collapsed block when a request arrives in it, and flags the header while one waits', async () => {
    const { dm } = await mountChatView([spawn('s1'), thread('th1', 's1', 'Summarize a.txt')])
    expect(within(blockOf('Summarize a.txt')).getByRole('button', { name: /Summarize a.txt/ }).getAttribute('aria-expanded')).toBe('false')

    act(() => dm.chats.emitItem('chat_1', asked()))

    expect(within(blockOf('Summarize a.txt')).getByRole('button', { name: /Summarize a.txt/ }).getAttribute('aria-expanded')).toBe('true')
    // The person can still close it; the header keeps saying there is a question.
    fireEvent.click(within(blockOf('Summarize a.txt')).getByRole('button', { name: /Summarize a.txt/ }))
    expect(within(blockOf('Summarize a.txt')).getByText('Needs your answer')).toBeTruthy()
  })

  it('keeps a request answerable when its thread was never stored', async () => {
    await mountChatView([{ ...approvalRequest('req_9'), threadId: 'lost', threadLabel: 'Lost subagent' } as ChatItem])

    expect(within(blockOf('Lost subagent')).getByRole('button', { name: 'Allow once' })).toBeTruthy()
  })
})

const BOUND: ThreadBinding = { threadId: 'th1', role: 'worker', kind: 'attempt', attemptId: ATTEMPT, runId: RUN, epicId: EPIC, ticketId: TICKET, ticketKey: 'DM-12' }

describe('bound threads (c3)', () => {
  it('shows the ticket key of a thread bound to an attempt, and opens that ticket\'s Activity tab for the attempt', async () => {
    const { links } = await mountChatView(TWO_WORKERS, { bindings: [BOUND] })

    const link = within(blockOf('DM-12 worker')).getByRole('button', { name: /DM-12.*Activity/ })
    expect(link.textContent).toContain('DM-12')
    expect(within(blockOf('DM-13 worker')).queryByRole('button', { name: /Activity/ })).toBeNull()

    fireEvent.click(link)
    expect(links.tickets).toEqual([{ epicId: EPIC, ticketId: TICKET, attemptId: ATTEMPT }])
    // Following the link does not expand or collapse the block.
    expect(within(blockOf('DM-12 worker')).getByRole('button', { name: /DM-12 worker/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('finds the key itself when the main process could not resolve it', async () => {
    const unresolved: ThreadBinding = { ...BOUND, runId: null, epicId: null, ticketId: null, ticketKey: null }
    const mounted = await mountChatView([], { bindings: [unresolved] })
    mounted.dm.handlers.getAttemptTimeline = () => ({ attemptId: ATTEMPT, runId: RUN, ticketId: TICKET }) as unknown as AttemptTimelineView
    mounted.dm.handlers.getRun = () => ({ id: RUN, epicId: EPIC, tickets: [{ ticketId: TICKET, key: 'DM-12' }] }) as unknown as RunView
    TWO_WORKERS.forEach((item) => act(() => mounted.dm.chats.emitItem('chat_1', item)))
    await settle()

    fireEvent.click(within(blockOf('DM-12 worker')).getByRole('button', { name: /DM-12.*Activity/ }))
    expect(mounted.links.tickets).toEqual([{ epicId: EPIC, ticketId: TICKET, attemptId: ATTEMPT }])
  })

  it('names the attempt without a link while its ticket is unknown, and shows the key without a link when the view has nowhere to go', async () => {
    await mountChatView(TWO_WORKERS, { bindings: [{ ...BOUND, runId: null, epicId: null, ticketId: null, ticketKey: null }] })
    expect(within(blockOf('DM-12 worker')).queryByRole('button', { name: /Activity/ })).toBeNull()
    expect(within(blockOf('DM-12 worker')).getByText('Attempt')).toBeTruthy()
    cleanup()

    await mountChatView(TWO_WORKERS, { bindings: [BOUND], noNavigation: true })
    expect(within(blockOf('DM-12 worker')).queryByRole('button', { name: /Activity/ })).toBeNull()
    expect(within(blockOf('DM-12 worker')).getByText('DM-12')).toBeTruthy()
  })

  it('reads the bindings once the chat is shown and again when a thread or a Dark Mechanicus answer arrives, not for streaming text', async () => {
    const { dm } = await mountChatView([spawn('s1'), thread('th1', 's1', 'Worker')], { bindings: [] })
    expect(dm.chats.callsOf('threadBindings')).toEqual([[REF]])

    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'n1', delta: 'x', threadId: 'th1' }))
    act(() => dm.chats.emitItem('chat_1', toolCall('t1', { name: 'Bash' })))
    await settle()
    expect(dm.chats.callsOf('threadBindings')).toHaveLength(1)

    dm.chats.bindings.chat_1 = [BOUND]
    act(() => dm.chats.emitItem('chat_1', thread('th9', 's1', 'Another worker')))
    await settle()
    expect(dm.chats.callsOf('threadBindings')).toHaveLength(2)
    expect(within(blockOf('Worker')).getByRole('button', { name: /DM-12.*Activity/ })).toBeTruthy()

    act(() => dm.chats.emitItem('chat_1', toolCall('c1', { name: 'mcp__darkmechanicus__claim_ticket', input: {}, resultSummary: 'ok' })))
    await settle()
    expect(dm.chats.callsOf('threadBindings')).toHaveLength(3)
  })
})

describe('opening a chat at a thread', () => {
  const NESTED: ChatItem[] = [
    spawn('s1'),
    thread('outer', 's1', 'Outer'),
    inThread(spawn('s2'), 'outer'),
    thread('inner', 's2', 'Inner', { threadId: 'outer' }),
    inThread(assistantText('deep', 'Deep work.'), 'inner'),
    spawn('s3'),
    thread('other', 's3', 'Other')
  ]

  it('opens the thread and every thread above it, scrolls it into view and says it took the request', async () => {
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.getAttribute('aria-label') ?? '')
    }

    const { links } = await mountChatView(NESTED, { landing: { threadId: 'inner' } })

    expect(within(blockOf('Outer')).getByRole('button', { name: /Outer/ }).getAttribute('aria-expanded')).toBe('true')
    expect(within(blockOf('Inner')).getByRole('button', { name: /Inner/ }).getAttribute('aria-expanded')).toBe('true')
    expect(within(blockOf('Inner')).getByText('Deep work.')).toBeTruthy()
    expect(within(blockOf('Other')).getByRole('button', { name: /Other/ }).getAttribute('aria-expanded')).toBe('false')
    expect(scrolled).toEqual(['Thread: Inner'])
    expect(links.landed).toBe(1)
  })

  it('does not open anything for a thread the chat does not have, and opens nothing without a request', async () => {
    const { links } = await mountChatView(NESTED, { landing: { threadId: 'nowhere' } })
    expect(within(blockOf('Outer')).getByRole('button', { name: /Outer/ }).getAttribute('aria-expanded')).toBe('false')
    expect(links.landed).toBe(1)
    cleanup()

    const none = await mountChatView(NESTED)
    expect(within(blockOf('Outer')).getByRole('button', { name: /Outer/ }).getAttribute('aria-expanded')).toBe('false')
    expect(none.links.landed).toBe(0)
  })
})
