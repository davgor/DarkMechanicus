// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AgentChatSnapshot } from '../../../shared/agents/agentChat'
import type { CommandResult } from '../../../shared/desktop/api'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { AgentChat } from './AgentChat'
import { agentChatState, reduceAgentChat } from './agentChatModel'
import { agentChatScenarios } from './__mocks__/agentChatScenario'
import { isCollapsedMap, scrollTopFor, TodoCard } from './TodoCard'
import { useAgentChat } from './useAgentChat'

const ref = { folder: null, chatId: 'fixture-chat' }
afterEach(() => { cleanup(); localStorage.clear() })
const seed = () => agentChatState(agentChatScenarios.todos.snapshot)

it('renders canonical 4/7 progress, phases, inert task text and accessible statuses', () => {
  const { container } = render(<TodoCard chatId="one" state={seed()} />)
  expect(screen.getByText('To-dos')).toBeTruthy()
  expect(screen.getByText('4/7')).toBeTruthy()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('4')
  expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('7')
  expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Inspect 3/3', 'Deliver 1/4'])
  expect(screen.getByText('Blocked on: Review fixture approval')).toBeTruthy()
  expect(container.querySelectorAll('.todo-card-completed .todo-card-task')).toHaveLength(3)
  expect(container.querySelectorAll('.todo-card-abandoned .todo-card-task')).toHaveLength(1)
  for (const word of ['pending', 'in progress', 'completed', 'abandoned', 'blocked']) expect(screen.getAllByText(word).length).toBeGreaterThan(0)
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('Implement the card')
  expect(container.querySelector('.todo-card-spinner')).toBeTruthy()
})

it('renders the named 3/7 case without changing abandoned-task arithmetic', () => {
  const state = seed()
  const phases = structuredClone(state.todos.get('')!)
  phases[0].tasks[0].status = 'pending'
  render(<TodoCard chatId="one" state={{ ...state, todos: new Map([['', phases]]) }} />)
  expect(screen.getByText('3/7')).toBeTruthy()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3')
})

it('remembers collapse by chat, shows only the collapsed activeForm and restores expansion', () => {
  const state = seed()
  const view = render(<TodoCard chatId="one" state={state} />)
  expect(screen.queryByText('Implementing the card')).toBeNull()
  fireEvent.click(screen.getByRole('button'))
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  expect(screen.getByText('Implementing the card')).toBeTruthy()
  view.unmount()
  const remount = render(<TodoCard chatId="one" state={state} />)
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  remount.rerender(<TodoCard chatId="two" state={state} />)
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  remount.rerender(<TodoCard chatId="one" state={state} />)
  fireEvent.click(screen.getByRole('button'))
  expect(screen.queryByText('Implementing the card')).toBeNull()
  expect(screen.getAllByRole('listitem')).toHaveLength(7)
})

it('uses a static dashed ring while idle and never falls back to main-thread tasks', () => {
  const state = { ...seed(), status: 'idle' as const }
  const view = render(<TodoCard chatId="one" state={state} />)
  expect(view.container.querySelector('.todo-card-spinner')).toBeNull()
  expect(view.container.querySelector('[aria-current="step"] [data-icon="circle-dashed"]')).toBeTruthy()
  view.rerender(<TodoCard chatId="one" state={state} threadId="worker" />)
  expect(screen.queryByRole('region')).toBeNull()
  view.rerender(<TodoCard chatId="one" state={{ ...state, todos: new Map([['worker', state.todos.get('')!]]) }} threadId="worker" />)
  expect(screen.getByText('4/7')).toBeTruthy()
})

it('clamps active-row scrolling and positions the row one third down', () => {
  expect(scrollTopFor({ rowTop: 300, rowHeight: 30, viewport: 180, scrollHeight: 900 })).toBe(250)
  expect(scrollTopFor({ rowTop: 0, rowHeight: 30, viewport: 180, scrollHeight: 900 })).toBe(0)
  expect(scrollTopFor({ rowTop: 880, rowHeight: 30, viewport: 180, scrollHeight: 900 })).toBe(720)
  expect(scrollTopFor({ rowTop: 30, rowHeight: 30, viewport: 180, scrollHeight: 90 })).toBe(0)
})

