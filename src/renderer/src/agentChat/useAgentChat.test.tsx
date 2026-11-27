// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { AgentChatSnapshot, AgentTodoPhase } from '../../../shared/agents/agentChat'
import type { CommandResult } from '../../../shared/desktop/api'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { FakeChatMail, mailEntry } from '../__mocks__/fakeChatMail'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { AgentMailContext, createAgentMailStore, type AgentMailStore } from '../agents/useAgentMail'
import { ClockContext, type Clock } from '../epic/clock'
import { useAgentChat, useMailTranscript, type TranscriptLine } from './useAgentChat'
import { showsTodoCard } from './todoPanelModel'

const ref = { folder: 'C:\\project', chatId: 'chat-one' }
const snapshot = (overrides: Partial<AgentChatSnapshot> = {}): AgentChatSnapshot => ({ items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [], ...overrides })
const message = { id: 'a', at: '2026-01-01T00:00:00.000Z', kind: 'assistant_text' as const, text: 'Hello world' }
function mount(api = new FakeAgentChat(), scheduler = new ManualScheduler()) {
  const view = renderHook((props) => useAgentChat({ ...props, api, scheduler }), { initialProps: ref })
  return { ...view, api, scheduler }
}
afterEach(cleanup)

  it('replays early events over the snapshot in order and commits streamed text once', async () => {
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: snapshot({ items: [{ ...message, text: 'old' }], queued: 9 }) }
    const held = api.hold('snapshot')
    const view = mount(api)
    act(() => {
      api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'Hello' })
      api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: ' world' })
      api.emit({ ...ref, type: 'queued', count: 1 })
      api.emit({ ...ref, type: 'queued', count: 2 })
      api.emit({ ...ref, type: 'status', status: 'busy' })
    })
    held.resolve()
    await settle()
    expect(view.result.current.state.streaming.get('a')?.text).toBe('Hello world')
    expect(view.result.current.state.queued).toBe(2)
    expect(view.result.current.state.status).toBe('busy')
    expect(view.result.current.state.turn).toBe(1)
    act(() => api.emit({ ...ref, type: 'item', item: message }))
    expect(view.result.current.state.items).toEqual([message])
    expect(view.result.current.state.streaming.size).toBe(0)
    expect(api.callsOf('start')).toEqual([])
  })

  it('filters both identities and unsubscribes while cancelling a scheduled delta render', async () => {
    const view = mount()
    await settle()
    act(() => {
      view.api.emit({ ...ref, folder: 'C:\\other', type: 'queued', count: 8 })
      view.api.emit({ ...ref, chatId: 'other', type: 'queued', count: 7 })
      view.api.emit({ ...ref, folder: null, type: 'queued', count: 6 })
    })
    expect(view.result.current.state.queued).toBe(0)
    act(() => view.api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'hello' }))
    expect(view.scheduler.timeouts()).toEqual([33])
    expect(view.api.subscribers()).toBe(1)
    view.unmount()
    expect(view.api.subscribers()).toBe(0)
    expect(view.scheduler.timeouts()).toEqual([])
  })

  it('batches deltas at 33ms and immediately flushes a committed item', async () => {
    const view = mount()
    await settle()
    act(() => {
      view.api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'thinking', text: 'Think' })
      view.api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'Hello' })
      view.api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: ' world' })
    })
    expect(view.scheduler.timeouts()).toEqual([33])
    expect(view.result.current.state.streaming.size).toBe(0)
    act(() => view.scheduler.fireTimeouts(33))
    expect(view.result.current.state.streaming.get('a')).toEqual({ text: 'Hello world', thinking: 'Think' })
    act(() => {
      view.api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: '!' })
      view.api.emit({ ...ref, type: 'item', item: message })
    })
    expect(view.scheduler.timeouts()).toEqual([])
    expect(view.result.current.state.items).toEqual([message])
    expect(view.result.current.state.streaming.size).toBe(0)
  })

  it('forwards all commands with folder/chat identity and applies surface snapshots', async () => {
    const view = mount()
    await settle()
    await act(async () => {
      await view.result.current.send({ text: 'Steer' })
      await view.result.current.send({ text: '', imageIds: ['ci_00000000000000000000000000'] })
      await view.result.current.stageImage('iVBORw0KGgo=')
      await view.result.current.interrupt()
      await view.result.current.answer({ promptId: 'prompt', optionId: 'allow_once' })
      await view.result.current.answer({ promptId: 'question', optionId: 'other', text: 'Response' })
      await view.result.current.answer({ promptId: 'multi', optionIds: ['a', 'text'], text: 'Also this' })
      await view.result.current.answer({ promptId: 'form', fields: [{ fieldId: 'databases', optionIds: ['option_0', 'option_1'] }, { fieldId: 'note', optionIds: [], text: 'No' }] })
      await view.result.current.start()
      await view.result.current.setSurface('terminal')
    })
    expect(view.api.callsOf('send')).toEqual([[{ ...ref, text: 'Steer' }], [{ ...ref, text: '', imageIds: ['ci_00000000000000000000000000'] }]])
    expect(view.api.callsOf('stageImage')).toEqual([[{ ...ref, data: 'iVBORw0KGgo=' }]])
    expect(view.api.callsOf('interrupt')).toEqual([[ref]])
    expect(view.api.callsOf('answer')).toEqual([
      [{ ...ref, promptId: 'prompt', optionId: 'allow_once' }],
      [{ ...ref, promptId: 'question', optionId: 'other', text: 'Response' }],
      [{ ...ref, promptId: 'multi', optionIds: ['a', 'text'], text: 'Also this' }],
      [{ ...ref, promptId: 'form', fields: [{ fieldId: 'databases', optionIds: ['option_0', 'option_1'] }, { fieldId: 'note', optionIds: [], text: 'No' }] }]
    ])
    expect(view.api.callsOf('start')).toEqual([[ref]])
    expect(view.api.callsOf('setSurface')).toEqual([[{ ...ref, surface: 'terminal' }]])
    expect(view.result.current.state.surface).toBe('terminal')
  })

  it('starts an exited GUI session once on mount, retaining snapshot todos', async () => {
    const api = new FakeAgentChat()
    const todos = [{ threadId: null, phases: [{ name: 'Work', tasks: [] }] }]
    api.snapshotResult = { ok: true, data: snapshot({ status: 'exited', todos }) }
    const view = mount(api)
    await settle()
    expect(api.callsOf('start')).toEqual([[ref]])
    expect(view.result.current.state.status).toBe('idle')
    expect(view.result.current.state.todos).toEqual(new Map([['', todos[0].phases]]))
  })

  it('only reads an exited GUI session with autoStart false, still applying pushes', async () => {
    const api = new FakeAgentChat()
    const scheduler = new ManualScheduler()
    api.snapshotResult = { ok: true, data: snapshot({ status: 'exited', items: [message] }) }
    const view = renderHook((props) => useAgentChat({ ...props, api, scheduler }, { autoStart: false }), { initialProps: ref })
    await settle()
    expect(api.callsOf('snapshot')).toEqual([[ref]])
    expect(api.callsOf('start')).toEqual([])
    expect(view.result.current.state).toMatchObject({ status: 'exited', items: [message] })
    act(() => api.emit({ ...ref, type: 'status', status: 'busy' }))
    expect(view.result.current.state.status).toBe('busy')
    expect(api.callsOf('start')).toEqual([])
  })

  it('does not start a terminal owner, signed-out session or failed snapshot', async () => {
    for (const data of [snapshot({ status: 'exited', surface: 'terminal' }), snapshot({ status: 'signed_out' })]) {
      const api = new FakeAgentChat()
      api.snapshotResult = { ok: true, data }
      const view = mount(api)
      await settle()
      expect(api.callsOf('start')).toEqual([])
      view.unmount()
    }
    const api = new FakeAgentChat()
    api.failures.snapshot = { code: 'unauthorized', message: 'Denied' }
    const view = mount(api)
    await settle()
    expect(api.callsOf('start')).toEqual([])
    expect(view.result.current.state).toMatchObject({ status: 'failed', statusDetail: 'Denied' })
  })

  it('starts when no process snapshot exists', async () => {
    const api = new FakeAgentChat()
    api.failures.snapshot = { code: 'not_found', message: 'No process' }
    const view = mount(api)
    await settle()
    expect(api.callsOf('start')).toEqual([[ref]])
    expect(view.result.current.state.status).toBe('idle')
  })

  it('does not auto-start after an early busy event supersedes an exited snapshot', async () => {
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: snapshot({ status: 'exited' }) }
    const held = api.hold('snapshot')
    const view = mount(api)
    act(() => api.emit({ ...ref, type: 'status', status: 'busy' }))
    held.resolve()
    await settle()
    expect(api.callsOf('start')).toEqual([])
    expect(view.result.current.state.status).toBe('busy')
  })

  it('ignores old snapshot and deltas after changing folder and chat', async () => {
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: snapshot({ items: [message], status: 'exited' }) }
    const held = api.hold('snapshot')
    const view = mount(api)
    act(() => api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'old' }))
    api.snapshotResult = { ok: true, data: snapshot({ queued: 4 }) }
    const next = { folder: 'C:\\next', chatId: 'chat-two' }
    view.rerender(next)
    await settle()
    held.resolve()
    await settle()
    expect(view.result.current.state.items).toEqual([])
    expect(view.result.current.state.streaming.size).toBe(0)
    expect(view.result.current.state.queued).toBe(4)
    expect(api.callsOf('start')).toEqual([])
    expect(api.subscribers()).toBe(1)
    await view.result.current.send({ text: 'new' })
    expect(api.callsOf('send')).toEqual([[{ ...next, text: 'new' }]])
  })

  it('replays pushes during start and setSurface without replacing newer state', async () => {
    const view = mount()
    await settle()
    const held = view.api.hold('start')
    let starting: Promise<unknown>
    act(() => { starting = view.result.current.start() })
    act(() => view.api.emit({ ...ref, type: 'queued', count: 5 }))
    await act(async () => { held.resolve(); await starting })
    expect(view.result.current.state.queued).toBe(5)
    const switching = view.api.hold('setSurface')
    let switched: Promise<unknown>
    act(() => { switched = view.result.current.setSurface('terminal') })
    act(() => view.api.emit({ ...ref, type: 'item', item: message }))
    await act(async () => { switching.resolve(); await switched })
    expect(view.result.current.state.surface).toBe('terminal')
    expect(view.result.current.state.items).toEqual([message])
  })

  it('ignores an older snapshot when an explicit start already loaded newer state', async () => {
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: snapshot({ status: 'exited', items: [message] }) }
    const held = api.hold('snapshot')
    const view = mount(api)
    api.snapshotResult = { ok: true, data: snapshot({ queued: 3 }) }
    await act(async () => { await view.result.current.start() })
    held.resolve()
    await settle()
    expect(api.callsOf('start')).toEqual([[ref]])
    expect(view.result.current.state).toMatchObject({ status: 'idle', queued: 3, items: [] })
  })

  it('rebinds when the injected API changes and ignores its predecessor', async () => {
    const oldApi = new FakeAgentChat()
    const newApi = new FakeAgentChat()
    const held = oldApi.hold('snapshot')
    newApi.snapshotResult = { ok: true, data: snapshot({ queued: 2 }) }
    const scheduler = new ManualScheduler()
    const view = renderHook(({ api }) => useAgentChat({ ...ref, api, scheduler }), { initialProps: { api: oldApi } })
    view.rerender({ api: newApi })
    await settle()
    held.resolve()
    await settle()
    expect(oldApi.subscribers()).toBe(0)
    expect(newApi.subscribers()).toBe(1)
    expect(view.result.current.state.queued).toBe(2)
  })

  it('ignores pending initialization after unmount and uses the default FakeDm bridge', async () => {
    const dm = new FakeDm()
    window.dm = dm
    const held = dm.agentChat.hold('snapshot')
    dm.agentChat.snapshotResult = { ok: true, data: snapshot({ status: 'exited' }) }
    const view = renderHook(() => useAgentChat({ ...ref, folder: null }))
    expect(dm.agentChat.callsOf('snapshot')).toEqual([[{ ...ref, folder: null }]])
    view.unmount()
    held.resolve()
    await settle()
    expect(dm.agentChat.callsOf('start')).toEqual([])
    expect(dm.agentChat.subscribers()).toBe(0)
  })

