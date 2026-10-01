import { describe, expect, it } from 'vitest'
import type { ToastState } from './toastState'
import { INITIAL_TOASTS, MAX_TOASTS, toastReducer } from './toastState'

function push(state: ToastState, message: string, tone: 'error' | 'info' | 'success' = 'error'): ToastState {
  return toastReducer(state, { type: 'push', tone, message })
}

describe('toastReducer push', () => {
  it('appends a toast with the next id', () => {
    const state = push(push(INITIAL_TOASTS, 'first'), 'second', 'info')
    expect(state.toasts).toEqual([
      { id: 1, tone: 'error', message: 'first' },
      { id: 2, tone: 'info', message: 'second' }
    ])
    expect(state.nextId).toBe(3)
  })

  it('ignores a repeat of a visible toast with the same tone and message', () => {
    const once = push(INITIAL_TOASTS, 'offline')
    expect(push(once, 'offline')).toBe(once)
  })

  it('keeps toasts that differ by tone or message', () => {
    const state = push(push(push(INITIAL_TOASTS, 'x'), 'x', 'info'), 'y')
    expect(state.toasts.map((toast) => toast.message)).toEqual(['x', 'x', 'y'])
  })

  it('shows at most the newest toasts', () => {
    let state = INITIAL_TOASTS
    for (let index = 0; index < MAX_TOASTS + 2; index += 1) state = push(state, `m${index}`)
    expect(state.toasts).toHaveLength(MAX_TOASTS)
    expect(state.toasts[0]?.message).toBe('m2')
    expect(state.toasts[MAX_TOASTS - 1]?.message).toBe(`m${MAX_TOASTS + 1}`)
  })
})

describe('toastReducer dismiss', () => {
  it('removes only the requested toast', () => {
    const state = push(push(INITIAL_TOASTS, 'a'), 'b')
    const next = toastReducer(state, { type: 'dismiss', id: 1 })
    expect(next.toasts.map((toast) => toast.message)).toEqual(['b'])
  })

  it('keeps issuing fresh ids after a dismissal', () => {
    const dismissed = toastReducer(push(INITIAL_TOASTS, 'a'), { type: 'dismiss', id: 1 })
    expect(push(dismissed, 'b').toasts[0]?.id).toBe(2)
  })

  it('allows a dismissed message to show again', () => {
    const dismissed = toastReducer(push(INITIAL_TOASTS, 'a'), { type: 'dismiss', id: 1 })
    expect(push(dismissed, 'a').toasts).toHaveLength(1)
  })

  it('ignores unknown ids', () => {
    const state = push(INITIAL_TOASTS, 'a')
    expect(toastReducer(state, { type: 'dismiss', id: 99 }).toasts).toHaveLength(1)
  })
})
