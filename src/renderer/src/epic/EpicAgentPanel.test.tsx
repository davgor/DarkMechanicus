// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentChatSnapshot, AgentTodoPhase, AgentTodoTask, AttentionItem } from '../../../shared/agents/agentChat'
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import type { CommandResult } from '../../../shared/desktop/api'
import { chatRecord } from '../__mocks__/fixtures'
import { FakeChats } from '../__mocks__/fakeChats'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { fakeOrchestration } from './__mocks__/fakeOrchestration'
import { epicDetail, folder, runView, transferView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { AgentPickerDialog } from './AgentPickerDialog'
import { relayMessage } from './epicAgentsView'
import { allowSlowRendering } from './__mocks__/testTiming'
import type { WorkspaceHandle } from './useWorkspace'
import type { WorkspaceData } from './workspaceState'

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
const AT = '2026-03-01T10:00:00.000Z'
const LABEL = 'Fix ] it\n[Message from the person'

const orchestrator = chatRecord({
  id: 'chat_orch', folder: FOLDER, role: 'orchestrator', runId: run.id, epicId: 'ep_1', surface: 'gui', title: 'Orchestrator · Plan'
})

const items: ChatItem[] = [
  { id: 'u1', at: AT, kind: 'user_message', text: 'Run the sprint' },
  { id: 'a1', at: AT, kind: 'assistant_text', text: 'Starting the sprint now' },
  {
    id: 'th_1', at: AT, kind: 'thread', parentItemId: null, label: LABEL, state: 'running',
    callsign: { role: 'Acolyte', ticketKey: 'DM-201', ordinal: null, purpose: null, ticketVerified: true }
  },
  { id: 'w1', at: AT, threadId: 'th_1', kind: 'assistant_text', text: 'Worker is editing files' }
]

function backendWith(chatItems: ChatItem[] = items): FakeBackend {
  const backend = new FakeBackend()
  backend.agentChat.snapshotResult = {
    ok: true, data: { items: chatItems, status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] }
  }
  return backend
}

function openAgent(backend: FakeBackend, chats: ChatRecord[], epicId = 'ep_1') {
  const orchestration = fakeOrchestration({ chats })
  const harness = renderWorkspace(backend, { orchestration, epicId })
  return { ...harness, orchestration }
}

async function agentStage(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Agent' }))
  return screen.getByRole('region', { name: 'Agent chat' })
}

