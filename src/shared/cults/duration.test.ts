import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration, parseTimeLimit } from './duration'

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

describe('parseDuration', () => {
  it.each([
    ['90s', 90 * S],
    ['1m', M],
    ['45 min', 45 * M],
    ['90h', 90 * H],
    ['90hr', 90 * H],
    ['2d', 2 * D],
    ['1d 6h', D + 6 * H],
    ['1D6H', D + 6 * H],
    [' 2h 30m ', 2 * H + 30 * M]
  ])('parses %j', (text, ms) => {
    expect(parseDuration(text)).toEqual({ ok: true, ms })
  })

  it.each(['0m', '0s 0h', '-1h', '5x', '', '1.5h', 'h', '10', '1m garbage'])('refuses %j', (text) => {
    expect(parseDuration(text).ok).toBe(false)
  })

  it('names the unknown unit', () => {
    expect(parseDuration('5x')).toEqual({ ok: false, error: 'Unknown unit "x"; use s, m, h or d.' })
  })

  it('refuses a duration past the largest exact millisecond count', () => {
    expect(parseDuration('999999999999d')).toEqual({ ok: false, error: 'That duration is too long.' })
    expect(parseDuration('104249991d').ok).toBe(true)
  })
})

describe('parseTimeLimit', () => {
  it('accepts unlimited as null and a minute or more with no upper bound', () => {
    expect(parseTimeLimit('unlimited')).toEqual({ ok: true, ms: null })
    expect(parseTimeLimit('1m')).toEqual({ ok: true, ms: M })
    expect(parseTimeLimit('9999d')).toEqual({ ok: true, ms: 9999 * D })
  })

  it.each(['30s', '59s', '0m', '-1h', '5x'])('refuses %j as a time limit', (text) => {
    expect(parseTimeLimit(text).ok).toBe(false)
  })
})

describe('formatDuration', () => {
  it.each([
    [M, '1m'],
    [90 * H, '3d 18h'],
    [D + 6 * H, '1d 6h'],
    [90 * S, '1m 30s'],
    [0, '0s']
  ])('formats %d as %j', (ms, text) => {
    expect(formatDuration(ms)).toBe(text)
  })

  it.each([M, 90 * S, 90 * H, 2 * D, D + 6 * H + 5 * M + 7 * S])('round-trips %d through parseDuration', (ms) => {
    expect(parseDuration(formatDuration(ms))).toEqual({ ok: true, ms })
  })
})
