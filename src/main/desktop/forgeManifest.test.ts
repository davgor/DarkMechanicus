import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scratchDir } from '../../test/gitScratch'
import { logger } from '../logger'
import { replaceForgeFile } from './forgeManifest'

vi.mock('../logger', () => ({ logger: { info: vi.fn() } }))

let scratch: ReturnType<typeof scratchDir>
let file: string
let temp: string

beforeEach(() => {
  vi.mocked(logger.info).mockClear()
  scratch = scratchDir('forge-manifest-')
  file = join(scratch.path, 'forge-world.json')
  temp = file + '.next'
  writeFileSync(file, 'before\n')
  writeFileSync(temp, 'after\n')
})

afterEach(() => {
  scratch.cleanup()
})

const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename refused`), { code })

/** A rename that refuses with `codes` in turn, then renames for real. */
function refusing(...codes: string[]): { rename: (from: string, to: string) => void; calls: number } {
  const state = {
    calls: 0,
    rename: (from: string, to: string): void => {
      const code = codes[state.calls++]
      if (code !== undefined) throw failure(code)
      renameSync(from, to)
    }
  }
  return state
}

describe('replaceForgeFile', () => {
  it('replaces the manifest after Windows refuses the rename once as busy', () => {
    const rename = refusing('EPERM')
    replaceForgeFile(temp, file, rename.rename)
    expect(rename.calls).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('after\n')
    expect(existsSync(temp)).toBe(false)
    expect(vi.mocked(logger.info).mock.calls).toEqual([['Forge World manifest rename refused (EPERM); trying again.']])
  })

  it('throws the original busy error after four refusals and leaves the manifest untouched', () => {
    const rename = refusing('EPERM', 'EACCES', 'EBUSY', 'EPERM', 'EPERM')
    expect(() => replaceForgeFile(temp, file, rename.rename)).toThrow('EPERM: rename refused')
    expect(rename.calls).toBe(4)
    expect(readFileSync(file, 'utf8')).toBe('before\n')
    expect(readFileSync(temp, 'utf8')).toBe('after\n')
    expect(vi.mocked(logger.info).mock.calls.map(([message]) => message)).toEqual(['EPERM', 'EACCES', 'EBUSY'].map(code => `Forge World manifest rename refused (${code}); trying again.`))
  })

  it('throws any other error at once without asking again', () => {
    const rename = refusing('ENOENT')
    expect(() => replaceForgeFile(temp, file, rename.rename)).toThrow('ENOENT: rename refused')
    expect(rename.calls).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('before\n')
    expect(vi.mocked(logger.info).mock.calls).toEqual([])
  })
})