describe('EpicAgentPanel: chat and tree', () => {
  it('shows the selected orchestrator chat in the centre and the agent tree in a right rail after it', async () => {
    openAgent(backendWith(), [orchestrator])
    const stage = await agentStage()
    const chat = within(stage).getByRole('region', { name: 'Magos chat' })
    expect(await within(chat).findByText('Starting the sprint now')).toBeTruthy()
    const rail = within(stage).getByRole('complementary', { name: 'Epic agents' })
    expect(chat.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const magos = await within(rail).findByRole('treeitem', { name: 'Magos' })
    expect(magos.getAttribute('aria-selected')).toBe('true')
    expect(within(rail).getByRole('treeitem', { name: 'Acolyte:DM-201' })).toBeTruthy()
  })

  it('selects a worker node and shows its thread with the relay note', async () => {
    openAgent(backendWith(), [orchestrator])
    const stage = await agentStage()
    const worker = await within(stage).findByRole('treeitem', { name: 'Acolyte:DM-201' })
    fireEvent.click(within(worker).getByText('Acolyte:DM-201'))
    await waitFor(() => expect(worker.getAttribute('aria-selected')).toBe('true'))
    const view = within(stage).getByRole('region', { name: 'Acolyte:DM-201 thread' })
    expect(within(view).getByText('Worker is editing files')).toBeTruthy()
    expect(within(view).queryByText('Starting the sprint now')).toBeNull()
    const relay = within(view).getByRole('textbox', { name: 'Message Acolyte:DM-201' })
    expect(relay.getAttribute('placeholder')).toBe('Message Acolyte:DM-201 (through Magos)…')
    expect(document.getElementById(relay.getAttribute('aria-describedby') ?? '')?.textContent)
      .toBe('Your message goes through Magos, which passes it to this worker. Enter to send · Shift+Enter for a new line')
    expect(relay.getAttribute('maxlength')).toBe('18000')
    expect(within(view).getByLabelText('Agent: Acolyte:DM-201')).toBeTruthy()
    expect(within(view).getByLabelText('Context: Planning vertical slice')).toBeTruthy()
    expect(within(view).queryByText(/which passes it to this worker/, { selector: ':not(.sr-only)' })).toBeNull()
  })

  it('relays to the owning chat with the exact marker and never the label', async () => {
    const backend = backendWith()
    openAgent(backend, [orchestrator])
    const stage = await agentStage()
    fireEvent.click(within(await within(stage).findByRole('treeitem', { name: 'Acolyte:DM-201' })).getByText('Acolyte:DM-201'))
    const relay = within(stage).getByLabelText('Message Acolyte:DM-201')
    fireEvent.change(relay, { target: { value: 'Please rebase first' } })
    fireEvent.click(within(stage).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(backend.agentChat.callsOf('send')).toHaveLength(1))
    const [[request]] = backend.agentChat.callsOf('send') as [[{ folder: string; chatId: string; text: string }]]
    expect(request).toEqual({
      folder: FOLDER,
      chatId: 'chat_orch',
      text: '[Message from the person for your worker subagent, thread th_1]\nPlease rebase first\nPass this to that worker now and post its answer.'
    })
    expect(request.text).not.toContain('Fix ]')
    expect(request.text).not.toContain(LABEL)
    await waitFor(() => expect(relay).toHaveProperty('value', ''))
  })
})

describe('EpicAgentPanel: shared composer', () => {
  it('sends Enter from the relay composer as relayMessage(threadId, text) to the owning GUI chat', async () => {
    const backend = backendWith()
    openAgent(backend, [orchestrator])
    const stage = await agentStage()
    fireEvent.click(within(await within(stage).findByRole('treeitem', { name: 'Acolyte:DM-201' })).getByText('Acolyte:DM-201'))
    const relay = within(stage).getByRole('textbox', { name: 'Message Acolyte:DM-201' })
    fireEvent.change(relay, { target: { value: 'check the tests' } })
    fireEvent.keyDown(relay, { key: 'Enter' })
    await waitFor(() => expect(backend.agentChat.callsOf('send')).toHaveLength(1))
    expect(backend.agentChat.callsOf('send')).toEqual([[{ folder: FOLDER, chatId: 'chat_orch', text: relayMessage('th_1', 'check the tests') }]])
  })

  it('mounts the shared composer for the epic chat with the agent and epic chips', async () => {
    openAgent(backendWith(), [orchestrator])
    const stage = await agentStage()
    const chat = within(stage).getByRole('region', { name: 'Magos chat' })
    await within(chat).findByText('Starting the sprint now')
    const input = within(chat).getByRole('textbox', { name: 'Message Magos' })
    expect(input.getAttribute('placeholder')).toBe('Reply to Magos…')
    expect(within(chat).getByLabelText(/^Agent: Magos · \S/)).toBeTruthy()
    expect(within(chat).getByLabelText('Context: Planning vertical slice')).toBeTruthy()
  })
})

describe('EpicAgentPanel: legacy thread names in a thread view', () => {
  const servitor1 = { role: 'Servitor' as const, ticketKey: null, ordinal: 1, purpose: null, ticketVerified: false }
  const legacy = (id: string, label: string, threadId?: string): ChatItem => ({
    id, at: AT, kind: 'thread', parentItemId: null, label, state: 'running', ...(threadId === undefined ? {} : { threadId })
  })
  const allLegacy: ChatItem[] = [
    { id: 'u1', at: AT, kind: 'user_message', text: 'Run the sprint' },
    legacy('th_p', 'Parent helper'),
    { id: 'pw', at: AT, threadId: 'th_p', kind: 'assistant_text', text: 'Parent is delegating' },
    legacy('th_c', 'Child helper', 'th_p'),
    { id: 'cw', at: AT, threadId: 'th_c', kind: 'assistant_text', text: 'Child is reading files' }
  ]
  const withStamped: ChatItem[] = [
    { id: 'th_s', at: AT, kind: 'thread', parentItemId: null, label: 'Stamped helper', state: 'running', callsign: servitor1 },
    ...allLegacy
  ]
  /** The live child once main stamps it with the ordinal it reserved: its name must not change. */
  const childStamped: ChatItem[] = allLegacy.map((item) => item.id === 'th_c' && item.kind === 'thread'
    ? { ...item, callsign: { ...servitor1, ordinal: 2 } }
    : item)

  it.each([
    ['an all-legacy chat', allLegacy, 'Servitor-1', 'Servitor-2'],
    ['a chat with a stamped Servitor-1', withStamped, 'Servitor-2', 'Servitor-3'],
    ['a chat whose live child main has since stamped', childStamped, 'Servitor-1', 'Servitor-2']
  ])('names a nested legacy thread in its parent’s view as the tree does, in %s', async (_case, chatItems, parent, child) => {
    openAgent(backendWith(chatItems), [orchestrator])
    const stage = await agentStage()
    const rail = within(stage).getByRole('complementary', { name: 'Epic agents' })
    const parentRow = await within(rail).findByRole('treeitem', { name: parent })
    expect(within(rail).getByRole('treeitem', { name: child })).toBeTruthy()
    fireEvent.click(within(parentRow).getByText(parent))
    const view = await within(stage).findByRole('region', { name: `${parent} thread` })
    expect(within(view).getByText('Parent is delegating')).toBeTruthy()
    const block = within(view).getByRole('listitem', { name: `Thread: ${child}` })
    fireEvent.click(within(block).getByRole('button', { expanded: false }))
    expect(within(block).getByText('Child is reading files')).toBeTruthy()
    expect(within(view).queryByRole('listitem', { name: `Thread: ${parent}` })).toBeNull()
  })
})

describe('EpicAgentPanel: selection across views', () => {

  it('keeps the selected worker thread while every other view opens in the View order and Agent returns', async () => {
    openAgent(backendWith(), [orchestrator])
    const stage = await agentStage()
    fireEvent.click(within(await within(stage).findByRole('treeitem', { name: 'Acolyte:DM-201' })).getByText('Acolyte:DM-201'))
    await waitFor(() => expect(within(stage).getByRole('region', { name: 'Acolyte:DM-201 thread' })).toBeTruthy())
    const view = within(screen.getByRole('group', { name: 'View' }))
    const opened: Record<string, () => HTMLElement> = {
      Graph: () => screen.getByLabelText('Plan graph'),
      List: () => screen.getByLabelText('Plan list'),
      Scorecard: () => screen.getByRole('region', { name: 'Epic scorecard' })
    }
    for (const name of ['Graph', 'List', 'Scorecard']) {
      fireEvent.click(view.getByRole('button', { name }))
      expect(opened[name]!()).toBeTruthy()
      expect(screen.queryByRole('region', { name: 'Agent chat' })).toBeNull()
    }
    fireEvent.click(view.getByRole('button', { name: 'Agent' }))
    const back = screen.getByRole('region', { name: 'Agent chat' })
    expect(await within(back).findByRole('region', { name: 'Acolyte:DM-201 thread' })).toBeTruthy()
    expect((await within(back).findByRole('treeitem', { name: 'Acolyte:DM-201' })).getAttribute('aria-selected')).toBe('true')
  })
})

describe('EpicAgentPanel: rail memory', () => {
  it('remembers a collapsed rail for the same epic but not for another epic', async () => {
    const chats = [orchestrator, { ...orchestrator, id: 'chat_other', epicId: 'ep_2', runId: undefined }]
    const first = openAgent(backendWith(), chats)
    const stage = await agentStage()
    fireEvent.click(within(stage).getByRole('button', { name: 'Collapse Epic agents' }))
    expect(window.localStorage.getItem(`dm.epicRail.v1:${FOLDER}\nep_1`)).toContain('"collapsed":true')
    first.unmount()
    const again = openAgent(backendWith(), chats)
    expect(within(await agentStage()).getByRole('button', { name: 'Expand Epic agents' })).toBeTruthy()
    again.unmount()
    openAgent(backendWith([]), chats, 'ep_2')
    expect(within(await agentStage()).getByRole('button', { name: 'Collapse Epic agents' })).toBeTruthy()
  })
})

const roleCard = (scope: HTMLElement, name: 'Magos' | 'Lexmechanic'): HTMLElement =>
  within(scope).getByRole('radio', { name }).closest<HTMLElement>('.arc')!

function noRunBackend(patch: Parameters<typeof scenario>[0] = {}): FakeBackend {
  const backend = new FakeBackend(scenario({ run: null, checkpoint: null, ...patch }))
  backend.agentChat.snapshotResult = { ok: true, data: { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] } }
  return backend
}

