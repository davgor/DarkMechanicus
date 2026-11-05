/**
 * Which operation a repository is in the middle of, read from git's marker files, on real repositories: a rebase wins
 * over the MERGE_HEAD a `git rebase -r` leaves at a conflicting merge, and `git am` is told apart from a rebase. Also
 * which of git's sides is the person's own work, which Use mine takes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoStatus } from '../../shared/git/status'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put, scratchDir } from '../../test/gitScratch'
import { mergeIntoCurrent } from './branches'
import { abortMerge, abortOperation, commitMerge, getConflicts, resolveWith } from './conflicts'
import { createGitRunner, type GitRunner } from './runner'
import { readRepoState } from './status'

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

function commitAll(r: GitRepo, message: string): void {
  r.git('add', '-A')
  r.git('commit', '-q', '-m', message)
}

async function statusOf(folder: string): Promise<RepoStatus> {
  const state = await readRepoState(runner, folder)
  if (state.kind !== 'repository') {
    throw new Error(`expected a repository, got ${state.kind}`)
  }
  return state.status
}

/** A runner that records the arguments of every git command it runs. */
function recording(): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, runner: { run: (request) => (calls.push([...request.args]), runner.run(request)) } }
}

/** `main` with a commit `topic` changes `a.txt` in, and a conflicting change to it on `main`. */
function divergedOnA(r: GitRepo): void {
  put(r.root, 'a.txt', 'base\n')
  commitAll(r, 'base')
  r.branch('topic')
  put(r.root, 'a.txt', 'topic\n')
  commitAll(r, 'topic change')
  r.switchTo('main')
  put(r.root, 'a.txt', 'main\n')
  commitAll(r, 'main change')
}

/**
 * `topic` merges `side`, both having changed `a.txt`, with the conflict resolved by hand; `main` moved on elsewhere.
 * `git rebase -r main` replays the merge without the hand resolution, so it stops at the merge with MERGE_HEAD set.
 */
function stoppedRebaseAtMerge(r: GitRepo): string {
  put(r.root, 'a.txt', 'base\n')
  commitAll(r, 'base')
  r.branch('side')
  put(r.root, 'a.txt', 'side\n')
  commitAll(r, 'side change')
  r.switchTo('main')
  r.branch('topic')
  put(r.root, 'a.txt', 'topic\n')
  commitAll(r, 'topic change')
  expect(() => r.git('merge', '--no-edit', 'side')).toThrow()
  put(r.root, 'a.txt', 'resolved\n')
  commitAll(r, 'merge side')
  const head = r.rev('HEAD')
  r.switchTo('main')
  put(r.root, 'other.txt', 'elsewhere\n')
  commitAll(r, 'main elsewhere')
  r.switchTo('topic')
  expect(() => r.git('rebase', '-r', 'main')).toThrow()
  return head
}

describe('a rebase stopped at a conflicting merge', () => {
  it('is reported as a rebase although MERGE_HEAD exists, and Abort ends the rebase', async () => {
    const r = repo()
    const head = stoppedRebaseAtMerge(r)
    expect(existsSync(join(r.root, '.git', 'MERGE_HEAD'))).toBe(true)
    expect(existsSync(join(r.root, '.git', 'rebase-merge'))).toBe(true)
    expect(await statusOf(r.root)).toMatchObject({ inProgress: 'rebase' })
    await expect(abortMerge(runner, r.root)).rejects.toThrow(/No merge is in progress/)
    await expect(commitMerge(runner, r.root, {})).rejects.toThrow(/No merge is in progress/)
    const state = await abortOperation(runner, r.root)
    expect(state).toMatchObject({ status: { inProgress: null, files: [], branch: { name: 'topic' } } })
    expect(r.rev('HEAD')).toBe(head)
    expect(existsSync(join(r.root, '.git', 'rebase-merge'))).toBe(false)
    expect(existsSync(join(r.root, '.git', 'MERGE_HEAD'))).toBe(false)
  })

  it('reports a stopped apply-backend rebase (rebase-apply without `applying`) as a rebase', async () => {
    const r = repo()
    divergedOnA(r)
    r.switchTo('topic')
    const head = r.rev('HEAD')
    expect(() => r.git('rebase', '--apply', 'main')).toThrow()
    expect(existsSync(join(r.root, '.git', 'rebase-apply'))).toBe(true)
    expect(await statusOf(r.root)).toMatchObject({ inProgress: 'rebase' })
    const recorder = recording()
    expect(await abortOperation(recorder.runner, r.root)).toMatchObject({ status: { inProgress: null, branch: { name: 'topic' } } })
    expect(recorder.calls).toContainEqual(['rebase', '--abort'])
    expect(r.rev('HEAD')).toBe(head)
  })
})

/**
 * Resolves `a.txt` the way the Conflicts panel's buttons do (Use mine takes `mineSide`, Use theirs the other side) and
 * returns the content it kept.
 */
async function resolvedWith(r: GitRepo, button: 'mine' | 'theirs'): Promise<string> {
  const { mineSide } = await getConflicts(runner, r.root)
  const side = button === 'mine' ? mineSide : mineSide === 'ours' ? 'theirs' : 'ours'
  await resolveWith(runner, r.root, { path: 'a.txt', side })
  return readFileSync(join(r.root, 'a.txt'), 'utf8')
}

