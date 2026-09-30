import { describe, expect, it } from 'vitest'
import { classNames } from './classNames'

describe('classNames', () => {
  it('joins parts with single spaces', () => {
    expect(classNames('btn', 'btn-primary')).toBe('btn btn-primary')
  })

  it('drops false, null, undefined and empty parts', () => {
    expect(classNames('a', false, null, undefined, '', 'b')).toBe('a b')
  })

  it('returns an empty string when nothing remains', () => {
    expect(classNames(false, undefined)).toBe('')
    expect(classNames()).toBe('')
  })
})
