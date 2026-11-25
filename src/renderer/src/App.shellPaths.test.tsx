// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { agentView, chatRecord, folderView } from './__mocks__/fixtures'
import { fakeForgeSetup } from './__mocks__/forgeSetup'
import { metricsSummary } from './__mocks__/metricsFixtures'
import { settle } from './__mocks__/settle'
import { FakeBoard, cardView } from './kanban/__mocks__/fixtures'

let h: AppHarness

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
})

afterEach(cleanup)

const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))
const workspace = (): ReturnType<typeof within> => within(screen.getByRole('main', { name: 'Workspace' }))
const stored = (): unknown => JSON.parse(window.localStorage.getItem('dm.selection') ?? 'null')

async function mount(): Promise<void> {
  h.mount()
  await settle()
}

function connectClaude(): void {
  h.dm.agents = [agentView({ kind: 'claude' }), agentView({ kind: 'codex' })]
  h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'ok' }
  h.dm.agentStatuses.codex = { state: 'signed_in', reason: 'ok' }
}

describe('App footer Metrics link', () => {
  it('opens the selected folder’s Metrics dashboard and marks the link current', async () => {
    h.dm.responses.getMetricsSummary = metricsSummary()
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Metrics' }))
    await settle()
    expect(stored()).toEqual({ folderPath: '/a', epicId: null, metrics: true })
    expect(workspace().getByRole('heading', { level: 1, name: 'Metrics' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Metrics' }).getAttribute('aria-current')).toBe('page')
    expect(h.dm.callsOf('getMetricsSummary').length).toBeGreaterThan(0)
  })
})

describe('App Kanban card chat link', () => {
  it('opens the card’s chat in its folder from the card panel', async () => {
    connectClaude()
    const board = new FakeBoard(h.dm)
    const card = cardView({ id: 'kc_a', key: 'DM-7', title: 'Fix login', lane: 'in_progress', openAttempt: { number: 1, state: 'running' } })
    board.open = [card]
    h.dm.handlers.getKanbanCard = () => card
    h.dm.handlers.listKanbanMessages = () => []
    h.dm.chats.chats = [chatRecord({ id: 'chat_card', folder: '/a', cardId: 'kc_a', title: 'Kanban · DM-7 Fix login', agent: 'claude' })]
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'Kanban, 1 open card' }))
    await settle()
    fireEvent.click(workspace().getByRole('button', { name: /^DM-7/ }))
    await settle()
    fireEvent.click(within(screen.getByRole('complementary', { name: 'DM-7 Fix login' })).getAllByRole('button', { name: 'Open chat' })[0]!)
    await settle()
    expect(stored()).toEqual({ folderPath: '/a', epicId: null, chatId: 'chat_card' })
    expect(workspace().getByRole('heading', { level: 1, name: 'Kanban · DM-7 Fix login' })).toBeTruthy()
  })
})

async function prepareStandards(): Promise<void> {
  await mount()
  fireEvent.click(screen.getByRole('tab', { name: 'Delivery Standards' }))
  await settle()
  fireEvent.click(workspace().getByRole('button', { name: 'Prepare with agent' }))
  await settle()
}

describe('App delivery standards chat', () => {
  it('opens agent setup and starts no chat when no agent is connected', async () => {
    await prepareStandards()
    expect(h.dm.chats.callsOf('create')).toEqual([])
    expect(workspace().getByRole('heading', { level: 1, name: 'Add an agent' })).toBeTruthy()
  })

  it('starts a planner chat with the standards prompt and opens it', async () => {
    connectClaude()
    await prepareStandards()
    expect(h.dm.chats.callsOf('create')).toEqual([[expect.objectContaining({ folder: '/a', agent: 'claude', model: null, role: 'planner', allowSave: true, firstPrompt: expect.any(String) })]])
    expect(stored()).toEqual({ folderPath: '/a', epicId: null, chatId: 'chat_new_1' })
  })

  it('says the chat could not be opened when creating it fails', async () => {
    connectClaude()
    h.dm.chats.failures.create = { code: 'internal', message: 'Could not store the chat.' }
    await prepareStandards()
    expect(workspace().getByRole('alert').textContent).toContain('Could not open the project delivery standards chat.')
    expect(h.dm.chats.chats).toEqual([])
    expect(screen.getByRole('tab', { name: 'Delivery Standards' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('App first prompt requests while one is open', () => {
  it('keeps the open request when New chat or Summon is pressed again', async () => {
    connectClaude()
    await mount()
    fireEvent.click(within(screen.getByRole('region', { name: 'Agents' })).getByRole('button', { name: 'Summon Codex without a project' }))
    await settle()
    const dialog = screen.getByRole('dialog', { name: 'Start a new chat' })
    fireEvent.click(within(screen.getByRole('region', { name: 'Agents' })).getByRole('button', { name: 'Summon Claude Code without a project' }))
    fireEvent.click(sidebar().getByRole('button', { name: 'New chat in alpha' }))
    await settle()
    expect(screen.getAllByRole('dialog')).toEqual([dialog])
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'First prompt' }), { target: { value: 'Tidy up' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }))
    await settle()
    expect(h.dm.chats.callsOf('create')).toEqual([[{ folder: null, agent: 'codex', model: null, firstPrompt: 'Tidy up' }]])
  })
})

describe('App Forge World creation without a folder to open', () => {
  it('closes the dialog and stays on the current folder when the receipt names no world or member', async () => {
    const setup = fakeForgeSetup()
    setup.provision.mockImplementation(async (request, id) => ({ id, request, state: 'complete', phase: 'complete', message: null }))
    Object.assign(h.dm, { forgeSetup: setup })
    h.github.account = { login: 'fixture', name: 'Fixture' }
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Add a Forge World' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create a Forge World…' }))
    await settle()
    const dialog = within(screen.getByRole('dialog', { name: 'Create a Forge World' }))
    fireEvent.change(dialog.getByLabelText('World repository name'), { target: { value: 'world' } })
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }))
    await settle()
    expect(setup.provision).toHaveBeenCalledExactlyOnceWith({ world: { kind: 'new', name: 'world' } }, expect.any(String))
    expect(screen.queryByRole('dialog', { name: 'Create a Forge World' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'alpha' })).toBeTruthy()
  })
})
