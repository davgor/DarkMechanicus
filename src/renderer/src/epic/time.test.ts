import { describe, expect, it } from 'vitest'
import { NOW, iso } from './__mocks__/fixtures'
import { formatAgo, formatCountdown, formatElapsed } from './time'

describe('formatElapsed', () => {
  it('uses seconds, minutes, hours and days with exact boundaries', () => {
    expect(
      [
        -5,
        0,
        999,
        1_000,
        59_999,
        60_000,
        3_599_999,
        3_600_000,
        (2 * 60 + 14) * 60_000,
        86_399_999,
        86_400_000,
        3 * 86_400_000
      ].map(formatElapsed)
    ).toEqual([
      'just now',
      'just now',
      'just now',
      '1s ago',
      '59s ago',
      '1m ago',
      '59m ago',
      '1h ago',
      '2h 14m ago',
      '23h 59m ago',
      '1d ago',
      '3d ago'
    ])
  })
})

describe('formatAgo', () => {
  it('measures from an ISO timestamp to now', () => {
    expect(formatAgo(iso(-12 * 60_000), NOW)).toBe('12m ago')
    expect(formatAgo(null, NOW)).toBe('')
    expect(formatAgo('not a date', NOW)).toBe('')
  })
})

describe('formatCountdown', () => {
  it('shows the remaining lease as mm:ss, rounding partial seconds up', () => {
    expect(formatCountdown(iso(4 * 60_000 + 12_000), NOW)).toBe('04:12')
    expect(formatCountdown(iso(500), NOW)).toBe('00:01')
    expect(formatCountdown(iso(61_000), NOW)).toBe('01:01')
    expect(formatCountdown(iso(0), NOW)).toBe('00:00')
    expect(formatCountdown(iso(-30_000), NOW)).toBe('00:00')
    expect(formatCountdown(iso(125 * 60_000), NOW)).toBe('125:00')
    expect(formatCountdown(null, NOW)).toBe('')
  })
})
