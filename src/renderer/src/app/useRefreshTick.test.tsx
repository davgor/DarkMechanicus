// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { useRefreshTick } from './useRefreshTick'

afterEach(cleanup)

interface Props {
  enabled: boolean
}

function mount(scheduler: ManualScheduler, enabled = true): ReturnType<typeof renderHook<number, Props>> {
  return renderHook(({ enabled: on }: Props) => useRefreshTick({ scheduler, everyMs: 10_000, enabled: on }), {
    initialProps: { enabled }
  })
}

describe('useRefreshTick', () => {
  it('starts at zero and counts each interval', () => {
    const scheduler = new ManualScheduler()
    const view = mount(scheduler)
    expect(view.result.current).toBe(0)
    expect(scheduler.intervals()).toEqual([10_000])
    act(() => scheduler.fireIntervals())
    expect(view.result.current).toBe(1)
    act(() => scheduler.fireIntervals())
    expect(view.result.current).toBe(2)
  })

  it('counts a window focus as a refresh', () => {
    const view = mount(new ManualScheduler())
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(view.result.current).toBe(1)
  })

  it('does nothing while disabled', () => {
    const scheduler = new ManualScheduler()
    const view = mount(scheduler, false)
    expect(scheduler.intervals()).toEqual([])
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(view.result.current).toBe(0)
  })

  it('starts and stops with the enabled flag', () => {
    const scheduler = new ManualScheduler()
    const view = mount(scheduler, false)
    view.rerender({ enabled: true })
    expect(scheduler.intervals()).toEqual([10_000])
    view.rerender({ enabled: false })
    expect(scheduler.intervals()).toEqual([])
  })

  it('stops on unmount', () => {
    const scheduler = new ManualScheduler()
    const view = mount(scheduler)
    view.unmount()
    expect(scheduler.intervals()).toEqual([])
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(view.result.current).toBe(0)
  })
})