describe('EpicAgentPanel: starting an agent on an empty epic', () => {
  it('shows the Magos and Lexmechanic cards in place of a Start planner button', async () => {
    openAgent(noRunBackend(), [])
    const stage = await agentStage()
    const group = within(stage).getByRole('radiogroup', { name: 'Agent role' })
    expect(within(group).getAllByRole('radio').map((radio) => radio.textContent))
      .toEqual(['MagosOrchestrator', 'LexmechanicPlanner'])
    expect(within(stage).queryByRole('button', { name: 'Start planner' })).toBe(null)
    expect(within(stage).getByRole('radio', { name: 'Magos' }).getAttribute('aria-disabled')).toBe(null)
  })

  it('starts the planner once with the folder and epic id when Lexmechanic is chosen, and selects the returned chat', async () => {
    const backend = noRunBackend()
    const harness = openAgent(backend, [])
    const stage = await agentStage()
    fireEvent.click(roleCard(stage, 'Lexmechanic'))
    await waitFor(() => expect(harness.orchestration.chatsChanged.count).toBe(1))
    expect((backend.chats as FakeChats).callsOf('startPlanner')).toEqual([[{ folder: FOLDER, epicId: 'ep_1' }]])
    expect((backend.chats as FakeChats).callsOf('startOrchestrator')).toEqual([])
    // A newer epic chat would be the default; the started planner stays selected.
    const started = chatRecord({ id: 'chat_new_1', folder: FOLDER, role: 'planner', epicId: 'ep_1', surface: 'gui', title: 'Started planner', createdAt: AT })
    const newer = chatRecord({ id: 'chat_newer', folder: FOLDER, role: 'planner', epicId: 'ep_1', surface: 'gui', title: 'Newer planner', createdAt: '2026-03-02T10:00:00.000Z' })
    harness.orchestration.chats = [newer, started]
    harness.refresh(1)
    const rail = await within(await agentStage()).findByRole('complementary', { name: 'Epic agents' })
    await within(rail).findByRole('treeitem', { selected: true })
    // The newest epic chat is the default selection; the started one (the older, bare-callsign Lexmechanic) is selected.
    expect(within(rail).getAllByRole('treeitem').map((row) => [row.getAttribute('aria-label'), row.getAttribute('aria-selected')]))
      .toEqual([['Lexmechanic-2', 'false'], ['Lexmechanic', 'true']])
  })

  it('shows main’s sign-in prompt text when no agent can start the planner', async () => {
    const backend = noRunBackend()
    ;(backend.chats as FakeChats).plannerAgent = null
    openAgent(backend, [])
    const stage = await agentStage()
    fireEvent.click(roleCard(stage, 'Lexmechanic'))
    expect((await within(stage).findByRole('alert')).textContent)
      .toBe('No connected agent is signed in. Sign in to one in Agents, then start the planner again.')
  })
})

