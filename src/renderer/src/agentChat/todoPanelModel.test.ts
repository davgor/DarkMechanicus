import { expect, it } from 'vitest'
import { TODO_TOOL_NAMES, type AgentTodoPhase, type AgentTodoTask } from '../../../shared/agents/agentChat'
import type { ChatItem } from '../../../shared/agents/chat'
import { activeTask, isTodoToolCall, nextTodoMemory, showsTodoCard, todoProgress, todoProgressLabel, withoutTodoCalls } from './todoPanelModel'

const task = (status: AgentTodoTask['status'], content = status): AgentTodoTask => ({ id: null, content, status })
const phases = (...tasks: AgentTodoTask[]): AgentTodoPhase[] => [{ name: 'Work', tasks }]
const open = phases(task('in_progress'))
const closed = phases(task('completed'), task('abandoned'))

it('counts all phases and treats completed and abandoned as closed', () => {
  const list = [...phases(task('completed'), task('abandoned')), { name: 'Next', tasks: [task('pending'), task('blocked'), task('in_progress')] }]
  expect(todoProgress(list)).toEqual({ closed: 2, total: 5 })
  expect(todoProgressLabel(list)).toBe('2/5')
  expect(todoProgress([])).toEqual({ closed: 0, total: 0 })
  expect(todoProgressLabel([])).toBeNull()
  expect(todoProgressLabel(phases())).toBeNull()
})

it('returns the first active task in phase order without replacing its active form', () => {
  const first = { ...task('in_progress'), activeForm: 'Implementing' }
  const list = [...phases(task('completed')), { name: 'Next', tasks: [task('pending'), first, task('in_progress')] }]
  expect(activeTask(list)).toBe(first)
  expect(activeTask(list)?.activeForm).toBe('Implementing')
  expect(activeTask(open)?.content).toBe('in_progress')
  expect(activeTask(closed)).toBeNull()
  expect(activeTask([])).toBeNull()
})

it('lingers only until the finishing turn ends, never reviving in the next turn', () => {
  const running = nextTodoMemory(null, { phases: open, turn: 1, busy: true })
  expect(showsTodoCard(running, open, 1, true)).toBe(true)
  const finished = nextTodoMemory(running, { phases: closed, turn: 1, busy: true })
  expect(finished.finishedInTurn).toBe(1)
  expect(running.finishedInTurn).toBeNull()
  expect(showsTodoCard(finished, closed, 1, true)).toBe(true)
  expect(nextTodoMemory(finished, { phases: closed, turn: 1, busy: true })).toEqual(finished)
  expect(showsTodoCard(finished, closed, 1, false)).toBe(false)
  expect(showsTodoCard(finished, closed, 2, true)).toBe(false)
  const idle = nextTodoMemory(finished, { phases: closed, turn: 1, busy: false })
  expect(idle.finishedInTurn).toBeNull()
  const second = nextTodoMemory(idle, { phases: closed, turn: 2, busy: true })
  expect(showsTodoCard(second, closed, 2, true)).toBe(false)
  const reopened = nextTodoMemory(second, { phases: open, turn: 2, busy: true })
  expect(showsTodoCard(reopened, open, 2, true)).toBe(true)
  const finishedAgain = nextTodoMemory(reopened, { phases: closed, turn: 2, busy: true })
  expect(finishedAgain.finishedInTurn).toBe(2)
  expect(showsTodoCard(finishedAgain, closed, 2, true)).toBe(true)
})

it('keeps closed snapshots hidden after reload, including later busy notifications', () => {
  const idle = nextTodoMemory(null, { phases: closed, turn: 0, busy: false })
  expect(showsTodoCard(idle, closed, 0, false)).toBe(false)
  const busy = nextTodoMemory(idle, { phases: closed, turn: 1, busy: true })
  expect(showsTodoCard(busy, closed, 1, true)).toBe(false)
  const busyReload = nextTodoMemory(null, { phases: closed, turn: 1, busy: true })
  expect(showsTodoCard(busyReload, closed, 1, true)).toBe(false)
})

it.each(['pending', 'in_progress', 'blocked'] as const)('shows %s tasks even while idle', (status) => {
  const list = phases(task(status))
  const memory = nextTodoMemory(null, { phases: list, turn: 1, busy: false })
  expect(showsTodoCard(memory, list, 1, false)).toBe(true)
  const finishedIdle = nextTodoMemory(memory, { phases: closed, turn: 1, busy: false })
  expect(showsTodoCard(finishedIdle, closed, 1, false)).toBe(false)
  expect(showsTodoCard(nextTodoMemory(finishedIdle, { phases: closed, turn: 2, busy: true }), closed, 2, true)).toBe(false)
})

it('expires lingering when cleared or advanced and does not treat empty phases as work', () => {
  const running = nextTodoMemory(null, { phases: open, turn: 1, busy: true })
  const finished = nextTodoMemory(running, { phases: closed, turn: 1, busy: true })
  for (const list of [[], phases()]) {
    const cleared = nextTodoMemory(finished, { phases: list, turn: 1, busy: true })
    expect(cleared.finishedInTurn).toBeNull()
    expect(showsTodoCard(cleared, list, 1, true)).toBe(false)
    expect(showsTodoCard(nextTodoMemory(cleared, { phases: closed, turn: 1, busy: true }), closed, 1, true)).toBe(false)
  }
  const nextTurn = nextTodoMemory(finished, { phases: closed, turn: 2, busy: true })
  expect(nextTurn.finishedInTurn).toBeNull()
  expect(showsTodoCard(nextTurn, closed, 2, true)).toBe(false)
})

const call = (name: string, status: Extract<ChatItem, { kind: 'tool_call' }>['status']): ChatItem => ({
  id: `${name}-${status}`, at: '2026-01-01T00:00:00.000Z', kind: 'tool_call', name, input: {}, status, resultSummary: null
})
const message: ChatItem = { id: 'message', at: '2026-01-01T00:00:00.000Z', kind: 'assistant_text', text: 'TodoWrite' }

it.each(TODO_TOOL_NAMES)('recognizes %s and hides only running or completed calls', (name) => {
  const failed = call(name, 'failed')
  const denied = call(name, 'denied')
  const cancelled = call(name, 'cancelled')
  const items = [message, call(name, 'running'), failed, call(name, 'completed'), denied, cancelled]
  expect(isTodoToolCall(items[1])).toBe(true)
  const visible = withoutTodoCalls(items)
  expect(visible).toEqual([message, failed, denied, cancelled])
  expect(visible[1]).toBe(failed)
  expect(items).toHaveLength(6)
})

it('preserves non-todo calls, error outcomes and array identity when nothing is dropped', () => {
  const items = [message, call('Read', 'running'), call('todowrite', 'completed'), call('todo', 'failed'), call('TaskCreate', 'denied'), call('TaskUpdate', 'cancelled')]
  expect(isTodoToolCall(message)).toBe(false)
  expect(isTodoToolCall(items[1])).toBe(false)
  expect(isTodoToolCall(items[2])).toBe(false)
  expect(withoutTodoCalls(items)).toBe(items)
  const empty: ChatItem[] = []
  expect(withoutTodoCalls(empty)).toBe(empty)
  expect(withoutTodoCalls([call('todo', 'running'), call('TodoWrite', 'completed')])).toEqual([])
})
