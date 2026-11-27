import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scratchDir } from '../../test/gitScratch'
import { replaceForgeFile, type RenameRetryNote } from './forgeManifest'

const onRetry = vi.fn<RenameRetryNote>()

let scratch: ReturnType<typeof scratchDir>
let file: string
let temp: string

beforeEach(() => {
  onRetry.mockReset()
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
    replaceForgeFile(temp, file, onRetry, rename.rename)
    expect(rename.calls).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('after\n')
    expect(existsSync(temp)).toBe(false)
    expect(onRetry.mock.calls).toEqual([['EPERM', file]])
  })

  it('throws the original busy error after four refusals, 300 ms of waits, and leaves the manifest untouched', () => {
    const rename = refusing('EPERM', 'EACCES', 'EBUSY', 'EPERM', 'EPERM')
    const started = performance.now()
    expect(() => replaceForgeFile(temp, file, onRetry, rename.rename)).toThrow('EPERM: rename refused')
    expect(performance.now() - started).toBeGreaterThanOrEqual(295)
    expect(rename.calls).toBe(4)
    expect(readFileSync(file, 'utf8')).toBe('before\n')
    expect(readFileSync(temp, 'utf8')).toBe('after\n')
    expect(onRetry.mock.calls).toEqual([['EPERM', file], ['EACCES', file], ['EBUSY', file]])
  })

  it('throws any other error at once without asking again', () => {
    const rename = refusing('ENOENT')
    expect(() => replaceForgeFile(temp, file, onRetry, rename.rename)).toThrow('ENOENT: rename refused')
    expect(rename.calls).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('before\n')
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('still renames when the retry note throws, and works with no note at all', () => {
    onRetry.mockImplementation(() => { throw new Error('log closed') })
    const noted = refusing('EBUSY')
    replaceForgeFile(temp, file, onRetry, noted.rename)
    expect(noted.calls).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('after\n')
    writeFileSync(temp, 'again\n')
    const silent = refusing('EACCES')
    replaceForgeFile(temp, file, undefined, silent.rename)
    expect(silent.calls).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('again\n')
  })
})
