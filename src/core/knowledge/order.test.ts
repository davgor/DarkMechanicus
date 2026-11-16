import { describe, expect, it } from 'vitest'
import { compareCodeUnits } from './order'

describe('compareCodeUnits', () => {
  it('sorts by code unit, so upper case comes before lower case whatever the locale', () => {
    expect(['b.md', 'a.md', 'B.md', 'a.md', 'ä.md'].sort(compareCodeUnits)).toEqual(['B.md', 'a.md', 'a.md', 'b.md', 'ä.md'])
  })

  it('treats equal strings as equal', () => {
    expect(compareCodeUnits('same', 'same')).toBe(0)
  })
})
