import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  baselineKey,
  findNewDeadExports,
  normalizeTsPruneLine,
  readIgnoreSet
} from './deadcode-check.mjs'

describe('normalizeTsPruneLine', () => {
  it('strips parenthetical notes and normalizes slashes', () => {
    expect(normalizeTsPruneLine('src\\main\\foo.ts:1 - bar (used in module)')).toBe(
      'src/main/foo.ts:1 - bar'
    )
  })

  it('returns empty for blank lines', () => {
    expect(normalizeTsPruneLine('')).toBe('')
    expect(normalizeTsPruneLine('   ')).toBe('')
  })
})

describe('baselineKey', () => {
  it('drops the line number, keeping file and export name', () => {
    expect(baselineKey('src/preload/index.ts:26 - AutoUpdateApi')).toBe(
      'src/preload/index.ts - AutoUpdateApi'
    )
  })

  it('leaves an entry already in file + name form unchanged', () => {
    expect(baselineKey('src/preload/index.ts - AutoUpdateApi')).toBe(
      'src/preload/index.ts - AutoUpdateApi'
    )
  })
})

describe('readIgnoreSet', () => {
  it('skips comments and blank lines and keys entries by file + name', () => {
    const set = readIgnoreSet(
      fileURLToPath(new URL('./deadcode-check.test-fixture-ignore', import.meta.url))
    )
    expect(set.has('src/example.ts - kept')).toBe(true)
    expect(set.has('# comment')).toBe(false)
    expect(set.size).toBe(1)
  })
})

describe('findNewDeadExports', () => {
  const ignore = new Set(['src/preload/index.ts - AutoUpdateApi'])

  it('treats a baselined export whose line moved as baselined', () => {
    expect(findNewDeadExports(['src/preload/index.ts:99 - AutoUpdateApi'], ignore)).toEqual([])
  })

  it('reports a new dead export that is not in the baseline', () => {
    expect(
      findNewDeadExports(
        ['src/preload/index.ts:27 - AutoUpdateApi', 'src/preload/index.ts:30 - NewApi'],
        ignore
      )
    ).toEqual(['src/preload/index.ts:30 - NewApi'])
  })

  it('still reports the same export name in a different file', () => {
    expect(findNewDeadExports(['src/other.ts:1 - AutoUpdateApi'], ignore)).toEqual([
      'src/other.ts:1 - AutoUpdateApi'
    ])
  })
})
