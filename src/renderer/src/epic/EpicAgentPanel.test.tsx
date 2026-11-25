// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import { chatRecord } from '../__mocks__/fixtures'
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

describe('EpicAgentPanel', () => {
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
    expect(backend.chats.callsOf('startPlanner')).toEqual([[{ folder: FOLDER, epicId: 'ep_1' }]])
  })

  it('shows the sign-in prompt text when no agent can start the planner', async () => {
    const backend = backendWith()
    backend.chats.plannerAgent = null
    openAgent(backend, [])
    const stage = await agentStage()
    fireEvent.click(within(stage).getByRole('button', { name: 'Start planner' }))
    expect((await within(stage).findByRole('alert')).textContent)
      .toBe('No connected agent is signed in. Sign in to one in Agents, then start the planner again.')
  })

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
})
