// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatEvent } from '../../../shared/agents/agentChat'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { AgentChat } from './AgentChat'
import { agentChatScenarios } from './__mocks__/agentChatScenario'

const ref = { folder: null, chatId: 'fixture-chat' }
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount(name: keyof typeof agentChatScenarios = 'empty') {
  const scenario = agentChatScenarios[name]
  const api = new FakeAgentChat()
  const scheduler = new ManualScheduler()
  api.snapshotResult = { ok: true, data: scenario.snapshot }
  const view = render(<AgentChat {...ref} agentLabel="Magos" api={api} scheduler={scheduler} />)
  await settle()
  function emit(events: AgentChatEvent[]) {
    act(() => {
      for (const event of events) api.emit(event)
      scheduler.fireTimeouts(33)
    })
  }
  emit(scenario.events)
  return { ...view, api, emit, commit: () => emit(scenario.commit) }
}

it('renders the empty scenario with a text-only bounded composer', async () => {
  await mount()
  expect(screen.getByText('Send a message to Magos to begin.')).toBeTruthy()
  expect(screen.getByRole('textbox').getAttribute('maxlength')).toBe('20000')
  expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
  expect(document.querySelector('input[type="file"]')).toBe(null)
})

it('renders user/assistant roles, live Markdown, thinking and exactly one committed reply', async () => {
  const view = await mount('streaming')
  expect(screen.getByRole('article', { name: 'You' }).textContent).toContain('Check the chat view.')
  expect(screen.getByRole('article', { name: 'Assistant' }).querySelector('strong')?.textContent).toBe('chat view')
  const live = screen.getByRole('article', { name: 'Assistant streaming' })
  expect(live.querySelector('strong')?.textContent).toBe('streamed reply')
  expect(within(live).getByText('Checking layout and keyboard behavior.')).toBeTruthy()
  expect(screen.getByLabelText('Queued messages').textContent).toBe('2 queued')
  view.commit()
  expect(screen.queryByRole('article', { name: 'Assistant streaming' })).toBe(null)
  expect(screen.getAllByText('streamed reply')).toHaveLength(1)
})

it('renders a running tool, updates it in place and opens the subagent thread', async () => {
  const view = await mount('tool')
  const tool = screen.getByRole('listitem', { name: 'Tool call: Read' })
  expect(tool.textContent).toMatch(/running/i)
  view.commit()
  expect(screen.getAllByRole('listitem', { name: 'Tool call: Read' })).toHaveLength(1)
  fireEvent.click(within(tool).getByRole('button'))
  expect(tool.textContent).toContain('Read 120 lines')
  const thread = screen.getByRole('listitem', { name: 'Thread: Acolyte:DM-785' })
  fireEvent.click(within(thread).getByRole('button'))
  expect(within(thread).getByText('Composer keyboard behavior inspected.')).toBeTruthy()
})

it('hides completed to-do calls but keeps the failed TodoWrite and Bash cards', async () => {
  const { emit } = await mount()
  emit([
    { id: 'todo-done', name: 'TodoWrite', status: 'completed' },
    { id: 'task-done', name: 'TaskUpdate', status: 'completed' },
    { id: 'todo-failed', name: 'TodoWrite', status: 'failed' },
    { id: 'bash-done', name: 'Bash', status: 'completed' }
  ].map(({ id, name, status }) => ({
    ...ref, type: 'item', item: {
      id, name, status: status as 'completed' | 'failed', kind: 'tool_call',
      at: '2026-11-24T08:00:00.000Z', input: {}, resultSummary: id
    }
  })))
  const cards = screen.getAllByRole('listitem', { name: /^Tool call:/ })
  expect(cards).toHaveLength(2)
  const failed = screen.getByRole('listitem', { name: 'Tool call: TodoWrite' })
  expect(failed.textContent).toMatch(/failed/i)
  fireEvent.click(within(failed).getByRole('button'))
  expect(within(failed).getByText('todo-failed')).toBeTruthy()
  const bash = screen.getByRole('listitem', { name: 'Tool call: Bash' })
  expect(within(bash).getByText('Done')).toBeTruthy()
  fireEvent.click(within(bash).getByRole('button'))
  expect(within(bash).getByText('bash-done')).toBeTruthy()
  expect(screen.queryByRole('listitem', { name: 'Tool call: TaskUpdate' })).toBe(null)
})

it('sends on Enter, preserves Shift+Enter and IME composition, and ignores blank drafts', async () => {
  const { api } = await mount()
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'Inspect the composer\ncarefully' } })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(api.callsOf('send')).toEqual([])
  fireEvent.keyDown(input, { key: 'Enter' })
  await settle()
  expect(api.callsOf('send')).toEqual([[{ ...ref, text: 'Inspect the composer\ncarefully' }]])
  expect(input).toHaveProperty('value', '')
  fireEvent.change(input, { target: { value: '  ' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(api.callsOf('send')).toHaveLength(1)
})

it('sends with the button and retains the draft on a command failure', async () => {
  const { api } = await mount()
  api.failures.send = { code: 'conflict', message: 'Session is unavailable.' }
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await settle()
  expect(screen.getByRole('alert').textContent).toBe('Session is unavailable.')
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'Keep this draft')
})

