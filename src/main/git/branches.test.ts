/** Branch operations on real temporary repositories with a local bare `origin`. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoState, RepoStatus } from '../../shared/git/status'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { bareRepo, isolateGitConfig, remoteRepos, teammatePushes } from '../../test/gitRemotes'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { createBranch, deleteBranch, listBranches, mergeIntoCurrent, renameBranch, switchBranch } from './branches'
import { createGitRunner } from './runner'

const runner = createGitRunner()
const signedOut = { getAccount: () => null, getToken: () => null }
const deps = { runner, session: signedOut, env: {} }
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

function statusOf(state: RepoState): RepoStatus {
  if (state.kind !== 'repository') {
    throw new Error(`expected a repository, got ${state.kind}`)
  }
  return state.status
}

function read(root: string, file: string): string {
  return readFileSync(join(root, file), 'utf8')
}

function localBranches(r: GitRepo): string[] {
  return r.git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter((name) => name !== '')
}

describe('listBranches', () => {
  it('lists local and remote branches with upstream, ahead/behind, last commit time, current and default', async () => {
    const { local, other } = remoteRepos(cleanups)
    teammatePushes(other, 'team.txt', 2)
    gitIn(other, 'switch', '-q', '-c', 'feature')
    teammatePushes(other, 'feature.txt')
    local.commit('mine')
    local.git('fetch', '-q', 'origin')
    local.git('remote', 'set-head', 'origin', 'feature')
    local.git('branch', 'side')
    const list = await listBranches(runner, local.root)
    expect(list.current).toBe('main')
    expect(list.defaultBranch).toBe('feature')
    expect(list.branches.map((branch) => branch.name)).toEqual(['main', 'side', 'origin/feature', 'origin/main'])
    const [main, side, feature] = list.branches
    expect(main).toMatchObject({ kind: 'local', remote: null, upstream: 'origin/main', ahead: 1, behind: 2, isCurrent: true })
    expect(main.lastCommitAt).toBe(new Date(local.git('log', '-1', '--format=%cI', 'main')).toISOString())
    expect(side).toMatchObject({ kind: 'local', upstream: null, ahead: 0, behind: 0, isCurrent: false })
    expect(feature).toMatchObject({ kind: 'remote', remote: 'origin', upstream: null, ahead: 0, behind: 0, isCurrent: false })
  })

  it('falls back to main or master without a remote HEAD, and reports a detached HEAD as no current branch', async () => {
    const r = repo()
    expect((await listBranches(runner, r.root)).defaultBranch).toBe('main')
    r.git('branch', '-m', 'main', 'master')
    expect((await listBranches(runner, r.root)).defaultBranch).toBe('master')
    r.git('branch', '-m', 'master', 'trunk')
    expect((await listBranches(runner, r.root)).defaultBranch).toBeNull()
    r.git('checkout', '-q', '--detach')
    const list = await listBranches(runner, r.root)
    expect(list.current).toBeNull()
    expect(list.branches.every((branch) => !branch.isCurrent)).toBe(true)
  })

  it('keeps remote names that hold a slash whole', async () => {
    const { local, bare } = remoteRepos(cleanups)
    local.git('remote', 'add', 'team/fork', bare)
    local.git('fetch', '-q', 'team/fork')
    const remote = (await listBranches(runner, local.root)).branches.find((branch) => branch.name === 'team/fork/main')
    expect(remote).toMatchObject({ kind: 'remote', remote: 'team/fork' })
  })
})

describe('createBranch', () => {
  it('creates a branch at HEAD and brings uncommitted changes along', async () => {
    const r = repo()
    put(r.root, 'file-1.txt', 'changed\n')
    const status = statusOf(await createBranch(runner, r.root, { name: 'topic', startPoint: 'current' }))
    expect(status.branch.name).toBe('topic')
    expect(r.rev('topic')).toBe(r.rev('main'))
    expect(read(r.root, 'file-1.txt')).toBe('changed\n')
  })

  it('creates a branch at the default branch, without tracking it', async () => {
    const r = repo()
    r.branch('work')
    r.commit('work only')
    const status = statusOf(await createBranch(runner, r.root, { name: 'fresh', startPoint: 'default' }))
    expect(status.branch).toMatchObject({ name: 'fresh', upstream: null })
    expect(r.rev('fresh')).toBe(r.rev('main'))
  })

  it("starts at the remote's default branch when there is no local one", async () => {
    const { local } = remoteRepos(cleanups)
    local.git('remote', 'set-head', 'origin', 'main')
    local.branch('work')
    local.git('branch', '-D', 'main')
    const status = statusOf(await createBranch(runner, local.root, { name: 'fresh', startPoint: 'default' }))
    expect(status.branch).toMatchObject({ name: 'fresh', upstream: null })
    expect(local.rev('fresh')).toBe(local.rev('origin/main'))
  })

  it('returns branch_exists for a name in use and stays put', async () => {
    const r = repo()
    r.git('branch', 'taken')
    await expect(createBranch(runner, r.root, { name: 'taken', startPoint: 'current' })).rejects.toMatchObject({ code: 'branch_exists' })
    expect(r.git('branch', '--show-current')).toBe('main')
  })
})

/** `main` and `other`, where `shared.txt` differs. */
function withOtherBranch(): GitRepo {
  const r = repo()
  put(r.root, 'shared.txt', 'base\n')
  r.git('add', '.')
  r.git('commit', '-q', '-m', 'shared')
  r.branch('other')
  put(r.root, 'shared.txt', 'other\n')
  r.git('commit', '-q', '-am', 'other')
  r.switchTo('main')
  return r
}

