import { describe, expect, it } from 'vitest'
import { isProfileName, PROFILE_NAME_RULE } from './profileNames'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
const DEVICE_NAMES = ['con', 'prn', 'aux', 'nul', ...DIGITS.map((digit) => `com${digit}`), ...DIGITS.map((digit) => `lpt${digit}`)]

describe('isProfileName accepts safe slugs', () => {
  it('accepts lowercase letters, digits, and inner hyphens', () => {
    const names = ['a', '0', 'x1', 'ui-implementation', 'deep-review', 'a--b', '2024-review']
    expect(names.filter((name) => !isProfileName(name))).toEqual([])
  })

  it('accepts exactly 64 characters and rejects 65', () => {
    const longest = `a${'b'.repeat(62)}c`
    expect(longest).toHaveLength(64)
    expect(isProfileName(longest)).toBe(true)
    expect(isProfileName(`${longest}d`)).toBe(false)
    expect(isProfileName(`${'1'.repeat(64)}`)).toBe(true)
    expect(isProfileName(`${'1'.repeat(65)}`)).toBe(false)
  })

  it('accepts names that only start or end like a device name', () => {
    const names = ['con-1', 'console', 'com10', 'lpt-2', 'nul0', 'auxiliary', 'my-con', 'prn2x']
    expect(names.filter((name) => !isProfileName(name))).toEqual([])
  })
})

describe('isProfileName rejects unsafe names', () => {
  it('rejects empty, edge hyphens, uppercase, and other characters', () => {
    const names = ['', '-', '-a', 'a-', 'A', 'Deep-review', 'a_b', 'a.b', 'a b', ' a', 'a ', 'é', 'a.json', 'a\u0000b']
    expect(names.filter((name) => isProfileName(name))).toEqual([])
  })

  it('rejects traversal and path separators', () => {
    const names = ['..', '../x', 'x/..', 'x/y', 'x\\y', '/abs', 'C:x', '.hidden', '~home']
    expect(names.filter((name) => isProfileName(name))).toEqual([])
  })

  it.each(DEVICE_NAMES)('rejects the Windows device name %s', (name) => {
    expect(isProfileName(name)).toBe(false)
  })

  it('covers every Windows device name', () => {
    expect(DEVICE_NAMES).toHaveLength(24)
  })
})

describe('PROFILE_NAME_RULE', () => {
  it('states the rule in words', () => {
    expect(PROFILE_NAME_RULE).toBe(
      'Use 1-64 lowercase letters, digits, or hyphens, starting and ending with a letter or digit; device names such as con or nul are not allowed.'
    )
  })
})
