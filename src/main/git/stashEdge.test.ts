/** DM stash edge cases on real temporary repositories: nothing to stash, an unknown stash, detached HEAD, a merge. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { switchBranch } from './branches'
import { GitError } from './errors'
import { createGitRunner } from './runner'
import { listStashes, popStash, restoreStash, stashChanges } from './stash'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function repo(): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  return r
}

/** A repository on `main` holding one DM stash of a change to `file-1.txt`. */
async function stashed(): Promise<GitRepo> {
  const r = repo()
  r.git('branch', 'other')
  put(r.root, 'file-1.txt', 'mine\n')
  await switchBranch(runner, r.root, { name: 'other', uncommitted: 'stash' })
  await switchBranch(runner, r.root, { name: 'main', uncommitted: 'bring' })
  return r
}

describe('stashChanges', () => {
  it('returns null when there is nothing to stash, with or without an older stash on top', async () => {
    const r = repo()
    expect(await stashChanges(runner, r.root, 'main')).toBeNull()
    expect(r.git('stash', 'list')).toBe('')
    put(r.root, 'file-1.txt', 'older\n')
    r.git('stash', 'push', '-q', '-m', 'my own stash')
    expect(await stashChanges(runner, r.root, 'main')).toBeNull()
    expect(r.git('stash', 'list', '--format=%gs')).toBe('On main: my own stash')
  })
})

describe('popStash', () => {
  it('pops nothing when no stash has that commit id', async () => {
    const r = repo()
    put(r.root, 'file-1.txt', 'kept aside\n')
    r.git('stash', 'push', '-q', '-m', 'my own stash')
    await popStash(runner, r.root, r.rev('main'))
    expect(r.git('stash', 'list', '--format=%gs')).toBe('On main: my own stash')
    expect(r.git('status', '--porcelain')).toBe('')
  })
})

describe('listStashes on a detached HEAD', () => {
  it('lists no stash, since none belongs to a branch', async () => {
    const r = await stashed()
    r.git('checkout', '-q', '--detach')
    expect(await listStashes(runner, r.root)).toEqual([])
    r.switchTo('main')
    expect(await listStashes(runner, r.root)).toHaveLength(1)
  })
})

describe('restoreStash during a merge', () => {
  it('returns operation_in_progress and keeps the stash', async () => {
    const r = await stashed()
    r.branch('topic')
    put(r.root, 'file-2.txt', 'topic\n')
    r.git('add', 'file-2.txt')
    r.git('commit', '-q', '-m', 'topic')
    r.switchTo('main')
    put(r.root, 'file-2.txt', 'main\n')
    r.git('add', 'file-2.txt')
    r.git('commit', '-q', '-m', 'main')
    expect(() => r.git('merge', '-q', '--no-edit', 'topic')).toThrow()
    const failure = restoreStash(runner, r.root, 'stash@{0}')
    await expect(failure).rejects.toBeInstanceOf(GitError)
    await expect(failure).rejects.toMatchObject({ code: 'operation_in_progress', message: expect.stringContaining('merge') })
    expect(r.git('stash', 'list', '--format=%gs')).toBe('On main: dm-stash:main')
  })
})