describe('switchBranch', () => {
  it('stashes the changes, untracked files included, as dm-stash:<branch>, then switches', async () => {
    const r = withOtherBranch()
    put(r.root, 'shared.txt', 'mine\n')
    put(r.root, 'new.txt', 'new\n')
    const status = statusOf(await switchBranch(runner, r.root, { name: 'other', uncommitted: 'stash' }))
    expect(status.branch.name).toBe('other')
    expect(status.files).toEqual([])
    expect(r.git('stash', 'list', '--format=%gs')).toBe('On main: dm-stash:main')
    // Switching back never pops the stash.
    statusOf(await switchBranch(runner, r.root, { name: 'main', uncommitted: 'stash' }))
    expect(read(r.root, 'shared.txt')).toBe('base\n')
    expect(r.git('stash', 'list', '--format=%gs')).toBe('On main: dm-stash:main')
  })

  it('brings changes along when git can', async () => {
    const r = withOtherBranch()
    put(r.root, 'file-1.txt', 'carried\n')
    const status = statusOf(await switchBranch(runner, r.root, { name: 'other', uncommitted: 'bring' }))
    expect(status.branch.name).toBe('other')
    expect(read(r.root, 'file-1.txt')).toBe('carried\n')
    expect(r.git('stash', 'list')).toBe('')
  })

  it('returns local_changes_would_be_overwritten and changes nothing when git refuses to bring them', async () => {
    const r = withOtherBranch()
    put(r.root, 'shared.txt', 'mine\n')
    await expect(switchBranch(runner, r.root, { name: 'other', uncommitted: 'bring' })).rejects.toMatchObject({
      code: 'local_changes_would_be_overwritten'
    })
    expect(r.git('branch', '--show-current')).toBe('main')
    expect(read(r.root, 'shared.txt')).toBe('mine\n')
    expect(r.git('stash', 'list')).toBe('')
  })
})

describe('switchBranch when git refuses after the stash', () => {
  it('puts the changes back from its own stash and leaves the person’s stashes alone', async () => {
    const r = withOtherBranch()
    put(r.root, 'file-1.txt', 'own stash\n')
    r.git('stash', 'push', '-q', '-m', 'my own stash')
    const elsewhere = scratchDir()
    cleanups.push(elsewhere.cleanup)
    r.git('worktree', 'add', '-q', join(elsewhere.path, 'wt'), 'other')
    put(r.root, 'shared.txt', 'mine\n')
    put(r.root, 'file-1.txt', 'staged\n')
    r.git('add', 'file-1.txt')
    put(r.root, 'new.txt', 'new\n')
    await expect(switchBranch(runner, r.root, { name: 'other', uncommitted: 'stash' })).rejects.toThrow()
    expect(r.git('branch', '--show-current')).toBe('main')
    expect(read(r.root, 'shared.txt')).toBe('mine\n')
    expect(read(r.root, 'new.txt')).toBe('new\n')
    expect(r.git('diff', '--cached', '--name-only')).toBe('file-1.txt')
    expect(r.git('stash', 'list', '--format=%gs')).toBe('On main: my own stash')
  })
})

describe('switchBranch to a remote branch', () => {
  it('checks out a remote-only branch as a tracking branch, by its own name or its remote name', async () => {
    const { local, other } = remoteRepos(cleanups)
    gitIn(other, 'switch', '-q', '-c', 'feature')
    teammatePushes(other, 'feature.txt')
    gitIn(other, 'switch', '-q', '-c', 'second')
    teammatePushes(other, 'second.txt')
    local.git('fetch', '-q', 'origin')
    const first = statusOf(await switchBranch(runner, local.root, { name: 'feature', uncommitted: 'bring' }))
    expect(first.branch).toMatchObject({ name: 'feature', upstream: 'origin/feature', ahead: 0, behind: 0 })
    const second = statusOf(await switchBranch(runner, local.root, { name: 'origin/second', uncommitted: 'bring' }))
    expect(second.branch).toMatchObject({ name: 'second', upstream: 'origin/second' })
    statusOf(await switchBranch(runner, local.root, { name: 'origin/feature', uncommitted: 'bring' }))
    expect(local.git('branch', '--show-current')).toBe('feature')
  })
})

describe('renameBranch', () => {
  it('renames a branch, the current one included, and refuses a name in use', async () => {
    const r = repo()
    r.git('branch', 'old')
    r.git('branch', 'taken')
    await renameBranch(runner, r.root, { from: 'old', to: 'new' })
    const status = statusOf(await renameBranch(runner, r.root, { from: 'main', to: 'trunk' }))
    expect(status.branch.name).toBe('trunk')
    expect(localBranches(r)).toEqual(['new', 'taken', 'trunk'])
    await expect(renameBranch(runner, r.root, { from: 'new', to: 'taken' })).rejects.toMatchObject({ code: 'branch_exists' })
  })
})

