// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { BoundThread } from '../../../shared/agents/chatApi'
import type { ActivityEntry, AttemptTimelineView } from '../../../shared/domain/activity'
import { FakeDm } from '../__mocks__/fakeDm'
import { chatRecord } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { attempt } from '../epic/__mocks__/fixtures'
import { ActivityTab } from './ActivityTab'

let dm: FakeDm
let scheduler: ManualScheduler
let pages: AttemptTimelineView[]
let opened: [string, string | undefined][]

const ATTEMPT = 'at_202_2'
const FOLDER = '/repo'
const BASE = { sessionId: 'ss_w', attemptId: ATTEMPT, ticketId: 'tk_202' }

const WORKER: BoundThread = { folder: FOLDER, chatId: 'chat_o', threadId: 'th_1', role: 'worker' }
const ORCHESTRATOR: BoundThread = { folder: FOLDER, chatId: 'chat_o', threadId: null, role: 'orchestrator' }

function minute(value: number): string {
  return `2026-09-30T11:${String(value).padStart(2, '0')}:00.000Z`
}

function claim(): ActivityEntry {
  const worker = { label: 'worker-a', modelId: 'model-large', hostId: 'claude-code', effort: null, rationale: null }
  return { ...BASE, kind: 'claim', id: 'claim:at_202_2', at: minute(0), number: 2, worker }
}

function note(at: number, text: string): ActivityEntry {
  return { ...BASE, kind: 'note', id: `event:${text}`, at: minute(at), text, step: null }
}

function page(entries: ActivityEntry[], cursor: number): AttemptTimelineView {
  return { attemptId: ATTEMPT, runId: 'rn_2', ticketId: 'tk_202', state: 'running', isLive: true, cursor, entries, sessions: [] }
}

const inThread = (threadId: string | null): { threadId?: string } => (threadId === null ? {} : { threadId })

/** An assistant text in a thread (null: the chat's own thread). */
function said(id: string, at: number, text: string, threadId: string | null = 'th_1'): ChatItem {
  return { id, at: minute(at), kind: 'assistant_text', text, ...inThread(threadId) }
}

function ran(id: string, at: number, command: string, threadId: string | null = 'th_1'): ChatItem {
  return { id, at: minute(at), kind: 'tool_call', name: 'Bash', input: { command }, status: 'completed', resultSummary: 'ok', ...inThread(threadId) }
}

function asked(requestId: string, at: number): ChatItem {
  return {
    id: `item_${requestId}`,
    at: minute(at),
    kind: 'approval_request',
    requestId,
    category: 'command',
    tool: 'Bash',
    summary: 'Run npm install',
    input: { command: 'npm install' },
    threadId: 'th_1',
    threadLabel: 'Worker DM-202'
  }
}

const THREAD: ChatItem = { id: 'th_1', at: minute(1), kind: 'thread', parentItemId: 'spawn', label: 'Worker DM-202', state: 'running' }

/** The orchestrator's chat holding `items`, with the attempt bound to `bound`. */
function seed(items: ChatItem[], bound: BoundThread[] = [ORCHESTRATOR, WORKER]): void {
  dm.chats.chats = [chatRecord({ id: 'chat_o', folder: FOLDER, role: 'orchestrator' })]
  dm.chats.transcripts.chat_o = items
  dm.chats.bound.attempts[ATTEMPT] = bound
}

function serve(...served: AttemptTimelineView[]): void {
  pages = served
  dm.handlers.getAttemptTimeline = () => (pages.length > 1 ? pages.shift() : pages[0])
}

function renderTab(): ReturnType<typeof render> {
  return render(
    <ActivityTab
      folderPath={FOLDER}
      attempts={[attempt('DM-202', 1, 'failed'), attempt('DM-202', 2, 'running')]}
      attemptId={ATTEMPT}
      onChoose={() => undefined}
      onOpenChat={(chatId, threadId) => opened.push([chatId, threadId])}
      scheduler={scheduler}
    />
  )
}

async function poll(): Promise<void> {
  act(() => scheduler.fireIntervals())
  await settle()
}

