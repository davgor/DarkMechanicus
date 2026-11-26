// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentChatSnapshot, AgentTodoPhase, AgentTodoTask, AttentionItem } from '../../../shared/agents/agentChat'
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import type { CommandResult } from '../../../shared/desktop/api'
import { chatRecord } from '../__mocks__/fixtures'
import { FakeChats } from '../__mocks__/fakeChats'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend } from './__mocks__/fakeBackend'
import { fakeOrchestration } from './__mocks__/fakeOrchestration'
import { folder, runView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

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
    expect(within(view).getByText('Your message goes through Magos, which passes it to this worker.')).toBeTruthy()
  })

  it('relays to the owning chat with the exact marker and never the label', async () => {
    const backend = backendWith()
    openAgent(backend, [orchestrator])
    const stage = await agentStage()
    fireEvent.click(within(await within(stage).findByRole('treeitem', { name: 'Acolyte:DM-201' })).getByText('Acolyte:DM-201'))
    fireEvent.change(within(stage).getByLabelText('Message Acolyte:DM-201'), { target: { value: 'Please rebase first' } })
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
  })
})

describe('EpicAgentPanel: rail memory and empty epic', () => {
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

  it('offers Start planner with no agents and starts it with the epic id', async () => {
    const backend = backendWith()
    const { orchestration } = openAgent(backend, [])
    const stage = await agentStage()
    fireEvent.click(within(stage).getByRole('button', { name: 'Start planner' }))
    await waitFor(() => expect(orchestration.chatsChanged.count).toBe(1))
    expect((backend.chats as FakeChats).callsOf('startPlanner')).toEqual([[{ folder: FOLDER, epicId: 'ep_1' }]])
  })

  it('shows the sign-in prompt text when no agent can start the planner', async () => {
    const backend = backendWith()
    ;(backend.chats as FakeChats).plannerAgent = null
    openAgent(backend, [])
    const stage = await agentStage()
    fireEvent.click(within(stage).getByRole('button', { name: 'Start planner' }))
    expect((await within(stage).findByRole('alert')).textContent)
      .toBe('No connected agent is signed in. Sign in to one in Agents, then start the planner again.')
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
})
