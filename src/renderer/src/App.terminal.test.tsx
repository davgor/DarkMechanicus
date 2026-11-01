// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within, type BoundFunctions, type queries } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { FakeTerminals } from './__mocks__/fakeTerminals'
import { agentView, chatRecord, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness
let terminals: FakeTerminals
let opened: unknown[]

const CHAT = chatRecord({ id: 'chat_a', folder: '/a', title: 'Fix the build', agent: 'claude', model: 'opus', updatedAt: '2026-03-01T10:00:00.000Z' })
const OTHER = chatRecord({ id: 'chat_b', folder: '/a', title: 'Other chat', agent: 'claude', updatedAt: '2026-03-02T10:00:00.000Z' })

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  terminals = new FakeTerminals()
  h.dm.terminals = terminals
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
  h.dm.agents = [agentView({ kind: 'claude' })]
  h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'ok' }
  h.dm.chats.chats = [CHAT, OTHER]
  h.dm.chats.transcripts[CHAT.id] = [{ id: 'u1', at: '2026-03-01T10:00:00.000Z', kind: 'user_message', text: 'Why is CI red?' }]
  opened = []
  window.open = (...args: unknown[]) => {
    opened.push(args)
    return null
  }
})

afterEach(cleanup)

const sidebar = (): BoundFunctions<typeof queries> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))
const workspace = (): BoundFunctions<typeof queries> => within(screen.getByRole('main', { name: 'Workspace' }))
const row = (title: RegExp): HTMLElement => sidebar().getByRole('button', { name: title })
const liveDot = (title: RegExp): HTMLElement | null => within(row(title)).queryByRole('img', { name: 'terminal running' })

async function openChat(title: RegExp = /^Fix the build/): Promise<void> {
  fireEvent.click(row(title))
  await settle()
}

describe('App chat terminal', () => {
  it('shows the chat’s terminal in the main area in place of its transcript, in this window', async () => {
    h.mount()
    await settle()
    await openChat()

    expect(terminals.calls).toEqual([['/a', 'chat_a']])
    expect(workspace().getByRole('heading', { level: 1, name: 'Fix the build' })).toBeTruthy()
    expect(within(workspace().getByRole('list', { name: 'Chat details' })).getByText('Running')).toBeTruthy()
    expect(h.terminalKit.latest().host).toBe(workspace().getByTestId('terminal-host'))
    expect(screen.queryByRole('log', { name: 'Transcript' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
    expect(workspace().queryByRole('combobox', { name: 'Model' })).toBeNull()
    expect(opened).toEqual([])
  })

  it('keeps one terminal mounted: switching disposes the shown one, and showing a chat again paints main’s snapshot of it', async () => {
    terminals.screens = { chat_a: 'screen of a', chat_b: 'screen of b' }
    h.mount()
    await settle()
    await openChat()
    await openChat(/^Other chat/)
    const [first, second] = h.terminalKit.views
    expect(first?.disposed).toBe(true)
    expect(second?.written).toEqual(['screen of b'])

    terminals.screens.chat_a = 'screen of a, later'
    await openChat()
    expect(h.terminalKit.latest().written).toEqual(['screen of a, later'])
    expect(h.terminalKit.views.filter((view) => !view.disposed)).toHaveLength(1)
    expect(terminals.calls.map(([, chatId]) => chatId)).toEqual(['chat_a', 'chat_b', 'chat_a'])
  })

  it('paints the shown chat from main’s snapshot after a reload', async () => {
    terminals.screens.chat_a = 'the screen before the reload'
    h.mount()
    await settle()
    await openChat()
    cleanup()

    h.mount()
    await settle()
    expect(workspace().getByRole('heading', { level: 1, name: 'Fix the build' })).toBeTruthy()
    expect(h.terminalKit.latest().written).toEqual(['the screen before the reload'])
    expect(terminals.calls).toEqual([
      ['/a', 'chat_a'],
      ['/a', 'chat_a']
    ])
  })
})

describe('App chat terminal rows', () => {
  it('marks the sidebar rows of chats whose terminal runs, also while another is shown, until the CLI exits', async () => {
    h.mount()
    await settle()
    expect(liveDot(/^Fix the build/)).toBeNull()

    await openChat()
    await openChat(/^Other chat/)
    expect(liveDot(/^Fix the build/)).toBeTruthy()
    expect(liveDot(/^Other chat/)).toBeTruthy()

    const [chatA] = terminals.handles
    act(() => chatA?.emitExit({ exitCode: 0, signal: null, message: null, resumed: false }))
    expect(liveDot(/^Fix the build/)).toBeNull()
    expect(liveDot(/^Other chat/)).toBeTruthy()
  })

  it('marks no row for a chat whose CLI did not start', async () => {
    terminals.outcomes.chat_a = { state: 'signed_out', message: 'Claude Code is signed out.' }
    h.mount()
    await settle()
    await openChat()
    expect(workspace().getByRole('status').textContent).toBe('Claude Code is signed out.')
    expect(liveDot(/^Fix the build/)).toBeNull()
  })
})

describe('App old chats with an unanswered request', () => {
  it('flags nothing: the request is a record of an agent that is gone, and no approval waits in the app', async () => {
    h.dm.chats.transcripts[CHAT.id] = [
      { id: 'u1', at: '2026-03-01T10:00:00.000Z', kind: 'user_message', text: 'Install it' },
      { id: 'q1', at: '2026-03-01T10:00:01.000Z', kind: 'approval_request', requestId: 'q1', category: 'command', tool: 'Bash', summary: 'npm install' }
    ]
    h.mount()
    await settle()
    expect(sidebar().queryByText('Needs approval')).toBeNull()
    fireEvent.click(sidebar().getByRole('button', { name: 'Collapse alpha' }))
    expect(within(sidebar().getByRole('button', { name: /^alpha/ })).queryByText(/waiting/)).toBeNull()
  })
})
