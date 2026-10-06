import { describe, expect, it } from 'vitest'
import { folderTabOf, isFolderTabs } from './folderTabs'

describe('folder tabs', () => {
  it('defaults to Source control', () => {
    expect(folderTabOf({}, '/a')).toBe('source')
    expect(folderTabOf({}, null)).toBe('source')
  })

  it('remembers a folder tab per folder', () => {
    expect(folderTabOf({ '/a': 'epics' }, '/a')).toBe('epics')
    expect(folderTabOf({ '/a': 'epics' }, '/b')).toBe('source')
  })

  it('falls back to Source control for an unknown stored value', () => {
    expect(folderTabOf({ '/a': 'history' }, '/a')).toBe('source')
    expect(folderTabOf({ '/a': 7 }, '/a')).toBe('source')
    expect(folderTabOf({}, 'constructor')).toBe('source')
  })

  it('accepts only objects as stored maps', () => {
    expect(isFolderTabs({ '/a': 'epics' })).toBe(true)
    expect(isFolderTabs(null)).toBe(false)
    expect(isFolderTabs('epics')).toBe(false)
    expect(isFolderTabs(['epics'])).toBe(false)
  })
})
