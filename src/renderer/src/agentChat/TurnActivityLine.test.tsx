// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentChatEvent, AgentChatSnapshot } from '../../../shared/agents/agentChat'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { createManualClock } from '../__mocks__/manualClock'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ClockContext } from '../epic/clock'
import { AgentChat } from './AgentChat'
import { agentChatScenarioClockStart, agentChatScenarios } from './__mocks__/agentChatScenario'

const ref = { folder: null, chatId: 'fixture-chat' }
const start = agentChatScenarioClockStart
const busy = { ...agentChatScenarios.empty.snapshot, status: 'busy' as const }
afterEach(cleanup)

async function mount(snapshot: AgentChatSnapshot = busy) {
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: snapshot }
  const scheduler = new ManualScheduler()
  const clock = createManualClock(start)
  const view = render(<ClockContext.Provider value={clock}><AgentChat {...ref} agentLabel="Magos" api={api} scheduler={scheduler} /></ClockContext.Provider>)
  await settle()
  const line = () => view.container.querySelector('.turn-activity') as HTMLElement
  function emit(event: AgentChatEvent) {
    act(() => { api.emit(event); scheduler.fireTimeouts(33) })
  }
  return { ...view, api, clock, line, emit }
}

it('ticks Working 1m 12s · Bash without changing the live word or transcript', async () => {
  const view = await mount({ ...busy, items: [{ id: 'bash', kind: 'tool_call', at: new Date(start).toISOString(), name: 'Bash', status: 'running', input: {}, resultSummary: null }] })
  act(() => view.clock.advance(72_000))
  expect(view.line().textContent).toBe('Working 1m 12s · Bash')
  const live = within(view.line()).getByRole('status')
  expect(live.getAttribute('aria-live')).toBe('polite')
  expect(live.textContent).toBe('Working')
  const changes = vi.fn()
  const observer = new MutationObserver(changes)
  observer.observe(view.container.querySelector('.agent-chat-scroll')!, { childList: true, subtree: true, characterData: true })
  act(() => view.clock.advance(1_000))
  await settle()
  expect(view.line().textContent).toBe('Working 1m 13s · Bash')
  expect(live.textContent).toBe('Working')
  expect(changes).not.toHaveBeenCalled()
  observer.disconnect()
})

it('warns exactly at 30 seconds and Stop calls the existing interrupt path once', async () => {
  const view = await mount()
  act(() => view.clock.set(start + 29_999))
  expect(view.line().textContent).toBe('Working 29s')
  act(() => view.clock.advance(1))
  expect(view.line().textContent).toBe('No activity for 30sStop')
  expect(within(view.line()).getByRole('status').textContent).toBe('No activity')
  const hold = view.api.hold('interrupt')
  const stop = within(view.line()).getByRole('button', { name: 'Stop' })
  fireEvent.click(stop)
  expect(stop).toHaveProperty('disabled', true)
  fireEvent.click(stop)
  expect(view.api.callsOf('interrupt')).toEqual([[ref]])
  hold.resolve()
  await settle()
  expect(stop).toHaveProperty('disabled', false)
  act(() => view.clock.advance(1_000))
  expect(view.line().textContent).toBe('No activity for 31sStop')
})

it('keeps running tools Working even after ten minutes of silence', async () => {
  const view = await mount(agentChatScenarios.tool.snapshot)
  act(() => view.clock.advance(600_000))
  expect(view.line().textContent).toBe('Working 10m 0s · Read')
  expect(view.line().classList.contains('turn-activity-stalled')).toBe(false)
})

it('clears the warning on the next emitted event', async () => {
  const view = await mount()
  act(() => view.clock.advance(30_000))
  expect(view.line().textContent).toContain('No activity')
  view.emit({ ...ref, type: 'delta', itemId: 'reply', kind: 'text', text: 'Still working' })
  expect(view.line().textContent).toBe('Working 30s')
  expect(within(view.line()).queryByRole('button')).toBe(null)
})

it('waits for a pending answer above the prompt and To-dos cards', async () => {
  const view = await mount({ ...agentChatScenarios.todos.snapshot, pending: agentChatScenarios.approval.snapshot.pending })
  act(() => view.clock.advance(600_000))
  expect(view.line().textContent).toBe('Waiting for an answer')
  expect(view.line().nextElementSibling?.classList.contains('agent-prompt')).toBe(true)
  expect(view.line().nextElementSibling?.nextElementSibling?.classList.contains('todo-card')).toBe(true)
  expect(within(view.line()).queryByRole('button')).toBe(null)
})

it('renders nothing when idle and removes the line on a stop status event', async () => {
  const view = await mount(agentChatScenarios.empty.snapshot)
  expect(view.line()).toBe(null)
  view.emit({ ...ref, type: 'status', status: 'busy' })
  act(() => view.clock.advance(30_000))
  view.emit({ ...ref, type: 'status', status: 'idle' })
  expect(view.line()).toBe(null)
})

it('renders the stalled scenario at its matching clock time', async () => {
  const scenario = agentChatScenarios.stalled
  const view = await mount(scenario.snapshot)
  for (const event of scenario.events) view.emit(event)
  act(() => view.clock.advance(scenario.advanceMs!))
  expect(view.line().textContent).toBe('No activity for 31sStop')
})

it('surfaces interrupt errors through the composer rather than swallowing them', async () => {
  const view = await mount()
  act(() => view.clock.advance(30_000))
  view.api.failures.interrupt = { code: 'conflict', message: 'Interrupt unavailable.' }
  fireEvent.click(within(view.line()).getByRole('button', { name: 'Stop' }))
  await settle()
  expect(screen.getByRole('alert').textContent).toBe('Interrupt unavailable.')
})

it('manual clock synchronously notifies all subscribers and respects unsubscribe', () => {
  const clock = createManualClock(10)
  const values: number[] = []
  const unsubscribe = clock.subscribe(() => values.push(clock.now()))
  const other = vi.fn()
  clock.subscribe(other)
  clock.set(20)
  clock.advance(5)
  unsubscribe()
  clock.advance(5)
  expect(values).toEqual([20, 25])
  expect(other).toHaveBeenCalledTimes(3)
  expect(clock.now()).toBe(30)
})
