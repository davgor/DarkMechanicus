import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFolderRegistry } from '../desktop/folderRegistry'
import { folderStoreId } from './folderStoreId'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('folderStoreId', () => {
  it('is the first 32 hex characters of the sha256 of the canonical path', () => {
    const path = '/work/Repo'
    expect(folderStoreId(path, 'linux')).toBe(createHash('sha256').update(path).digest('hex').slice(0, 32))
    expect(folderStoreId(path, 'linux')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('ignores case on win32 only', () => {
    expect(folderStoreId('C:\\Users\\Dev\\Repo', 'win32')).toBe(folderStoreId('c:\\users\\dev\\repo', 'win32'))
    expect(folderStoreId('/work/Repo', 'linux')).not.toBe(folderStoreId('/work/repo', 'linux'))
    expect(folderStoreId('/work/Repo', 'darwin')).not.toBe(folderStoreId('/work/repo', 'darwin'))
  })

  it('stays the same across two registry instances, while the per-run attachment key does not', () => {
    // Native realpath, like the registry, so Windows 8.3 temp names are already expanded.
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-store-id-')))
    roots.push(root)
    const folder = join(root, 'Repo')
    mkdirSync(folder)
    const options = { file: join(root, 'state', 'folders.json'), homeDir: join(root, 'home'), dmHome: join(root, 'home', '.darkmechanicus') }

    const first = createFolderRegistry(options).track(folder).folder
    const second = createFolderRegistry(options).list().find(entry => entry.path === first.path)

    expect(second).toBeDefined()
    expect(second!.attachmentKey).not.toBe(first.attachmentKey)
    expect(folderStoreId(second!.path)).toBe(folderStoreId(first.path))
  })
})