function rows(): string[] {
  return within(screen.getByRole('log', { name: 'Attempt timeline' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '')
}

beforeEach(() => {
  scheduler = new ManualScheduler()
  opened = []
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

describe('Activity tab of an attempt bound to a chat thread', () => {
  it('shows the thread\'s items among the timeline entries, in time order', async () => {
    seed([THREAD, said('s1', 2, 'Reading the ticket'), ran('r1', 3, 'npm test')])
    serve(page([claim(), note(5, 'Wrote the tests')], 4))
    renderTab()

    await screen.findByText('Reading the ticket')
    await settle()

    const lines = rows()
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('Claimed by worker-a')
    expect(lines[1]).toContain('Reading the ticket')
    expect(lines[2]).toContain('npm test')
    expect(lines[3]).toContain('Wrote the tests')
  })

})

describe('Activity tab following the chat', () => {
  it('opens the chat once and asks for the bound thread of the attempt', async () => {
    seed([THREAD, said('s1', 2, 'Reading')])
    serve(page([claim()], 2))
    renderTab()
    await screen.findByText('Reading')

    expect(dm.chats.callsOf('boundThreads')[0]).toEqual([{ folder: FOLDER, attemptId: ATTEMPT }])
    expect(dm.chats.callsOf('open')).toEqual([[{ folder: FOLDER, chatId: 'chat_o' }]])
  })

  it('adds an item the thread stores while the tab is open, and a text as it is being written', async () => {
    seed([THREAD, said('s1', 2, 'Reading')])
    serve(page([claim(), note(9, 'Late note')], 4))
    renderTab()
    await screen.findByText('Reading')

    act(() => dm.chats.emitItem('chat_o', ran('r2', 4, 'npm run build')))
    expect(await screen.findByText(/npm run build/)).toBeTruthy()
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_o', itemId: 'typing', delta: 'Fixing the', threadId: 'th_1' }))
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_o', itemId: 'typing', delta: ' import', threadId: 'th_1' }))

    const lines = rows()
    expect(lines.map((line) => ['Claimed', 'Reading', 'npm run build', 'Late note', 'Fixing the import'].find((part) => line.includes(part)))).toEqual([
      'Claimed',
      'Reading',
      'npm run build',
      'Late note',
      'Fixing the import'
    ])
  })

  it('shows nothing of the chat outside the thread, or of another chat', async () => {
    seed([THREAD, said('own', 2, 'In the main thread', null), said('other', 2, 'In another thread', 'th_2'), said('mine', 3, 'In my thread')])
    serve(page([claim()], 2))
    renderTab()
    await screen.findByText('In my thread')

    act(() => dm.chats.emit({ type: 'item', chatId: 'chat_elsewhere', item: said('x', 4, 'From another chat') }))

    expect(screen.queryByText('In the main thread')).toBe(null)
    expect(screen.queryByText('In another thread')).toBe(null)
    expect(screen.queryByText('From another chat')).toBe(null)
  })

})

describe('Activity tab choosing the thread to follow', () => {
  it('shows what the agent wrote as text and Markdown, never as markup', async () => {
    seed([THREAD, said('s1', 2, '<img src=x onerror="alert(1)"> **bold**')])
    serve(page([claim()], 2))
    const { container } = renderTab()
    await screen.findByText(/onerror/)

    expect(container.querySelector('img')).toBe(null)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
  })

  it('follows the thread of a worker that is a whole chat, by its main thread', async () => {
    seed([said('main', 2, 'Working in the chat itself', null), said('deeper', 2, 'Inside a subagent', 'th_9')], [{ ...WORKER, threadId: null }])
    serve(page([claim()], 2))
    renderTab()

    expect(await screen.findByText('Working in the chat itself')).toBeTruthy()
    expect(screen.queryByText('Inside a subagent')).toBe(null)
  })

  it('finds the thread when it is bound after the tab opened, as the timeline moves', async () => {
    seed([THREAD, said('s1', 2, 'Reading')], [ORCHESTRATOR])
    serve(page([claim()], 2), page([note(5, 'Heartbeat')], 3))
    renderTab()
    await screen.findByText('Claimed by worker-a')
    expect(screen.queryByText('Reading')).toBe(null)

    dm.chats.bound.attempts[ATTEMPT] = [ORCHESTRATOR, WORKER]
    await poll()

    expect(await screen.findByText('Reading')).toBeTruthy()
    // Asked as the tab opened and as each page of the timeline arrived; never on a timer of its own.
    expect(dm.chats.callsOf('boundThreads')).toHaveLength(3)
  })

  it('stops following the chat when the tab is closed', async () => {
    seed([THREAD, said('s1', 2, 'Reading')])
    serve(page([claim()], 2))
    const view = renderTab()
    await screen.findByText('Reading')
    expect(dm.chats.subscribers()).toBe(1)

    view.unmount()

    expect(dm.chats.subscribers()).toBe(0)
  })

  it('keeps the timeline when the chat cannot be read, and says so', async () => {
    seed([THREAD])
    dm.chats.failures.open = { code: 'not_found', message: 'Chat not found.' }
    serve(page([claim()], 2))
    renderTab()

    expect(await screen.findByText('Claimed by worker-a')).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toBe('Chat not found.')
  })
})

describe('Activity tab Open chat link', () => {
  it('opens the chat with the thread expanded', async () => {
    seed([THREAD, said('s1', 2, 'Reading')])
    serve(page([claim()], 2))
    renderTab()
    await screen.findByText('Reading')

    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }))

    expect(opened).toEqual([['chat_o', 'th_1']])
  })

  it('opens the chat itself when the worker is the whole chat', async () => {
    seed([said('main', 2, 'Working', null)], [{ ...WORKER, threadId: null }])
    serve(page([claim()], 2))
    renderTab()
    await screen.findByText('Working')

    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }))

    expect(opened).toEqual([['chat_o', undefined]])
  })
})