it('stacks the usable prompt above todos and composer without stealing composer focus; finishes only for this busy turn', async () => {
  const api = new FakeAgentChat()
  const scheduler = new ManualScheduler()
  api.snapshotResult = { ok: true, data: { ...agentChatScenarios.todosDone.snapshot, pending: agentChatScenarios.approval.snapshot.pending } }
  const { container } = render(<AgentChat {...ref} agentLabel="Magos" api={api} scheduler={scheduler} />)
  await settle()
  const card = screen.getByRole('region', { name: 'To-dos' })
  const allow = screen.getByRole('button', { name: 'Allow once' })
  const composer = screen.getByRole('textbox')
  expect(allow.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(card.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  composer.focus()
  act(() => { for (const event of agentChatScenarios.todosDone.events) api.emit(event); scheduler.fireTimeouts(33) })
  expect(document.activeElement).toBe(composer)
  expect(within(card).getByText('7/7')).toBeTruthy()
  expect(container.querySelector('.todo-card-list')).toBeTruthy()
  fireEvent.click(allow)
  await settle()
  expect(api.calls.some((call) => call.method === 'answer')).toBe(true)
  act(() => { for (const event of agentChatScenarios.todosDone.commit) api.emit(event); scheduler.fireTimeouts(33) })
  expect(screen.queryByRole('region', { name: 'To-dos' })).toBeNull()
})

it('does not linger a closed snapshot or resurrect completion on a later turn', () => {
  let state = seed()
  const view = render(<TodoCard chatId="one" state={state} />)
  for (const event of agentChatScenarios.todosDone.events) state = reduceAgentChat(state, event)
  view.rerender(<TodoCard chatId="one" state={state} />)
  expect(screen.getByText('7/7')).toBeTruthy()
  view.rerender(<TodoCard chatId="one" state={{ ...state, turn: state.turn + 1 }} />)
  expect(screen.queryByRole('region')).toBeNull()
  view.unmount()
  const snapshot = agentChatScenarios.todosDone.snapshot
  render(<TodoCard chatId="one" state={agentChatState({ ...snapshot, todos: [{ threadId: null, phases: state.todos.get('')! }] })} />)
  expect(screen.queryByRole('region')).toBeNull()
})

it('validates only plain boolean maps', () => {
  for (const value of [null, [], { one: 1 }, { one: 'true' }, new Date(), Object.create({ one: true })]) expect(isCollapsedMap(value)).toBe(false)
  expect(isCollapsedMap({})).toBe(true)
  expect(isCollapsedMap({ one: true, two: false })).toBe(true)
})

it.each(['completion-idle-busy', 'idle-busy-completion'] as const)('preserves ordered lifecycle through one React batch: %s', async (ordering) => {
  const api = new FakeAgentChat()
  const scheduler = new ManualScheduler()
  api.snapshotResult = { ok: true, data: agentChatScenarios.todos.snapshot }
  render(<AgentChat {...ref} agentLabel="Magos" api={api} scheduler={scheduler} />)
  await settle()
  const composer = screen.getByRole('textbox')
  composer.focus()
  const completion = agentChatScenarios.todosDone.events
  act(() => {
    if (ordering === 'completion-idle-busy') for (const event of completion) api.emit(event)
    api.emit({ ...ref, type: 'status', status: 'idle' })
    api.emit({ ...ref, type: 'status', status: 'busy' })
    if (ordering === 'idle-busy-completion') for (const event of completion) api.emit(event)
  })
  expect(document.activeElement).toBe(composer)
  if (ordering === 'completion-idle-busy') expect(screen.queryByRole('region', { name: 'To-dos' })).toBeNull()
  else expect(screen.getByText('7/7')).toBeTruthy()
})

it('tracks an unselected worker in event order without inheriting another thread memory', () => {
  let state = seed()
  const view = render(<TodoCard chatId="one" state={state} />)
  state = reduceAgentChat(state, { ...ref, type: 'todos', threadId: 'worker', phases: state.todos.get('')! })
  const completion = agentChatScenarios.todosDone.events[0]
  if (completion.type !== 'todos') throw new Error('Expected todos fixture')
  state = reduceAgentChat(state, { ...completion, threadId: 'worker' })
  view.rerender(<TodoCard chatId="one" state={state} threadId="worker" />)
  expect(screen.getByText('7/7')).toBeTruthy()
  state = reduceAgentChat(state, { ...ref, type: 'status', status: 'idle' })
  state = reduceAgentChat(state, { ...ref, type: 'status', status: 'busy' })
  view.rerender(<TodoCard chatId="one" state={state} threadId="worker" />)
  expect(screen.queryByRole('region')).toBeNull()
  view.rerender(<TodoCard chatId="one" state={state} />)
  expect(screen.getByText('4/7')).toBeTruthy()
})

it.each(['completion-idle-busy', 'idle-busy-completion'] as const)('keeps the card lifecycle after a held successful GUI snapshot: %s', async ordering => {
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: agentChatScenarios.todos.snapshot }
  let setSurface: (surface: AgentChatSnapshot['surface']) => Promise<CommandResult<AgentChatSnapshot>>
  function Surface(): JSX.Element {
    const chat = useAgentChat({ ...ref, api })
    setSurface = chat.setSurface
    return <TodoCard chatId={ref.chatId} state={chat.state} />
  }
  render(<Surface />)
  await settle()
  const held = api.hold('setSurface')
  let pending: Promise<CommandResult<AgentChatSnapshot>>
  act(() => { pending = setSurface('gui') })
  act(() => {
    if (ordering === 'completion-idle-busy') for (const event of agentChatScenarios.todosDone.events) api.emit(event)
    api.emit({ ...ref, type: 'status', status: 'idle' })
    api.emit({ ...ref, type: 'status', status: 'busy' })
    if (ordering === 'idle-busy-completion') for (const event of agentChatScenarios.todosDone.events) api.emit(event)
  })
  api.snapshotResult = { ok: true, data: agentChatScenarios.todosDone.snapshot }
  await act(async () => { held.resolve(); await pending })
  expect(screen.queryByText('To-dos') !== null).toBe(ordering === 'idle-busy-completion')
  if (ordering === 'idle-busy-completion') expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('7')
  act(() => api.emit({ ...ref, type: 'status', status: 'idle' }))
  expect(screen.queryByText('To-dos')).toBeNull()
})
