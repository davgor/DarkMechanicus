import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addSeconds, createSystemClock, isBefore } from './clock'

const START_ISO = '2026-03-04T05:06:07.089Z'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(START_ISO))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createSystemClock', () => {
  it('reads the current time in whole milliseconds', () => {
    expect(createSystemClock().nowMs()).toBe(Date.parse(START_ISO))
  })

  it('formats the current time as ISO-8601 UTC with milliseconds', () => {
    expect(createSystemClock().nowIso()).toBe(START_ISO)
  })

  it('follows the system clock as time passes', () => {
    const clock = createSystemClock()
    vi.advanceTimersByTime(1500)
    expect(clock.nowMs()).toBe(Date.parse(START_ISO) + 1500)
    expect(clock.nowIso()).toBe('2026-03-04T05:06:08.589Z')
  })

  it('reports the same instant in both representations', () => {
    const clock = createSystemClock()
    expect(Date.parse(clock.nowIso())).toBe(clock.nowMs())
  })
})

describe('addSeconds', () => {
  it('adds whole seconds', () => {
    expect(addSeconds('2026-01-01T00:00:00.000Z', 90)).toBe('2026-01-01T00:01:30.000Z')
    expect(addSeconds('2026-01-01T00:00:00.000Z', 900)).toBe('2026-01-01T00:15:00.000Z')
  })

  it('subtracts when the seconds are negative', () => {
    expect(addSeconds('2026-01-01T00:01:30.000Z', -90)).toBe('2026-01-01T00:00:00.000Z')
  })

  it('keeps sub-second precision', () => {
    expect(addSeconds('2026-01-01T00:00:00.250Z', 1.5)).toBe('2026-01-01T00:00:01.750Z')
    expect(addSeconds('2026-01-01T00:00:00.000Z', 0.001)).toBe('2026-01-01T00:00:00.001Z')
  })

  it('returns the same instant for zero seconds', () => {
    expect(addSeconds('2026-01-01T00:00:00.123Z', 0)).toBe('2026-01-01T00:00:00.123Z')
  })

  it('carries across day and year boundaries', () => {
    expect(addSeconds('2026-12-31T23:59:59.500Z', 1)).toBe('2027-01-01T00:00:00.500Z')
    expect(addSeconds('2026-01-01T00:00:00.000Z', 86_400)).toBe('2026-01-02T00:00:00.000Z')
  })

  it('normalizes offsets to UTC', () => {
    expect(addSeconds('2026-01-01T02:00:00+02:00', 60)).toBe('2026-01-01T00:01:00.000Z')
  })
})

describe('isBefore', () => {
  it('is true only when the first instant is strictly earlier', () => {
    expect(isBefore('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')).toBe(true)
    expect(isBefore('2026-01-01T00:00:01.000Z', '2026-01-01T00:00:00.000Z')).toBe(false)
  })

  it('is false for equal instants', () => {
    expect(isBefore('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(false)
  })

  it('distinguishes a single millisecond', () => {
    expect(isBefore('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.001Z')).toBe(true)
    expect(isBefore('2026-01-01T00:00:00.001Z', '2026-01-01T00:00:00.000Z')).toBe(false)
  })

  it('compares instants rather than strings', () => {
    expect(isBefore('2026-01-01T01:00:00+02:00', '2026-01-01T00:30:00Z')).toBe(true)
    expect(isBefore('2026-01-01T00:30:00Z', '2026-01-01T01:00:00+02:00')).toBe(false)
  })
})
