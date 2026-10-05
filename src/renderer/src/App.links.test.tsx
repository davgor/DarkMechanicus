// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../shared/agents/chat'
import type { ThreadBinding } from '../../shared/agents/chatApi'
import { AppHarness } from './__mocks__/appHarness'
import { toolCall, userMessage } from './__mocks__/chatViewKit'
import { agentView, chatRecord, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

const AT = '2026-03-01T10:00:00.000Z'
const EPIC = 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k'
const RUN = 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb'
const ATTEMPT = 'at_01k8zq4a1b2c3d4e5f6g7h8j9k'
const TICKET = 'tk_01k8zq2m3n4p5q6r7s8t9v0w1x'

const CHAT = chatRecord({ id: 'chat_a', folder: '/a', title: 'Run the epic', agent: 'claude', role: 'orchestrator', updatedAt: AT })

const BOUND: ThreadBinding = { threadId: 'th1', role: 'worker', kind: 'attempt', attemptId: ATTEMPT, runId: RUN, epicId: EPIC, ticketId: TICKET, ticketKey: 'DM-12' }

const ITEMS: ChatItem[] = [
  userMessage('u1', 'Run the epic.'),
  toolCall('s1', { name: 'Agent', input: { description: 'DM-12 worker', prompt: 'Do it.' }, resultSummary: null }),
  { id: 'th1', at: AT, kind: 'thread', parentItemId: 's1', label: 'DM-12 worker', state: 'running' },
  { ...toolCall('t1', { name: 'Bash', input: { command: 'npm test' } }), threadId: 'th1' } as ChatItem,
  toolCall('c1', { name: 'mcp__darkmechanicus__start_run', input: { epicId: EPIC }, resultSummary: `{"ok":true,"data":{"id":"${RUN}","epicId":"${EPIC}"}}` })
]

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
  h.dm.agents = [agentView({ kind: 'claude' })]
  h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'ok' }
  h.dm.chats.chats = [CHAT]
  h.dm.chats.transcripts[CHAT.id] = ITEMS
  h.dm.chats.bindings[CHAT.id] = [BOUND]
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))
const landing = (): unknown => JSON.parse(screen.getByTestId('epic-landing').textContent ?? 'null')

async function openChat(): Promise<void> {
  h.mount()
  await settle()
  fireEvent.click(sidebar().getByRole('button', { name: /^Run the epic/ }))
  await settle()
}

describe('links from a chat to its epic', () => {
  it('opens the ticket of a bound thread in its epic, asking for its Activity tab for the attempt', async () => {
    await openChat()

    fireEvent.click(screen.getByRole('button', { name: 'DM-12 Activity' }))
    await settle()

    expect(screen.getByTestId('epic-stub').textContent).toBe(`alpha|${EPIC}|0`)
    expect(landing()).toEqual({ kind: 'ticket', epicId: EPIC, ticketId: TICKET, attemptId: ATTEMPT })
  })

  it('opens the epic from a marker that names it, with nothing to land on', async () => {
    await openChat()

    fireEvent.click(screen.getByRole('button', { name: /started the run/ }))
    await settle()

    expect(screen.getByTestId('epic-stub').textContent).toBe(`alpha|${EPIC}|0`)
    expect(landing()).toBeNull()
  })

  it('forgets the request once the workspace took it, so the epic is not asked again', async () => {
    await openChat()
    fireEvent.click(screen.getByRole('button', { name: 'DM-12 Activity' }))
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'stub landed' }))
    await settle()

    expect(landing()).toBeNull()
  })
})

describe('opening a chat at a thread from another screen', () => {
  it('shows the chat with that thread open and scrolled into view, and takes the request once', async () => {
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.getAttribute('aria-label') ?? '')
    }
    // Any screen with the shell's navigation can ask: here the epic workspace's "open chat" link, given a thread.
    window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: '/a', epicId: EPIC }))
    h.mount()
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'stub open thread' }))
    await settle()

    const log = within(screen.getByRole('log', { name: 'Transcript' }))
    const block = within(log.getByRole('listitem', { name: 'Thread: DM-12 worker' }))
    expect(block.getByRole('button', { name: /DM-12 worker/ }).getAttribute('aria-expanded')).toBe('true')
    expect(block.getByRole('listitem', { name: 'Tool call: Bash' })).toBeTruthy()
    expect(scrolled).toEqual(['Thread: DM-12 worker'])
  })
})
