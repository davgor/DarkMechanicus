/** Branch operations' edge cases and refusals on real temporary repositories (no network). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { createBranch, deleteBranch, listBranches, mergeIntoCurrent, switchBranch } from './branches'
import { GitError, GitInputError } from './errors'
import { createGitRunner } from './runner'

const runner = createGitRunner()
const deps = { runner, session: { getAccount: () => null, getToken: () => null }, env: {} }
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

/** `main` and `topic` both changed `file-1.txt` since they split. */
function divergedTopic(r: GitRepo): void {
  r.branch('topic')
  put(r.root, 'file-1.txt', 'topic\n')
  r.git('commit', '-q', '-am', 'topic')
  r.switchTo('main')
  put(r.root, 'file-1.txt', 'main\n')
  r.git('commit', '-q', '-am', 'main')
}

describe('listBranches edge cases', () => {
  it('owns remote refs by the longest remote name, keeps an unknown remote whole, and tolerates odd refs', async () => {
    const r = repo()
    r.git('remote', 'add', 'team', '/nowhere/team')
    r.git('remote', 'add', 'team/fork', '/nowhere/fork')
    r.git('update-ref', 'refs/remotes/team/fork/x', 'HEAD')
    r.git('update-ref', 'refs/remotes/ghost/y', 'HEAD')
    r.git('update-ref', 'refs/remotes/team/tree', r.git('rev-parse', 'HEAD^{tree}'))
    r.git('branch', '--track', 'feature', 'main')
    const list = await listBranches(runner, r.root)
    const byName = new Map(list.branches.map((branch) => [branch.name, branch]))
    expect([...byName.keys()]).toEqual(['feature', 'main', 'ghost/y', 'team/fork/x', 'team/tree'])
    expect(byName.get('team/fork/x')?.remote).toBe('team/fork')
    expect(byName.get('ghost/y')?.remote).toBe('ghost')
    expect(byName.get('team/tree')?.lastCommitAt).toBe('')
    expect(byName.get('feature')?.upstream).toBe('main')
    expect(byName.get('main')?.upstream).toBeNull()
    expect(list.defaultBranch).toBe('main')
  })
})

describe('createBranch from the default branch', () => {
  it('refuses when there is no default branch to start from, creating nothing', async () => {
    const r = repo()
    r.git('branch', '-m', 'main', 'trunk')
    await expect(createBranch(runner, r.root, { name: 'topic', startPoint: 'default' })).rejects.toThrow(
      new GitInputError('This repository has no default branch to start from.')
    )
    expect(r.git('for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/trunk')
  })
})

describe('switchBranch refusals', () => {
  it('refuses a name no branch has, and one more than one remote has', async () => {
    const r = repo()
    r.git('remote', 'add', 'a', '/nowhere/a')
    r.git('remote', 'add', 'b', '/nowhere/b')
    r.git('update-ref', 'refs/remotes/a/shared', 'HEAD')
    r.git('update-ref', 'refs/remotes/b/shared', 'HEAD')
    await expect(switchBranch(runner, r.root, { name: 'missing', uncommitted: 'bring' })).rejects.toThrow(
      new GitInputError('There is no branch with that name.')
    )
    await expect(switchBranch(runner, r.root, { name: 'shared', uncommitted: 'bring' })).rejects.toThrow(
      new GitInputError('More than one remote has a branch with that name; pick one.')
    )
    expect(r.git('branch', '--show-current')).toBe('main')
  })

  it('treats switching to the current branch as nothing to do, stashing nothing', async () => {
    const r = repo()
    put(r.root, 'file-1.txt', 'work in progress\n')
    const state = await switchBranch(runner, r.root, { name: 'main', uncommitted: 'stash' })
    expect(state).toMatchObject({ kind: 'repository', status: { branch: { name: 'main' } } })
    expect(state).toMatchObject({ status: { files: [{ path: 'file-1.txt', kind: 'modified' }] } })
    expect(r.git('stash', 'list')).toBe('')
  })

  it('refuses to stash changes made on a detached HEAD, leaving them in place', async () => {
    const r = repo()
    r.git('checkout', '-q', '--detach')
    put(r.root, 'file-1.txt', 'detached work\n')
    await expect(switchBranch(runner, r.root, { name: 'main', uncommitted: 'stash' })).rejects.toThrow(GitInputError)
    expect(r.git('stash', 'list')).toBe('')
    expect(r.git('status', '--porcelain')).toBe('M file-1.txt')
    expect(r.git('branch', '--show-current')).toBe('')
  })

  it('refuses while a merge is in progress, which a switch or stash would end', async () => {
    const r = repo()
    divergedTopic(r)
    expect(() => r.git('merge', '-q', 'topic')).toThrow()
    const failure = switchBranch(runner, r.root, { name: 'topic', uncommitted: 'stash' })
    await expect(failure).rejects.toBeInstanceOf(GitError)
    await expect(failure).rejects.toMatchObject({ code: 'operation_in_progress', message: expect.stringContaining('merge') })
    expect(r.git('rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBe(r.rev('topic'))
    expect(r.git('stash', 'list')).toBe('')
  })
})

describe('deleteBranch with a remote branch git no longer knows', () => {
  it('returns remote_not_found and keeps the local branch when the remote-tracking ref is gone', async () => {
    const r = repo()
    r.git('remote', 'add', 'origin', '/nowhere/origin')
    r.git('branch', 'feature')
    r.git('config', 'branch.feature.remote', 'origin')
    r.git('config', 'branch.feature.merge', 'refs/heads/feature')
    const failure = deleteBranch(deps, r.root, { name: 'feature', force: false, deleteRemote: true })
    await expect(failure).rejects.toMatchObject({ code: 'remote_not_found' })
    expect(r.git('rev-parse', '--verify', '-q', 'refs/heads/feature')).toBe(r.rev('main'))
  })
})

describe('mergeIntoCurrent edge cases', () => {
  it('refuses a branch that does not exist, and names a remote-tracking branch as one in the message', async () => {
    const r = repo()
    await expect(mergeIntoCurrent(runner, r.root, { branch: 'nope' })).rejects.toThrow(
      new GitInputError('There is no branch with that name.')
    )
    r.git('remote', 'add', 'origin', '/nowhere/origin')
    r.branch('topic')
    r.commit('topic work')
    r.git('update-ref', 'refs/remotes/origin/topic', 'topic')
    r.switchTo('main')
    r.git('branch', '-D', 'topic')
    r.commit('main work')
    await mergeIntoCurrent(runner, r.root, { branch: 'origin/topic' })
    expect(r.git('log', '-1', '--format=%s')).toBe("Merge remote-tracking branch 'origin/topic'")
    expect(r.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
  })
})
