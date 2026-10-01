// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { usePersistentState } from './usePersistentState'

const isCount = (value: unknown): value is number => typeof value === 'number'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(cleanup)

function useCount(): ReturnType<typeof usePersistentState<number>> {
  return usePersistentState('count', 3, isCount)
}

function blockStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('storage blocked')
    }
  })
  return () => {
    if (original) Object.defineProperty(window, 'localStorage', original)
  }
}

describe('usePersistentState reading', () => {
  it('starts from the fallback when nothing is stored', () => {
    expect(renderHook(useCount).result.current[0]).toBe(3)
  })

  it('starts from a stored value', () => {
    window.localStorage.setItem('count', '9')
    expect(renderHook(useCount).result.current[0]).toBe(9)
  })

  it('ignores stored values that fail validation', () => {
    window.localStorage.setItem('count', '"nine"')
    expect(renderHook(useCount).result.current[0]).toBe(3)
  })
})

describe('usePersistentState writing', () => {
  it('persists updates', () => {
    const view = renderHook(useCount)
    act(() => view.result.current[1](5))
    expect(view.result.current[0]).toBe(5)
    expect(window.localStorage.getItem('count')).toBe('5')
  })

  it('supports functional updates', () => {
    const view = renderHook(useCount)
    act(() => view.result.current[1]((previous) => previous + 4))
    expect(window.localStorage.getItem('count')).toBe('7')
  })

  it('restores the value in a fresh mount', () => {
    const first = renderHook(useCount)
    act(() => first.result.current[1](8))
    first.unmount()
    expect(renderHook(useCount).result.current[0]).toBe(8)
  })
})

describe('usePersistentState with blocked storage', () => {
  it('still works in memory', () => {
    const restore = blockStorage()
    try {
      const view = renderHook(useCount)
      act(() => view.result.current[1](6))
      expect(view.result.current[0]).toBe(6)
    } finally {
      restore()
    }
  })
})
