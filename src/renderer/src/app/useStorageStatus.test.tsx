// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { storageStatus } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { useStorageStatus } from './useStorageStatus'

let dm: FakeDm
let errors: unknown[]

interface Props {
  path: string | null
  token: number
  tick: number
}

beforeEach(() => {
  errors = []
  dm = new FakeDm()
  dm.handlers.getStorageStatus = (_input, folder) => storageStatus({ repoRoot: folder })
  window.dm = dm
})

afterEach(cleanup)

function mount(props: Props): ReturnType<typeof renderHook<ReturnType<typeof useStorageStatus>, Props>> {
  return renderHook((p: Props) => useStorageStatus({ ...p, onError: (e) => errors.push(e) }), {
    initialProps: props
  })
}

describe('useStorageStatus', () => {
  it('has no status without a folder', async () => {
    const view = mount({ path: null, token: 0, tick: 0 })
    await settle()
    expect(view.result.current).toBeNull()
    expect(dm.callsOf('getStorageStatus')).toHaveLength(0)
  })

  it('loads the status of the folder', async () => {
    const view = mount({ path: '/a', token: 0, tick: 0 })
    expect(view.result.current).toBeNull()
    await settle()
    expect(view.result.current?.repoRoot).toBe('/a')
  })
})

describe('useStorageStatus refreshing', () => {
  it('reloads when the token changes but not otherwise', async () => {
    const view = mount({ path: '/a', token: 0, tick: 0 })
    await settle()
    view.rerender({ path: '/a', token: 0, tick: 0 })
    await settle()
    expect(dm.callsOf('getStorageStatus')).toHaveLength(1)
    view.rerender({ path: '/a', token: 1, tick: 0 })
    await settle()
    expect(dm.callsOf('getStorageStatus')).toHaveLength(2)
  })

  it('reloads when the tick changes', async () => {
    const view = mount({ path: '/a', token: 3, tick: 0 })
    await settle()
    view.rerender({ path: '/a', token: 3, tick: 1 })
    await settle()
    expect(dm.callsOf('getStorageStatus')).toHaveLength(2)
  })

  it('reloads when the token and the tick change together', async () => {
    const view = mount({ path: '/a', token: 0, tick: 0 })
    await settle()
    view.rerender({ path: '/a', token: 1, tick: 1 })
    await settle()
    expect(dm.callsOf('getStorageStatus')).toHaveLength(2)
  })

  it('does not mistake one token and tick pair for another', async () => {
    const view = mount({ path: '/a', token: 1, tick: 2 })
    await settle()
    view.rerender({ path: '/a', token: 2, tick: 1 })
    await settle()
    expect(dm.callsOf('getStorageStatus')).toHaveLength(2)
  })
})

describe('useStorageStatus folder changes', () => {
  it('drops the previous folder status at once when the folder changes', async () => {
    const view = mount({ path: '/a', token: 0, tick: 0 })
    await settle()
    const hold = dm.holdNext('getStorageStatus')
    view.rerender({ path: '/b', token: 0, tick: 0 })
    expect(view.result.current).toBeNull()
    hold.resolve()
    await settle()
    expect(view.result.current?.repoRoot).toBe('/b')
  })

  it('ignores a response that arrives after the folder changed', async () => {
    const hold = dm.holdNext('getStorageStatus')
    const view = mount({ path: '/a', token: 0, tick: 0 })
    view.rerender({ path: '/b', token: 0, tick: 0 })
    await settle()
    hold.resolve()
    await settle()
    expect(view.result.current?.repoRoot).toBe('/b')
  })

  it('reports failures', async () => {
    dm.failures.getStorageStatus = { code: 'internal', message: 'status unavailable' }
    const view = mount({ path: '/a', token: 0, tick: 0 })
    await settle()
    expect(view.result.current).toBeNull()
    expect((errors[0] as Error).message).toBe('status unavailable')
  })
})
