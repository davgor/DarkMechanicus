// @vitest-environment jsdom
/**
 * Landing on an agent at a narrow window (1024 px), where the epic's agent rail starts collapsed: a notification, the
 * ticket's Activity tab or a tree click shows the selected agent's row, and the ticket panel does not cover the rail.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { AttemptTimelineView } from '../../../shared/domain/activity'
import type { EpicLanding } from '../app/landing'
import { FakeChats } from '../__mocks__/fakeChats'
import { chatRecord } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend } from './__mocks__/fakeBackend'
import { fakeOrchestration } from './__mocks__/fakeOrchestration'
import { folder, runView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

const FOLDER = folder().path
const run = runView()
const AT = '2026-03-01T10:00:00.000Z'

const orchestrator = chatRecord({
  id: 'chat_orch', folder: FOLDER, role: 'orchestrator', runId: run.id, epicId: 'ep_1', surface: 'gui', title: 'Orchestrator · Plan'
})
/** A worker running in a GUI chat of its own, bound to the epic: a notification lands on it. */
const worker = chatRecord({
  id: 'chat_dm2', folder: FOLDER, role: 'worker', epicId: 'ep_1', surface: 'gui', title: 'Acolyte:DM-2', createdAt: '2026-03-01T09:00:00.000Z'
})

const items: ChatItem[] = [
  { id: 'a1', at: AT, kind: 'assistant_text', text: 'Starting the sprint now' },
  {
    id: 'th_1', at: AT, kind: 'thread', parentItemId: null, label: 'Worker one', state: 'running',
    callsign: { role: 'Acolyte', ticketKey: 'DM-201', ordinal: null, purpose: null, ticketVerified: true }
  },
  {
    id: 'th_2', at: AT, kind: 'thread', parentItemId: null, label: 'Worker two', state: 'done',
    callsign: { role: 'Acolyte', ticketKey: 'DM-202', ordinal: null, purpose: null, ticketVerified: true }
  },
  { id: 'w2', at: AT, threadId: 'th_2', kind: 'assistant_text', text: 'Worker two finished' }
]

function backend(): FakeBackend {
  const fake = new FakeBackend()
  fake.agentChat.snapshotResult = { ok: true, data: { items, status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] } }
  fake.handlers.getAttemptTimeline = (): AttemptTimelineView => ({
    attemptId: 'at_202_2', runId: run.id, ticketId: 'tk_202', state: 'accepted', isLive: false, cursor: 1, entries: [], sessions: []
  })
  return fake
}

function land(fake: FakeBackend, landing: EpicLanding | null): void {
  renderWorkspace(fake, {
    scheduler: new ManualScheduler(),
    orchestration: fakeOrchestration({ chats: [orchestrator, worker] }),
    ...(landing === null ? {} : { landing, onLanded: () => undefined })
  })
}

const rail = (): HTMLElement => screen.getByRole('complementary', { name: 'Epic agents' })

beforeAll(() => {
  installDomShims()
})

beforeEach(() => {
  // A 1024 px window: narrower than the rail's 1100 px breakpoint, so with nothing stored it starts collapsed.
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(max-width: 1099px)', addEventListener: () => undefined, removeEventListener: () => undefined
  })))
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('landing on an agent at 1024 px', () => {
  it('starts collapsed when the person opens the Agent tab themselves', async () => {
    land(backend(), null)
    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))
    expect(within(rail()).getByRole('button', { name: 'Expand Epic agents' })).toBeTruthy()
  })
})

describe('landing on an agent from a notification at 1024 px', () => {
  it('expands the rail with the agent a notification landed on selected and visible', async () => {
    land(backend(), { kind: 'epicAgent', epicId: 'ep_1', chatId: worker.id })
    const row = await within(await screen.findByRole('complementary', { name: 'Epic agents' })).findByRole('treeitem', { name: 'Acolyte:DM-2' })
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(within(rail()).getByRole('button', { name: 'Collapse Epic agents' })).toBeTruthy()
    // The rail persists its state in a passive effect, which React may still have queued on its scheduler when the
    // expanded row is found. Unmounting commits synchronously, and React flushes every pending passive effect before
    // it commits, so the stored state is final only then; a fresh visit to the Agent tab shows what was remembered.
    cleanup()
    expect(window.localStorage.getItem(`dm.epicRail.v1:${FOLDER}\nep_1`)).toContain('"collapsed":false')
    land(backend(), null)
    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))
    expect(within(rail()).getByRole('button', { name: 'Collapse Epic agents' })).toBeTruthy()
  })

  it('takes the reveal once: collapsing the rail afterwards stands', async () => {
    land(backend(), { kind: 'epicAgent', epicId: 'ep_1', chatId: worker.id })
    await within(await screen.findByRole('complementary', { name: 'Epic agents' })).findByRole('treeitem', { name: 'Acolyte:DM-2' })
    fireEvent.click(within(rail()).getByRole('button', { name: 'Collapse Epic agents' }))
    expect(within(rail()).getByRole('button', { name: 'Expand Epic agents' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    expect(within(rail()).getByRole('button', { name: 'Expand Epic agents' })).toBeTruthy()
  })
})

describe('landing on an agent from the Activity tab or the tree at 1024 px', () => {
  it('from the Activity tab: closes the ticket panel and shows the finished worker inside its opened Finished group', async () => {
    const fake = backend()
    const chats = new FakeChats()
    chats.bound.attempts.at_202_2 = [{ folder: FOLDER, chatId: orchestrator.id, threadId: 'th_2', role: 'worker' }]
    fake.chats = chats
    land(fake, { kind: 'ticket', epicId: 'ep_1', ticketId: 'tk_202', attemptId: 'at_202_2' })
    const ticket = await screen.findByLabelText('Ticket DM-202')
    fireEvent.click(await within(ticket).findByRole('button', { name: 'Open chat' }))

    await waitFor(() => expect(screen.queryByLabelText('Ticket DM-202')).toBeNull())
    expect(document.querySelector('.ew-main.has-panel')).toBeNull()
    const row = await within(rail()).findByRole('treeitem', { name: 'Acolyte:DM-202' })
    expect(row.getAttribute('aria-selected')).toBe('true')
    const finished = within(rail()).getByRole('treeitem', { name: 'Finished 1' })
    expect(finished.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('region', { name: 'Acolyte:DM-202 thread' })).toBeTruthy()
  })

  it('from a tree click: the selected row stays shown in the expanded rail', async () => {
    land(backend(), null)
    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))
    fireEvent.click(within(rail()).getByRole('button', { name: 'Expand Epic agents' }))
    const row = await within(rail()).findByRole('treeitem', { name: 'Acolyte:DM-201' })
    fireEvent.click(within(row).getByText('Acolyte:DM-201'))
    await waitFor(() => expect(within(rail()).getByRole('treeitem', { name: 'Acolyte:DM-201' }).getAttribute('aria-selected')).toBe('true'))
    expect(within(rail()).getByRole('button', { name: 'Collapse Epic agents' })).toBeTruthy()
  })
})
