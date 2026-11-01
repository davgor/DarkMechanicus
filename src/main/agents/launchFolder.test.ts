import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFolderRegistry, type FolderRegistry } from '../desktop/folderRegistry'
import { resolveLaunchFolder, type LaunchFolderDeps } from './launchFolder'

const AGAIN = 'Track the folder again to keep using this chat.'

let root: string
let repo: string
let registry: FolderRegistry
let deps: LaunchFolderDeps

beforeEach(() => {
  // Canonical from the start: on macOS the temporary directory is reached through the /var symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dm-launch-')))
  repo = join(root, 'repo')
  mkdirSync(repo)
  registry = createFolderRegistry({ file: join(root, 'state', 'folders.json'), homeDir: '', dmHome: join(root, 'dm-home') })
  registry.track(repo)
  deps = { trackedFolder: (path) => registry.resolve(path) }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function refusal(folder: string, using: LaunchFolderDeps = deps): unknown {
  try {
    resolveLaunchFolder({ folder }, using)
  } catch (error) {
    return error
  }
  throw new Error('The folder was not refused.')
}

describe('resolveLaunchFolder: a folder the chat can start in', () => {
  it('returns the canonical path of a tracked folder that is still there', () => {
    expect(resolveLaunchFolder({ folder: repo }, deps)).toBe(repo)
  })
})

describe('resolveLaunchFolder: folders that are refused', () => {
  it('refuses a folder that was deleted, naming it', () => {
    rmSync(repo, { recursive: true })

    const error = refusal(repo)

    expect(error).toMatchObject({ name: 'DomainError', code: 'not_found' })
    expect((error as Error).message).toContain(repo)
    expect((error as Error).message).toContain('moved or deleted')
    expect((error as Error).message).toContain(AGAIN)
  })

  it('refuses a path that is now a file, not a folder', () => {
    rmSync(repo, { recursive: true })
    writeFileSync(repo, 'not a folder')

    const error = refusal(repo)

    expect(error).toMatchObject({ code: 'not_found', message: expect.stringContaining('no longer a folder') })
    expect((error as Error).message).toContain(repo)
    expect((error as Error).message).toContain(AGAIN)
  })

  it('refuses a folder replaced by a symlink to another directory, even though the path still resolves', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    rmSync(repo, { recursive: true })
    symlinkSync(elsewhere, repo)

    const error = refusal(repo)

    expect(error).toMatchObject({ code: 'not_found' })
    expect((error as Error).message).toContain(repo)
    expect((error as Error).message).toContain(elsewhere)
    expect((error as Error).message).toContain(AGAIN)
  })

  it('refuses a folder that is no longer tracked', () => {
    registry.untrack(repo)

    const error = refusal(repo)

    expect(error).toMatchObject({ code: 'not_found', message: expect.stringContaining('no longer tracked') })
    expect((error as Error).message).toContain(repo)
    expect((error as Error).message).toContain(AGAIN)
  })

  it('refuses a folder whose tracked entry is another path', () => {
    const error = refusal(repo, { trackedFolder: () => join(root, 'other') })

    expect(error).toMatchObject({ code: 'not_found', message: expect.stringContaining('no longer tracked') })
  })

  it('refuses a chat stored under a path that is not canonical', () => {
    const link = join(root, 'link')
    symlinkSync(repo, link)

    expect(refusal(link)).toMatchObject({ code: 'not_found', message: expect.stringContaining(repo) })
  })
})