describe('Activity tab approvals of the thread', () => {
  it('shows a request the thread waits on and sends the answer', async () => {
    seed([THREAD, asked('req_1', 2)])
    serve(page([claim()], 2))
    renderTab()

    const card = await screen.findByRole('article', { name: 'Approval request: Run a command' })
    expect(within(card).getByText('Needs your answer')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }))
    await settle()

    expect(dm.chats.callsOf('answerApproval')).toEqual([[{ folder: FOLDER, chatId: 'chat_o', requestId: 'req_1', decision: 'allow_once' }]])
    expect(await within(card).findByText('Allowed once')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Allow once' })).toBe(null)
  })

  it('shows why an answer was refused and lets the person try again', async () => {
    seed([THREAD, asked('req_1', 2)])
    dm.chats.failures.answerApproval = { code: 'not_found', message: 'That approval request is no longer waiting for an answer.' }
    serve(page([claim()], 2))
    renderTab()
    const card = await screen.findByRole('article', { name: 'Approval request: Run a command' })

    fireEvent.click(within(card).getByRole('button', { name: 'Deny' }))
    await settle()

    expect(within(card).getByRole('alert').textContent).toBe('That approval request is no longer waiting for an answer.')
    expect((within(card).getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a request that a request raised in the thread was answered by an earlier decision', async () => {
    seed([THREAD, asked('req_1', 2), { id: 'item_answer_req_1', at: minute(3), kind: 'approval_decision', requestId: 'req_1', decision: 'deny', threadId: 'th_1' }])
    serve(page([claim()], 2))
    renderTab()

    const card = await screen.findByRole('article', { name: 'Approval request: Run a command' })

    expect(within(card).getByText('Denied')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Allow once' })).toBe(null)
  })
})

describe('Activity tab of an attempt bound to no chat thread', () => {
  it('is the plain timeline: no chat is opened and there is no Open chat link', async () => {
    seed([THREAD, said('s1', 2, 'Reading')], [])
    serve(page([claim(), note(5, 'Wrote the tests')], 4))
    renderTab()

    await screen.findByText('Wrote the tests')
    await settle()

    expect(rows()).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBe(null)
    expect(screen.queryByText('Reading')).toBe(null)
    expect(dm.chats.callsOf('open')).toEqual([])
    expect(dm.chats.subscribers()).toBe(0)
  })

  it('treats an attempt only its orchestrator touched as unbound', async () => {
    seed([THREAD, said('s1', 2, 'Reading')], [ORCHESTRATOR])
    serve(page([claim()], 2))
    renderTab()

    await screen.findByText('Claimed by worker-a')
    await settle()

    expect(rows()).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBe(null)
    expect(dm.chats.callsOf('open')).toEqual([])
  })

})

describe('Activity tab when the lookup goes wrong', () => {
  it('is just as plain when the lookup cannot be made at all', async () => {
    seed([THREAD], [WORKER])
    dm.chats.boundThreads = () => Promise.reject(new Error('The bridge is down.'))
    serve(page([claim()], 2))
    renderTab()

    await screen.findByText('Claimed by worker-a')
    await settle()

    expect(rows()).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBe(null)
  })

  it('ignores an answer to the lookup that arrives after the tab was closed', async () => {
    seed([THREAD, said('s1', 2, 'Reading')])
    const gate = dm.chats.hold('boundThreads')
    serve(page([claim()], 2))
    const view = renderTab()

    view.unmount()
    gate.resolve()
    await settle()

    expect(dm.chats.callsOf('open')).toEqual([])
    expect(dm.chats.subscribers()).toBe(0)
  })

  it('is just as plain when the lookup fails', async () => {
    seed([THREAD], [WORKER])
    dm.chats.failures.boundThreads = { code: 'internal', message: 'No lookup.' }
    serve(page([claim()], 2))
    renderTab()

    await screen.findByText('Claimed by worker-a')
    await settle()

    expect(rows()).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBe(null)
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBe(null)
  })
})
