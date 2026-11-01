/** Cloning: the stored parent, a local bare repository (the test-only file allowance), tracking and cleanup on failure. */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneRig, trackedView, type CloneRig, type CloneRigOptions } from '../../test/cloneRig'
import { remoteRepos, isolateGitConfig } from '../../test/gitRemotes'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { linkDirectory } from '../../test/tempRepo'
import { createCloneParentStore } from './clone'
import { GitError, GitInputError } from './errors'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'

const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

const rig = (options: CloneRigOptions = {}): CloneRig => cloneRig(cleanups, options)

/** Real git, with every network command recorded. */
function recording(): { runner: GitRunner; network: GitRunRequest[] } {
  const real = createGitRunner()
  const network: GitRunRequest[] = []
  return {
    network,
    runner: {
      run: (request) => {
        if (request.kind === 'network') {
          network.push(request)
        }
        return real.run(request)
      }
    }
  }
}

describe('the clone parent', () => {
  it('is null until chosen; the choice is stored atomically in clone.json and read back by a new store', async () => {
    const dir = scratchDir('dm-clone-parent-')
    cleanups.push(dir.cleanup)
    const file = join(dir.path, 'userData', 'clone.json')
    const picked = join(dir.path, 'picked')
    const store = createCloneParentStore({ file, pickDirectory: async () => picked })
    expect(store.get()).toBeNull()
    expect(await store.choose()).toBe(picked)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, parent: picked })
    expect(readdirSync(join(dir.path, 'userData'))).toEqual(['clone.json'])
    expect(store.get()).toBe(picked)
    expect(createCloneParentStore({ file, pickDirectory: async () => null }).get()).toBe(picked)
  })

  it('keeps the stored folder when the dialog is dismissed', async () => {
    const dir = scratchDir('dm-clone-parent-')
    cleanups.push(dir.cleanup)
    const answers = [dir.path, null]
    const store = createCloneParentStore({ file: join(dir.path, 'clone.json'), pickDirectory: async () => answers.shift() ?? null })
    await store.choose()
    expect(await store.choose()).toBeNull()
    expect(store.get()).toBe(dir.path)
  })

  it('reads a missing, corrupt, other-version or relative file as no parent', () => {
    const dir = scratchDir('dm-clone-parent-')
    cleanups.push(dir.cleanup)
    const file = join(dir.path, 'clone.json')
    const store = createCloneParentStore({ file, pickDirectory: async () => null })
    for (const text of ['{', JSON.stringify({ version: 2, parent: dir.path }), JSON.stringify({ version: 1, parent: 'relative/folder' }), JSON.stringify({ version: 1 })]) {
      writeFileSync(file, text)
      expect(store.get(), text).toBeNull()
    }
  })
})

describe('clone from a local bare repository', () => {
  it('clones into <chosen folder>/<name> with progress events, then tracks the new folder and returns it', async () => {
    const { local, bare } = remoteRepos(cleanups)
    const r = rig()
    await r.cloner.chooseParent()
    const target = join(r.parent, 'copy')
    expect(await r.cloner.clone({ operationId: 'op', url: pathToFileURL(bare).href, name: 'copy' })).toEqual(trackedView(target))
    expect(r.tracked).toEqual([target])
    expect(gitIn(target, 'rev-parse', 'HEAD').trim()).toBe(local.rev('HEAD'))
    expect(r.events.length).toBeGreaterThan(0)
    expect(r.events.every((event) => event.folder === r.parent && event.operationId === 'op' && event.operation === 'clone')).toBe(true)
    expect(r.events).toContainEqual({ folder: r.parent, operationId: 'op', operation: 'clone', phase: 'Receiving objects', percent: 100 })
  })

  it('clones into an empty folder that was already there', async () => {
    const { bare } = remoteRepos(cleanups)
    const r = rig()
    await r.cloner.chooseParent()
    mkdirSync(join(r.parent, 'empty'))
    await r.cloner.clone({ operationId: 'op', url: pathToFileURL(bare).href, name: 'empty' })
    expect(r.tracked).toEqual([join(r.parent, 'empty')])
    expect(existsSync(join(r.parent, 'empty', '.git'))).toBe(true)
  })
})

