// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { BoundThread } from '../../../shared/agents/chatApi'
import type { ActivityEntry, RunTimelineView } from '../../../shared/domain/activity'
import { FakeChats } from '../__mocks__/fakeChats'
import { chatRecord } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend } from './__mocks__/fakeBackend'
import { fakeOrchestration, type FakeOrchestration } from './__mocks__/fakeOrchestration'
import { folder, iso } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

const SECOND = 1000
const FOLDER = folder().path
const MAIN: BoundThread = { folder: FOLDER, chatId: 'chat_o', threadId: null, role: 'orchestrator' }

let scheduler: ManualScheduler
let chats: FakeChats
let host: FakeOrchestration

beforeAll(() => {
  installDomShims()
})

beforeEach(() => {
  scheduler = new ManualScheduler()
  chats = new FakeChats()
  host = fakeOrchestration()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function started(): ActivityEntry {
  return { kind: 'run', id: 'event:1', at: iso(-60 * SECOND), sessionId: 'ss_orch', change: 'started', reason: null }
}

function submitted(): ActivityEntry {
  return { kind: 'submitted', id: 'event:3', at: iso(-5 * SECOND), sessionId: 'ss_orch', attemptId: 'at_202_1', ticketId: 'tk_202', summary: 'Drawer added' }
}

function timeline(entries: ActivityEntry[], cursor: number): RunTimelineView {
  const group = { session: { id: 'ss_orch', role: 'orchestrator' as const, label: 'Claude Code in chat' }, entries }
  return { runId: 'rn_2', epicId: 'ep_1', state: 'running', isLive: true, cursor, groups: [group] }
}

function said(id: string, secondsAgo: number, text: string, threadId?: string): ChatItem {
  return { id, at: iso(-secondsAgo * SECOND), kind: 'assistant_text', text, ...(threadId === undefined ? {} : { threadId }) }
}

function ran(id: string, secondsAgo: number, command: string): ChatItem {
  return { id, at: iso(-secondsAgo * SECOND), kind: 'tool_call', name: 'Bash', input: { command }, status: 'completed', resultSummary: 'ok' }
}

function asked(requestId: string, secondsAgo: number, threadId?: string): ChatItem {
  return {
    id: `item_${requestId}`,
    at: iso(-secondsAgo * SECOND),
    kind: 'approval_request',
    requestId,
    category: 'command',
    tool: 'Bash',
    summary: 'Run npm install',
    input: { command: 'npm install' },
    ...(threadId === undefined ? {} : { threadId, threadLabel: 'Worker DM-202' })
  }
}

/** The orchestrator's chat holding `items`, bound to run 2 as `bound` says; the run's own entries are `entries`. */
function backendWith(items: ChatItem[], bound: BoundThread[] = [MAIN], entries: ActivityEntry[] = [started(), submitted()]): FakeBackend {
  const backend = new FakeBackend()
  backend.handlers.getRunTimeline = () => timeline(entries, entries.length)
  chats.chats = [chatRecord({ id: 'chat_o', folder: FOLDER, role: 'orchestrator', runId: 'rn_2' })]
  chats.transcripts.chat_o = items
  chats.bound.runs.rn_2 = bound
  backend.chats = chats
  return backend
}

async function openFeed(backend: FakeBackend): Promise<HTMLElement> {
  renderWorkspace(backend, { scheduler, orchestration: host })
  fireEvent.click(await screen.findByRole('button', { name: 'Claude Code in chat' }))
  const feed = await screen.findByRole('region', { name: 'Orchestrator feed' })
  await settle()
  return feed
}

function rows(feed: HTMLElement): string[] {
  return within(within(feed).getByRole('log', { name: 'Run activity' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '')
}

describe('the live feed of a run orchestrated in a chat', () => {
  it('lists the main thread of the chat among the run entries, newest first', async () => {
    const feed = await openFeed(backendWith([said('a', 45, 'Planning the sprint'), ran('r', 20, 'git status'), said('b', 2, 'Waiting on DM-202')]))

    const lines = rows(feed)

    expect(lines).toHaveLength(5)
    expect(lines[0]).toContain('Waiting on DM-202')
    expect(lines[1]).toContain('Submitted')
    expect(lines[2]).toContain('git status')
    expect(lines[3]).toContain('Planning the sprint')
    expect(lines[4]).toContain('Run started')
    expect(chats.callsOf('boundThreads')).toEqual([[{ folder: FOLDER, runId: 'rn_2' }]])
    expect(chats.callsOf('open')).toEqual([[{ folder: FOLDER, chatId: 'chat_o' }]])
  })

  it('adds what the chat stores while the feed is open, and a text as it is being written', async () => {
    const feed = await openFeed(backendWith([said('a', 45, 'Planning the sprint')]))

    act(() => chats.emitItem('chat_o', ran('r2', 1, 'npm run lint')))
    act(() => chats.emit({ type: 'assistant_delta', chatId: 'chat_o', itemId: 'typing', delta: 'Claiming the ' }))
    act(() => chats.emit({ type: 'assistant_delta', chatId: 'chat_o', itemId: 'typing', delta: 'next ticket' }))

    const lines = rows(feed)
    expect(lines[0]).toContain('Claiming the next ticket')
    expect(lines[1]).toContain('npm run lint')
  })

  it('shows a subagent the chat started as one row, not what happens inside it', async () => {
    const thread: ChatItem = { id: 'th_1', at: iso(-30 * SECOND), kind: 'thread', parentItemId: 'spawn', label: 'Worker DM-202', state: 'running' }
    const feed = await openFeed(backendWith([thread, said('inside', 25, 'Inside the worker', 'th_1')]))

    expect(within(feed).getByText('Worker DM-202')).toBeTruthy()
    expect(within(feed).queryByText('Inside the worker')).toBe(null)
  })

  it('shows what the agent wrote as text and Markdown, never as markup', async () => {
    const feed = await openFeed(backendWith([said('a', 45, '<img src=x onerror="alert(1)"> **bold**')]))

    expect(feed.querySelector('img')).toBe(null)
    expect(feed.querySelector('strong')?.textContent).toBe('bold')
  })

  it('leaves out an item of another chat', async () => {
    const feed = await openFeed(backendWith([said('a', 45, 'Planning the sprint')]))

    act(() => chats.emit({ type: 'item', chatId: 'chat_elsewhere', item: said('x', 1, 'From another chat') }))

    expect(within(feed).queryByText('From another chat')).toBe(null)
  })
})

describe('the live feed linking to the chat', () => {
  it('opens the chat that orchestrates the run', async () => {
    const feed = await openFeed(backendWith([said('a', 45, 'Planning the sprint')]))

    fireEvent.click(within(feed).getByRole('button', { name: 'Open chat' }))

    expect(host.openedChats).toEqual(['chat_o'])
  })

  it('stops following the chat when the feed is closed, and asks for nothing until it is opened', async () => {
    const backend = backendWith([said('a', 45, 'Planning the sprint')])
    renderWorkspace(backend, { scheduler, orchestration: host })
    const chip = await screen.findByRole('button', { name: 'Claude Code in chat' })
    await settle()
    expect(chats.callsOf('boundThreads')).toEqual([])
    expect(chats.callsOf('open')).toEqual([])

    fireEvent.click(chip)
    await screen.findByText('Planning the sprint')
    expect(chats.subscribers()).toBe(1)
    fireEvent.click(within(screen.getByRole('region', { name: 'Orchestrator feed' })).getByRole('button', { name: 'Close feed' }))

    expect(chats.subscribers()).toBe(0)
  })

  it('keeps the run entries when the chat cannot be read, and says so', async () => {
    chats.failures.open = { code: 'not_found', message: 'Chat not found.' }
    const feed = await openFeed(backendWith([]))

    expect(within(feed).getByRole('alert').textContent).toBe('Chat not found.')
    expect(within(feed).getByText('Run started')).toBeTruthy()
  })
})

describe('the live feed approvals of the chat', () => {
  it('shows a request the chat waits on and sends the answer', async () => {
    const feed = await openFeed(backendWith([asked('req_1', 10)]))

    const card = within(feed).getByRole('article', { name: 'Approval request: Run a command' })
    fireEvent.click(within(card).getByRole('button', { name: 'Allow once' }))
    await settle()

    expect(chats.callsOf('answerApproval')).toEqual([[{ folder: FOLDER, chatId: 'chat_o', requestId: 'req_1', decision: 'allow_once' }]])
    expect(await within(card).findByText('Allowed once')).toBeTruthy()
  })

  it('shows a request that waits inside a subagent, so it is never missed', async () => {
    const thread: ChatItem = { id: 'th_1', at: iso(-30 * SECOND), kind: 'thread', parentItemId: 'spawn', label: 'Worker DM-202', state: 'running' }
    const feed = await openFeed(backendWith([thread, asked('deep', 10, 'th_1')]))

    const card = within(feed).getByRole('article', { name: 'Approval request: Run a command' })

    expect(within(card).getByText('Asked by the subagent: Worker DM-202')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: 'Deny' }))
    await settle()
    expect(chats.callsOf('answerApproval')).toEqual([[{ folder: FOLDER, chatId: 'chat_o', requestId: 'deep', decision: 'deny' }]])
  })
})

describe('the live feed of a run no chat orchestrates', () => {
  it('is the run entries alone: no chat is opened and there is no Open chat link', async () => {
    const feed = await openFeed(backendWith([said('a', 45, 'Planning the sprint')], []))

    expect(rows(feed)).toHaveLength(2)
    expect(within(feed).queryByRole('button', { name: 'Open chat' })).toBe(null)
    expect(within(feed).queryByText('Planning the sprint')).toBe(null)
    expect(chats.callsOf('open')).toEqual([])
    expect(chats.subscribers()).toBe(0)
  })

  it('treats a run only a subagent thread is bound to as no orchestrating chat', async () => {
    const feed = await openFeed(backendWith([said('a', 45, 'Planning the sprint')], [{ ...MAIN, threadId: 'th_1' }]))

    expect(within(feed).queryByRole('button', { name: 'Open chat' })).toBe(null)
    expect(chats.callsOf('open')).toEqual([])
  })

  it('is just as plain when the lookup fails', async () => {
    chats.failures.boundThreads = { code: 'internal', message: 'No lookup.' }
    const feed = await openFeed(backendWith([said('a', 45, 'Planning the sprint')]))

    expect(rows(feed)).toHaveLength(2)
    expect(within(feed).queryByRole('alert')).toBe(null)
    expect(within(feed).queryByRole('button', { name: 'Open chat' })).toBe(null)
  })
})
