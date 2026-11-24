// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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
  const thread = screen.getByRole('listitem', { name: 'Thread: Acolyte:DM-785 Inspect composer' })
  fireEvent.click(within(thread).getByRole('button'))
  expect(within(thread).getByText('Composer keyboard behavior inspected.')).toBeTruthy()
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
