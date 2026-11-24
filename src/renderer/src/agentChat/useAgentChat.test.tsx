// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { AgentChatSnapshot, AgentTodoPhase } from '../../../shared/agents/agentChat'
import type { CommandResult } from '../../../shared/desktop/api'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ClockContext, type Clock } from '../epic/clock'
import { useAgentChat } from './useAgentChat'

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
      await view.result.current.send('Steer')
      await view.result.current.interrupt()
      await view.result.current.answer('prompt', 'allow_once')
      await view.result.current.answer('question', 'other', 'Response')
      await view.result.current.start()
      await view.result.current.setSurface('terminal')
    })
    expect(view.api.callsOf('send')).toEqual([[{ ...ref, text: 'Steer' }]])
    expect(view.api.callsOf('interrupt')).toEqual([[ref]])
    expect(view.api.callsOf('answer')).toEqual([[{ ...ref, promptId: 'prompt', optionId: 'allow_once' }], [{ ...ref, promptId: 'question', optionId: 'other', text: 'Response' }]])
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
    await view.result.current.send('new')
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