it('keeps deltas exactly once when a snapshot-producing command fails', async () => {
  const view = mount()
  await settle()
  const held = view.api.hold('start')
  view.api.failures.start = { code: 'busy', message: 'Already busy' }
  let starting: Promise<unknown>
  act(() => { starting = view.result.current.start() })
  act(() => view.api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'once' }))
  await act(async () => { held.resolve(); await starting })
  expect(view.result.current.state.streaming.get('a')?.text).toBe('once')
  expect(view.result.current.state.statusDetail).toBe('Already busy')
})

it('seeds thread maps and replays replacement and deletion pushes over snapshot arrays', async () => {
  const api = new FakeAgentChat()
  const phases = [{ name: 'Work', tasks: [{ id: null, content: 'Implement', status: 'pending' as const }] }]
  const replacement = [{ name: 'Done', tasks: [{ id: null, content: 'Implement', status: 'completed' as const }] }]
  api.snapshotResult = { ok: true, data: snapshot({ todos: [{ threadId: null, phases }, { threadId: 'child', phases }] }) }
  const held = api.hold('snapshot')
  const view = mount(api)
  act(() => {
    api.emit({ ...ref, type: 'todos', threadId: null, phases: replacement })
    api.emit({ ...ref, type: 'todos', threadId: 'child', phases: [] })
    api.emit({ ...ref, type: 'todos', threadId: 'other', phases })
  })
  held.resolve()
  await settle()
  expect(view.result.current.state.todos).toEqual(new Map<string, AgentTodoPhase[]>([['', replacement], ['other', phases]]))
})

