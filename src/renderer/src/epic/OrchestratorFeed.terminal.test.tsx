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

  it('still shows an old chat’s binding beside it: Open terminal navigates, Open chat lands in the Agent tab', async () => {
    const main: BoundThread = { folder: FOLDER, chatId: 'chat_old', threadId: null, role: 'orchestrator' }
    const old = chatRecord({ id: 'chat_old', folder: FOLDER, role: 'orchestrator', epicId: 'ep_1' })
    host = fakeOrchestration({ chats: [old] })
    chats.terminals.runs.rn_2 = 'chat_t'
    const served = backend()
    chats.chats.push(old)
    chats.transcripts.chat_old = []
    chats.bound.runs.rn_2 = [main]
    const feed = await openFeed(served)

    fireEvent.click(within(feed).getByRole('button', { name: 'Open terminal' }))
    expect(host.openedChats).toEqual(['chat_t'])
    fireEvent.click(within(feed).getByRole('button', { name: 'Open chat' }))

    expect(host.openedChats).toEqual(['chat_t'])
    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('region', { name: 'Orchestrator feed' })).toBe(null)
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

describe('the live feed of a run whose chat bound by grant runs in the GUI', () => {
  it('labels a GUI chat bound by grant Open chat and shows it in the Agent tab with its node selected', async () => {
    const gui = chatRecord({ id: 'chat_g', folder: FOLDER, role: 'orchestrator', runId: 'rn_2', epicId: 'ep_1', surface: 'gui', title: 'Orchestrator · GUI' })
    host = fakeOrchestration({ chats: [gui] })
    chats.terminals.runs.rn_2 = 'chat_g'
    const served = backend()
    chats.chats = [gui]
    const feed = await openFeed(served)

    expect(within(feed).queryByRole('button', { name: 'Open terminal' })).toBe(null)
    fireEvent.click(within(feed).getByRole('button', { name: 'Open chat' }))

    expect(host.openedChats).toEqual([])
    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-pressed')).toBe('true')
    const tree = within(screen.getByRole('complementary', { name: 'Epic agents' }))
    expect((await tree.findByRole('treeitem', { name: 'Magos' })).getAttribute('aria-selected')).toBe('true')
  })

  it('keeps navigating for a GUI folder chat bound by grant that the epic does not list, reading Open chat', async () => {
    const elsewhere = chatRecord({ id: 'chat_f', folder: FOLDER, role: 'orchestrator', surface: 'gui', title: 'Folder chat' })
    host = fakeOrchestration({ chats: [elsewhere] })
    chats.terminals.runs.rn_2 = 'chat_f'
    const served = backend()
    chats.chats = [elsewhere]
    const feed = await openFeed(served)

    fireEvent.click(within(feed).getByRole('button', { name: 'Open chat' }))

    expect(host.openedChats).toEqual(['chat_f'])
    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Agent chat' })).toBe(null)
  })
})
