// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FakeChats } from '../__mocks__/fakeChats'
import { chatRecord } from '../__mocks__/fixtures'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { fakeOrchestration } from './__mocks__/fakeOrchestration'
import { draftPlan, epicDetail, folder, runView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'

beforeAll(installDomShims)
afterEach(() => {
  cleanup()
  localStorage.clear()
})

async function panelToggle(): Promise<HTMLButtonElement> {
  return screen.findByRole('button', { name: 'Orchestrator messages' })
}

describe('Orchestrator messages', () => {
  it('is collapsed by default and remembers expansion', async () => {
    const backend = new FakeBackend()
    const first = renderWorkspace(backend)
    const toggle = await panelToggle()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => expect(localStorage.getItem('dm.orchestratorMessages.open')).toBe('true'))
    first.unmount()
    renderWorkspace(backend)
    expect((await panelToggle()).getAttribute('aria-expanded')).toBe('true')
  })

  it('follows Attempts in saved view and Validation in draft view', async () => {
    const backend = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() }))
    renderWorkspace(backend)
    const panel = (await panelToggle()).closest('section') as HTMLElement
    const attempts = screen.getByRole('button', { name: 'Attempts' }).closest('section') as HTMLElement
    expect(attempts.nextElementSibling).toBe(panel)
    fireEvent.click(screen.getByRole('button', { name: 'View draft' }))
    const validation = await screen.findByLabelText('Draft validation')
    expect(validation.nextElementSibling).toBe(panel)
  })

  it('sends to the epic-only target', async () => {
    const backend = new FakeBackend()
    renderWorkspace(backend)
    fireEvent.click(await panelToggle())
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'Status please' } })
    const send = screen.getByRole('button', { name: 'Send' })
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false))
    fireEvent.click(send)
    await waitFor(() => expect(backend.state.comments).toHaveLength(1))
    expect(backend.state.comments[0]).toMatchObject({ epicId: 'ep_1', body: 'Status please' })
    // FakeBackend installs this concrete chat fake behind the production ChatsApi boundary.
    const chats = backend.chats as FakeChats
    const request = chats.callsOf('sendConversationMessage')[0]?.[0]
    expect(request).toMatchObject({ target: { epicId: 'ep_1' } })
    expect(request).toBeTruthy()
    if (request !== null && typeof request === 'object' && 'target' in request) {
      expect(request.target).not.toHaveProperty('ticketId')
    }
  })

  it('does not offer Send for a completed epic', async () => {
    renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ status: 'completed' }), run: runView({ state: 'completed' }) })))
    fireEvent.click(await panelToggle())
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })
})

describe('Orchestrator messages: Open chat', () => {
  it('lands Open chat in the Agent tab with that chat selected, without leaving the epic', async () => {
    const FOLDER = folder().path
    const planner = chatRecord({ id: 'chat_plan', folder: FOLDER, role: 'planner', epicId: 'ep_1', surface: 'gui', title: 'Planner · Plan', createdAt: '2026-03-01T09:00:00.000Z' })
    const bound = chatRecord({
      id: 'chat_conv', folder: FOLDER, role: 'orchestrator', epicId: 'ep_1', surface: 'gui', title: 'Answering the board',
      conversation: { epicId: 'ep_1' }, createdAt: '2026-03-01T08:00:00.000Z'
    })
    const backend = new FakeBackend()
    ;(backend.chats as FakeChats).chats = [planner, bound]
    const host = fakeOrchestration({ chats: [planner, bound] })
    renderWorkspace(backend, { orchestration: host })
    fireEvent.click(await panelToggle())

    fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }))

    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-pressed')).toBe('true')
    const stage = screen.getByRole('region', { name: 'Agent chat' })
    const tree = within(within(stage).getByRole('complementary', { name: 'Epic agents' }))
    expect((await tree.findByRole('treeitem', { name: 'Answering the board' })).getAttribute('aria-selected')).toBe('true')
    expect(tree.getByRole('treeitem', { name: 'Lexmechanic' }).getAttribute('aria-selected')).toBe('false')
    expect(host.openedChats).toEqual([])
  })

  it('opens a receiving folder chat the epic does not list outside the epic', async () => {
    const elsewhere = chatRecord({ id: 'chat_f', folder: folder().path, role: 'orchestrator', surface: 'gui', title: 'Folder chat' })
    const backend = new FakeBackend()
    const chats = backend.chats as FakeChats
    chats.chats = [elsewhere]
    // Main resolved the board conversation to an ordinary folder chat that is not bound to this epic.
    chats.conversationState = async () => ({ ok: true, data: { chat: { id: 'chat_f', title: 'Folder chat', via: 'conversation' }, deliveries: {} } })
    const host = fakeOrchestration({ chats: [elsewhere] })
    renderWorkspace(backend, { orchestration: host })
    fireEvent.click(await panelToggle())

    fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }))

    expect(host.openedChats).toEqual(['chat_f'])
    expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('region', { name: 'Agent chat' })).toBeNull()
  })
})
