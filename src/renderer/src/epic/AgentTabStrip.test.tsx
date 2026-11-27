// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentChatSnapshot, AttentionItem } from '../../../shared/agents/agentChat'
import type { ChatRecord } from '../../../shared/agents/chat'
import { chatRecord } from '../__mocks__/fixtures'
import { FakeChatMail } from '../__mocks__/fakeChatMail'
import { createAgentMailStore, type AgentMailStore } from '../agents/useAgentMail'
import { AgentTabStrip } from './AgentTabStrip'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend } from './__mocks__/fakeBackend'
import { fakeOrchestration, readyAgent } from './__mocks__/fakeOrchestration'
import { folder, runView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'
import type { WorkspaceHandle } from './useWorkspace'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const FOLDER = folder().path
const run = runView()
const magos = chatRecord({
  id: 'chat_orch', folder: FOLDER, role: 'orchestrator', runId: run.id, epicId: 'ep_1', surface: 'gui', agent: 'omp',
  title: 'Orchestrator · Plan', createdAt: '2026-03-01T10:00:00.000Z'
})
const planner = chatRecord({
  id: 'chat_plan', folder: FOLDER, role: 'planner', epicId: 'ep_1', surface: 'gui', agent: 'omp', title: 'Planner',
  createdAt: '2026-03-01T11:00:00.000Z'
})
const AGENTS = [readyAgent('omp').agent, readyAgent('claude').agent]

type Status = AgentChatSnapshot['status']

/** Each chat answers its own snapshot; a start makes the started chat idle, as main does. */
function backendWith(statuses: Record<string, Status>): FakeBackend {
  const backend = new FakeBackend()
  const api = backend.agentChat
  const snapshotOf = (chatId: string): AgentChatSnapshot => ({
    items: [], status: statuses[chatId] ?? 'exited', pending: null, queued: 0, surface: 'gui', todos: []
  })
  const read = api.snapshot.bind(api)
  api.snapshot = (request) => {
    api.snapshotResult = { ok: true, data: snapshotOf(request.chatId) }
    return read(request)
  }
  const start = api.start.bind(api)
  api.start = (request) => {
    statuses[request.chatId] = 'idle'
    api.snapshotResult = { ok: true, data: snapshotOf(request.chatId) }
    return start(request)
  }
  return backend
}

function mailWith(backend: FakeBackend, unseen: Record<string, number>): AgentMailStore {
  const mail = new FakeChatMail()
  backend.chats.mail = mail
  for (const [chatId, unseenCount] of Object.entries(unseen)) mail.put({ folder: FOLDER, chatId, unseenCount })
  const store = createAgentMailStore(mail)
  store.track([FOLDER])
  return store
}

function open(backend: FakeBackend, chats: ChatRecord[], mail: AgentMailStore | null = null) {
  return renderWorkspace(backend, { orchestration: fakeOrchestration({ chats, agents: AGENTS }), epicId: 'ep_1' }, mail)
}

async function agentStage(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))
  return screen.getByRole('region', { name: 'Agent chat' })
}

const strip = (stage: HTMLElement): HTMLElement => within(stage).getByRole('tablist', { name: 'Agent tabs' })
const railRow = (stage: HTMLElement, name: string | RegExp): Promise<HTMLElement> =>
  within(within(stage).getByRole('complementary', { name: 'Epic agents' })).findByRole('treeitem', { name })

