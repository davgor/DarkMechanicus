// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within, type BoundFunctions, type queries } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { FakeTerminals } from './__mocks__/fakeTerminals'
import { agentView, chatRecord, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness
let terminals: FakeTerminals

const IN_ALPHA = chatRecord({ id: 'chat_alpha', folder: '/a', title: 'Alpha plan', agent: 'claude', updatedAt: '2026-03-01T10:00:00.000Z' })
const SUMMONED = chatRecord({ id: 'chat_free', folder: null, title: 'Tidy every board', agent: 'claude', role: 'orchestrator', updatedAt: '2026-03-03T10:00:00.000Z' })
const IN_BETA = chatRecord({ id: 'chat_beta', folder: '/b', title: 'Beta work', agent: 'claude', updatedAt: '2026-03-02T10:00:00.000Z' })
const CODEX = chatRecord({ id: 'chat_codex', folder: '/a', title: 'Codex review', agent: 'codex', updatedAt: '2026-03-04T10:00:00.000Z' })

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  terminals = new FakeTerminals()
  h.dm.terminals = terminals
  h.dm.folders = [folderView({ path: '/a', name: 'alpha' }), folderView({ path: '/b', name: 'beta' })]
  h.dm.agents = [agentView({ kind: 'claude' }), agentView({ kind: 'codex' })]
  h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'ok' }
  h.dm.agentStatuses.codex = { state: 'signed_in', reason: 'ok' }
  h.dm.chats.chats = [IN_ALPHA, SUMMONED, IN_BETA, CODEX]
})

afterEach(cleanup)

const agentsSection = (): BoundFunctions<typeof queries> => within(screen.getByRole('region', { name: 'Agents' }))
const workspace = (): BoundFunctions<typeof queries> => within(screen.getByRole('main', { name: 'Workspace' }))
const toggle = (name = 'Claude Code'): HTMLElement => agentsSection().getByRole('button', { name: `Chats of ${name}` })
const agentChats = (name = 'Claude Code'): HTMLElement => agentsSection().getByRole('list', { name: `Chats of ${name}` })
const rows = (name = 'Claude Code'): string[] =>
  Array.from(agentChats(name).querySelectorAll('.chat-row')).map((row) => `${row.querySelector('.chat-row-title')?.textContent} | ${row.querySelector('.chat-row-place')?.textContent}`)

async function mount(): Promise<void> {
  h.mount()
  await settle()
}

async function expand(name = 'Claude Code'): Promise<void> {
  fireEvent.click(toggle(name))
  await settle()
}

