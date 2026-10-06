import { rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RepoStatus } from '../../shared/git/status'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, put, samePath, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from './runner'
import { readRepoState } from './status'

const runner = createGitRunner()
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function repo(): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  return r
}

async function statusOf(folder: string): Promise<RepoStatus> {
  const state = await readRepoState(runner, folder)
  if (state.kind !== 'repository') {
    throw new Error(`expected a repository, got ${state.kind}`)
  }
  return state.status
}

describe('readRepoState', () => {
  it('reports a plain folder as not_repository', async () => {
    const dir = scratchDir()
    cleanups.push(dir.cleanup)
    expect(await readRepoState(runner, dir.path)).toEqual({ kind: 'not_repository' })
  })

  it('reports git_missing when git cannot be started', async () => {
    const r = repo()
    expect(await readRepoState(createGitRunner({ gitPath: 'definitely-not-git-1b7c' }), r.root)).toEqual({ kind: 'git_missing' })
  })

  it('reports root, branch and a clean tree', async () => {
    const r = repo()
    const status = await statusOf(r.root)
    expect(samePath(status.root)).toBe(samePath(r.root))
    expect(status.branch).toEqual({ name: 'main', headOid: r.rev('HEAD'), upstream: null, ahead: 0, behind: 0 })
    expect(status.files).toEqual([])
    expect(status.inProgress).toBeNull()
  })
})

describe('readRepoState (file kinds)', () => {
  it('reports every kind of change with paths and old paths, sorted', async () => {
    const r = repo()
    put(r.root, 'keep.txt', 'a\nb\nc\nd\ne\nf\ng\nh\n')
    put(r.root, 'gone.txt', 'bye\n')
    put(r.root, 'move-me.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
    r.git('add', '.')
    r.git('commit', '-q', '-m', 'files')
    put(r.root, 'keep.txt', 'a\nB\nc\nd\ne\nf\ng\nh\n')
    rmSync(join(r.root, 'gone.txt'))
    r.git('mv', 'move-me.txt', 'moved.txt')
    put(r.root, 'moved.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n')
    put(r.root, 'added.txt', 'new\n')
    r.git('add', 'added.txt')
    put(r.root, 'dir/untracked.txt', 'u\n')
    put(r.root, 'héllo wörld ✓.txt', 'unicode\n')
    const { files } = await statusOf(r.root)
    expect(files).toEqual([
      { path: 'added.txt', oldPath: null, kind: 'added' },
      { path: 'dir/untracked.txt', oldPath: null, kind: 'untracked' },
      { path: 'gone.txt', oldPath: null, kind: 'deleted' },
      { path: 'héllo wörld ✓.txt', oldPath: null, kind: 'untracked' },
      { path: 'keep.txt', oldPath: null, kind: 'modified' },
      { path: 'moved.txt', oldPath: 'move-me.txt', kind: 'renamed' }
    ])
  })

  it('reports a non-ASCII tracked file', async () => {
    const r = repo()
    put(r.root, 'café.txt', 'x\n')
    r.git('add', '.')
    r.git('commit', '-q', '-m', 'cafe')
    put(r.root, 'café.txt', 'y\n')
    expect((await statusOf(r.root)).files).toEqual([{ path: 'café.txt', oldPath: null, kind: 'modified' }])
  })
})

describe('readRepoState (branch states)', () => {
  // Skipped on Windows: creating a symlink there needs privileges.
  it.skipIf(process.platform === 'win32')('reports a typechange', async () => {
    const r = repo()
    rmSync(join(r.root, 'file-1.txt'))
    symlinkSync('elsewhere', join(r.root, 'file-1.txt'))
    expect((await statusOf(r.root)).files).toEqual([{ path: 'file-1.txt', oldPath: null, kind: 'typechange' }])
  })

  it('reports an unborn branch', async () => {
    const dir = scratchDir()
    cleanups.push(dir.cleanup)
    gitIn(dir.path, 'init', '-q', '-b', 'trunk')
    put(dir.path, 'a.txt', 'a\n')
    const status = await statusOf(dir.path)
    expect(status.branch).toEqual({ name: 'trunk', headOid: null, upstream: null, ahead: 0, behind: 0 })
    expect(status.files).toEqual([{ path: 'a.txt', oldPath: null, kind: 'untracked' }])
  })

  it('reports a detached HEAD', async () => {
    const r = repo()
    const head = r.rev('HEAD')
    r.git('checkout', '-q', '--detach')
    const { branch } = await statusOf(r.root)
    expect(branch).toMatchObject({ name: null, headOid: head })
  })
})

describe('readRepoState (operations in progress)', () => {
  function conflictingBranches(r: GitRepo): string {
    put(r.root, 'c.txt', 'base\n')
    r.git('add', '.')
    r.git('commit', '-q', '-m', 'c')
    r.branch('other')
    put(r.root, 'c.txt', 'other\n')
    r.git('commit', '-q', '-am', 'other')
    const otherHead = r.rev('HEAD')
    r.switchTo('main')
    put(r.root, 'c.txt', 'main\n')
    r.git('commit', '-q', '-am', 'main')
    return otherHead
  }

  it('reports a merge in progress with conflicted files', async () => {
    const r = repo()
    conflictingBranches(r)
    expect(() => r.git('merge', 'other')).toThrow()
    const status = await statusOf(r.root)
    expect(status.inProgress).toBe('merge')
    expect(status.files).toEqual([{ path: 'c.txt', oldPath: null, kind: 'conflicted' }])
  })

  it('reports a cherry-pick in progress', async () => {
    const r = repo()
    const pick = conflictingBranches(r)
    expect(() => r.git('cherry-pick', pick)).toThrow()
    expect((await statusOf(r.root)).inProgress).toBe('cherry-pick')
  })
})

describe('readRepoState (subfolder and upstream)', () => {
  it('reports the repository root for a subfolder', async () => {
    const r = repo()
    put(r.root, 'sub/inner/f.txt', 'f\n')
    const status = await statusOf(join(r.root, 'sub', 'inner'))
    expect(samePath(status.root)).toBe(samePath(r.root))
    expect(status.files).toEqual([{ path: 'sub/inner/f.txt', oldPath: null, kind: 'untracked' }])
  })

  it('counts commits ahead of and behind the upstream', async () => {
    const r = repo()
    const bare = scratchDir()
    const other = scratchDir()
    cleanups.push(bare.cleanup, other.cleanup)
    gitIn(bare.path, 'init', '-q', '--bare', '-b', 'main')
    r.git('remote', 'add', 'origin', bare.path)
    r.git('push', '-q', '-u', 'origin', 'main')
    const clone = join(other.path, 'clone')
    gitIn(other.path, 'clone', '-q', bare.path, clone)
    put(clone, 'remote-1.txt', '1\n')
    gitIn(clone, 'add', '.')
    gitIn(clone, 'commit', '-q', '-m', 'remote')
    gitIn(clone, 'push', '-q', 'origin', 'main')
    r.commit('local one')
    r.commit('local two')
    r.commit('local three')
    r.git('fetch', '-q', 'origin')
    expect((await statusOf(r.root)).branch).toMatchObject({ name: 'main', upstream: 'origin/main', ahead: 3, behind: 1 })
  })
})
