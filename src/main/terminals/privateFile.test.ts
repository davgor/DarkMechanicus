import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { writePrivateFile } from './privateFile'

/** A rename that fails with `code` on its first `times` calls, as Windows does while another rename replaces the path. */
function failingRename(code: string, times: number): { calls: string[]; renameFile: (from: string, to: string) => Promise<void> } {
  const calls: string[] = []
  return {
    calls,
    renameFile: async (from, to) => {
      calls.push(to)
      if (calls.length <= times) {
        throw Object.assign(new Error(`${code}: rename '${from}' -> '${to}'`), { code, syscall: 'rename' })
      }
      await rename(from, to)
    }
  }
}

describe('writePrivateFile: a rename the system refuses for a moment', () => {
  let folder: string

  beforeEach(() => {
    folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-private-file-')))
  })

  afterEach(() => {
    removeScratch(folder)
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('tries the rename again while it fails with %s, then replaces the file', async (code) => {
    const path = join(folder, 'ch_1.md')
    const { calls, renameFile } = failingRename(code, 3)

    await writePrivateFile(path, 'instructions', 0o600, renameFile)

    expect(calls).toEqual([path, path, path, path])
    expect(readFileSync(path, 'utf8')).toBe('instructions')
    expect(readdirSync(folder)).toEqual(['ch_1.md'])
  })

  it('throws any other failure at once, leaving no staged file behind', async () => {
    const { calls, renameFile } = failingRename('ENOENT', 1)

    await expect(writePrivateFile(join(folder, 'ch_1.md'), 'instructions', 0o600, renameFile)).rejects.toMatchObject({ code: 'ENOENT' })

    expect(calls).toHaveLength(1)
    expect(readdirSync(folder)).toEqual([])
  })

  it('gives up after ten tries on a rename that stays refused, leaving no staged file behind', async () => {
    const { calls, renameFile } = failingRename('EPERM', Number.POSITIVE_INFINITY)

    await expect(writePrivateFile(join(folder, 'ch_1.md'), 'instructions', 0o600, renameFile)).rejects.toMatchObject({ code: 'EPERM' })

    expect(calls).toHaveLength(10)
    expect(readdirSync(folder)).toEqual([])
  })
})
