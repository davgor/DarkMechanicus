// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserScheduler } from './scheduler'

afterEach(() => {
  vi.useRealTimers()
})

describe('browserScheduler.after', () => {
  it('runs the task once after the delay', () => {
    vi.useFakeTimers()
    let runs = 0
    browserScheduler.after(100, () => {
      runs += 1
    })
    vi.advanceTimersByTime(99)
    expect(runs).toBe(0)
    vi.advanceTimersByTime(1)
    expect(runs).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(runs).toBe(1)
  })

  it('does not run a canceled task', () => {
    vi.useFakeTimers()
    let runs = 0
    const cancel = browserScheduler.after(100, () => {
      runs += 1
    })
    cancel()
    vi.advanceTimersByTime(500)
    expect(runs).toBe(0)
  })
})

describe('browserScheduler.every', () => {
  it('repeats the task on every interval', () => {
    vi.useFakeTimers()
    let runs = 0
    browserScheduler.every(50, () => {
      runs += 1
    })
    vi.advanceTimersByTime(200)
    expect(runs).toBe(4)
  })

  it('stops repeating once canceled', () => {
    vi.useFakeTimers()
    let runs = 0
    const cancel = browserScheduler.every(50, () => {
      runs += 1
    })
    vi.advanceTimersByTime(100)
    cancel()
    vi.advanceTimersByTime(500)
    expect(runs).toBe(2)
  })
})
