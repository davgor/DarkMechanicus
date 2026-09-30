// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import type { Deferred } from '../__mocks__/deferred'
import { settle } from '../__mocks__/settle'
import { useResource } from './useResource'

afterEach(cleanup)

interface Props {
  key: string | null
  version: number
}

class Source {
  errors: unknown[] = []
  loads: string[] = []
  failWith: string | null = null
  hold: Deferred | null = null

  load = async (key: string): Promise<string> => {
    this.loads.push(key)
    await this.hold?.promise
    if (this.failWith !== null) throw new Error(this.failWith)
    return `value:${key}`
  }
}

function mount(source: Source, initial: Props): ReturnType<typeof renderHook<ReturnType<typeof useResource<string>>, Props>> {
  return renderHook(
    (props: Props) =>
      useResource<string>({
        key: props.key,
        version: props.version,
        load: () => source.load(props.key ?? ''),
        onError: (error) => source.errors.push(error)
      }),
    { initialProps: initial }
  )
}

describe('useResource loading', () => {
  it('starts loading and then holds the value', async () => {
    const source = new Source()
    const view = mount(source, { key: 'a', version: 0 })
    expect(view.result.current).toEqual({ status: 'loading' })
    await settle()
    expect(view.result.current).toEqual({ status: 'ready', value: 'value:a' })
  })

  it('stays idle and never loads without a key', async () => {
    const source = new Source()
    const view = mount(source, { key: null, version: 0 })
    await settle()
    expect(view.result.current).toEqual({ status: 'loading' })
    expect(source.loads).toEqual([])
  })

  it('reloads when the version changes but not otherwise', async () => {
    const source = new Source()
    const view = mount(source, { key: 'a', version: 0 })
    await settle()
    view.rerender({ key: 'a', version: 0 })
    await settle()
    expect(source.loads).toEqual(['a'])
    view.rerender({ key: 'a', version: 1 })
    await settle()
    expect(source.loads).toEqual(['a', 'a'])
  })
})

describe('useResource key changes', () => {
  it('never shows another key value while the new one loads', async () => {
    const source = new Source()
    const view = mount(source, { key: 'a', version: 0 })
    await settle()
    source.hold = deferred()
    view.rerender({ key: 'b', version: 0 })
    expect(view.result.current).toEqual({ status: 'loading' })
    source.hold.resolve()
    await settle()
    expect(view.result.current).toEqual({ status: 'ready', value: 'value:b' })
  })

  it('ignores a slow response for a key that is no longer current', async () => {
    const source = new Source()
    source.hold = deferred()
    const first = source.hold
    const view = mount(source, { key: 'a', version: 0 })
    source.hold = null
    view.rerender({ key: 'b', version: 0 })
    await settle()
    first.resolve()
    await settle()
    expect(view.result.current).toEqual({ status: 'ready', value: 'value:b' })
  })
})

describe('useResource failures', () => {
  it('reports the error and exposes an error state', async () => {
    const source = new Source()
    source.failWith = 'nope'
    const view = mount(source, { key: 'a', version: 0 })
    await settle()
    expect(view.result.current).toEqual({ status: 'error' })
    expect((source.errors[0] as Error).message).toBe('nope')
  })

  it('keeps the last good value when a refresh fails', async () => {
    const source = new Source()
    const view = mount(source, { key: 'a', version: 0 })
    await settle()
    source.failWith = 'flaky'
    view.rerender({ key: 'a', version: 1 })
    await settle()
    expect(view.result.current).toEqual({ status: 'ready', value: 'value:a' })
    expect(source.errors).toHaveLength(1)
  })
})