it('does not duplicate in-flight sends or discard text typed while sending', async () => {
  const { api } = await mount()
  const hold = api.hold('send')
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'First' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.change(input, { target: { value: 'Next' } })
  hold.resolve()
  await settle()
  expect(api.callsOf('send')).toHaveLength(1)
  expect(input).toHaveProperty('value', 'Next')
})

it('Stop and Escape interrupt only while busy; Enter still queues a message', async () => {
  const { api, emit } = await mount('streaming')
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await settle()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  await settle()
  expect(api.callsOf('interrupt')).toEqual([[ref], [ref]])
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Queued steering' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  await settle()
  expect(api.callsOf('send')).toEqual([[{ ...ref, text: 'Queued steering' }]])
  emit([{ ...ref, type: 'status', status: 'idle' }])
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(screen.queryByRole('button', { name: 'Stop' })).toBe(null)
  expect(api.callsOf('interrupt')).toHaveLength(2)
})

it('switches the idle chat to Terminal and refuses it while busy', async () => {
  const { api, emit } = await mount()
  const terminal = screen.getByRole('button', { name: 'Terminal' })
  emit([{ ...ref, type: 'status', status: 'busy' }])
  expect(terminal).toHaveProperty('disabled', true)
  expect(terminal.parentElement?.title).toContain('idle')
  fireEvent.click(terminal)
  expect(api.callsOf('setSurface')).toEqual([])
  emit([{ ...ref, type: 'status', status: 'idle' }])
  fireEvent.click(terminal)
  await settle()
  expect(api.callsOf('setSurface')).toEqual([[{ ...ref, surface: 'terminal' }]])
})

it('consumes the approval scenario and disables Terminal even when the agent is idle', async () => {
  const { api, emit } = await mount('approval')
  const terminal = screen.getByRole('button', { name: 'Terminal' })
  expect(terminal).toHaveProperty('disabled', true)
  fireEvent.click(terminal)
  expect(api.callsOf('setSurface')).toEqual([])
  emit([{ ...ref, type: 'pending', prompt: null }])
  expect(terminal).toHaveProperty('disabled', false)
})

it('consumes the error scenario and renders the failed transcript notice', async () => {
  await mount('error')
  expect(screen.getByText('The agent process stopped unexpectedly.')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('failed')
  expect(screen.getByRole('textbox')).toHaveProperty('disabled', true)
})

it('labels starting, signed-out and exited status without enabling Terminal', async () => {
  const { emit } = await mount()
  for (const status of ['starting', 'signed_out', 'exited'] as const) {
    emit([{ ...ref, type: 'status', status }])
    expect(screen.getByRole('status').textContent).toBe(status.replace('_', ' '))
    expect(screen.getByRole('button', { name: 'Terminal' })).toHaveProperty('disabled', true)
  }
})

it('pins updates unless scrolled up, then resumes pinning at the bottom', async () => {
  const { emit } = await mount()
  const scroll = screen.getByLabelText('Chat messages')
  Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } })
  const delta = (text: string): AgentChatEvent => ({ ...ref, type: 'delta', itemId: 'scroll', kind: 'text', text })
  emit([delta('first')])
  expect(scroll.scrollTop).toBe(1000)
  scroll.scrollTop = 100
  fireEvent.scroll(scroll)
  emit([delta(' second')])
  expect(scroll.scrollTop).toBe(100)
  scroll.scrollTop = 800
  fireEvent.scroll(scroll)
  Object.defineProperty(scroll, 'scrollHeight', { value: 1200 })
  emit([delta(' third')])
  expect(scroll.scrollTop).toBe(1200)
})

it('repins viewport-only resizes without moving a person who scrolled up', async () => {
  const observers = new Map<Element, () => void>()
  vi.stubGlobal('ResizeObserver', class {
    constructor(private notify: () => void) {}
    observe(target: Element) { observers.set(target, this.notify) }
    disconnect() { observers.clear() }
  })
  const { unmount } = await mount('tool')
  const scroll = screen.getByLabelText('Chat messages')
  const content = scroll.firstElementChild
  let height = 400
  let top = 600
  Object.defineProperties(scroll, {
    scrollHeight: { value: 1000 },
    clientHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.min(value, 1000 - height) } }
  })
  fireEvent.scroll(scroll)
  expect(observers.has(scroll)).toBe(true)
  expect(observers.has(content!)).toBe(true)
  // No content resize or model update: only the viewport shrinks.
  height = 200
  act(() => observers.get(scroll)!())
  expect(scroll.scrollTop).toBe(800)
  scroll.scrollTop = 100
  fireEvent.scroll(scroll)
  height = 100
  act(() => observers.get(scroll)!())
  expect(scroll.scrollTop).toBe(100)
  // Returning to the bottom restores pinning for subsequent viewport resizes.
  scroll.scrollTop = 900
  fireEvent.scroll(scroll)
  height = 150
  act(() => observers.get(scroll)!())
  expect(scroll.scrollTop).toBe(850)
  unmount()
  expect(observers.size).toBe(0)
})