describe('whose side Use mine takes', () => {
  it('at a rebase-merges merge step: the rewritten branch is mine and the merged-in side theirs (no swap)', async () => {
    const r = repo()
    stoppedRebaseAtMerge(r)
    expect(await getConflicts(runner, r.root)).toMatchObject({ mineSide: 'ours' })
    expect(await resolvedWith(r, 'mine')).toBe('topic\n')
    const other = repo()
    stoppedRebaseAtMerge(other)
    expect(await resolvedWith(other, 'theirs')).toBe('side\n')
    // Two repositories each stopped at a real `git rebase -r`: a few seconds alone, past vitest's 15 s on a loaded Windows CI runner.
  }, 60_000)

  it('while a rebase replays a commit: the replayed commit is mine and the upstream theirs (swapped)', async () => {
    for (const backend of ['--merge', '--apply']) {
      for (const button of ['mine', 'theirs'] as const) {
        const r = repo()
        divergedOnA(r)
        r.switchTo('topic')
        expect(() => r.git('rebase', backend, 'main')).toThrow()
        expect(await getConflicts(runner, r.root)).toMatchObject({ mineSide: 'theirs' })
        expect(await resolvedWith(r, button)).toBe(button === 'mine' ? 'topic\n' : 'main\n')
      }
    }
    // Several real git rebases: a few seconds alone, but past vitest's 15 s on a loaded Windows CI runner.
  }, 60_000)

  it('in a merge, a cherry-pick and a git am: the current branch is mine', async () => {
    const merged = repo()
    divergedOnA(merged)
    await expect(mergeIntoCurrent(runner, merged.root, { branch: 'topic' })).rejects.toMatchObject({ code: 'merge_conflicts' })
    expect(await getConflicts(runner, merged.root)).toMatchObject({ mineSide: 'ours' })
    expect(await resolvedWith(merged, 'mine')).toBe('main\n')
    const picked = repo()
    divergedOnA(picked)
    expect(() => picked.git('cherry-pick', 'topic')).toThrow()
    expect(await resolvedWith(picked, 'mine')).toBe('main\n')
    const applied = repo()
    divergedOnA(applied)
    const patches = scratchDir('dm-am-')
    cleanups.push(patches.cleanup)
    applied.git('format-patch', '-q', '-o', patches.path, 'main..topic')
    expect(() => applied.git('am', '-3', join(patches.path, '0001-topic-change.patch'))).toThrow()
    expect(await resolvedWith(applied, 'mine')).toBe('main\n')
    // Three real-git repositories (a merge, a cherry-pick and a git am): 20 s on PR #16's loaded Windows CI runner, past vitest's 15 s.
  }, 60_000)
})

describe('a git am in progress', () => {
  it('is reported as its own kind, and Abort runs `git am --abort`', async () => {
    const r = repo()
    divergedOnA(r)
    const patches = scratchDir('dm-am-')
    cleanups.push(patches.cleanup)
    r.git('format-patch', '-q', '-o', patches.path, 'main..topic')
    const head = r.rev('HEAD')
    expect(() => r.git('am', '-3', join(patches.path, '0001-topic-change.patch'))).toThrow()
    expect(existsSync(join(r.root, '.git', 'rebase-apply', 'applying'))).toBe(true)
    expect(await statusOf(r.root)).toMatchObject({ inProgress: 'am' })
    await expect(commitMerge(runner, r.root, {})).rejects.toThrow(/No merge is in progress/)
    const recorder = recording()
    const state = await abortOperation(recorder.runner, r.root)
    expect(recorder.calls).toContainEqual(['am', '--abort'])
    expect(state).toMatchObject({ status: { inProgress: null, files: [], branch: { name: 'main' } } })
    expect(r.rev('HEAD')).toBe(head)
    expect(existsSync(join(r.root, '.git', 'rebase-apply'))).toBe(false)
  })
})

describe('other operations, detected as before', () => {
  it('reports a plain conflicting merge as a merge', async () => {
    const r = repo()
    divergedOnA(r)
    await expect(mergeIntoCurrent(runner, r.root, { branch: 'topic' })).rejects.toMatchObject({ code: 'merge_conflicts' })
    expect(await statusOf(r.root)).toMatchObject({ inProgress: 'merge' })
    await expect(abortOperation(runner, r.root)).rejects.toThrow(/No rebase, cherry-pick or revert/)
    expect(await abortMerge(runner, r.root)).toMatchObject({ status: { inProgress: null } })
  })

  it('reports a conflicting cherry-pick and revert as such', async () => {
    const r = repo()
    divergedOnA(r)
    expect(() => r.git('cherry-pick', 'topic')).toThrow()
    expect(await statusOf(r.root)).toMatchObject({ inProgress: 'cherry-pick' })
    await abortOperation(runner, r.root)
    const changed = r.rev('HEAD')
    put(r.root, 'a.txt', 'main again\n')
    commitAll(r, 'main again')
    expect(() => r.git('revert', '--no-edit', changed)).toThrow()
    expect(await statusOf(r.root)).toMatchObject({ inProgress: 'revert' })
  })

  it('reports nothing in progress on a clean repository', async () => {
    const r = repo()
    divergedOnA(r)
    expect(await statusOf(r.root)).toMatchObject({ inProgress: null })
  })
})