it('keeps turn numbering through command snapshots and counts subsequent busy transitions', async () => {
  const view = mount()
  await settle()
  act(() => {
    view.api.emit({ ...ref, type: 'status', status: 'busy' })
    view.api.emit({ ...ref, type: 'status', status: 'idle' })
  })
  expect(view.result.current.state.turn).toBe(1)
  await act(async () => { await view.result.current.setSurface('terminal') })
  expect(view.result.current.state.turn).toBe(1)
  await act(async () => { await view.result.current.setSurface('gui') })
  act(() => view.api.emit({ ...ref, type: 'status', status: 'busy' }))
  expect(view.result.current.state.turn).toBe(2)
})

function mountTimed(api = new FakeAgentChat()) {
  let now = 1_000
  const clock: Clock = { now: () => now, subscribe: () => () => {} }
  const scheduler = new ManualScheduler()
  const wrapper = ({ children }: { children: ReactNode }) => <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
  const view = renderHook(() => useAgentChat({ ...ref, api, scheduler }), { wrapper })
  return { ...view, api, scheduler, setTime: (at: number) => { now = at } }
}

it('uses the injected clock for event arrival, not delayed rendering', async () => {
  const view = mountTimed()
  await settle()
  expect(view.result.current.state.lastEventAt).toBe(1_000)
  act(() => view.api.emit({ ...ref, type: 'status', status: 'busy' }))
  expect(view.result.current.state).toMatchObject({ lastEventAt: 1_000, turnStartedAt: 1_000 })
  view.setTime(2_000)
  act(() => view.api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'once' }))
  view.setTime(9_000)
  act(() => view.scheduler.fireTimeouts(33))
  expect(view.result.current.state).toMatchObject({ lastEventAt: 2_000, turnStartedAt: 1_000 })
})

