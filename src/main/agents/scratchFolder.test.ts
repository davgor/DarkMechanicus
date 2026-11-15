import { existsSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeScratch } from '../../test/removeScratch'
import { ensureScratchFolder, removeScratchFolder, scratchFolderPath } from './scratchFolder'

let userData = ''

function freshUserData(): string {
  userData = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-scratch-')))
  return userData
}

afterEach(() => {
  removeScratch(userData)
})

describe('a project-less chat scratch folder', () => {
  it('lives at userData/agents/scratch/<chat id>', () => {
    expect(scratchFolderPath('/data', 'chat_1')).toBe(join('/data', 'agents', 'scratch', 'chat_1'))
  })

  it('refuses anything but a chat id, so no path can escape the scratch root', () => {
    expect(() => scratchFolderPath('/data', '../elsewhere')).toThrow(/is not a chat id/)
  })

  it('is created on demand and answered by its canonical path, again and again', () => {
    const data = freshUserData()

    const folder = ensureScratchFolder(data, 'chat_1')

    expect(folder).toBe(realpathSync.native(join(data, 'agents', 'scratch', 'chat_1')))
    expect(statSync(folder).isDirectory()).toBe(true)
    expect(ensureScratchFolder(data, 'chat_1')).toBe(folder)
  })

  it('is removed with everything in it, and removing one that is gone is not an error', async () => {
    const data = freshUserData()
    const folder = ensureScratchFolder(data, 'chat_1')
    writeFileSync(join(folder, 'notes.md'), 'work')

    await removeScratchFolder(data, 'chat_1')
    await removeScratchFolder(data, 'chat_1')

    expect(existsSync(folder)).toBe(false)
  })
})
