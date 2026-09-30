import { describe, expect, it } from 'vitest'
import { plural } from './plural'

describe('plural', () => {
  it('uses the singular for exactly one', () => {
    expect(plural(1, 'file')).toBe('1 file')
  })

  it('uses the plural for zero and many', () => {
    expect(plural(0, 'file')).toBe('0 files')
    expect(plural(2, 'file')).toBe('2 files')
    expect(plural(11, 'epic')).toBe('11 epics')
  })
})