describe('deleteBranch', () => {
  it('deletes a merged branch, refuses an unmerged one unless forced, and refuses the current branch', async () => {
    const r = repo()
    r.git('branch', 'merged')
    r.branch('unmerged')
    r.commit('only here')
    r.switchTo('main')
    await deleteBranch(deps, r.root, { name: 'merged', deleteRemote: false, force: false })
    await expect(deleteBranch(deps, r.root, { name: 'unmerged', deleteRemote: false, force: false })).rejects.toMatchObject({
      code: 'branch_not_fully_merged'
    })
    expect(localBranches(r)).toEqual(['main', 'unmerged'])
    await deleteBranch(deps, r.root, { name: 'unmerged', deleteRemote: false, force: true })
    await expect(deleteBranch(deps, r.root, { name: 'main', deleteRemote: false, force: true })).rejects.toThrow(/current branch/)
    expect(localBranches(r)).toEqual(['main'])
  })
})

describe('deleteBranch with its remote branch', () => {
  it("deletes the branch's upstream on its own remote, and refuses one under another name", async () => {
    const { local, bare } = remoteRepos(cleanups)
    const fork = bareRepo(cleanups)
    local.git('remote', 'add', 'fork', fork)
    local.git('push', '-q', 'origin', 'main:feature')
    local.git('push', '-q', 'fork', 'main', 'main:feature', 'main:develop')
    local.git('branch', '--track', 'fix', 'fork/develop')
    local.git('branch', '--track', 'feature', 'fork/feature')
    await expect(deleteBranch(deps, local.root, { name: 'fix', deleteRemote: true, force: false })).rejects.toThrow(/another name/)
    await deleteBranch(deps, local.root, { name: 'feature', deleteRemote: true, force: false })
    expect(localBranches(local)).toEqual(['fix', 'main'])
    expect(gitIn(fork, 'for-each-ref', '--format=%(refname)').trim().split('\n')).toEqual(['refs/heads/develop', 'refs/heads/main'])
    expect(gitIn(bare, 'for-each-ref', '--format=%(refname)').trim().split('\n')).toEqual(['refs/heads/feature', 'refs/heads/main'])
    expect(local.git('for-each-ref', '--format=%(refname)', 'refs/remotes/fork').split('\n')).toEqual(['refs/remotes/fork/develop', 'refs/remotes/fork/main'])
  })

  it('keeps everything when the remote branch has work HEAD lacks, unless forced', async () => {
    const { local, other, bare } = remoteRepos(cleanups)
    gitIn(other, 'switch', '-q', '-c', 'feature')
    teammatePushes(other, 'feature.txt')
    local.git('fetch', '-q', 'origin')
    local.git('branch', '--track', 'feature', 'origin/main')
    local.git('branch', '--set-upstream-to=origin/feature', 'feature')
    await expect(deleteBranch(deps, local.root, { name: 'feature', deleteRemote: true, force: false })).rejects.toMatchObject({
      code: 'branch_not_fully_merged'
    })
    expect(localBranches(local)).toEqual(['feature', 'main'])
    expect(gitIn(bare, 'rev-parse', '--verify', '-q', 'refs/heads/feature').trim()).not.toBe('')
    await deleteBranch(deps, local.root, { name: 'feature', deleteRemote: true, force: true })
    expect(gitIn(bare, 'for-each-ref', '--format=%(refname)').trim()).toBe('refs/heads/main')
  })

  it('refuses to delete a remote branch the local one does not track, deleting nothing', async () => {
    const r = repo()
    r.git('branch', 'loner')
    await expect(deleteBranch(deps, r.root, { name: 'loner', deleteRemote: true, force: false })).rejects.toThrow(/upstream/)
    expect(localBranches(r)).toEqual(['loner', 'main'])
  })
})

describe('mergeIntoCurrent', () => {
  it('merges a branch into the current one', async () => {
    const r = repo()
    r.branch('topic')
    r.commit('topic work')
    r.switchTo('main')
    r.commit('main work')
    const status = statusOf(await mergeIntoCurrent(runner, r.root, { branch: 'topic' }))
    expect(status.inProgress).toBeNull()
    expect(r.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    expect(r.git('log', '-1', '--format=%s')).toBe("Merge branch 'topic'")
  })

  it('returns merge_conflicts for a conflicting branch, leaving the merge in progress', async () => {
    const r = repo()
    r.branch('topic')
    put(r.root, 'file-1.txt', 'topic\n')
    r.git('commit', '-q', '-am', 'topic')
    r.switchTo('main')
    put(r.root, 'file-1.txt', 'main\n')
    r.git('commit', '-q', '-am', 'main')
    await expect(mergeIntoCurrent(runner, r.root, { branch: 'topic' })).rejects.toMatchObject({ code: 'merge_conflicts' })
    expect(r.git('rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBe(r.rev('topic'))
  })
})
