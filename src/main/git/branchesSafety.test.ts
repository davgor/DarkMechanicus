/** Red-team cases: operations in progress, hooks, a branch named `stash`, worktrees, child refs and stale leases. */
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyGitRepo, createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig, teammatePushes, useRemoteRepos } from '../../test/gitRemotes'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { useTemplate } from '../../test/gitTemplate'
import { createBranch, deleteBranch, switchBranch } from './branches'
import { GitInputError } from './errors'
import { createGitRunner } from './runner'
import { discardStash, listStashes, restoreStash } from './stash'

const runner = createGitRunner()
const deps = { runner, session: { getAccount: () => null, getToken: () => null }, env: {} }
const cleanups: Array<() => void> = []
const remotes = useRemoteRepos()
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

/** `main` and `other` at its initial commit: built once for the file, copied for each test. */
const repoTemplate = useTemplate((templateCleanups) => {
  const r = createGitRepo()
  templateCleanups.push(r.cleanup)
  r.git('branch', 'other')
  return r
})

function repo(): GitRepo {
  const r = copyGitRepo(repoTemplate())
  cleanups.push(r.cleanup)
  return r
}

function stashSubjects(r: GitRepo): string[] {
  return r.git('stash', 'list', '--format=%gs').split('\n').filter((line) => line !== '')
}