describe('EpicAgentPanel: starting the Magos on an empty epic', () => {
  it('opens the Start run dialog when Magos is chosen and never starts an orchestrator itself', async () => {
    const backend = noRunBackend()
    openAgent(backend, [])
    const stage = await agentStage()
    fireEvent.keyDown(within(stage).getByRole('radio', { name: 'Magos' }), { key: 'Enter' })
    expect(await screen.findByRole('dialog', { name: 'Start run' })).toBeTruthy()
    expect((backend.chats as FakeChats).callsOf('startOrchestrator')).toEqual([])
    expect((backend.chats as FakeChats).callsOf('startPlanner')).toEqual([])
  })

  it.each([
    ['no saved plan', noRunBackend({ epic: epicDetail({ currentRevisionId: null, currentRevisionNumber: null }), saved: null }), 'Save the plan first'],
    ['an active run', backendWith(), 'A run is active; its Magos is in the list'],
    ['an open Linear transfer', noRunBackend({ transfer: transferView('in_progress') }), 'A Linear transfer is open']
  ])('disables Magos with its reason with %s, as the header withholds Start run, and choosing it opens nothing', async (_, backend, reason) => {
    openAgent(backend, [])
    const stage = await agentStage()
    const magos = roleCard(stage, 'Magos')
    expect(within(magos).getByText(reason)).toBeTruthy()
    expect(within(stage).getByRole('radio', { name: 'Magos' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Start run' })).toBe(null)
    fireEvent.click(magos)
    expect(screen.queryByRole('dialog', { name: 'Start run' })).toBe(null)
    expect((backend.chats as FakeChats).callsOf('startOrchestrator')).toEqual([])
  })
})

function pickerWorkspace(input: Pick<WorkspaceData, 'epic' | 'run'> & Partial<Pick<WorkspaceData, 'transfer'>>, backend: FakeBackend): {
  ws: WorkspaceHandle
  opened: { count: number }
  dispatched: unknown[]
} {
  window.dm = backend
  const opened = { count: 0 }
  const dispatched: unknown[] = []
  const ws = {
    data: { transfer: null, ...input }, folder: folder(), epicId: 'ep_1', orchestration: fakeOrchestration(),
    dispatch: (action: unknown) => dispatched.push(action),
    openStartRun: () => { opened.count += 1 }
  } as unknown as WorkspaceHandle
  return { ws, opened, dispatched }
}

describe('AgentPickerDialog', () => {
  it('offers the same cards and rules in a dialog that Escape closes', () => {
    const { ws } = pickerWorkspace({ epic: epicDetail(), run: runView() }, noRunBackend())
    const closed = { count: 0 }
    render(<AgentPickerDialog ws={ws} onClose={() => { closed.count += 1 }} />)
    const dialog = screen.getByRole('dialog', { name: 'Start an agent' })
    expect(within(dialog).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['MagosOrchestrator', 'LexmechanicPlanner'])
    expect(within(roleCard(dialog, 'Magos')).getByText('A run is active; its Magos is in the list')).toBeTruthy()
    fireEvent.keyDown(within(dialog).getByRole('radio', { name: 'Lexmechanic' }), { key: 'Escape' })
    expect(closed.count).toBe(1)
  })

  it.each([
    ['until the plan is saved', { epic: epicDetail({ currentRevisionId: null, currentRevisionNumber: null }), run: null }, 'Save the plan first'],
    ['while a Linear transfer is open', { epic: epicDetail(), run: null, transfer: transferView('queued') }, 'A Linear transfer is open']
  ])('disables Magos %s', (_, data, reason) => {
    const { ws } = pickerWorkspace(data, noRunBackend())
    render(<AgentPickerDialog ws={ws} onClose={() => undefined} />)
    expect(within(roleCard(screen.getByRole('dialog'), 'Magos')).getByText(reason)).toBeTruthy()
  })

  it('opens Start run for Magos and closes; never starts an orchestrator itself', () => {
    const backend = noRunBackend()
    const { ws, opened } = pickerWorkspace({ epic: epicDetail(), run: null }, backend)
    const closed = { count: 0 }
    render(<AgentPickerDialog ws={ws} onClose={() => { closed.count += 1 }} />)
    fireEvent.click(roleCard(screen.getByRole('dialog'), 'Magos'))
    expect([opened.count, closed.count]).toEqual([1, 1])
    expect((backend.chats as FakeChats).callsOf('startOrchestrator')).toEqual([])
  })

  it('starts the planner for Lexmechanic, selects its chat and closes', async () => {
    const backend = noRunBackend()
    const { ws, dispatched } = pickerWorkspace({ epic: epicDetail(), run: null }, backend)
    const closed = { count: 0 }
    render(<AgentPickerDialog ws={ws} onClose={() => { closed.count += 1 }} />)
    fireEvent.click(roleCard(screen.getByRole('dialog'), 'Lexmechanic'))
    await waitFor(() => expect(closed.count).toBe(1))
    expect((backend.chats as FakeChats).callsOf('startPlanner')).toEqual([[{ folder: FOLDER, epicId: 'ep_1' }]])
    expect(dispatched).toEqual([{ type: 'select_agent', chatId: 'chat_new_1' }])
  })
})

describe('EpicAgentPanel: terminal chat', () => {
  it('offers Open terminal and Switch to GUI for a terminal chat', async () => {
    const backend = backendWith()
    const terminal = { ...orchestrator, surface: 'terminal' as const }
    const { orchestration } = openAgent(backend, [terminal])
    const stage = await agentStage()
    fireEvent.click(within(stage).getByRole('button', { name: 'Open terminal' }))
    expect(orchestration.openedChats).toEqual(['chat_orch'])
    fireEvent.click(within(stage).getByRole('button', { name: 'Switch to GUI' }))
    await waitFor(() => expect(backend.agentChat.callsOf('setSurface')).toEqual([[{ folder: FOLDER, chatId: 'chat_orch', surface: 'gui' }]]))
    await waitFor(() => expect(orchestration.chatsChanged.count).toBe(1))
  })

  it('shows a terminal owner’s worker thread read-only with its terminal actions and never sends', async () => {
    const backend = backendWith()
    if (backend.agentChat.snapshotResult.ok) {
      backend.agentChat.snapshotResult = { ok: true, data: { ...backend.agentChat.snapshotResult.data, surface: 'terminal' } }
    }
    const terminal = { ...orchestrator, surface: 'terminal' as const }
    const { orchestration } = openAgent(backend, [terminal])
    const stage = await agentStage()
    fireEvent.click(within(await within(stage).findByRole('treeitem', { name: 'Acolyte:DM-201' })).getByText('Acolyte:DM-201'))
    const view = within(stage).getByRole('region', { name: 'Acolyte:DM-201 thread' })
    expect(within(view).getByText('Worker is editing files')).toBeTruthy()
    expect(within(view).queryByRole('button', { name: 'Send' })).toBeNull()
    expect(within(view).queryByRole('textbox')).toBeNull()
    fireEvent.click(within(view).getByRole('button', { name: 'Open terminal' }))
    expect(orchestration.openedChats).toEqual(['chat_orch'])
    expect(within(view).getByRole('button', { name: 'Switch to GUI' })).toBeTruthy()
    expect(backend.agentChat.callsOf('send')).toEqual([])
    expect(backend.agentChat.callsOf('start')).toEqual([])
  })
})

describe('EpicAgentPanel: Changes card', () => {
  const edit = (id: string, path: string, threadId?: string): ChatItem => ({
    id, at: AT, kind: 'tool_call', name: 'Edit', input: { file_path: path }, status: 'completed', resultSummary: 'Edited',
    ...(threadId === undefined ? {} : { threadId })
  })
  const changed = [...items, edit('e1', 'src/worker.ts', 'th_1'), edit('e2', 'src/worker.ts', 'th_1'), edit('e3', 'src/lead.ts')]
  const rowNames = (card: HTMLElement): string[] => within(card).getAllByRole('listitem').map((row) => row.textContent ?? '')

  it('follows the selection: the whole run for the orchestrator, the worker’s files for its thread', async () => {
    const { orchestration } = openAgent(backendWith(changed), [orchestrator])
    const stage = await agentStage()
    const rail = within(stage).getByRole('complementary', { name: 'Epic agents' })
    const card = within(rail).getByRole('region', { name: 'Changes' })
    expect(within(rail).getByRole('tree').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await waitFor(() => expect(within(card).getAllByRole('button')[0].textContent).toBe('Changes · 2 files'))
    expect(rowNames(card)).toEqual(['src/lead.tsEEdit', 'src/worker.tsEEdit×2'])
    fireEvent.click(within(await within(rail).findByRole('treeitem', { name: 'Acolyte:DM-201' })).getByText('Acolyte:DM-201'))
    await waitFor(() => expect(within(card).getAllByRole('button')[0].textContent).toBe('Changes · 1 file'))
    expect(rowNames(card)).toEqual(['src/worker.tsEEdit×2'])
    fireEvent.click(within(card).getByRole('button', { name: /worker\.ts/ }))
    expect(orchestration.openedSourceFiles).toEqual([`${FOLDER}/src/worker.ts`])
    fireEvent.click(within(within(rail).getByRole('treeitem', { name: 'Magos' })).getAllByText('Magos')[0])
    await waitFor(() => expect(within(card).getAllByRole('button')[0].textContent).toBe('Changes · 2 files'))
  })

  it('shows the not-available text for a terminal chat', async () => {
    openAgent(backendWith(changed), [{ ...orchestrator, surface: 'terminal' as const }])
    const stage = await agentStage()
    const card = within(stage).getByRole('region', { name: 'Changes' })
    expect(within(card).getByText('Not available for terminal chats')).toBeTruthy()
  })
})

const task = (id: string, status: AgentTodoTask['status']): AgentTodoTask => ({ id, content: `Task ${id}`, status })
// 3 of 7 closed: completed and abandoned close a task; in-progress, blocked and pending do not.
const threeOfSeven: AgentTodoPhase[] = [
  { name: 'Inspect', tasks: [task('1', 'completed'), task('2', 'completed'), task('3', 'in_progress')] },
  { name: 'Deliver', tasks: [task('4', 'abandoned'), task('5', 'blocked'), task('6', 'pending'), task('7', 'pending')] }
]
// The row's own line, not its nested children's.
const ownRow = (row: HTMLElement): HTMLElement => row.querySelector(':scope > .at-row') as HTMLElement
const snapshot = (patch: Partial<AgentChatSnapshot>): CommandResult<AgentChatSnapshot> => ({
  ok: true, data: { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [], ...patch }
})

/** Each chat answers with its own snapshot, as main does. */
function snapshotsByChat(backend: FakeBackend, snapshots: Record<string, CommandResult<AgentChatSnapshot>>): void {
  const api = backend.agentChat
  const read = api.snapshot.bind(api)
  api.snapshot = (request) => {
    api.snapshotResult = snapshots[request.chatId]
    return read(request)
  }
}

describe('EpicAgentPanel: to-do progress on worker rows', () => {
  it('shows a worker thread’s 3/7 from the orchestrator’s recorded list, and nothing on a row without one', async () => {
    // The model-written label claims another count; only the recorded list counts.
    const labelled = items.map((item) => item.kind === 'thread' ? { ...item, label: 'Acolyte DM-201 done 9/9' } : item)
    const backend = backendWith(labelled)
    backend.agentChat.snapshotResult = snapshot({ items: labelled, todos: [{ threadId: 'th_1', phases: threeOfSeven }] })
    openAgent(backend, [orchestrator])
    const stage = await agentStage()
    const rail = within(stage).getByRole('complementary', { name: 'Epic agents' })
    const worker = await within(rail).findByRole('treeitem', { name: 'Acolyte:DM-201' })
    const label = await within(worker).findByRole('img', { name: 'To-dos 3 of 7 done' })
    expect(label.textContent).toBe('3/7')
    expect(label.className).toBe('at-todos')
    const magos = ownRow(within(rail).getByRole('treeitem', { name: 'Magos' }))
    expect(within(magos).queryByRole('img', { name: /^To-dos/ })).toBeNull()
    expect(rail.querySelectorAll('.at-todos')).toHaveLength(1)
    expect(rail.textContent).not.toContain('9/9')
  })

  it('hides the worker’s own to-do tool calls in its read-only thread view', async () => {
    const todoCall: ChatItem = {
      id: 'w2', at: AT, threadId: 'th_1', kind: 'tool_call', name: 'TodoWrite', input: {}, status: 'completed', resultSummary: null
    }
    openAgent(backendWith([...items, todoCall]), [orchestrator])
    const stage = await agentStage()
    fireEvent.click(within(await within(stage).findByRole('treeitem', { name: 'Acolyte:DM-201' })).getByText('Acolyte:DM-201'))
    const view = within(stage).getByRole('region', { name: 'Acolyte:DM-201 thread' })
    expect(within(view).getByText('Worker is editing files')).toBeTruthy()
    expect(within(view).queryByRole('listitem', { name: 'Tool call: TodoWrite' })).toBeNull()
  })
})

describe('EpicAgentPanel: to-do progress on chat rows', () => {
  it('reads a GUI chat row’s own list without starting it, and never subscribes to a terminal row', async () => {
    const planner = chatRecord({
      id: 'chat_plan', folder: FOLDER, role: 'planner', epicId: 'ep_1', surface: 'gui', title: 'Planner', createdAt: '2026-02-01T10:00:00.000Z'
    })
    const terminal = chatRecord({
      id: 'chat_term', folder: FOLDER, role: 'orchestrator', epicId: 'ep_1', surface: 'terminal', title: 'Old lead', createdAt: '2026-01-01T10:00:00.000Z'
    })
    const backend = backendWith()
    // The stopped chats would start under a subscription that may start.
    snapshotsByChat(backend, {
      chat_orch: snapshot({ items }),
      chat_plan: snapshot({ status: 'exited', todos: [{ threadId: null, phases: threeOfSeven }] }),
      chat_term: snapshot({ status: 'exited', surface: 'terminal', todos: [{ threadId: null, phases: threeOfSeven }] })
    })
    openAgent(backend, [orchestrator, planner, terminal])
    const stage = await agentStage()
    const rail = within(stage).getByRole('complementary', { name: 'Epic agents' })
    const lexmechanic = ownRow(await within(rail).findByRole('treeitem', { name: 'Lexmechanic' }))
    expect((await within(lexmechanic).findByRole('img', { name: 'To-dos 3 of 7 done' })).textContent).toBe('3/7')
    const old = ownRow(within(rail).getByRole('treeitem', { name: 'Old lead' }))
    expect(within(old).queryByRole('img', { name: /^To-dos/ })).toBeNull()
    expect(within(ownRow(within(rail).getByRole('treeitem', { name: 'Magos' }))).queryByRole('img', { name: /^To-dos/ })).toBeNull()
    const requests = backend.agentChat.callsOf('snapshot') as [{ chatId: string }][]
    const subscribed = requests.map(([request]) => request.chatId)
    expect(subscribed).toContain('chat_plan')
    expect(subscribed).not.toContain('chat_term')
    expect(backend.agentChat.callsOf('start')).toEqual([])
  })
})

const acolyte = { role: 'Acolyte' as const, ticketKey: 'DM-201', ordinal: null, purpose: null, ticketVerified: true }
const inquisitor = { role: 'Inquisitor' as const, ticketKey: 'DM-202', ordinal: null, purpose: null, ticketVerified: true }
const nested: ChatItem[] = [
  ...items,
  { id: 'th_2', at: AT, kind: 'thread', parentItemId: null, label: 'Review', state: 'running',
    callsign: { role: 'Acolyte', ticketKey: 'DM-202', ordinal: null, purpose: null, ticketVerified: true } },
  { id: 'th_3', at: AT, threadId: 'th_2', kind: 'thread', parentItemId: null, label: 'Inspect', state: 'running', callsign: inquisitor }
]
const prompt = (threadId: string | null, arbitration: AttentionItem['arbitration'], callsign: AttentionItem['callsign'] = acolyte): AttentionItem => ({
  chatId: 'chat_orch', promptId: `p_${threadId}`, kind: 'approval', threadId, callsign, arbitration, title: 'Run the tests?', shown: true
})
const header = (rail: HTMLElement): string => rail.querySelector('.at-header')?.textContent ?? ''

async function railWith(attention: AttentionItem[], chatItems: ChatItem[] = items) {
  const backend = backendWith(chatItems)
  backend.agentChat.attentionResult = { ok: true, data: attention }
  openAgent(backend, [orchestrator])
  const stage = await agentStage()
  const rail = within(stage).getByRole('complementary', { name: 'Epic agents' })
  await within(rail).findByRole('treeitem', { name: 'Acolyte:DM-201' })
  return { backend, stage, rail }
}

describe('EpicAgentPanel: needs you dots', () => {
  it('dots a worker approval, bubbles it to the collapsed orchestrator and counts 1 needs you', async () => {
    const { backend, rail } = await railWith([prompt('th_1', 'escalated')])
    expect(backend.agentChat.callsOf('attention')).toEqual([[{ folder: FOLDER }]])
    const worker = within(rail).getByRole('treeitem', { name: 'Acolyte:DM-201' })
    expect(await within(worker).findByRole('button', { name: 'Acolyte:DM-201 needs you' })).toBeTruthy()
    expect(header(rail)).toMatch(/^1 needs you/)
    const magos = within(rail).getByRole('treeitem', { name: 'Magos' })
    expect(within(magos).queryAllByRole('button', { name: 'Magos needs you' })).toHaveLength(0)
    fireEvent.click(within(rail).getByRole('button', { name: 'Collapse Magos' }))
    const bubbled = within(magos).getByRole('button', { name: 'Magos needs you' })
    expect(bubbled.getAttribute('title')).toBe('1 waiting below')
    expect(header(rail)).toMatch(/^1 needs you/)
  })

  it('selects the orchestrator chat that holds the card when a dot is clicked', async () => {
    const { stage, rail } = await railWith([prompt('th_1', 'off')])
    const worker = within(rail).getByRole('treeitem', { name: 'Acolyte:DM-201' })
    fireEvent.click(within(worker).getByText('Acolyte:DM-201'))
    await waitFor(() => expect(worker.getAttribute('aria-selected')).toBe('true'))
    fireEvent.click(await within(worker).findByRole('button', { name: 'Acolyte:DM-201 needs you' }))
    await waitFor(() => expect(within(rail).getByRole('treeitem', { name: 'Magos' }).getAttribute('aria-selected')).toBe('true'))
    expect(within(stage).getByRole('region', { name: 'Magos chat' })).toBeTruthy()
    expect(within(stage).queryByRole('region', { name: 'Acolyte:DM-201 thread' })).toBeNull()
  })

  it('shows the grey Magos deciding glyph for a deciding prompt and no needs-you header or dot', async () => {
    const { rail } = await railWith([prompt('th_1', 'deciding')])
    const worker = within(rail).getByRole('treeitem', { name: 'Acolyte:DM-201' })
    const glyph = await within(worker).findByRole('img', { name: 'Magos deciding' })
    expect(glyph.className).toBe('at-deciding')
    expect(within(rail).queryAllByRole('button', { name: /needs you$/ })).toHaveLength(0)
    expect(header(rail)).not.toContain('needs you')
    fireEvent.click(within(rail).getByRole('button', { name: 'Collapse Magos' }))
    expect(within(rail).queryAllByRole('button', { name: /needs you$/ })).toHaveLength(0)
  })
})

describe('EpicAgentPanel: needs you header and pushes', () => {
  it('dots a waiting worker under an expanded parent and a second, collapsed parent, and counts 2 needs you', async () => {
    const { rail } = await railWith([prompt('th_1', 'off'), prompt('th_3', 'escalated', inquisitor)], nested)
    const worker = within(rail).getByRole('treeitem', { name: 'Acolyte:DM-201' })
    expect(await within(worker).findByRole('button', { name: 'Acolyte:DM-201 needs you' })).toBeTruthy()
    fireEvent.click(within(rail).getByRole('button', { name: 'Collapse Acolyte:DM-202' }))
    const second = within(rail).getByRole('treeitem', { name: 'Acolyte:DM-202' })
    expect(within(rail).queryByRole('treeitem', { name: 'Inquisitor:DM-202' })).toBeNull()
    expect(within(second).getByRole('button', { name: 'Acolyte:DM-202 needs you' }).getAttribute('title')).toBe('1 waiting below')
    expect(within(rail).getByRole('treeitem', { name: 'Magos' }).getAttribute('aria-expanded')).toBe('true')
    expect(header(rail)).toMatch(/^2 needs you/)
  })

  it('follows attention pushes and clears the dot and header on the empty exit list', async () => {
    const { backend, rail } = await railWith([])
    expect(header(rail)).not.toContain('needs you')
    act(() => backend.agentChat.emit({ folder: FOLDER, chatId: 'chat_orch', type: 'attention', items: [prompt(null, 'off', null)] }))
    const magos = within(rail).getByRole('treeitem', { name: 'Magos' })
    expect(within(magos).getAllByRole('button', { name: 'Magos needs you' })).toHaveLength(1)
    expect(header(rail)).toMatch(/^1 needs you/)
    act(() => backend.agentChat.emit({ folder: FOLDER, chatId: 'chat_orch', type: 'attention', items: [] }))
    expect(within(rail).queryAllByRole('button', { name: /needs you$/ })).toHaveLength(0)
    expect(header(rail)).not.toContain('needs you')
  })

  it('badges an unwatched chat’s row for its subagent’s prompt and never counts prompts queued behind a shown head', async () => {
    const planner = chatRecord({
      id: 'chat_plan', folder: FOLDER, role: 'planner', epicId: 'ep_1', surface: 'gui', title: 'Planner', createdAt: '2026-02-01T10:00:00.000Z'
    })
    const backend = backendWith()
    backend.agentChat.attentionResult = { ok: true, data: [
      { ...prompt('th_9', 'off'), chatId: 'chat_plan', promptId: 'p_plan' },
      prompt('th_1', 'deciding'),
      { ...prompt('th_1', 'off'), promptId: 'p_queued', shown: false }
    ] }
    openAgent(backend, [orchestrator, planner])
    const stage = await agentStage()
    const rail = within(stage).getByRole('complementary', { name: 'Epic agents' })
    const lexmechanic = await within(rail).findByRole('treeitem', { name: 'Lexmechanic' })
    expect(await within(lexmechanic).findByRole('button', { name: 'Lexmechanic needs you' })).toBeTruthy()
    const worker = await within(rail).findByRole('treeitem', { name: 'Acolyte:DM-201' })
    expect(within(worker).getByRole('img', { name: 'Magos deciding' })).toBeTruthy()
    expect(within(worker).queryAllByRole('button', { name: /needs you$/ })).toHaveLength(0)
    expect(header(rail)).toMatch(/^1 needs you/)
  })
})

describe('EpicAgentPanel: one push subscription per GUI chat', () => {
  const planners = Array.from({ length: 9 }, (_, index) => chatRecord({
    id: `chat_plan_${index + 1}`, folder: FOLDER, role: 'planner', epicId: 'ep_1', surface: 'gui', title: 'Planner',
    createdAt: `2026-02-0${index + 1}T10:00:00.000Z`
  }))

  it('holds one subscription per chat for 10 GUI chats with a lead and a selected one, naming each planner apart', async () => {
    const backend = backendWith()
    openAgent(backend, [orchestrator, ...planners])
    const stage = await agentStage()
    const rail = within(stage).getByRole('complementary', { name: 'Epic agents' })
    const names = ['Magos', 'Lexmechanic', ...planners.slice(1).map((_, index) => `Lexmechanic-${index + 2}`)]
    for (const name of names) expect(await within(rail).findByRole('treeitem', { name })).toBeTruthy()
    const selected = within(rail).getByRole('treeitem', { name: 'Lexmechanic-2' })
    fireEvent.click(within(ownRow(selected)).getByText('Lexmechanic-2'))
    await waitFor(() => expect(selected.getAttribute('aria-selected')).toBe('true'))
    expect(within(stage).getByRole('region', { name: 'Lexmechanic-2 chat' })).toBeTruthy()
    // The lead and the selected chat appear in several views (feed, centre chat, changes card, row progress) and
    // every other row in one; each chat still holds one subscription, beside the folder's one attention listener.
    await waitFor(() => expect(backend.agentChat.subscribers()).toBe(planners.length + 1 + 1))
    const reads = (backend.agentChat.callsOf('snapshot') as [{ chatId: string }][]).map(([request]) => request.chatId)
    expect(new Set(reads)).toEqual(new Set(['chat_orch', ...planners.map((chat) => chat.id)]))
  })
})
