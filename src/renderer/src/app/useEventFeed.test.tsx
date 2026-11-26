// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../__mocks__/eventLog'
import { FakeDm } from '../__mocks__/fakeDm'
import { EPIC_A, EPIC_B } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { epicToken, folderToken, kanbanCountToken } from './eventRouting'
import { BACKGROUND_POLL_MS, SELECTED_POLL_MS, useEventFeed } from './useEventFeed'

let dm: FakeDm
let scheduler: ManualScheduler
let errors: unknown[]
const logs = new Map<string, EventLog>()

interface Props {
  paths: string[]
  selected: string | null
  identities?: ReadonlyMap<string, string>
}

function logFor(path: string): EventLog {
  const existing = logs.get(path)
  if (existing) return existing
  const created = new EventLog()
  logs.set(path, created)
  return created
}

beforeEach(() => {
  logs.clear()
  errors = []
  scheduler = new ManualScheduler()
  dm = new FakeDm()
  dm.handlers.getEventHead = (_input, path) => logFor(path).head()
  dm.handlers.listEvents = (input, folder) => logFor(folder).page(input as Parameters<EventLog['page']>[0])
  window.dm = dm
})

afterEach(cleanup)

async function mount(props: Props): Promise<ReturnType<typeof renderHook<ReturnType<typeof useEventFeed>, Props>>> {
  const view = renderHook(
    (p: Props) =>
      useEventFeed({ paths: p.paths, identities: p.identities, selectedPath: p.selected, scheduler, onError: (e) => errors.push(e) }),
    { initialProps: props }
  )
  await settle()
  return view
}

async function poll(): Promise<void> {
  act(() => scheduler.fireIntervals())
  await settle()
}

describe('useEventFeed scheduling', () => {
  it('polls the selected folder faster than the others', async () => {
    await mount({ paths: ['/a', '/b'], selected: '/a' })
    expect(scheduler.intervals()).toEqual([SELECTED_POLL_MS, BACKGROUND_POLL_MS])
    expect([SELECTED_POLL_MS, BACKGROUND_POLL_MS]).toEqual([1500, 5000])
  })

  it('reschedules when the selection moves', async () => {
    const view = await mount({ paths: ['/a', '/b'], selected: '/a' })
    view.rerender({ paths: ['/a', '/b'], selected: '/b' })
    expect(scheduler.intervals()).toEqual([BACKGROUND_POLL_MS, SELECTED_POLL_MS])
  })

  it('stops polling folders that leave the active set and everything on unmount', async () => {
    const view = await mount({ paths: ['/a', '/b'], selected: '/a' })
    view.rerender({ paths: ['/a'], selected: '/a' })
    expect(scheduler.intervals()).toEqual([SELECTED_POLL_MS])
    view.unmount()
    expect(scheduler.intervals()).toEqual([])
  })
})

describe('useEventFeed tokens', () => {
  it('starts from the end of the log and refreshes the folder once', async () => {
    logFor('/a').append({ epicId: EPIC_A })
    logFor('/a').append({ epicId: EPIC_B })
    const view = await mount({ paths: ['/a'], selected: '/a' })
    expect(folderToken(view.result.current.tokens, '/a')).toBe(1)
    expect(epicToken(view.result.current.tokens, '/a', EPIC_A)).toBe(1)
  })

  it('bumps the affected epic and the folder when events arrive', async () => {
    const view = await mount({ paths: ['/a'], selected: '/a' })
    logFor('/a').append({ epicId: EPIC_A })
    await poll()
    const { tokens } = view.result.current
    expect(epicToken(tokens, '/a', EPIC_A)).toBe(2)
    expect(epicToken(tokens, '/a', EPIC_B)).toBe(1)
    expect(folderToken(tokens, '/a')).toBe(2)
  })

  it('keeps folders independent', async () => {
    const view = await mount({ paths: ['/a', '/b'], selected: '/a' })
    logFor('/b').append({ epicId: EPIC_B })
    await poll()
    expect(folderToken(view.result.current.tokens, '/a')).toBe(1)
    expect(folderToken(view.result.current.tokens, '/b')).toBe(2)
  })

  it('does not change tokens while nothing happens', async () => {
    const view = await mount({ paths: ['/a'], selected: '/a' })
    await poll()
    await poll()
    expect(folderToken(view.result.current.tokens, '/a')).toBe(1)
  })

  it('re-baselines a folder that becomes active again', async () => {
    const view = await mount({ paths: ['/a', '/b'], selected: '/a' })
    view.rerender({ paths: ['/a'], selected: '/a' })
    logFor('/b').append({ epicId: EPIC_B })
    view.rerender({ paths: ['/a', '/b'], selected: '/a' })
    await settle()
    expect(folderToken(view.result.current.tokens, '/b')).toBe(1)
    expect(epicToken(view.result.current.tokens, '/b', EPIC_B)).toBe(1)
  })

  it('lets the shell bump a folder directly', async () => {
    const view = await mount({ paths: ['/a'], selected: '/a' })
    act(() => view.result.current.bumpFolder('/a'))
    expect(folderToken(view.result.current.tokens, '/a')).toBe(2)
  })
})

