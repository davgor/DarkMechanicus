/** Dark Mechanicus stashes (`dm-stash:<branch>`) on real temporary repositories. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { switchBranch } from './branches'
import { GitInputError } from './errors'
import { createGitRunner } from './runner'
import { discardStash, listStashes, restoreStash } from './stash'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

/** A repository on `main` with a DM stash of a modified and an untracked file, made by switching away and back. */
async function stashed(): Promise<GitRepo> {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  r.git('branch', 'other')
  put(r.root, 'file-1.txt', 'mine\n')
  put(r.root, 'new.txt', 'new\n')
  await switchBranch(runner, r.root, { name: 'other', uncommitted: 'stash' })
  await switchBranch(runner, r.root, { name: 'main', uncommitted: 'bring' })
  return r
}

function stashSubjects(r: GitRepo): string[] {
  return r.git('stash', 'list', '--format=%gs').split('\n').filter((line) => line !== '')
}

describe('listStashes', () => {
  it("lists only the current branch's DM stashes, with their files", async () => {
    const r = await stashed()
    put(r.root, 'file-1.txt', 'manual\n')
    r.git('stash', 'push', '-q', '-m', 'my own stash')
    r.switchTo('other')
    put(r.root, 'file-1.txt', 'other\n')
    await switchBranch(runner, r.root, { name: 'main', uncommitted: 'stash' })
    expect(stashSubjects(r)).toEqual(['On other: dm-stash:other', 'On main: my own stash', 'On main: dm-stash:main'])
    const stashes = await listStashes(runner, r.root)
    expect(stashes).toHaveLength(1)
    expect(stashes[0]).toMatchObject({ ref: 'stash@{2}', branch: 'main' })
    expect(Number.isNaN(Date.parse(stashes[0].createdAt))).toBe(false)
    expect(stashes[0].files).toEqual([
      { path: 'file-1.txt', oldPath: null, kind: 'modified' },
      { path: 'new.txt', oldPath: null, kind: 'added' }
    ])
  })
})

describe('restoreStash', () => {
  it('restores the changes and drops the stash', async () => {
    const r = await stashed()
    await restoreStash(runner, r.root, 'stash@{0}')
    expect(readFileSync(join(r.root, 'file-1.txt'), 'utf8')).toBe('mine\n')
    expect(readFileSync(join(r.root, 'new.txt'), 'utf8')).toBe('new\n')
    expect(stashSubjects(r)).toEqual([])
  })

  it('returns merge_conflicts on a conflict and keeps the stash', async () => {
    const r = await stashed()
    put(r.root, 'file-1.txt', 'committed since\n')
    r.git('commit', '-q', '-am', 'since')
    await expect(restoreStash(runner, r.root, 'stash@{0}')).rejects.toMatchObject({ code: 'merge_conflicts' })
    expect(stashSubjects(r)).toEqual(['On main: dm-stash:main'])
  })

  it("refuses a stash that is not one of the current branch's DM stashes", async () => {
    const r = await stashed()
    put(r.root, 'file-1.txt', 'manual\n')
    r.git('stash', 'push', '-q', '-m', 'my own stash')
    await expect(restoreStash(runner, r.root, 'stash@{0}')).rejects.toBeInstanceOf(GitInputError)
    await expect(discardStash(runner, r.root, 'stash@{0}')).rejects.toBeInstanceOf(GitInputError)
    await expect(restoreStash(runner, r.root, 'stash@{5}')).rejects.toBeInstanceOf(GitInputError)
    expect(stashSubjects(r)).toEqual(['On main: my own stash', 'On main: dm-stash:main'])
  })
})

describe('discardStash', () => {
  it('drops the stash and leaves the working tree alone', async () => {
    const r = await stashed()
    await discardStash(runner, r.root, 'stash@{0}')
    expect(stashSubjects(r)).toEqual([])
    expect(await listStashes(runner, r.root)).toEqual([])
    expect(readFileSync(join(r.root, 'file-1.txt'), 'utf8')).not.toBe('mine\n')
  })
})
