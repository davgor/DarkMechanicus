import { describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import { EMPTY_SELECTION, findFolder, isSelection, resolveSelection } from './selection'

const alpha = folderView({ path: '/a', name: 'a' })
const beta = folderView({ path: '/b', name: 'b' })

describe('isSelection', () => {
  it('accepts null or string members', () => {
    expect(isSelection({ folderPath: null, epicId: null })).toBe(true)
    expect(isSelection({ folderPath: '/a', epicId: 'ep_1' })).toBe(true)
  })

  it('rejects malformed values', () => {
    expect(isSelection(null)).toBe(false)
    expect(isSelection('x')).toBe(false)
    expect(isSelection({})).toBe(false)
    expect(isSelection({ folderPath: 1, epicId: null })).toBe(false)
    expect(isSelection({ folderPath: null, epicId: 2 })).toBe(false)
  })
})

describe('findFolder', () => {
  it('finds a tracked folder by path', () => {
    expect(findFolder([alpha, beta], '/b')).toBe(beta)
  })

  it('returns null for unknown or missing paths', () => {
    expect(findFolder([alpha], '/zzz')).toBeNull()
    expect(findFolder([alpha], null)).toBeNull()
  })
})

describe('resolveSelection', () => {
  it('leaves the stored selection alone until folders have loaded', () => {
    const stored = { folderPath: '/gone', epicId: 'ep_1' }
    expect(resolveSelection(stored, [], false)).toBe(stored)
  })

  it('keeps a stored selection whose folder is still tracked', () => {
    const stored = { folderPath: '/a', epicId: 'ep_1' }
    expect(resolveSelection(stored, [alpha, beta], true)).toEqual(stored)
  })

  it('falls back to the first folder when the stored one is gone', () => {
    const stored = { folderPath: '/gone', epicId: 'ep_1' }
    expect(resolveSelection(stored, [alpha, beta], true)).toEqual({ folderPath: '/a', epicId: null })
  })

  it('selects the first folder when nothing was stored', () => {
    expect(resolveSelection(EMPTY_SELECTION, [beta], true)).toEqual({ folderPath: '/b', epicId: null })
  })

  it('selects nothing without folders', () => {
    expect(resolveSelection({ folderPath: '/a', epicId: null }, [], true)).toEqual(EMPTY_SELECTION)
  })

  it('drops the epic when the folder cannot show epics', () => {
    const stored = { folderPath: '/a', epicId: 'ep_1' }
    const setup = folderView({ path: '/a', initialized: false })
    const missing = folderView({ path: '/a', available: false })
    expect(resolveSelection(stored, [setup], true)).toEqual({ folderPath: '/a', epicId: null })
    expect(resolveSelection(stored, [missing], true)).toEqual({ folderPath: '/a', epicId: null })
  })
})