it('opens a replaced identity with a single head request and fences the late previous response', async () => {
  const previous = dm.holdNext('getEventHead')
  const view = await mount({ paths: ['/a'], selected: '/a', identities: new Map([['/a', 'old']]) })
  view.rerender({ paths: ['/a'], selected: '/a', identities: new Map([['/a', 'new']]) })
  await settle()
  previous.resolve()
  await settle()
  expect(view.result.current.tokens.ready['/a']).toBe('new')
  expect(dm.callsOf('getEventHead')).toHaveLength(2)
  expect(dm.callsOf('listEvents')).toEqual([])
  expect(kanbanCountToken(view.result.current.tokens, '/a')).toBe(1)
})

describe('useEventFeed failures', () => {
  it('reports a failing feed once', async () => {
    dm.failures.listEvents = { code: 'internal', message: 'main process unavailable' }
    await mount({ paths: ['/a'], selected: '/a' })
    await poll()
    await poll()
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('main process unavailable')
  })
})

describe('useEventFeed notifications', () => {
  const RUN = 'rn_0000000000000000000000000a'
  const SPRINT_1 = 'sp_0000000000000000000000000a'
  const SPRINT_2 = 'sp_0000000000000000000000000b'

  /** Shaped like the event `submitSprintReport` appends (src/core/services/reports.ts). */
  function reportSubmitted(path: string, sprintId: string, reportRevision: number): void {
    logFor(path).append({ kind: 'report.submitted', epicId: EPIC_A, runId: RUN, payload: { sprintId, reportRevision } })
  }

  function runFailed(path: string, runId = RUN): void {
    logFor(path).append({ kind: 'run.failed', epicId: EPIC_A, runId, payload: { reason: 'ticket failed', canceledAttempts: [] } })
  }

  it('raises nothing for the events before the baseline', async () => {
    reportSubmitted('/a', SPRINT_1, 1)
    runFailed('/a')
    await mount({ paths: ['/a'], selected: '/a' })
    await poll()
    expect(dm.notifications.raised).toEqual([])
  })

  it('raises a new run.failed once with the folder and ids', async () => {
    await mount({ paths: ['/a'], selected: '/a' })
    runFailed('/a')
    logFor('/a').append({ kind: 'run.failed', epicId: null, runId: RUN })
    logFor('/a').append({ kind: 'run.canceled', epicId: EPIC_A, runId: RUN })
    await poll()
    await poll()
    expect(dm.notifications.raised).toEqual([{ folder: '/a', kind: 'run_failed', epicId: EPIC_A, runId: RUN }])
  })

  it('raises checkpoint_ready once per sprint across report revisions', async () => {
    await mount({ paths: ['/a'], selected: '/a' })
    reportSubmitted('/a', SPRINT_1, 1)
    await poll()
    reportSubmitted('/a', SPRINT_1, 2)
    await poll()
    reportSubmitted('/a', SPRINT_2, 1)
    reportSubmitted('/a', SPRINT_2, 2)
    await poll()
    expect(dm.notifications.raised).toEqual([
      { folder: '/a', kind: 'checkpoint_ready', epicId: EPIC_A, runId: RUN },
      { folder: '/a', kind: 'checkpoint_ready', epicId: EPIC_A, runId: RUN }
    ])
  })

  it('does not repeat a notification when a re-created poller refetches', async () => {
    const view = await mount({ paths: ['/a'], selected: '/a', identities: new Map([['/a', 'old']]) })
    runFailed('/a')
    await poll()
    view.rerender({ paths: ['/a'], selected: '/a', identities: new Map([['/a', 'new']]) })
    await settle()
    reportSubmitted('/a', SPRINT_1, 1)
    runFailed('/a')
    await poll()
    expect(dm.notifications.raised.map(raised => raised.kind)).toEqual(['run_failed', 'checkpoint_ready'])
  })

  it('drops a failed raise without reporting it and keeps notifying', async () => {
    const view = await mount({ paths: ['/a'], selected: '/a' })
    const raise = dm.notifications.raise.bind(dm.notifications)
    let calls = 0
    dm.notifications.raise = (request) => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('main unavailable'))
      if (calls === 2) return Promise.resolve({ ok: false, error: { code: 'not_found', message: 'untracked' } })
      if (calls === 3) throw new Error('bridge gone')
      return raise(request)
    }
    runFailed('/a', 'rn_00000000000000000000000001')
    await poll()
    runFailed('/a', 'rn_00000000000000000000000002')
    await poll()
    runFailed('/a', 'rn_00000000000000000000000003')
    await poll()
    runFailed('/a')
    await poll()
    expect(errors).toEqual([])
    expect(calls).toBe(4)
    expect(dm.notifications.raised).toEqual([{ folder: '/a', kind: 'run_failed', epicId: EPIC_A, runId: RUN }])
    expect(folderToken(view.result.current.tokens, '/a')).toBe(5)
  })
})