describe('AgentTabStrip: selection', () => {
  it('selects a clicked tab, cycles with Ctrl+Tab, and keeps the rail’s selection in step', async () => {
    open(backendWith({ chat_orch: 'idle', chat_plan: 'idle' }), [magos, planner])
    const stage = await agentStage()
    const tabs = strip(stage)
    const magosTab = await within(tabs).findByRole('tab', { name: /^Magos/ })
    expect(magosTab.getAttribute('aria-selected')).toBe('true')
    // The Magos comes first, then the live Lexmechanic.
    await waitFor(() => expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Magos', 'Lexmechanic']))

    fireEvent.click(within(tabs).getByRole('tab', { name: /^Lexmechanic/ }))
    expect(await within(stage).findByRole('region', { name: 'Lexmechanic chat' })).toBeTruthy()
    expect(within(tabs).getByRole('tab', { name: /^Lexmechanic/ }).getAttribute('aria-selected')).toBe('true')
    expect((await railRow(stage, 'Lexmechanic')).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })
    expect(await within(stage).findByRole('region', { name: 'Magos chat' })).toBeTruthy()
    expect(within(tabs).getByRole('tab', { name: /^Magos/ }).getAttribute('aria-selected')).toBe('true')
    expect((await railRow(stage, 'Magos')).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true, shiftKey: true })
    expect(await within(stage).findByRole('region', { name: 'Lexmechanic chat' })).toBeTruthy()

    // Arrow keys move within the tablist and follow with focus.
    fireEvent.keyDown(within(tabs).getByRole('tab', { name: /^Lexmechanic/ }), { key: 'ArrowRight' })
    expect(await within(stage).findByRole('region', { name: 'Magos chat' })).toBeTruthy()
    expect(document.activeElement).toBe(within(tabs).getByRole('tab', { name: /^Magos/ }))
  })

  it('keeps the owner’s tab active when the rail selects one of its workers', async () => {
    const backend = backendWith({ chat_orch: 'idle' })
    const thread = {
      id: 'th_1', at: magos.createdAt, kind: 'thread', parentItemId: null, label: 'Fix it', state: 'running',
      callsign: { role: 'Acolyte', ticketKey: 'DM-201', ordinal: null, purpose: null, ticketVerified: true }
    } as const
    const api = backend.agentChat
    const read = api.snapshot.bind(api)
    api.snapshot = async (request) => {
      const result = await read(request)
      return result.ok && request.chatId === 'chat_orch' ? { ok: true, data: { ...result.data, items: [thread] } } : result
    }
    open(backend, [magos])
    const stage = await agentStage()
    fireEvent.click(within(await railRow(stage, 'Acolyte:DM-201')).getByText('Acolyte:DM-201'))
    expect((await railRow(stage, 'Acolyte:DM-201')).getAttribute('aria-selected')).toBe('true')
    expect(within(strip(stage)).getByRole('tab', { name: /^Magos/ }).getAttribute('aria-selected')).toBe('true')
    expect(within(strip(stage)).getAllByRole('tab')).toHaveLength(1)
  })
})

