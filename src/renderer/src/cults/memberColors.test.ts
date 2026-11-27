import { describe, expect, it } from 'vitest'
import { MEMBER_HUES, memberColor, memberHue } from './memberColors'

/** The shorter way round the colour wheel between two hues. */
const apart = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

describe('memberColors', () => {
  it('gives 24 acolytes 24 distinct hues, at least 15° apart and clear of the Magos’s red', () => {
    const hues = Array.from({ length: 24 }, (_, index) => memberHue(index))
    expect(new Set(hues).size).toBe(24)
    for (const [i, a] of hues.entries()) {
      for (const b of hues.slice(i + 1)) expect(apart(a, b)).toBeGreaterThanOrEqual(15)
      expect(apart(a, 0)).toBeGreaterThanOrEqual(7)
    }
    expect(new Set(Array.from({ length: 24 }, (_, index) => memberColor(index))).size).toBe(24)
  })

  it('is stable: the same index always answers the same hue and colour', () => {
    expect(Array.from({ length: 24 }, (_, index) => memberHue(index))).toEqual(MEMBER_HUES)
    expect(memberHue(3)).toBe(memberHue(3))
    expect(memberColor(0)).toBe('hsl(188 70% 58%)')
    expect(memberColor(1)).toBe('hsl(68 70% 58%)')
  })

  it('spreads the first acolytes of a run far apart', () => {
    const first = Array.from({ length: 4 }, (_, index) => memberHue(index))
    for (const [i, a] of first.entries()) for (const b of first.slice(i + 1)) expect(apart(a, b)).toBeGreaterThanOrEqual(60)
  })

  it('wraps past 24', () => {
    expect(memberHue(24)).toBe(memberHue(0))
    expect(memberHue(-1)).toBe(memberHue(23))
  })
})