it('preserves buffered arrival times across initial snapshot resolution', async () => {
  const api = new FakeAgentChat()
  const held = api.hold('snapshot')
  const view = mountTimed(api)
  act(() => api.emit({ ...ref, type: 'status', status: 'busy' }))
  view.setTime(2_000)
  act(() => api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'early' }))
  view.setTime(40_000)
  held.resolve()
  await settle()
  expect(view.result.current.state).toMatchObject({ lastEventAt: 2_000, turnStartedAt: 1_000 })
  expect(view.result.current.state.streaming.get('a')?.text).toBe('early')
})

it('preserves receipt time across command snapshots and failures without duplicating deltas', async () => {
  const view = mountTimed()
  await settle()
  for (const fail of [false, true]) {
    const held = view.api.hold('start')
    if (fail) view.api.failures.start = { code: 'busy', message: 'Already busy' }
    let starting: Promise<unknown>
    act(() => { starting = view.result.current.start() })
    view.setTime(3_000)
    act(() => view.api.emit({ ...ref, type: 'status', status: 'busy' }))
    view.setTime(4_000)
    act(() => view.api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'once' }))
    view.setTime(50_000)
    await act(async () => { held.resolve(); await starting })
    expect(view.result.current.state).toMatchObject({ lastEventAt: 4_000, turnStartedAt: 3_000 })
    expect(view.result.current.state.streaming.get('a')?.text).toBe(fail ? 'onceonce' : 'once')
  }
})

it.each(['busy', 'unsupported_capability'] as const)('preserves the live session and buffered receipt times when a surface switch is refused: %s', async code => {
  const view = mountTimed()
  await settle()
  act(() => view.api.emit({ ...ref, type: 'status', status: 'busy' }))
  const held = view.api.hold('setSurface')
  view.api.failures.setSurface = { code, message: 'Cannot switch surfaces.' }
  let switching: Promise<CommandResult<AgentChatSnapshot>>
  act(() => { switching = view.result.current.setSurface('terminal') })
  view.setTime(2_000)
  act(() => view.api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'once' }))
  view.setTime(50_000)
  await act(async () => {
    held.resolve()
    expect(await switching).toEqual({ ok: false, error: { code, message: 'Cannot switch surfaces.' } })
  })
  expect(view.result.current.state).toMatchObject({ status: 'busy', surface: 'gui', turn: 1, lastEventAt: 2_000, turnStartedAt: 1_000 })
  expect(view.result.current.state.streaming.get('a')?.text).toBe('once')
  expect(view.result.current.state.statusDetail).toBeUndefined()
})