it('clears local draft and error state when selecting another chat', async () => {
  const view = await mount()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Private draft for first chat' } })
  view.rerender(<AgentChat folder={null} chatId="other-chat" agentLabel="Worker" api={view.api} />)
  await settle()
  expect(screen.getByRole('textbox')).toHaveProperty('value', '')
})

async function mountTree(rail: 'none' | 'toggle', chatId = 'fixture-chat') {
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: agentChatScenarios.tree.snapshot }
  const view = render(<AgentChat folder={null} chatId={chatId} agentLabel="Claude Code" api={api} rail={rail} />)
  await settle()
  return { ...view, api }
}

const level = (name: string) => screen.getByRole('treeitem', { name }).getAttribute('aria-level')

describe('Agents rail', () => {
  beforeEach(() => window.localStorage.clear())

  it('offers no Agents button with the default rail', async () => {
    await mountTree('none')
    expect(screen.queryByRole('button', { name: /^Agents/ })).toBe(null)
    expect(screen.queryByRole('complementary', { name: 'Chat agents' })).toBe(null)
  })

  it('opens a named, nested tree of the chat’s subagents', async () => {
    await mountTree('toggle')
    const toggle = screen.getByRole('button', { name: /^Agents/ })
    expect(toggle.textContent).toBe('Agents 4')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('complementary', { name: 'Chat agents' })).toBe(null)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const rail = screen.getByRole('complementary', { name: 'Chat agents' })
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.contains(rail)).toBe(true)
    const names = () => within(rail).getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'))
    expect(names()).toEqual(['Claude Code', 'Acolyte:DM-2', 'Inquisitor:DM-2', 'Servitor-1', 'Finished 1'])
    expect([level('Claude Code'), level('Acolyte:DM-2'), level('Inquisitor:DM-2'), level('Servitor-1'), level('Finished 1')])
      .toEqual(['1', '2', '3', '2', '2'])
    fireEvent.click(within(screen.getByRole('treeitem', { name: 'Finished 1' })).getByText('Finished 1'))
    expect(names()).toEqual(['Claude Code', 'Acolyte:DM-2', 'Inquisitor:DM-2', 'Servitor-1', 'Finished 1', 'Acolyte:DM-1'])
    expect(level('Acolyte:DM-1')).toBe('3')
    fireEvent.click(toggle)
    expect(screen.queryByRole('complementary', { name: 'Chat agents' })).toBe(null)
  })
})

describe('Agents rail selection and memory', () => {
  beforeEach(() => window.localStorage.clear())

  it('reveals a nested subagent’s thread and every enclosing block, scrolling once', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      await mountTree('toggle')
      const thread = (label: string) => screen.getByRole('listitem', { name: `Thread: ${label}` })
      const expanded = (label: string) => within(thread(label)).getAllByRole('button')[0].getAttribute('aria-expanded')
      expect(expanded('Acolyte:DM-2')).toBe('false')
      fireEvent.click(screen.getByRole('button', { name: /^Agents/ }))
      const inquisitor = screen.getByRole('treeitem', { name: 'Inquisitor:DM-2' })
      fireEvent.click(inquisitor.querySelector('.at-row')!)
      expect(expanded('Acolyte:DM-2')).toBe('true')
      expect(expanded('Inquisitor:DM-2')).toBe('true')
      expect(expanded('Acolyte:DM-1')).toBe('false')
      expect(inquisitor.getAttribute('aria-selected')).toBe('true')
      expect(scroll.mock.contexts).toEqual([thread('Inquisitor:DM-2')])
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })

  it('remembers the open rail for the same chat id only', async () => {
    const first = await mountTree('toggle')
    fireEvent.click(screen.getByRole('button', { name: /^Agents/ }))
    first.unmount()
    const again = await mountTree('toggle')
    expect(screen.getByRole('complementary', { name: 'Chat agents' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Agents/ }).getAttribute('aria-pressed')).toBe('true')
    again.rerender(<AgentChat folder={null} chatId="other-chat" agentLabel="Claude Code" api={again.api} rail="toggle" />)
    await settle()
    expect(screen.queryByRole('complementary', { name: 'Chat agents' })).toBe(null)
    expect(screen.getByRole('button', { name: /^Agents/ }).getAttribute('aria-pressed')).toBe('false')
  })
})

describe('Agents toggle and rail chevron', () => {
  beforeEach(() => window.localStorage.clear())

  it('shares one state between the Agents toggle and the rail chevron', async () => {
    const first = await mountTree('toggle')
    const toggle = () => screen.getByRole('button', { name: /^Agents/ })
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Chat agents' }))
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('complementary', { name: 'Chat agents' })).toBe(null)
    expect(JSON.parse(window.localStorage.getItem('dm.chatRail.v1:fixture-chat')!).collapsed).toBe(true)
    first.unmount()

    await mountTree('toggle')
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle())
    expect(screen.getByRole('complementary', { name: 'Chat agents' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Collapse Chat agents' }).getAttribute('aria-expanded')).toBe('true')
  })
})
