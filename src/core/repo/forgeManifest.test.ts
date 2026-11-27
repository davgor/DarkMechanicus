import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scratchDir } from '../../test/gitScratch'
import { RENAME_PAUSES_MS, replaceForgeFile, type RenameRetryNote } from './forgeManifest'

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
    replaceForgeFile(temp, file, onRetry, { rename: rename.rename })
    expect(rename.calls).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('after\n')
    expect(existsSync(temp)).toBe(false)
    expect(onRetry.mock.calls).toEqual([['EPERM', file]])
  })
})

describe('replaceForgeFile pausing between busy refusals', () => {
  it('waits out a busy rename on the doubling schedule and replaces the manifest on the attempt that succeeds', () => {
    const pauses: number[] = []
    const rename = refusing('EPERM', 'EACCES', 'EBUSY', 'EPERM')
    replaceForgeFile(temp, file, onRetry, { rename: rename.rename, pause: ms => { pauses.push(ms) } })
    expect(rename.calls).toBe(5)
    expect(pauses).toEqual([50, 100, 200, 400])
    expect(readFileSync(file, 'utf8')).toBe('after\n')
    expect(onRetry.mock.calls.map(([code]) => code)).toEqual(['EPERM', 'EACCES', 'EBUSY', 'EPERM'])
  })

  it('throws that the manifest stayed locked after 2,550 ms of waits, keeping the busy code, and leaves it untouched', () => {
    const pauses: number[] = []
    const rename = refusing(...Array.from({ length: RENAME_PAUSES_MS.length + 1 }, () => 'EPERM'))
    let thrown: unknown
    try { replaceForgeFile(temp, file, onRetry, { rename: rename.rename, pause: ms => { pauses.push(ms) } }) } catch (error) { thrown = error }
    expect(pauses).toEqual([50, 100, 200, 400, 800, 1_000])
    expect(rename.calls).toBe(7)
    expect(thrown).toMatchObject({ code: 'EPERM', message: `${file} stayed locked for 2550 ms (EPERM: rename refused)` })
    expect((thrown as Error).cause).toMatchObject({ code: 'EPERM' })
    expect(onRetry).toHaveBeenCalledTimes(6)
    expect(readFileSync(file, 'utf8')).toBe('before\n')
    expect(readFileSync(temp, 'utf8')).toBe('after\n')
  })
})

describe('replaceForgeFile with other errors and notes', () => {
  it('throws any other error at once without asking again', () => {
    const rename = refusing('ENOENT')
    expect(() => replaceForgeFile(temp, file, onRetry, { rename: rename.rename })).toThrow('ENOENT: rename refused')
    expect(rename.calls).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('before\n')
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('still renames when the retry note throws, and works with no note at all', () => {
    onRetry.mockImplementation(() => { throw new Error('log closed') })
    const noted = refusing('EBUSY')
    replaceForgeFile(temp, file, onRetry, { rename: noted.rename })
    expect(noted.calls).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('after\n')
    writeFileSync(temp, 'again\n')
    const silent = refusing('EACCES')
    replaceForgeFile(temp, file, undefined, { rename: silent.rename })
    expect(silent.calls).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe('again\n')
  })
})