it('flushes buffered deltas before retirement and preserves another live stream and receipt time', async () => {
  const view = mountTimed()
  await settle()
  act(() => {
    view.api.emit({ ...ref, type: 'delta', itemId: 'thinking', kind: 'thinking', text: 'Consider' })
    view.api.emit({ ...ref, type: 'delta', itemId: 'worker', kind: 'text', text: 'Still working' })
  })
  view.setTime(2_000)
  act(() => view.api.emit({ ...ref, type: 'stream_end', itemId: 'thinking' }))
  expect([...view.result.current.state.streaming.keys()]).toEqual(['worker'])
  expect(view.result.current.state.lastEventAt).toBe(2_000)
  view.setTime(9_000)
  act(() => view.scheduler.fireTimeouts(33))
  expect([...view.result.current.state.streaming.keys()]).toEqual(['worker'])
  expect(view.result.current.state.lastEventAt).toBe(2_000)
})

it.each(['snapshot', 'refusal', 'failure'] as const)('reconciles ordered todo completion through a command %s', async (outcome) => {
  const phases: AgentTodoPhase[] = [{ name: '', tasks: [{ id: 't', content: 'Work', status: 'pending' }] }]
  const closed: AgentTodoPhase[] = [{ name: '', tasks: [{ ...phases[0].tasks[0], status: 'completed' }] }]
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: [{ threadId: null, phases }] }) }
  const view = mount(api)
  await settle()
  act(() => api.emit({ ...ref, type: 'todos', threadId: null, phases: closed }))
  api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: [{ threadId: null, phases: closed }] }) }
  if (outcome === 'refusal') api.failures.setSurface = { code: 'busy', message: 'Busy' }
  if (outcome === 'failure') api.failures.start = { code: 'internal_error', message: 'Failed' }
  await act(async () => {
    if (outcome === 'failure') await view.result.current.start()
    else await view.result.current.setSurface('gui')
  })
  expect(view.result.current.state.todoMemory.get('')?.finishedInTurn).toBe(outcome === 'failure' ? null : 0)
  const held = api.hold('setSurface')
  let pending: Promise<CommandResult<AgentChatSnapshot>>
  act(() => { pending = view.result.current.setSurface('gui') })
  act(() => {
    api.emit({ ...ref, type: 'status', status: 'idle' })
    api.emit({ ...ref, type: 'status', status: 'busy' })
  })
  await act(async () => { held.resolve(); await pending })
  expect(view.result.current.state.todoMemory.get('')?.finishedInTurn).toBeNull()
})

it('reconciles snapshot completion and deletion without granting a fresh closed snapshot lingering', async () => {
  const phases: AgentTodoPhase[] = [{ name: '', tasks: [{ id: 't', content: 'Work', status: 'pending' }] }]
  const closed: AgentTodoPhase[] = [{ name: '', tasks: [{ ...phases[0].tasks[0], status: 'completed' }] }]
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: [{ threadId: 'worker', phases }] }) }
  const view = mount(api)
  await settle()
  api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: [{ threadId: 'worker', phases: closed }] }) }
  await act(async () => { await view.result.current.setSurface('gui') })
  expect(view.result.current.state.todoMemory.get('worker')?.finishedInTurn).toBe(0)
  view.unmount()
  const reload = mount(api)
  await settle()
  expect(reload.result.current.state.todoMemory.get('worker')?.finishedInTurn).toBeNull()
  api.snapshotResult = { ok: true, data: snapshot({ status: 'busy' }) }
  await act(async () => { await reload.result.current.setSurface('gui') })
  expect(reload.result.current.state.todoMemory.size).toBe(0)
})

const openTodo: AgentTodoPhase[] = [{ name: '', tasks: [{ id: 't', content: 'Work', status: 'pending' }] }]
const closedTodo: AgentTodoPhase[] = [{ name: '', tasks: [{ id: 't', content: 'Work', status: 'completed' }] }]

it.each([
  [null, 'snapshot'], ['worker', 'snapshot'], [null, 'refusal'], ['worker', 'refusal'],
  [null, 'failure'], ['worker', 'failure']
] as const)('keeps live lifecycle for thread %s during held %s in both event orders', async (threadId, outcome) => {
  for (const completionLast of [false, true]) {
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: [{ threadId, phases: openTodo }] }) }
    const view = mountTimed(api)
    await settle()
    const method = outcome === 'failure' ? 'start' : 'setSurface'
    const held = api.hold(method)
    if (outcome !== 'snapshot') api.failures[method] = { code: 'busy', message: 'Refused' }
    let pending: Promise<CommandResult<AgentChatSnapshot>>
    act(() => { pending = method === 'start' ? view.result.current.start() : view.result.current.setSurface('gui') })
    act(() => {
      if (!completionLast) api.emit({ ...ref, type: 'todos', threadId, phases: closedTodo })
      view.setTime(2_000)
      api.emit({ ...ref, type: 'status', status: 'idle' })
      view.setTime(3_000)
      api.emit({ ...ref, type: 'status', status: 'busy' })
      if (completionLast) api.emit({ ...ref, type: 'todos', threadId, phases: closedTodo })
      view.setTime(4_000)
      api.emit({ ...ref, type: 'delta', itemId: 'a', kind: 'text', text: 'once' })
    })
    const key = threadId ?? ''
    const liveMemory = view.result.current.state.todoMemory.get(key)
    expect(liveMemory?.finishedInTurn).toBe(completionLast ? 1 : null)
    api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: [{ threadId, phases: closedTodo }] }) }
    view.setTime(50_000)
    await act(async () => { held.resolve(); await pending })
    const state = view.result.current.state
    expect(state.todoMemory.get(key)).toEqual(liveMemory)
    expect(state).toMatchObject({ turn: 1, status: 'busy', turnStartedAt: 3_000, lastEventAt: 4_000 })
    expect(state.streaming.get('a')?.text).toBe('once')
    expect(showsTodoCard(state.todoMemory.get(key) ?? null, state.todos.get(key) ?? [], state.turn, true)).toBe(completionLast)
    view.unmount()
  }
})

