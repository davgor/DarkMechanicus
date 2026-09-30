// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../__mocks__/eventLog'
import { FakeDm } from '../__mocks__/fakeDm'
import { EPIC_A, EPIC_B } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { epicToken, folderToken } from './eventRouting'
import { BACKGROUND_POLL_MS, SELECTED_POLL_MS, useEventFeed } from './useEventFeed'

let dm: FakeDm
let scheduler: ManualScheduler
let errors: unknown[]
const logs = new Map<string, EventLog>()

interface Props {
  paths: string[]
  selected: string | null
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
  dm.handlers.listEvents = (input, folder) => logFor(folder).page(input as Parameters<EventLog['page']>[0])
  window.dm = dm
})

afterEach(cleanup)

async function mount(props: Props): Promise<ReturnType<typeof renderHook<ReturnType<typeof useEventFeed>, Props>>> {
  const view = renderHook(
    (p: Props) =>
      useEventFeed({ paths: p.paths, selectedPath: p.selected, scheduler, onError: (e) => errors.push(e) }),
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
    expect(epicToken(view.result.current.tokens, '/a', EPIC_A)).toBe(0)
  })

  it('bumps the affected epic and the folder when events arrive', async () => {
    const view = await mount({ paths: ['/a'], selected: '/a' })
    logFor('/a').append({ epicId: EPIC_A })
    await poll()
    const { tokens } = view.result.current
    expect(epicToken(tokens, '/a', EPIC_A)).toBe(1)
    expect(epicToken(tokens, '/a', EPIC_B)).toBe(0)
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
    expect(folderToken(view.result.current.tokens, '/b')).toBe(2)
    expect(epicToken(view.result.current.tokens, '/b', EPIC_B)).toBe(0)
  })

  it('lets the shell bump a folder directly', async () => {
    const view = await mount({ paths: ['/a'], selected: '/a' })
    act(() => view.result.current.bumpFolder('/a'))
    expect(folderToken(view.result.current.tokens, '/a')).toBe(2)
  })
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
