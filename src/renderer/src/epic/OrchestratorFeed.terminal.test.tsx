// @vitest-environment jsdom
/**
 * The live feed of a run orchestrated in a chat's terminal: the command layer's run timeline, and an Open terminal
 * link to the chat main finds by grant (`chats:boundTerminal`); an old chat's item-based binding still shows.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

const FOLDER = folder().path

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

function timeline(): RunTimelineView {
  const started: ActivityEntry = { kind: 'run', id: 'event:1', at: iso(-60_000), sessionId: 'ss_cli', change: 'started', reason: null }
  const group = { session: { id: 'ss_cli', role: 'orchestrator' as const, label: 'Claude Code in a terminal', grantId: 'gr_1' }, entries: [started] }
  return { runId: 'rn_2', epicId: 'ep_1', state: 'running', isLive: true, cursor: 1, groups: [group] }
}

function backend(): FakeBackend {
  const served = new FakeBackend()
  served.handlers.getRunTimeline = () => timeline()
  chats.chats = [chatRecord({ id: 'chat_t', folder: FOLDER, role: 'orchestrator', runId: 'rn_2' })]
  served.chats = chats
  return served
}

async function openFeed(served: FakeBackend): Promise<HTMLElement> {
  renderWorkspace(served, { scheduler, orchestration: host })
  fireEvent.click(await screen.findByRole('button', { name: 'Claude Code in a terminal' }))
  const feed = await screen.findByRole('region', { name: 'Orchestrator feed' })
  await settle()
  return feed
}

describe('the live feed of a run orchestrated in a terminal chat', () => {
  it('shows the run timeline and an Open terminal link to the chat bound by grant, which opens it', async () => {
    chats.terminals.runs.rn_2 = 'chat_t'
    const feed = await openFeed(backend())

    fireEvent.click(within(feed).getByRole('button', { name: 'Open terminal' }))

    expect(host.openedChats).toEqual(['chat_t'])
    expect(within(feed).getByText('Run started')).toBeTruthy()
    expect(chats.callsOf('boundTerminal')).toEqual([[{ folder: FOLDER, runId: 'rn_2' }]])
    expect(within(feed).queryByRole('button', { name: 'Open chat' })).toBe(null)
    expect(chats.callsOf('read')).toEqual([])
  })

  it('still shows an old chat’s binding beside it', async () => {
    const main: BoundThread = { folder: FOLDER, chatId: 'chat_old', threadId: null, role: 'orchestrator' }
    chats.terminals.runs.rn_2 = 'chat_t'
    const served = backend()
    chats.chats.push(chatRecord({ id: 'chat_old', folder: FOLDER, role: 'orchestrator' }))
    chats.transcripts.chat_old = []
    chats.bound.runs.rn_2 = [main]
    const feed = await openFeed(served)

    fireEvent.click(within(feed).getByRole('button', { name: 'Open chat' }))
    fireEvent.click(within(feed).getByRole('button', { name: 'Open terminal' }))

    expect(host.openedChats).toEqual(['chat_old', 'chat_t'])
  })

  it('shows no Open terminal link for a run no chat started, and asks nothing until the feed is opened', async () => {
    const served = backend()
    renderWorkspace(served, { scheduler, orchestration: host })
    const chip = await screen.findByRole('button', { name: 'Claude Code in a terminal' })
    await settle()
    expect(chats.callsOf('boundTerminal')).toEqual([])

    fireEvent.click(chip)
    const feed = await screen.findByRole('region', { name: 'Orchestrator feed' })
    await settle()

    expect(within(feed).queryByRole('button', { name: 'Open terminal' })).toBe(null)
  })
})