it.each([false, true])('reconciles snapshot-only completion, removal and closed reappearance with buffered activity=%s', async buffered => {
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: [{ threadId: 'worker', phases: openTodo }] }) }
  const view = mountTimed(api)
  await settle()
  for (const phases of [closedTodo, null, closedTodo]) {
    const held = api.hold('setSurface')
    let pending: Promise<CommandResult<AgentChatSnapshot>>
    act(() => { pending = view.result.current.setSurface('gui') })
    if (buffered) act(() => {
      view.setTime(2_000)
      api.emit({ ...ref, type: 'status', status: 'idle' })
      view.setTime(3_000)
      api.emit({ ...ref, type: 'status', status: 'busy' })
    })
    const live = view.result.current.state
    api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: phases ? [{ threadId: 'worker', phases }] : [] }) }
    await act(async () => { held.resolve(); await pending })
    const state = view.result.current.state
    expect(state.turn).toBe(live.turn)
    expect(state.todoMemory.get('worker')?.finishedInTurn).toBe(
      phases ? live.todoMemory.get('worker')?.hadOpenTasks ? state.turn : null : undefined
    )
    expect(state.todos.has('worker')).toBe(phases !== null)
  }
})

it('does not resurrect a buffered cleared thread from a closed snapshot or count snapshot-only busy twice', async () => {
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: snapshot({ todos: [{ threadId: 'worker', phases: openTodo }] }) }
  const view = mountTimed(api)
  await settle()
  api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: [{ threadId: 'worker', phases: closedTodo }] }) }
  await act(async () => { await view.result.current.setSurface('gui') })
  expect(view.result.current.state).toMatchObject({ turn: 1, status: 'busy' })
  expect(view.result.current.state.todoMemory.get('worker')?.finishedInTurn).toBe(1)
  const held = api.hold('setSurface')
  let pending: Promise<CommandResult<AgentChatSnapshot>>
  act(() => { pending = view.result.current.setSurface('gui') })
  act(() => api.emit({ ...ref, type: 'todos', threadId: 'worker', phases: [] }))
  await act(async () => { held.resolve(); await pending })
  expect(view.result.current.state.turn).toBe(1)
  expect(view.result.current.state.todos.has('worker')).toBe(false)
  expect(view.result.current.state.todoMemory.has('worker')).toBe(false)
})

it('does not invent a turn when a failed command replays a redundant busy notification', async () => {
  const api = new FakeAgentChat()
  api.snapshotResult = { ok: true, data: snapshot({ status: 'busy', todos: [{ threadId: null, phases: openTodo }] }) }
  const view = mountTimed(api)
  await settle()
  act(() => api.emit({ ...ref, type: 'todos', threadId: null, phases: closedTodo }))
  const held = api.hold('start')
  api.failures.start = { code: 'internal_error', message: 'Failed' }
  let pending: Promise<CommandResult<AgentChatSnapshot>>
  act(() => { pending = view.result.current.start() })
  view.setTime(2_000)
  act(() => api.emit({ ...ref, type: 'status', status: 'busy' }))
  const live = view.result.current.state
  await act(async () => { held.resolve(); await pending })
  expect(view.result.current.state).toMatchObject({ turn: 0, status: 'busy', lastEventAt: 2_000, turnStartedAt: 1_000 })
  expect(view.result.current.state.todoMemory).toEqual(live.todoMemory)
  expect(view.result.current.state.todoMemory.get('')?.finishedInTurn).toBe(0)
})

