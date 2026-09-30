// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { epicSummary } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { EMPTY_TOKENS, bumpFolderToken } from './eventRouting'
import type { Tokens } from './eventRouting'
import { listFor, useEpicLists } from './useEpicLists'

const one = epicSummary({ id: 'ep_one', title: 'One' })
const two = epicSummary({ id: 'ep_two', title: 'Two' })
let dm: FakeDm
let errors: unknown[]
let served: Record<string, ReturnType<typeof epicSummary>[]>

interface Props {
  paths: string[]
  tokens: Tokens
}

beforeEach(() => {
  errors = []
  served = { '/a': [one], '/b': [two] }
  dm = new FakeDm()
  dm.handlers.listEpics = (_input, folder) => served[folder] ?? []
  window.dm = dm
})

afterEach(cleanup)

async function mount(props: Props): Promise<ReturnType<typeof renderHook<ReturnType<typeof useEpicLists>, Props>>> {
  const view = renderHook(
    (p: Props) => useEpicLists({ paths: p.paths, tokens: p.tokens, onError: (e) => errors.push(e) }),
    { initialProps: props }
  )
  await settle()
  return view
}

describe('useEpicLists loading', () => {
  it('loads the epics of every active folder', async () => {
    const view = await mount({ paths: ['/a', '/b'], tokens: EMPTY_TOKENS })
    expect(view.result.current['/a']).toEqual({ status: 'ready', epics: [one], error: null })
    expect(view.result.current['/b']?.epics).toEqual([two])
  })

  it('shows a loading state until the first response', async () => {
    const hold = dm.holdNext('listEpics')
    const view = renderHook(
      (p: Props) => useEpicLists({ paths: p.paths, tokens: p.tokens, onError: (e) => errors.push(e) }),
      { initialProps: { paths: ['/a'], tokens: EMPTY_TOKENS } }
    )
    expect(view.result.current['/a']).toEqual({ status: 'loading', epics: [], error: null })
    hold.resolve()
    await settle()
    expect(view.result.current['/a']?.status).toBe('ready')
  })

  it('fetches a folder when it becomes active', async () => {
    const view = await mount({ paths: ['/a'], tokens: EMPTY_TOKENS })
    view.rerender({ paths: ['/a', '/b'], tokens: EMPTY_TOKENS })
    await settle()
    expect(view.result.current['/b']?.epics).toEqual([two])
    expect(dm.callsOf('listEpics').map((call) => call.folder)).toEqual(['/a', '/b'])
  })
})

describe('useEpicLists refreshing', () => {
  it('does not refetch while tokens are unchanged', async () => {
    const view = await mount({ paths: ['/a'], tokens: EMPTY_TOKENS })
    view.rerender({ paths: ['/a'], tokens: EMPTY_TOKENS })
    await settle()
    expect(dm.callsOf('listEpics')).toHaveLength(1)
  })

  it('refetches a folder whose token changed, and only that folder', async () => {
    const view = await mount({ paths: ['/a', '/b'], tokens: EMPTY_TOKENS })
    served['/a'] = [one, two]
    view.rerender({ paths: ['/a', '/b'], tokens: bumpFolderToken(EMPTY_TOKENS, '/a') })
    await settle()
    expect(view.result.current['/a']?.epics).toEqual([one, two])
    expect(dm.callsOf('listEpics').map((call) => call.folder)).toEqual(['/a', '/b', '/a'])
  })

  it('keeps showing the old list while refreshing', async () => {
    const view = await mount({ paths: ['/a'], tokens: EMPTY_TOKENS })
    const hold = dm.holdNext('listEpics')
    view.rerender({ paths: ['/a'], tokens: bumpFolderToken(EMPTY_TOKENS, '/a') })
    expect(view.result.current['/a']).toEqual({ status: 'ready', epics: [one], error: null })
    hold.resolve()
    await settle()
  })

  it('ignores an older response that arrives after a newer one', async () => {
    const first = dm.holdNext('listEpics')
    const view = renderHook(
      (p: Props) => useEpicLists({ paths: p.paths, tokens: p.tokens, onError: (e) => errors.push(e) }),
      { initialProps: { paths: ['/a'], tokens: EMPTY_TOKENS } }
    )
    served['/a'] = [two]
    view.rerender({ paths: ['/a'], tokens: bumpFolderToken(EMPTY_TOKENS, '/a') })
    await settle()
    served['/a'] = [one]
    act(() => first.resolve())
    await settle()
    expect(view.result.current['/a']?.epics).toEqual([two])
  })
})

describe('useEpicLists failures', () => {
  it('reports the failure and keeps the last known list', async () => {
    const view = await mount({ paths: ['/a'], tokens: EMPTY_TOKENS })
    dm.failures.listEpics = { code: 'internal', message: 'database is locked' }
    view.rerender({ paths: ['/a'], tokens: bumpFolderToken(EMPTY_TOKENS, '/a') })
    await settle()
    expect(view.result.current['/a']).toEqual({ status: 'error', epics: [one], error: 'database is locked' })
    expect((errors[0] as Error).message).toBe('database is locked')
  })

  it('starts empty when the first load fails', async () => {
    dm.failures.listEpics = { code: 'not_initialized', message: 'not set up' }
    const view = await mount({ paths: ['/a'], tokens: EMPTY_TOKENS })
    expect(view.result.current['/a']).toEqual({ status: 'error', epics: [], error: 'not set up' })
  })
})

describe('listFor', () => {
  it('treats an unknown folder as still loading', () => {
    expect(listFor({}, '/a')).toEqual({ status: 'loading', epics: [], error: null })
  })

  it('returns the known list', () => {
    const known = { status: 'ready' as const, epics: [one], error: null }
    expect(listFor({ '/a': known }, '/a')).toBe(known)
  })
})
