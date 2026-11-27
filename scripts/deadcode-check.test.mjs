import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  baselineKey,
  deadInEveryProject,
  findNewDeadExports,
  normalizeTsPruneLine,
  projectFiles,
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

describe('deadInEveryProject', () => {
  const node = { files: new Set(['src/shared/contract.ts', 'src/main/only.ts']) }
  const web = { files: new Set(['src/shared/contract.ts', 'src/renderer/only.ts']) }

  it('keeps an export flagged by only one of two projects that include its file: the other uses it', () => {
    expect(deadInEveryProject([
      { ...node, lines: [] },
      { ...web, lines: ['src/shared/contract.ts:4 - usedByMain'] }
    ])).toEqual([])
  })

  it('reports an export flagged by every project that includes its file, once', () => {
    expect(deadInEveryProject([
      { ...node, lines: ['src/shared/contract.ts:7 - unused'] },
      { ...web, lines: ['src/shared/contract.ts:7 - unused'] }
    ])).toEqual(['src/shared/contract.ts:7 - unused'])
  })

  it('reports a file only one project includes exactly as that project flags it', () => {
    expect(deadInEveryProject([
      { ...node, lines: ['src/main/only.ts:2 - helper', 'src/main/only.ts:9 - Shape'] },
      { ...web, lines: ['src/renderer/only.ts:3 - Props'] }
    ])).toEqual(['src/main/only.ts:2 - helper', 'src/main/only.ts:9 - Shape', 'src/renderer/only.ts:3 - Props'])
  })
})

describe('projectFiles', () => {
  it('lists the files a tsconfig includes, relative and with forward slashes', () => {
    const web = projectFiles('tsconfig.web.json')
    expect(web.has('src/shared/cults/cult.ts')).toBe(true)
    expect(web.has('src/main/cults/cultSupervisor.ts')).toBe(false)
    expect(projectFiles('tsconfig.node.json').has('src/main/cults/cultSupervisor.ts')).toBe(true)
  })
})