it('shares one push subscription between every view of a chat and ends it when the last view leaves', async () => {
  const api = new FakeAgentChat()
  const scheduler = new ManualScheduler()
  api.snapshotResult = { ok: true, data: snapshot({ status: 'exited', items: [message] }) }
  const reader = renderHook(() => useAgentChat({ ...ref, api, scheduler }, { autoStart: false }))
  await settle()
  expect(api.subscribers()).toBe(1)
  expect(api.callsOf('start')).toEqual([])
  // A view that may start the chat joins the read-only one, reads once more and starts the stopped chat once.
  const chat = renderHook(() => useAgentChat({ ...ref, api, scheduler }))
  const other = renderHook(() => useAgentChat({ ...ref, chatId: 'chat-two', api, scheduler }, { autoStart: false }))
  expect(chat.result.current.state.items).toEqual([message])
  await settle()
  expect(api.subscribers()).toBe(2)
  expect(api.callsOf('snapshot')).toEqual([[ref], [ref], [{ ...ref, chatId: 'chat-two' }]])
  expect(api.callsOf('start')).toEqual([[ref]])
  const second = renderHook(() => useAgentChat({ ...ref, api, scheduler }))
  await settle()
  expect(api.callsOf('start')).toEqual([[ref]])
  act(() => api.emit({ ...ref, type: 'status', status: 'busy' }))
  for (const view of [reader, chat, second]) expect(view.result.current.state.status).toBe('busy')
  expect(other.result.current.state.status).toBe('exited')
  reader.unmount()
  chat.unmount()
  expect(api.subscribers()).toBe(2)
  act(() => api.emit({ ...ref, type: 'queued', count: 3 }))
  expect(second.result.current.state.queued).toBe(3)
  second.unmount()
  expect(api.subscribers()).toBe(1)
  other.unmount()
  expect(api.subscribers()).toBe(0)
})

it('restarts an exited chat when a start-capable view rejoins while a read-only view keeps the subscription', async () => {
  const api = new FakeAgentChat()
  const scheduler = new ManualScheduler()
  api.snapshotResult = { ok: true, data: snapshot({ status: 'exited' }) }
  const reader = renderHook(() => useAgentChat({ ...ref, api, scheduler }, { autoStart: false }))
  await settle()
  const selected = renderHook(() => useAgentChat({ ...ref, api, scheduler }))
  await settle()
  expect(api.callsOf('start')).toEqual([[ref]])
  // The session exits while selected; the selection moves away, the read-only view keeping the subscription alive.
  api.snapshotResult = { ok: true, data: snapshot({ status: 'exited' }) }
  act(() => api.emit({ ...ref, type: 'status', status: 'exited' }))
  selected.unmount()
  expect(api.subscribers()).toBe(1)
  expect(reader.result.current.state.status).toBe('exited')
  // Reselecting the chat starts it again.
  const reselected = renderHook(() => useAgentChat({ ...ref, api, scheduler }))
  await settle()
  expect(api.callsOf('start')).toEqual([[ref], [ref]])
  expect(reselected.result.current.state.status).toBe('idle')
  expect(reader.result.current.state.status).toBe('idle')
  expect(api.subscribers()).toBe(1)
})

const T = (second: number): string => `2026-11-26T10:00:0${second}.000Z`
const items = [
  { id: 'u1', at: T(0), kind: 'user_message' as const, text: 'Plan the epic' },
  { id: 'a1', at: T(2), kind: 'assistant_text' as const, text: 'Asked the Magos.' }
]
const lexmechanic = { label: 'Lexmechanic', kind: 'callsign' as const }
const magos = { label: 'Magos', kind: 'callsign' as const }
const planner = { folder: 'C:\\project', chatId: 'planner-chat' }
const orchestrator = { folder: 'C:\\project', chatId: 'magos-chat' }

/** A page with the shell's mail store over `mail`, and the Lexmechanic → Magos exchange in both mailboxes. */
function mailPage(): { mail: FakeChatMail; store: AgentMailStore; wrapper: (props: { children: ReactNode }) => JSX.Element } {
  const mail = new FakeChatMail()
  const dm = new FakeDm()
  dm.chats.mail = mail
  window.dm = dm
  mail.put({ ...planner, unseenCount: 1 })
  mail.put({ ...orchestrator, unseenCount: 1 })
  mail.setConversation(planner.folder, planner.chatId, [
    mailEntry({ id: 'ask', direction: 'sent', seq: null, from: lexmechanic, to: magos, acceptedAt: T(1), body: 'Proceed?' }),
    mailEntry({ id: 'answer', direction: 'received', seq: 1, from: magos, to: lexmechanic, acceptedAt: T(3), body: 'Yes', inReplyTo: 'ask' })
  ])
  mail.setConversation(orchestrator.folder, orchestrator.chatId, [
    mailEntry({ id: 'ask', direction: 'received', seq: 1, from: lexmechanic, to: magos, acceptedAt: T(1), body: 'Proceed?' }),
    mailEntry({ id: 'answer', direction: 'sent', seq: null, from: magos, to: lexmechanic, acceptedAt: T(3), body: 'Yes', inReplyTo: 'ask' })
  ])
  const store = createAgentMailStore(mail)
  store.track([planner.folder])
  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => <AgentMailContext.Provider value={store}>{children}</AgentMailContext.Provider>
  return { mail, store, wrapper }
}

