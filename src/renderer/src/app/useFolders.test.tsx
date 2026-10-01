// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { useFolders } from './useFolders'
import type { FoldersModel } from './useFolders'

const alpha = folderView({ path: '/a', name: 'a' })
const beta = folderView({ path: '/b', name: 'b' })
let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

interface Mounted {
  view: { result: { current: FoldersModel }; unmount(): void }
  errors: unknown[]
}

async function mount(): Promise<Mounted> {
  const errors: unknown[] = []
  const view = renderHook(() => useFolders((error) => errors.push(error)))
  await settle()
  return { view, errors }
}

describe('useFolders loading', () => {
  it('starts unloaded and then lists the tracked folders', async () => {
    dm.folders = [alpha, beta]
    const errors: unknown[] = []
    const view = renderHook(() => useFolders((error) => errors.push(error)))
    expect(view.result.current.loaded).toBe(false)
    await settle()
    expect(view.result.current.loaded).toBe(true)
    expect(view.result.current.folders).toEqual([alpha, beta])
  })

  it('loads once even though the error callback changes identity every render', async () => {
    await mount()
    expect(dm.calls.filter((call) => call === 'listFolders')).toHaveLength(1)
  })

  it('reports a load failure and still finishes loading', async () => {
    dm.rejects.listFolders = 'registry unreadable'
    const { view, errors } = await mount()
    expect(view.result.current.loaded).toBe(true)
    expect(view.result.current.folders).toEqual([])
    expect((errors[0] as Error).message).toBe('registry unreadable')
  })

})

describe('useFolders refreshing', () => {
  it('reloads when the window regains focus', async () => {
    const { view } = await mount()
    dm.folders = [alpha]
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(view.result.current.folders).toEqual([alpha])
  })

  it('stops listening for focus after unmounting', async () => {
    const { view } = await mount()
    view.unmount()
    const before = dm.calls.filter((call) => call === 'listFolders').length
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(dm.calls.filter((call) => call === 'listFolders')).toHaveLength(before)
  })

  it('keeps folder objects stable across a reload that changed nothing', async () => {
    dm.folders = [alpha, beta]
    const { view } = await mount()
    const before = view.result.current.folders
    await act(() => view.result.current.reload())
    expect(view.result.current.folders).toBe(before)
  })

  it('reloads on request', async () => {
    const { view } = await mount()
    dm.folders = [alpha]
    await act(() => view.result.current.reload())
    expect(view.result.current.folders).toEqual([alpha])
  })
})

describe('useFolders picking', () => {
  it('adds a newly picked folder and returns the result', async () => {
    dm.folders = [alpha]
    dm.pickQueue.push({ folder: beta, added: true })
    const { view } = await mount()
    let result: unknown
    await act(async () => {
      result = await view.result.current.pick()
    })
    expect(result).toEqual({ folder: beta, added: true })
    expect(view.result.current.folders).toEqual([alpha, beta])
  })

  it('does not duplicate an already tracked folder', async () => {
    dm.folders = [alpha, beta]
    const refreshed = folderView({ path: '/a', name: 'a', initialized: false })
    dm.pickQueue.push({ folder: refreshed, added: false })
    const { view } = await mount()
    await act(async () => {
      await view.result.current.pick()
    })
    expect(view.result.current.folders).toEqual([refreshed, beta])
  })

  it('leaves the list alone when the picker is canceled', async () => {
    dm.folders = [alpha]
    const { view } = await mount()
    let result: unknown
    await act(async () => {
      result = await view.result.current.pick()
    })
    expect(result).toEqual({ folder: null, added: false })
    expect(view.result.current.folders).toEqual([alpha])
  })
})

describe('useFolders untracking', () => {
  it('adopts the list returned after removing a folder', async () => {
    dm.folders = [alpha, beta]
    const { view } = await mount()
    await act(() => view.result.current.untrack('/a'))
    expect(view.result.current.folders).toEqual([beta])
  })
})
