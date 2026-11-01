// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNow } from './clock'

const START = Date.UTC(2026, 2, 1, 10, 0, 0)

function Now(): JSX.Element {
  return <output>{useNow()}</output>
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(START)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useNow on the system clock', () => {
  it('starts at the current time and moves on once a second', () => {
    render(<Now />)
    expect(screen.getByRole('status').textContent).toBe(String(START))

    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(screen.getByRole('status').textContent).toBe(String(START))
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByRole('status').textContent).toBe(String(START + 1_000))
  })

  it('stops ticking once nothing shows the time', () => {
    const shown = render(<Now />)
    expect(vi.getTimerCount()).toBe(1)

    shown.unmount()

    expect(vi.getTimerCount()).toBe(0)
  })
})