const shown = (line: TranscriptLine): string => line.kind === 'mail'
  ? `✉ ${line.mail.from.label} → ${line.mail.to.label}`
  : line.id

/** What the open chat view (`AgentChat`) uses: the chat's state, and its transcript with mail cards. */
function useOpenChat(options: Parameters<typeof useAgentChat>[0]) {
  const chat = useAgentChat(options)
  return { ...chat, transcript: useMailTranscript(options.folder, options.chatId, chat.state.items) }
}

describe('Skitarii mail cards in the transcript', () => {
  it('interleaves each chat’s own received and sent mail with its items by time, storing none of it', async () => {
    const { mail, wrapper } = mailPage()
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: snapshot({ items }) }
    const scheduler = new ManualScheduler()
    const forPlanner = renderHook(() => useOpenChat({ ...planner, api, scheduler }), { wrapper })
    const forMagos = renderHook(() => useOpenChat({ ...orchestrator, api, scheduler }), { wrapper })
    await settle()

    expect(forPlanner.result.current.transcript.map(shown)).toEqual(['u1', '✉ Lexmechanic → Magos', 'a1', '✉ Magos → Lexmechanic'])
    expect(forMagos.result.current.transcript.map(shown)).toEqual(['u1', '✉ Lexmechanic → Magos', 'a1', '✉ Magos → Lexmechanic'])
    // Only the chat's own mailbox is read, and mail never becomes a chat item or reaches the agent chat bridge.
    expect(mail.calls.filter((call) => call.method === 'conversation').map((call) => call.args)).toEqual([[planner], [orchestrator]])
    expect(forPlanner.result.current.state.items).toEqual(items)
    expect(api.calls.map((call) => call.method).filter((method) => method !== 'snapshot')).toEqual([])
  })

  it('marks the shown received mail seen once for the person, and reads again on a push without marking it twice', async () => {
    const { mail, store, wrapper } = mailPage()
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: snapshot({ items }) }
    const scheduler = new ManualScheduler()
    renderHook(() => useOpenChat({ ...planner, api, scheduler }), { wrapper })
    await settle()

    const marks = (): unknown[][] => mail.calls.filter((call) => call.method === 'markSeen').map((call) => call.args)
    expect(marks()).toEqual([[{ ...planner, throughSeq: 1 }]])
    expect(store.view(planner.folder, planner.chatId).state).toMatchObject({ humanSeenSeq: 1, unseenCount: 0 })
    act(() => mail.put({ ...orchestrator, pendingCount: 1 }, true))
    await settle()
    expect(mail.calls.filter((call) => call.method === 'conversation')).toHaveLength(2)
    expect(marks()).toHaveLength(1)
  })

  it('shows no cards, and marks nothing, for a chat without a mailbox or a page without the mail store', async () => {
    const { mail, wrapper } = mailPage()
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: snapshot({ items }) }
    const scheduler = new ManualScheduler()
    const claude = renderHook(() => useOpenChat({ folder: planner.folder, chatId: 'claude-chat', api, scheduler }), { wrapper })
    const bare = renderHook(() => useOpenChat({ ...planner, api, scheduler }))
    await settle()
    expect(claude.result.current.transcript.map(shown)).toEqual(['u1', 'a1'])
    expect(bare.result.current.transcript.map(shown)).toEqual(['u1', 'a1'])
    expect(mail.calls.map((call) => call.method).filter((method) => method !== 'snapshot')).toEqual(['conversation'])
  })
})

describe('views that only follow a chat', () => {
  it('reads no mail and marks nothing seen for a view that only follows the chat (a rail row, a feed, a changes card)', async () => {
    const { mail, store, wrapper } = mailPage()
    const api = new FakeAgentChat()
    api.snapshotResult = { ok: true, data: snapshot({ items }) }
    const scheduler = new ManualScheduler()
    const row = renderHook(() => useAgentChat({ ...planner, api, scheduler }, { autoStart: false }), { wrapper })
    renderHook(() => useAgentChat({ ...orchestrator, api, scheduler }), { wrapper })
    await settle()
    act(() => mail.put({ ...orchestrator, pendingCount: 1 }, true))
    await settle()
    expect(row.result.current.state.items).toEqual(items)
    expect(mail.calls.map((call) => call.method).filter((method) => method !== 'snapshot')).toEqual([])
    expect(store.view(planner.folder, planner.chatId).state).toMatchObject({ humanSeenSeq: 0, unseenCount: 1 })
  })
})
