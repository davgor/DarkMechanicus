import { describe, expect, it } from 'vitest'
import type { RepoState, RepoStatus } from '../../../shared/git/status'
import { FakeGit } from './fakeGit'

describe('FakeGit', () => {
  it('answers per-folder state and diffs, records calls, and reports unknown folders', async () => {
    const git = new FakeGit()
    git.setState('/a', { kind: 'not_repository' })
    git.setDiff('/a', 'x.txt', { kind: 'binary', path: 'x.txt', oldPath: null, oldMode: null, newMode: null, hash: '' } as never)
    expect(await git.getState('/a')).toEqual({ ok: true, data: { kind: 'not_repository' } })
    expect((await git.getWorkingDiff('/a', { path: 'x.txt', oldPath: null, kind: 'modified' })).ok).toBe(true)
    expect(await git.getState('/zzz')).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await git.initRepository('/a')).toMatchObject({ ok: true })
    expect(git.calls.map((call) => call.method)).toEqual(['getState', 'getWorkingDiff', 'getState', 'initRepository'])
  })

  it('commits, undoes and discards, refusing untracked folders and paths outside the repository', async () => {
    const git = new FakeGit()
    const status = {
      root: '/a',
      branch: { name: 'main', headOid: 'h', upstream: null, ahead: 0, behind: 0 },
      files: [{ path: 'x.txt', oldPath: null, kind: 'modified' as const }],
      inProgress: null,
      lastFetchedAt: null,
      remote: null
    }
    git.setState('/a', { kind: 'repository', status })
    git.undoneMessage = { summary: 'S', description: 'D' }
    const files = [{ path: 'x.txt', oldPath: null }]
    expect(await git.commit('/a', { summary: 'S', description: '', files })).toMatchObject({ ok: true })
    expect(await git.commit('/a', { summary: ' ', description: '', files })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.commit('/a', { summary: 'S', description: '', files: [{ path: '../x', oldPath: null }] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.commit('/zzz', { summary: 'S', description: '', files })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await git.undoLastCommit('/a')).toEqual({ ok: true, data: { summary: 'S', description: 'D' } })
    expect(await git.undoLastCommit('/zzz')).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await git.discardChanges('/a', { files: [{ path: '/etc/x', oldPath: null, kind: 'untracked' }] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.discardChanges('/zzz', { files: [] })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    const result = await git.discardChanges('/a', { files: [{ path: 'x.txt', oldPath: null, kind: 'modified' }] })
    expect(result.ok && result.data.kind === 'repository' && result.data.status.files).toEqual([])
  })

  it('delivers progress to listeners until they unsubscribe', () => {
    const git = new FakeGit()
    const seen: number[] = []
    const off = git.onProgress((event) => seen.push(event.percent ?? -1))
    const event = { folder: '/a', operationId: 'o', operation: 'x', phase: 'p', percent: 1 }
    git.emitProgress(event)
    off()
    git.emitProgress(event)
    expect(seen).toEqual([1])
  })
})

describe('FakeGit fetch, pull and push', () => {
  it('fetches, pulls and pushes to the folder state, fails with syncError, and never has anything to cancel', async () => {
    const git = new FakeGit()
    git.setState('/a', { kind: 'not_repository' })
    expect(await git.fetch('/a', { operationId: 'f' })).toEqual({ ok: true, data: { kind: 'not_repository' } })
    git.syncError = { code: 'rejected_non_fast_forward', message: 'Pull first.' }
    expect(await git.push('/a', { operationId: 'p' })).toEqual({ ok: false, error: git.syncError })
    expect(await git.pull('/zzz', { operationId: 'l' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await git.cancelOperation('/a', 'p')).toEqual({ ok: true, data: { cancelled: false } })
    expect(git.calls.map((call) => [call.method, call.request ?? call.operationId])).toEqual([
      ['fetch', { operationId: 'f' }],
      ['push', { operationId: 'p' }],
      ['pull', { operationId: 'l' }],
      ['cancelOperation', 'p']
    ])
  })
})

describe('FakeGit branches and stashes', () => {
  const status = {
    root: '/a',
    branch: { name: 'main', headOid: 'h', upstream: null, ahead: 0, behind: 0 },
    files: [],
    inProgress: null,
    lastFetchedAt: null,
    remote: null
  }

  it('lists what a test set, checks names like main, follows create and switch, and fails with branchError', async () => {
    const git = new FakeGit()
    git.setState('/a', { kind: 'repository', status })
    const list = { current: 'main', defaultBranch: 'main', branches: [] }
    git.setBranches('/a', list)
    git.setStashes('/a', [{ ref: 'stash@{0}', branch: 'main', createdAt: '2026-01-01T00:00:00.000Z', files: [] }])
    expect(await git.listBranches('/a')).toEqual({ ok: true, data: list })
    expect(await git.listStashes('/a')).toMatchObject({ ok: true, data: [{ ref: 'stash@{0}' }] })
    expect(await git.checkBranchName('/a', 'feature/x')).toEqual({ ok: true, data: { valid: true, normalized: 'feature/x' } })
    for (const bad of ['', '-x', 'a..b', '@{-1}', 'a b', 'x.lock', 'a/', 'x'.repeat(256)]) {
      expect(await git.checkBranchName('/a', bad), bad).toEqual({ ok: true, data: { valid: false, normalized: null } })
    }
    const created = await git.createBranch('/a', { name: 'topic', startPoint: 'current' })
    expect(created.ok && created.data.kind === 'repository' && created.data.status.branch.name).toBe('topic')
    const switched = await git.switchBranch('/a', { name: 'main', uncommitted: 'stash' })
    expect(switched.ok && switched.data.kind === 'repository' && switched.data.status.branch.name).toBe('main')
    expect(await git.createBranch('/a', { name: '-x', startPoint: 'current' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    git.branchError = { code: 'merge_conflicts', message: 'Conflicts.' }
    expect(await git.mergeIntoCurrent('/a', { branch: 'topic' })).toEqual({ ok: false, error: git.branchError })
    expect(await git.restoreStash('/a', 'stash@{0}')).toEqual({ ok: false, error: git.branchError })
    expect(await git.renameBranch('/zzz', { from: 'a', to: 'b' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    git.branchError = null
    expect((await git.deleteBranch('/a', { name: 'topic', deleteRemote: false, force: false })).ok).toBe(true)
    expect((await git.discardStash('/a', 'stash@{0}')).ok).toBe(true)
    expect(git.calls.map((call) => call.method)).toEqual([
      'listBranches',
      'listStashes',
      'checkBranchName',
      ...Array<string>(8).fill('checkBranchName'),
      'createBranch',
      'switchBranch',
      'createBranch',
      'mergeIntoCurrent',
      'restoreStash',
      'renameBranch',
      'deleteBranch',
      'discardStash'
    ])
  })
})

const merging = (inProgress: RepoStatus['inProgress'] = 'merge'): RepoState => ({
  kind: 'repository',
  status: {
    root: '/a',
    branch: { name: 'main', headOid: 'h', upstream: null, ahead: 0, behind: 0 },
    files: [
      { path: 'x.txt', oldPath: null, kind: 'conflicted' },
      { path: 'y.txt', oldPath: null, kind: 'conflicted' }
    ],
    inProgress,
    lastFetchedAt: null,
    remote: null
  }
})

describe('FakeGit conflicts', () => {
  it('derives conflicts from the state, resolves, refuses markers and commits the merge', async () => {
    const git = new FakeGit()
    git.setState('/a', merging())
    expect(await git.getConflicts('/a')).toEqual({
      ok: true,
      data: { ourBranch: 'main', theirLabel: null, mineSide: 'ours', files: [{ path: 'x.txt', kind: 'both_modified', markers: 1 }, { path: 'y.txt', kind: 'both_modified', markers: 1 }] }
    })
    expect(await git.markResolved('/a', { path: 'x.txt' })).toMatchObject({ ok: false, error: { code: 'conflict_markers_remain' } })
    expect(await git.commitMerge('/a', {})).toMatchObject({ ok: false, error: { code: 'merge_conflicts' } })
    expect(await git.resolveWith('/a', { path: '../x.txt', side: 'ours' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.resolveWith('/a', { path: 'z.txt', side: 'ours' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    const resolved = await git.resolveWith('/a', { path: 'x.txt', side: 'theirs' })
    expect(resolved.ok && resolved.data.kind === 'repository' && resolved.data.status.files).toEqual([
      { path: 'x.txt', oldPath: null, kind: 'modified' },
      { path: 'y.txt', oldPath: null, kind: 'conflicted' }
    ])
    git.setConflicts('/a', { ourBranch: 'main', theirLabel: 'topic', mineSide: 'ours', files: [{ path: 'y.txt', kind: 'both_added', markers: 0 }] })
    expect(await git.markResolved('/a', { path: 'y.txt' })).toMatchObject({ ok: true })
    expect(await git.getConflicts('/a')).toEqual({ ok: true, data: { ourBranch: 'main', theirLabel: 'topic', mineSide: 'ours', files: [] } })
    expect(await git.commitMerge('/a', { summary: 'M' })).toMatchObject({ ok: true })
    const after = await git.getState('/a')
    expect(after.ok && after.data.kind === 'repository' && after.data.status.inProgress).toBeNull()
  })

  it('aborts, opens files only when conflicted, and refuses untracked folders', async () => {
    const git = new FakeGit()
    git.setState('/a', merging())
    expect(await git.abortOperation('/a')).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.openInEditor('/a', 'x.txt')).toEqual({ ok: true, data: null })
    expect(await git.openInEditor('/a', 'other.txt')).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.openInEditor('/a', '/etc/hosts')).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    const aborted = await git.abortMerge('/a')
    expect(aborted.ok && aborted.data.kind === 'repository' && aborted.data.status.inProgress).toBeNull()
    expect(await git.abortMerge('/a')).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    git.setState('/a', merging('rebase'))
    expect(await git.abortOperation('/a')).toMatchObject({ ok: true })
    expect(await git.getConflicts('/zzz')).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await git.commitMerge('/zzz', {})).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(git.calls.filter((call) => call.method === 'openInEditor').map((call) => call.path)).toEqual(['x.txt', 'other.txt', '/etc/hosts'])
  })
})

describe('FakeGit pull requests', () => {
  const status: RepoStatus = {
    root: '/a',
    branch: { name: 'main', headOid: 'h', upstream: null, ahead: 0, behind: 0 },
    files: [],
    inProgress: null,
    lastFetchedAt: null,
    remote: null
  }
  const summary = { title: 'T', author: 'mona', isDraft: false, url: 'u', updatedAt: 'd', baseRef: 'main', headRepoFullName: 'octo/repo' }

  it('answers no pull requests and refuses the URLs until a GitHub repository is set', async () => {
    const git = new FakeGit()
    git.setState('/a', { kind: 'repository', status })
    expect(await git.getPullRequests('/a')).toEqual({ ok: true, data: { repository: null, current: null, open: [] } })
    expect(await git.getCommitUrl('/a', 'abcd')).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.getCompareUrl('/a')).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.getPullRequests('/zzz')).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })

  it('checks out a same-repository pull request as its branch and a fork one as pr/<n>, and builds URLs', async () => {
    const git = new FakeGit()
    git.setState('/a', { kind: 'repository', status })
    const open = [
      { ...summary, number: 1, headRef: 'feature', fromFork: false },
      { ...summary, number: 2, headRef: 'patch', fromFork: true }
    ]
    git.setPullRequests('/a', { ok: true, data: { repository: { owner: 'octo', repo: 'repo' }, current: null, open } })
    git.setCompareUrl('/a', { kind: 'needs_push' })
    const first = await git.checkoutPullRequest('/a', { number: 1, uncommitted: 'stash' })
    expect(first.ok && first.data.kind === 'repository' && first.data.status.branch.name).toBe('feature')
    const second = await git.checkoutPullRequest('/a', { number: 2, uncommitted: 'bring' })
    expect(second.ok && second.data.kind === 'repository' && second.data.status.branch.name).toBe('pr/2')
    expect(await git.getCommitUrl('/a', 'abcd')).toEqual({ ok: true, data: 'https://github.com/octo/repo/commit/abcd' })
    expect(await git.getCommitUrl('/a', 'xyz')).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.getCompareUrl('/a')).toEqual({ ok: true, data: { kind: 'needs_push' } })
    expect(git.calls.filter((call) => call.method === 'checkoutPullRequest').map((call) => call.request)).toEqual([
      { number: 1, uncommitted: 'stash' },
      { number: 2, uncommitted: 'bring' }
    ])
  })

  it('answers a set failure, such as auth_required, for both reading and checking out', async () => {
    const git = new FakeGit()
    git.setState('/a', { kind: 'repository', status })
    const signedOut = { ok: false as const, error: { code: 'auth_required' as const, message: 'Sign in.' } }
    git.setPullRequests('/a', signedOut)
    expect(await git.getPullRequests('/a', { refresh: true })).toEqual(signedOut)
    expect(await git.checkoutPullRequest('/a', { number: 1, uncommitted: 'bring' })).toEqual(signedOut)
  })
})

describe('FakeGit clone', () => {
  it('keeps the clone parent the dialog picks, and refuses a clone until there is one', async () => {
    const git = new FakeGit()
    expect(await git.getCloneParent()).toEqual({ ok: true, data: null })
    expect(await git.clone({ operationId: 'c', url: 'octocat/Hello-World', name: 'Hello-World' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await git.chooseCloneParent()).toEqual({ ok: true, data: null })
    git.pickedCloneParent = '/home/u/code'
    expect(await git.chooseCloneParent()).toEqual({ ok: true, data: '/home/u/code' })
    expect(await git.getCloneParent()).toEqual({ ok: true, data: '/home/u/code' })
  })

  it('clones into <parent>/<name>, or fails with cloneError', async () => {
    const git = new FakeGit()
    git.cloneParent = '/home/u/code'
    const done = await git.clone({ operationId: 'c', url: 'octocat/Hello-World', name: 'Hello-World' })
    expect(done).toMatchObject({ ok: true, data: { path: '/home/u/code/Hello-World', name: 'Hello-World' } })
    git.cloneError = { code: 'target_exists', message: '/home/u/code/Hello-World already exists and is not an empty folder.' }
    expect(await git.clone({ operationId: 'd', url: 'octocat/Hello-World', name: 'Hello-World' })).toEqual({ ok: false, error: git.cloneError })
    expect(git.calls.filter((call) => call.method === 'clone').map((call) => [call.folder, call.request])).toEqual([
      ['/home/u/code', { operationId: 'c', url: 'octocat/Hello-World', name: 'Hello-World' }],
      ['/home/u/code', { operationId: 'd', url: 'octocat/Hello-World', name: 'Hello-World' }]
    ])
  })

  it('holds clones until finished, and a cancel by parent and id fails one with cancelled', async () => {
    const git = new FakeGit()
    git.cloneParent = '/home/u/code'
    git.holdClones = true
    const first = git.clone({ operationId: 'a', url: 'octocat/Hello-World', name: 'one' })
    const second = git.clone({ operationId: 'b', url: 'octocat/Hello-World', name: 'two' })
    expect(await git.cancelOperation('/home/u/code', 'b')).toEqual({ ok: true, data: { cancelled: true } })
    expect(await second).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(await git.cancelOperation('/home/u/code', 'b')).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    git.finishClone('a')
    expect(await first).toMatchObject({ ok: true, data: { path: '/home/u/code/one' } })
  })
})
