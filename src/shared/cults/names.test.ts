import { describe, expect, it } from 'vitest'
import { cultistName } from './names'

describe('cultistName', () => {
  it('gives themed names by role', () => {
    expect(cultistName([], 'magos', 'seed')).toMatch(/^Magos [A-Z][a-z]+$/)
    expect(cultistName([], 'acolyte', 'seed')).toMatch(/^Acolyte [A-Z][a-z]+-\d+$/)
  })

  it('is deterministic from its seed and taken names', () => {
    expect(cultistName(['Magos Cawl'], 'magos', 'run-1')).toBe(cultistName(['Magos Cawl'], 'magos', 'run-1'))
    expect(cultistName([], 'acolyte', 'a')).toBe(cultistName([], 'acolyte', 'a'))
  })

  it('never repeats a taken name, case-insensitively', () => {
    const first = cultistName([], 'acolyte', 'x')
    const second = cultistName([first.toUpperCase()], 'acolyte', 'x')
    expect(second.toLowerCase()).not.toBe(first.toLowerCase())
  })

  it('stays unique within a run across many members of each role', () => {
    for (const role of ['magos', 'acolyte'] as const) {
      const taken: string[] = []
      for (let i = 0; i < 100; i++) taken.push(cultistName(taken, role, 'run'))
      expect(new Set(taken.map((name) => name.toLowerCase())).size).toBe(100)
    }
  })
})