describe('clone: refused before git runs', () => {
  it('until a parent is chosen through the dialog', async () => {
    const { runner, network } = recording()
    const r = rig({ runner })
    await expect(r.cloner.clone({ operationId: 'op', url: 'octocat/Hello-World', name: 'Hello-World' })).rejects.toThrow(GitInputError)
    expect(network).toEqual([])
    expect(readdirSync(r.parent)).toEqual([])
  })

  it('for a target that is not an empty folder: a folder with files, a file, a link to an empty folder', async () => {
    const { runner, network } = recording()
    const r = rig({ runner })
    await r.cloner.chooseParent()
    mkdirSync(join(r.parent, 'full'))
    writeFileSync(join(r.parent, 'full', 'keep.txt'), 'mine')
    writeFileSync(join(r.parent, 'file'), 'mine')
    mkdirSync(join(r.scratch, 'elsewhere'))
    linkDirectory(join(r.scratch, 'elsewhere'), join(r.parent, 'link'))
    for (const name of ['full', 'file', 'link']) {
      const error = await r.cloner.clone({ operationId: name, url: 'octocat/Hello-World', name }).catch((caught: unknown) => caught)
      expect(error, name).toBeInstanceOf(GitError)
      expect(error, name).toMatchObject({ code: 'target_exists', message: expect.stringContaining(join(r.parent, name)) })
    }
    expect(readFileSync(join(r.parent, 'full', 'keep.txt'), 'utf8')).toBe('mine')
    expect(readFileSync(join(r.parent, 'file'), 'utf8')).toBe('mine')
    expect(network).toEqual([])
    expect(r.tracked).toEqual([])
  })

  it('for an invalid name, a refused transport, or a file URL without the test allowance', async () => {
    const { runner, network } = recording()
    const r = rig({ runner, allowFile: false })
    await r.cloner.chooseParent()
    for (const request of [
      { url: 'octocat/Hello-World', name: '../escape' },
      { url: 'ext::sh -c touch% pwned', name: 'x' },
      { url: pathToFileURL(r.scratch).href, name: 'x' }
    ]) {
      await expect(r.cloner.clone({ operationId: 'op', ...request }), request.url).rejects.toThrow(GitInputError)
    }
    expect(network).toEqual([])
    expect(readdirSync(r.parent)).toEqual([])
  })
})

describe('a failed clone', () => {
  it('removes the folder it created, and leaves a folder that was there before', async () => {
    const r = rig()
    await r.cloner.chooseParent()
    const missing = pathToFileURL(join(r.scratch, 'missing.git')).href
    await expect(r.cloner.clone({ operationId: 'a', url: missing, name: 'made' })).rejects.toMatchObject({ code: 'remote_not_found' })
    expect(existsSync(join(r.parent, 'made'))).toBe(false)
    mkdirSync(join(r.parent, 'kept'))
    await expect(r.cloner.clone({ operationId: 'b', url: missing, name: 'kept' })).rejects.toBeInstanceOf(GitError)
    expect(readdirSync(join(r.parent, 'kept'))).toEqual([])
    expect(r.tracked).toEqual([])
  })

  it('removes the folder it created when tracking it fails', async () => {
    const { bare } = remoteRepos(cleanups)
    const r = rig({
      track: () => {
        throw new Error('disk full')
      }
    })
    await r.cloner.chooseParent()
    await expect(r.cloner.clone({ operationId: 'op', url: pathToFileURL(bare).href, name: 'copy' })).rejects.toThrow('disk full')
    expect(existsSync(join(r.parent, 'copy'))).toBe(false)
  })

  it('refuses a chosen folder that no longer exists', async () => {
    const r = rig()
    await r.cloner.chooseParent()
    rmSync(r.parent, { recursive: true })
    await expect(r.cloner.clone({ operationId: 'op', url: 'octocat/Hello-World', name: 'x' })).rejects.toThrow(GitInputError)
  })
})

describe('a parent the clone cannot write to', () => {
  it.skipIf(process.platform === 'win32')('is refused as input with the reason, not reported as a git failure', async () => {
    const r = rig()
    await r.cloner.chooseParent()
    chmodSync(r.parent, 0o555)
    cleanups.push(() => chmodSync(r.parent, 0o755))
    const error = await r.cloner.clone({ operationId: 'op', url: 'octocat/Hello-World', name: 'x' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitInputError)
    expect((error as Error).message).toContain(r.parent)
  })
})