describe('AGENTS section: each agent’s chats', () => {
  it('expands an agent to list its chats from every folder and the project-less ones, newest first, each labelled', async () => {
    await mount()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(agentsSection().queryByRole('list', { name: 'Chats of Claude Code' })).toBeNull()

    await expand()

    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(rows()).toEqual(['Tidy every board | No project', 'Beta work | beta', 'Alpha plan | alpha'])
  })

  it('keeps the list current as chats are created, renamed and deleted elsewhere, without a reload', async () => {
    await mount()
    await expand()

    await act(async () => {
      await window.dm.chats.create({ folder: '/a', agent: 'claude', role: 'planner', title: 'Fresh one' })
      await window.dm.chats.rename({ folder: '/b', chatId: IN_BETA.id, title: 'Beta renamed' })
      await window.dm.chats.delete({ folder: null, chatId: SUMMONED.id })
    })
    await settle()

    expect(rows()).toEqual(['Beta renamed | beta', 'Fresh one | alpha', 'Alpha plan | alpha'])
  })

  it('renames and deletes from a row’s menu, with the same dialogs as a folder’s chat rows', async () => {
    await mount()
    await expand()
    const row = within(agentChats()).getByRole('button', { name: /^Tidy every board/ }).closest('.chat-row') as HTMLElement

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for Tidy every board' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const rename = screen.getByRole('dialog', { name: 'Rename chat' })
    fireEvent.change(within(rename).getByRole('textbox'), { target: { value: 'Boards, tidied' } })
    fireEvent.click(within(rename).getByRole('button', { name: 'Rename chat' }))
    await settle()
    expect(h.dm.chats.callsOf('rename')).toEqual([[{ folder: null, chatId: SUMMONED.id, title: 'Boards, tidied' }]])

    const renamed = within(agentChats()).getByRole('button', { name: /^Boards, tidied/ }).closest('.chat-row') as HTMLElement
    fireEvent.click(within(renamed).getByRole('button', { name: 'Actions for Boards, tidied' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete this chat?' })).getByRole('button', { name: 'Delete chat' }))
    await settle()
    expect(h.dm.chats.callsOf('delete')).toEqual([[{ folder: null, chatId: SUMMONED.id }]])
    expect(rows()).toEqual(['Beta work | beta', 'Alpha plan | alpha'])
  })
})

describe('AGENTS section: opening an agent’s chats', () => {
  it('opens a folder chat in its folder and a project-less chat on its own, each in its terminal', async () => {
    await mount()
    await expand()

    fireEvent.click(within(agentChats()).getByRole('button', { name: /^Beta work/ }))
    await settle()
    expect(workspace().getByRole('heading', { level: 1, name: 'Beta work' })).toBeTruthy()

    fireEvent.click(within(agentChats()).getByRole('button', { name: /^Tidy every board/ }))
    await settle()
    expect(workspace().getByRole('heading', { level: 1, name: 'Tidy every board' })).toBeTruthy()
    expect(terminals.calls).toEqual([
      ['/b', IN_BETA.id],
      [null, SUMMONED.id]
    ])
    expect(within(agentChats()).getByRole('button', { name: /^Tidy every board/ }).getAttribute('aria-current')).toBe('true')
  })

  it('shows the live dot and the sign-in badge on an agent’s chat rows', async () => {
    h.dm.agentStatuses.claude = { state: 'signed_out', reason: 'Signed out.' }
    h.dm.chats.chats = [{ ...SUMMONED, cutShortMessageId: 'm1' }]
    await mount()
    await expand()
    fireEvent.click(within(agentChats()).getByRole('button', { name: /^Tidy every board/ }))
    await settle()

    const row = within(agentChats()).getByRole('button', { name: /^Tidy every board/ })
    expect(within(row).getByText('Needs sign-in')).toBeTruthy()
    expect(within(row).queryByRole('img', { name: 'terminal running' })).toBeTruthy()
  })

  it('says so when an expanded agent has no chats', async () => {
    h.dm.chats.chats = []
    await mount()
    await expand()

    expect(agentsSection().getByText('No chats yet.')).toBeTruthy()
  })
})

describe('AGENTS section: summoning an agent with no project', () => {
  it('asks for the first prompt, creates a project-less chat with that agent, opens it and lists it under the agent only', async () => {
    h.dm.chats.chats = [IN_ALPHA]
    await mount()

    fireEvent.click(agentsSection().getByRole('button', { name: 'Summon Claude Code without a project' }))
    const dialog = screen.getByRole('dialog', { name: 'Start a new chat' })
    expect(within(dialog).queryByRole('radiogroup')).toBeNull()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'First prompt' }), { target: { value: 'Tidy every board' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }))
    await settle()

    expect(h.dm.chats.callsOf('create')).toEqual([[{ folder: null, agent: 'claude', model: null, firstPrompt: 'Tidy every board' }]])
    const created = h.dm.chats.chats.find((chat) => chat.folder === null)
    expect(created).toMatchObject({ role: 'orchestrator', allowSave: true })
    expect(terminals.calls).toEqual([[null, created?.id]])
    await expand()
    expect(rows()).toEqual(['New chat | No project', 'Alpha plan | alpha'])
    const folderTitles = Array.from(document.querySelectorAll('.agents-block .chat-row-title')).map((element) => element.textContent)
    expect(folderTitles).not.toContain('New chat')
  })

  it('reopens a project-less chat after a reload, and falls back once it is deleted', async () => {
    await mount()
    await expand()
    fireEvent.click(within(agentChats()).getByRole('button', { name: /^Tidy every board/ }))
    await settle()
    cleanup()

    await mount()
    expect(workspace().getByRole('heading', { level: 1, name: 'Tidy every board' })).toBeTruthy()

    await act(async () => {
      await window.dm.chats.delete({ folder: null, chatId: SUMMONED.id })
    })
    await settle()
    expect(workspace().queryByRole('heading', { level: 1, name: 'Tidy every board' })).toBeNull()
  })
})