describe('switching during an operation and with hooks', () => {
  it('refuses to switch, even with stash, while a merge is in progress', async () => {
    const r = repo()
    r.switchTo('other')
    put(r.root, 'file-1.txt', 'other\n')
    r.git('commit', '-q', '-am', 'other')
    r.switchTo('main')
    put(r.root, 'file-1.txt', 'main\n')
    r.git('commit', '-q', '-am', 'main')
    expect(() => r.git('merge', '-q', 'other')).toThrow()
    put(r.root, 'file-1.txt', 'resolved\n')
    r.git('add', 'file-1.txt')
    await expect(switchBranch(runner, r.root, { name: 'other', uncommitted: 'stash' })).rejects.toMatchObject({ code: 'operation_in_progress' })
    expect(existsSync(join(r.root, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(stashSubjects(r)).toEqual([])
  })

  it('keeps the stash when a post-checkout hook fails after the switch', async () => {
    const r = repo()
    put(r.root, '.git/hooks/post-checkout', '#!/bin/sh\nexit 1\n')
    chmodSync(join(r.root, '.git/hooks/post-checkout'), 0o755)
    put(r.root, 'file-1.txt', 'mine\n')
    await expect(switchBranch(runner, r.root, { name: 'other', uncommitted: 'stash' })).rejects.toThrow()
    expect(r.git('branch', '--show-current')).toBe('other')
    expect(readFileSync(join(r.root, 'file-1.txt'), 'utf8')).not.toBe('mine\n')
    expect(stashSubjects(r)).toEqual(['On main: dm-stash:main'])
  })
})

describe('stashes beside a branch named stash', () => {
  it('lists, restores and discards them', async () => {
    const r = repo()
    await createBranch(runner, r.root, { name: 'stash', startPoint: 'current' })
    r.switchTo('main')
    put(r.root, 'file-1.txt', 'one\n')
    await switchBranch(runner, r.root, { name: 'other', uncommitted: 'stash' })
    await switchBranch(runner, r.root, { name: 'main', uncommitted: 'bring' })
    // The second DM stash is made the way switchBranch makes it, without another round trip through both branches.
    put(r.root, 'file-1.txt', 'two\n')
    r.git('stash', 'push', '--include-untracked', '-m', 'dm-stash:main')
    expect((await listStashes(runner, r.root)).map((stash) => stash.files)).toEqual([
      [{ path: 'file-1.txt', oldPath: null, kind: 'modified' }],
      [{ path: 'file-1.txt', oldPath: null, kind: 'modified' }]
    ])
    await discardStash(runner, r.root, 'stash@{0}')
    await restoreStash(runner, r.root, 'stash@{0}')
    expect(readFileSync(join(r.root, 'file-1.txt'), 'utf8')).toBe('one\n')
    expect(stashSubjects(r)).toEqual([])
  })

  it('reports a restore blocked by an existing untracked file as local changes, keeping the stash', async () => {
    const r = repo()
    put(r.root, 'u.txt', 'stashed\n')
    await switchBranch(runner, r.root, { name: 'other', uncommitted: 'stash' })
    await switchBranch(runner, r.root, { name: 'main', uncommitted: 'bring' })
    put(r.root, 'u.txt', 'in the way\n')
    await expect(restoreStash(runner, r.root, 'stash@{0}')).rejects.toMatchObject({ code: 'local_changes_would_be_overwritten' })
    expect(stashSubjects(r)).toEqual(['On main: dm-stash:main'])
  })
})

/** Local `x` (two commits ahead of `main`) tracking `origin/x`, and the bare origin. */
function pushedTopic(): { local: GitRepo; bare: string } {
  const { local, bare } = remotes(cleanups)
  local.branch('x')
  local.commit('x one')
  local.commit('x two')
  local.git('push', '-q', '-u', 'origin', 'x')
  local.switchTo('main')
  return { local, bare }
}

describe('deleting a remote branch that a rebase holds', () => {
  it('refuses a branch another worktree is rebasing, before touching the remote', async () => {
    const { local, bare } = pushedTopic()
    const elsewhere = scratchDir()
    cleanups.push(elsewhere.cleanup)
    const wt = join(elsewhere.path, 'wt')
    local.git('worktree', 'add', '-q', wt, 'x')
    expect(() => gitIn(wt, 'rebase', '-q', '--exec', 'false', 'HEAD~1')).toThrow()
    await expect(deleteBranch(deps, local.root, { name: 'x', deleteRemote: true, force: true })).rejects.toThrow(/worktree/)
    expect(gitIn(bare, 'rev-parse', '--verify', '-q', 'refs/heads/x').trim()).not.toBe('')
  })

  it('refuses a branch this worktree is rebasing (HEAD detached), before touching the remote', async () => {
    const { local, bare } = pushedTopic()
    local.switchTo('x')
    expect(() => local.git('rebase', '-q', '--exec', 'false', 'HEAD~1')).toThrow()
    await expect(deleteBranch(deps, local.root, { name: 'x', deleteRemote: true, force: true })).rejects.toThrow(/worktree/)
    expect(gitIn(bare, 'rev-parse', '--verify', '-q', 'refs/heads/x').trim()).not.toBe('')
  })
})

describe('deleting a remote branch safely', () => {
  it('refuses a branch checked out in another worktree before touching the remote', async () => {
    const { local, bare } = remotes(cleanups)
    local.git('push', '-q', 'origin', 'main:x')
    local.git('branch', '--track', 'x', 'origin/x')
    const elsewhere = scratchDir()
    cleanups.push(elsewhere.cleanup)
    local.git('worktree', 'add', '-q', join(elsewhere.path, 'wt'), 'x')
    await expect(deleteBranch(deps, local.root, { name: 'x', deleteRemote: true, force: true })).rejects.toThrow(/worktree/)
    expect(gitIn(bare, 'rev-parse', '--verify', '-q', 'refs/heads/x').trim()).not.toBe('')
  })

  it('refuses a name that is only a prefix of other branches, deleting nothing', async () => {
    const { local, bare } = remotes(cleanups)
    local.git('push', '-q', 'origin', 'main:feature/a')
    local.git('branch', '--track', 'feature/a', 'origin/feature/a')
    await expect(deleteBranch(deps, local.root, { name: 'feature', deleteRemote: true, force: true })).rejects.toBeInstanceOf(GitInputError)
    expect(gitIn(bare, 'rev-parse', '--verify', '-q', 'refs/heads/feature/a').trim()).not.toBe('')
  })

  it('leaves a remote branch that moved since the last fetch, even when forced', async () => {
    const { local, other, bare } = remotes(cleanups)
    gitIn(other, 'switch', '-q', '-c', 'feature')
    teammatePushes(other, 'feature.txt')
    local.git('fetch', '-q', 'origin')
    local.git('branch', '--track', 'feature', 'origin/feature')
    teammatePushes(other, 'more.txt')
    const moved = gitIn(bare, 'rev-parse', 'refs/heads/feature').trim()
    await expect(deleteBranch(deps, local.root, { name: 'feature', deleteRemote: true, force: true })).rejects.toMatchObject({
      code: 'rejected_non_fast_forward'
    })
    expect(gitIn(bare, 'rev-parse', 'refs/heads/feature').trim()).toBe(moved)
    expect(local.git('branch', '--list', 'feature')).not.toBe('')
  })
})
