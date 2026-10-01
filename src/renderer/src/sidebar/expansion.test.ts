import { describe, expect, it } from 'vitest'
import {
  BUCKET_DEFAULTS,
  bucketKey,
  folderKey,
  isExpansionMap,
  lookupExpanded
} from './expansion'

describe('expansion keys', () => {
  it('namespaces folder and bucket keys', () => {
    expect(folderKey('/a/b')).toBe('folder:/a/b')
    expect(bucketKey('/a/b', 'backlog')).toBe('bucket:/a/b:backlog')
  })

  it('keeps buckets of different folders apart', () => {
    expect(bucketKey('/a', 'backlog')).not.toBe(bucketKey('/b', 'backlog'))
  })
})

describe('BUCKET_DEFAULTS', () => {
  it('opens active work and collapses completed work', () => {
    expect(BUCKET_DEFAULTS).toEqual({ in_progress: true, backlog: true, completed: false })
  })
})

describe('lookupExpanded', () => {
  it('uses the stored value when present', () => {
    expect(lookupExpanded({ k: false }, 'k', true)).toBe(false)
    expect(lookupExpanded({ k: true }, 'k', false)).toBe(true)
  })

  it('falls back to the default when absent', () => {
    expect(lookupExpanded({}, 'k', true)).toBe(true)
    expect(lookupExpanded({}, 'k', false)).toBe(false)
  })
})

describe('isExpansionMap', () => {
  it('accepts plain objects of booleans', () => {
    expect(isExpansionMap({})).toBe(true)
    expect(isExpansionMap({ a: true, b: false })).toBe(true)
  })

  it('rejects other shapes', () => {
    expect(isExpansionMap(null)).toBe(false)
    expect(isExpansionMap([true])).toBe(false)
    expect(isExpansionMap('x')).toBe(false)
    expect(isExpansionMap({ a: 'yes' })).toBe(false)
  })
})