describe('AgentTabStrip: closing', () => {
  it('offers no ✕ on the Magos; the Lexmechanic’s ✕ confirms, Cancel does nothing and Stop stops it once', async () => {
    const backend = backendWith({ chat_orch: 'idle', chat_plan: 'idle' })
    open(backend, [magos, planner])
    const stage = await agentStage()
    const tabs = strip(stage)
    await within(tabs).findByRole('tab', { name: /^Lexmechanic/ })
    expect(within(tabs).queryByRole('button', { name: 'Stop Magos' })).toBeNull()

    fireEvent.click(within(tabs).getByRole('button', { name: 'Stop Lexmechanic' }))
    const confirm = screen.getByRole('dialog', { name: 'Stop the Lexmechanic?' })
    expect(within(confirm).getByText('Its chat stays in history.')).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(backend.agentChat.callsOf('stop')).toEqual([])
    expect(within(tabs).getByRole('tab', { name: /^Lexmechanic/ })).toBeTruthy()

    fireEvent.click(within(tabs).getByRole('button', { name: 'Stop Lexmechanic' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Stop the Lexmechanic?' })).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(within(tabs).queryByRole('tab', { name: /^Lexmechanic/ })).toBeNull())
    expect(backend.agentChat.callsOf('stop')).toEqual([[{ folder: FOLDER, chatId: 'chat_plan' }]])
    expect(screen.queryByRole('dialog')).toBeNull()
    // The chat stays in the rail's history.
    expect(await railRow(stage, 'Lexmechanic')).toBeTruthy()
  })

  it('moves the selection to the Magos when the selected Lexmechanic stops, so its tab goes', async () => {
    const backend = backendWith({ chat_orch: 'idle', chat_plan: 'idle' })
    open(backend, [magos, planner])
    const stage = await agentStage()
    const tabs = strip(stage)
    fireEvent.click(await within(tabs).findByRole('tab', { name: /^Lexmechanic/ }))
    await within(stage).findByRole('region', { name: 'Lexmechanic chat' })
    fireEvent.click(within(tabs).getByRole('button', { name: 'Stop Lexmechanic' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Stop the Lexmechanic?' })).getByRole('button', { name: 'Stop' }))
    expect(await within(stage).findByRole('region', { name: 'Magos chat' })).toBeTruthy()
    await waitFor(() => expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Magos']))
    expect(backend.agentChat.callsOf('stop')).toHaveLength(1)
  })

  it('keeps the tab and shows why when the stop is refused', async () => {
    const backend = backendWith({ chat_orch: 'idle', chat_plan: 'idle' })
    backend.agentChat.failures.stop = { code: 'busy', message: 'The chat is stopping.' }
    open(backend, [magos, planner])
    const stage = await agentStage()
    const tabs = strip(stage)
    fireEvent.click(await within(tabs).findByRole('button', { name: 'Stop Lexmechanic' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Stop the Lexmechanic?' })).getByRole('button', { name: 'Stop' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The chat is stopping.')
    expect(within(tabs).getByRole('tab', { name: /^Lexmechanic/ })).toBeTruthy()
  })
})

describe('AgentTabStrip: "+" and reopen', () => {
  it('opens the role picker with a Reopen list; Reopen selects the stopped chat and starts it in the GUI', async () => {
    const backend = backendWith({ chat_orch: 'idle', chat_plan: 'exited' })
    open(backend, [magos, planner])
    const stage = await agentStage()
    const tabs = strip(stage)
    await waitFor(() => expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Magos']))

    fireEvent.click(within(stage).getByRole('button', { name: 'Start or reopen an agent' }))
    const picker = screen.getByRole('dialog', { name: 'Start an agent' })
    expect(within(picker).getByRole('radio', { name: 'Lexmechanic' })).toBeTruthy()
    const reopen = within(picker).getByRole('region', { name: 'Reopen' })
    fireEvent.click(within(reopen).getByRole('button', { name: /^Lexmechanic/ }))

    expect(await within(stage).findByRole('region', { name: 'Lexmechanic chat' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(backend.agentChat.callsOf('start')).toContainEqual([{ folder: FOLDER, chatId: 'chat_plan' }]))
    expect(within(tabs).getByRole('tab', { name: /^Lexmechanic/ }).getAttribute('aria-selected')).toBe('true')
    expect(backend.agentChat.callsOf('setSurface')).toEqual([])
  })

  it('switches a stopped terminal chat to the GUI before it reopens', async () => {
    const backend = backendWith({ chat_orch: 'idle' })
    const terminal = { ...planner, surface: 'terminal' as const }
    open(backend, [magos, terminal])
    const stage = await agentStage()
    fireEvent.click(within(stage).getByRole('button', { name: 'Start or reopen an agent' }))
    fireEvent.click(within(screen.getByRole('region', { name: 'Reopen' })).getByRole('button', { name: /^Lexmechanic/ }))
    await waitFor(() => expect(backend.agentChat.callsOf('setSurface')).toEqual([[{ folder: FOLDER, chatId: 'chat_plan', surface: 'gui' }]]))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('AgentTabStrip: indicators', () => {
  it('shows the unread dot and the needs-you badge, and a woken Lexmechanic returns with its dot', async () => {
    const backend = backendWith({ chat_orch: 'idle', chat_plan: 'exited' })
    const attention: AttentionItem[] = [{
      chatId: 'chat_orch', promptId: 'p1', kind: 'approval', threadId: null, callsign: null, arbitration: 'escalated', title: 'Run', shown: true
    }]
    backend.agentChat.attentionResult = { ok: true, data: attention }
    open(backend, [magos, planner], mailWith(backend, { chat_plan: 1 }))
    const stage = await agentStage()
    const tabs = strip(stage)
    expect(await within(tabs).findByRole('tab', { name: 'Magos, needs you' })).toBeTruthy()
    expect(within(tabs).queryByRole('tab', { name: /^Lexmechanic/ })).toBeNull()

    // Mail wakes the stopped Lexmechanic: main starts it, and its tab comes back with the unread dot.
    act(() => backend.agentChat.emit({ folder: FOLDER, chatId: 'chat_plan', type: 'status', status: 'starting' }))
    const woken = await within(tabs).findByRole('tab', { name: 'Lexmechanic, 1 unread message' })
    expect(woken.querySelector('.ats-unread')).not.toBeNull()
    expect(woken.getAttribute('aria-selected')).toBe('false')
    act(() => backend.agentChat.emit({ folder: FOLDER, chatId: 'chat_plan', type: 'status', status: 'busy' }))
    expect((await within(tabs).findByRole('tab', { name: 'Lexmechanic, 1 unread message, working' })).querySelector('.ats-spinner')).not.toBeNull()
  })

  it('says “no coordination” in a Claude tab’s tooltip, and not in a Skitarii one’s', async () => {
    const claude = { ...planner, agent: 'claude' }
    open(backendWith({ chat_orch: 'idle', chat_plan: 'idle' }), [magos, claude])
    const stage = await agentStage()
    const tabs = strip(stage)
    const planTab = await within(tabs).findByRole('tab', { name: /^Lexmechanic/ })
    expect(planTab.getAttribute('title')).toMatch(/Claude Code[\s\S]*no coordination/i)
    expect(within(tabs).getByRole('tab', { name: /^Magos/ }).getAttribute('title')).not.toMatch(/no coordination/i)
  })
})

describe('AgentTabStrip alone', () => {
  it('renders the run’s Magos tab with nothing live and nothing selected elsewhere', () => {
    window.dm = backendWith({})
    const ws = {
      folder: folder(), epicId: 'ep_1', dispatch: () => undefined, orchestration: fakeOrchestration({ agents: AGENTS })
    } as unknown as WorkspaceHandle
    render(<AgentTabStrip ws={ws} chats={[magos, planner]} run={run} selectedId={null} names={new Map([['chat_orch', 'Magos']])} needsYou={new Set()} />)
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Magos'])
    expect(screen.getByRole('tab', { name: 'Magos' }).getAttribute('title')).toMatch(/Stopped/)
  })
})
