/** Merge conflicts on real temporary repositories: every kind, marker counts, resolving, aborting and committing. */
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig, remoteRepos, teammatePushes } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { mergeIntoCurrent, switchBranch } from './branches'
import { abortMerge, abortOperation, commitMerge, getConflicts, markResolved, resolveWith } from './conflicts'
import { readWorkingDiff } from './diff'
import { createGitRunner } from './runner'
import { restoreStash } from './stash'
import { createSync } from './sync'

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

/**
 * `main` merging `topic` with a conflict of each common kind: `both.txt` and `two.txt` (two hunks) both modified,
 * `gone.txt` deleted by them, `mine-gone.txt` deleted by us, and `new.txt` added on both sides.
 */
async function conflictedMerge(): Promise<GitRepo> {
  const r = repo()
  put(r.root, 'both.txt', 'base\n')
  put(r.root, 'two.txt', 'one\nkeep\nkeep\nkeep\nkeep\ntwo\n')
  put(r.root, 'gone.txt', 'base\n')
  put(r.root, 'mine-gone.txt', 'base\n')
  commitAll(r, 'base')
  r.branch('topic')
  put(r.root, 'both.txt', 'theirs\n')
  put(r.root, 'two.txt', 'ONE theirs\nkeep\nkeep\nkeep\nkeep\nTWO theirs\n')
  r.git('rm', '-q', 'gone.txt')
  put(r.root, 'mine-gone.txt', 'theirs\n')
  put(r.root, 'new.txt', 'theirs new\n')
  commitAll(r, 'theirs')
  r.switchTo('main')
  put(r.root, 'both.txt', 'ours\n')
  put(r.root, 'two.txt', 'ONE ours\nkeep\nkeep\nkeep\nkeep\nTWO ours\n')
  put(r.root, 'gone.txt', 'ours\n')
  r.git('rm', '-q', 'mine-gone.txt')
  put(r.root, 'new.txt', 'ours new\n')
  commitAll(r, 'ours')
  await expect(mergeIntoCurrent(runner, r.root, { branch: 'topic' })).rejects.toMatchObject({ code: 'merge_conflicts' })
  return r
}

const read = (r: GitRepo, path: string): string => readFileSync(join(r.root, path), 'utf8')

describe('getConflicts', () => {
  it('lists each conflicted file with its kind and marker count, and names both sides', async () => {
    const r = await conflictedMerge()
    expect(await getConflicts(runner, r.root)).toEqual({
      ourBranch: 'main',
      theirLabel: 'topic', mineSide: 'ours',
      files: [
        { path: 'both.txt', kind: 'both_modified', markers: 1 },
        { path: 'gone.txt', kind: 'deleted_by_them', markers: 0 },
        { path: 'mine-gone.txt', kind: 'deleted_by_us', markers: 0 },
        { path: 'new.txt', kind: 'both_added', markers: 1 },
        { path: 'two.txt', kind: 'both_modified', markers: 2 }
      ]
    })
  })

  it('reports both_deleted, added_by_us and added_by_them from a rename/rename conflict', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\nb\nc\n')
    commitAll(r, 'base')
    r.branch('topic')
    r.git('mv', 'a.txt', 'c.txt')
    commitAll(r, 'theirs')
    r.switchTo('main')
    r.git('mv', 'a.txt', 'b.txt')
    commitAll(r, 'ours')
    await expect(mergeIntoCurrent(runner, r.root, { branch: 'topic' })).rejects.toMatchObject({ code: 'merge_conflicts' })
    expect((await getConflicts(runner, r.root)).files).toEqual([
      { path: 'a.txt', kind: 'both_deleted', markers: 0 },
      { path: 'b.txt', kind: 'added_by_us', markers: 0 },
      { path: 'c.txt', kind: 'added_by_them', markers: 0 }
    ])
  })

  it('counts markers again as the working file changes, and 0 once the file is gone', async () => {
    const r = await conflictedMerge()
    put(r.root, 'two.txt', 'fixed one\nkeep\n<<<<<<< HEAD\nTWO ours\n=======\nTWO theirs\n>>>>>>> topic\n')
    put(r.root, 'both.txt', '<<<<<<<not a marker\n <<<<<<< indented\n')
    rmSync(join(r.root, 'new.txt'))
    const markers = (await getConflicts(runner, r.root)).files.map((file) => [file.path, file.markers])
    expect(markers).toEqual([['both.txt', 0], ['gone.txt', 0], ['mine-gone.txt', 0], ['new.txt', 0], ['two.txt', 1]])
  })

  it('is empty, with no label, when nothing conflicts', async () => {
    const r = repo()
    expect(await getConflicts(runner, r.root)).toEqual({ ourBranch: 'main', theirLabel: null, mineSide: 'ours', files: [] })
  })

  it('shows the working file, markers and all, as the diff of a conflicted file', async () => {
    const r = await conflictedMerge()
    const diff = await readWorkingDiff(runner, r.root, { path: 'both.txt', oldPath: null, kind: 'conflicted' })
    expect(JSON.stringify(diff)).toContain('<<<<<<< HEAD')
  })
})

describe('resolveWith', () => {
  it('takes our or their version of a file and stages it', async () => {
    const r = await conflictedMerge()
    await resolveWith(runner, r.root, { path: 'both.txt', side: 'ours' })
    await resolveWith(runner, r.root, { path: 'two.txt', side: 'theirs' })
    expect(read(r, 'both.txt')).toBe('ours\n')
    expect(read(r, 'two.txt')).toBe('ONE theirs\nkeep\nkeep\nkeep\nkeep\nTWO theirs\n')
    expect(r.git('diff', '--cached', '--name-status', '--', 'both.txt')).toBe('')
    expect(r.git('diff', '--cached', '--name-status', '--', 'two.txt')).toBe('M\ttwo.txt')
    expect((await getConflicts(runner, r.root)).files.map((file) => file.path)).toEqual(['gone.txt', 'mine-gone.txt', 'new.txt'])
  })

  it('deletes the file when the chosen side deleted it, and keeps it when the other side did', async () => {
    const r = await conflictedMerge()
    await resolveWith(runner, r.root, { path: 'gone.txt', side: 'theirs' })
    await resolveWith(runner, r.root, { path: 'mine-gone.txt', side: 'ours' })
    expect(existsSync(join(r.root, 'gone.txt'))).toBe(false)
    expect(existsSync(join(r.root, 'mine-gone.txt'))).toBe(false)
    expect(r.git('ls-files', '--', 'gone.txt', 'mine-gone.txt')).toBe('')
    await resolveWith(runner, r.root, { path: 'new.txt', side: 'theirs' })
    expect(read(r, 'new.txt')).toBe('theirs new\n')
  })

  it('deletes for a side without the file in a rename/rename conflict', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    commitAll(r, 'base')
    r.branch('topic')
    r.git('mv', 'a.txt', 'c.txt')
    commitAll(r, 'theirs')
    r.switchTo('main')
    r.git('mv', 'a.txt', 'b.txt')
    commitAll(r, 'ours')
    await expect(mergeIntoCurrent(runner, r.root, { branch: 'topic' })).rejects.toMatchObject({ code: 'merge_conflicts' })
    await resolveWith(runner, r.root, { path: 'a.txt', side: 'ours' })
    await resolveWith(runner, r.root, { path: 'b.txt', side: 'ours' })
    await resolveWith(runner, r.root, { path: 'c.txt', side: 'ours' })
    expect((await getConflicts(runner, r.root)).files).toEqual([])
    expect(r.git('ls-files')).toBe('b.txt\nfile-1.txt')
  })

  it('refuses a path that is not conflicted, or leaves the repository', async () => {
    const r = await conflictedMerge()
    await expect(resolveWith(runner, r.root, { path: 'file-1.txt', side: 'ours' })).rejects.toThrow(/not a conflicted file/)
    await expect(resolveWith(runner, r.root, { path: '../both.txt', side: 'ours' })).rejects.toThrow(/stay inside the repository/)
    await expect(resolveWith(runner, r.root, { path: join(r.root, 'both.txt'), side: 'ours' })).rejects.toThrow(/stay inside/)
    await expect(resolveWith(runner, r.root, { path: 'sub/../both.txt', side: 'ours' })).rejects.toThrow(/not a conflicted file/)
    expect(read(r, 'both.txt')).toContain('<<<<<<< ')
  })
})

describe('markResolved', () => {
  it('is refused while markers remain, then stages the file', async () => {
    const r = await conflictedMerge()
    await expect(markResolved(runner, r.root, { path: 'both.txt' })).rejects.toMatchObject({ code: 'conflict_markers_remain' })
    expect((await getConflicts(runner, r.root)).files.some((file) => file.path === 'both.txt')).toBe(true)
    put(r.root, 'both.txt', 'both, by hand\n')
    await markResolved(runner, r.root, { path: 'both.txt' })
    expect(r.git('show', ':both.txt')).toBe('both, by hand')
    expect((await getConflicts(runner, r.root)).files.some((file) => file.path === 'both.txt')).toBe(false)
  })

  it('stages a deletion when the file is gone', async () => {
    const r = await conflictedMerge()
    rmSync(join(r.root, 'gone.txt'))
    await expect(markResolved(runner, r.root, { path: 'gone.txt' })).resolves.toMatchObject({ kind: 'repository' })
    expect(r.git('ls-files', '--stage', '--', 'gone.txt')).toBe('')
  })
})

describe('abortMerge', () => {
  it('puts back the state from before the merge', async () => {
    const r = await conflictedMerge()
    const head = r.rev('HEAD')
    const state = await abortMerge(runner, r.root)
    expect(state).toMatchObject({ kind: 'repository', status: { inProgress: null, files: [] } })
    expect(r.rev('HEAD')).toBe(head)
    expect(read(r, 'both.txt')).toBe('ours\n')
  })

  it('is refused when no merge is in progress', async () => {
    const r = repo()
    await expect(abortMerge(runner, r.root)).rejects.toThrow(/No merge is in progress/)
  })
})

describe('commitMerge', () => {
  it('is refused while any file is unresolved', async () => {
    const r = await conflictedMerge()
    await expect(commitMerge(runner, r.root, {})).rejects.toMatchObject({ code: 'merge_conflicts' })
    for (const path of ['both.txt', 'two.txt', 'new.txt', 'gone.txt']) {
      await resolveWith(runner, r.root, { path, side: 'ours' })
    }
    await expect(commitMerge(runner, r.root, {})).rejects.toMatchObject({ code: 'merge_conflicts' })
  })

  it("makes the merge commit with git's message once every file is resolved", async () => {
    const r = await conflictedMerge()
    const ours = r.rev('HEAD')
    const theirs = r.rev('topic')
    const kept = ['both.txt', 'two.txt', 'new.txt', 'gone.txt']
    r.git('checkout', '--ours', '--', ...kept)
    r.git('add', '--', ...kept)
    await resolveWith(runner, r.root, { path: 'mine-gone.txt', side: 'theirs' })
    const { oid } = await commitMerge(runner, r.root, {})
    expect(r.rev('HEAD')).toBe(oid)
    expect(r.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1)).toEqual([ours, theirs])
    expect(r.git('log', '-1', '--format=%s')).toBe("Merge branch 'topic'")
    expect(read(r, 'mine-gone.txt')).toBe('theirs\n')
    expect(await getConflicts(runner, r.root)).toEqual({ ourBranch: 'main', theirLabel: null, mineSide: 'ours', files: [] })
  })

  it('takes a summary and description when given', async () => {
    const r = await conflictedMerge()
    const taken = ['both.txt', 'two.txt', 'new.txt', 'mine-gone.txt']
    r.git('checkout', '--theirs', '--', ...taken)
    r.git('add', '--', ...taken)
    await resolveWith(runner, r.root, { path: 'gone.txt', side: 'theirs' })
    await commitMerge(runner, r.root, { summary: 'Bring in topic', description: 'All theirs.' })
    expect(r.git('log', '-1', '--format=%B')).toBe('Bring in topic\n\nAll theirs.')
    expect(r.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
  })

  it('is refused when no merge is in progress', async () => {
    const r = repo()
    await expect(commitMerge(runner, r.root, {})).rejects.toThrow(/No merge is in progress/)
  })
})

/** `main` with a commit `topic` changes `file-1.txt` in, and a conflicting change to it on `main`. */
function divergedOnFile1(r: GitRepo): void {
  r.branch('topic')
  put(r.root, 'file-1.txt', 'topic\n')
  commitAll(r, 'topic change')
  r.switchTo('main')
  put(r.root, 'file-1.txt', 'main\n')
  commitAll(r, 'main change')
}

describe('abortOperation', () => {
  it('aborts a rebase started from the command line', async () => {
    const r = repo()
    divergedOnFile1(r)
    r.switchTo('topic')
    const head = r.rev('HEAD')
    expect(() => r.git('rebase', 'main')).toThrow()
    expect(await getConflicts(runner, r.root)).toMatchObject({ files: [{ path: 'file-1.txt', kind: 'both_modified', markers: 1 }] })
    const state = await abortOperation(runner, r.root)
    expect(state).toMatchObject({ status: { inProgress: null, files: [], branch: { name: 'topic' } } })
    expect(r.rev('HEAD')).toBe(head)
  })

  it('aborts a cherry-pick and a revert', async () => {
    const r = repo()
    divergedOnFile1(r)
    const head = r.rev('HEAD')
    expect(() => r.git('cherry-pick', 'topic')).toThrow()
    expect(await abortOperation(runner, r.root)).toMatchObject({ status: { inProgress: null } })
    put(r.root, 'file-1.txt', 'main again\n')
    commitAll(r, 'main again')
    expect(() => r.git('revert', '--no-edit', head)).toThrow()
    expect(await abortOperation(runner, r.root)).toMatchObject({ status: { inProgress: null, files: [] } })
  })

  it('is refused when no rebase, cherry-pick or revert is in progress', async () => {
    const r = await conflictedMerge()
    await expect(abortOperation(runner, r.root)).rejects.toThrow(/No rebase, cherry-pick or revert/)
  })
})

describe('conflicts from a pull, a merge or a stash restore', () => {
  it('shows a conflicting pull', async () => {
    const { local, other } = remoteRepos(cleanups)
    teammatePushes(other, 'file-1.txt')
    put(local.root, 'file-1.txt', 'mine\n')
    commitAll(local, 'mine')
    const sync = createSync({ runner, session: { getAccount: () => null, getToken: () => null }, onProgress: () => undefined })
    await expect(sync.run('pull', local.root, 'op-1')).rejects.toMatchObject({ code: 'merge_conflicts' })
    const conflicts = await getConflicts(runner, local.root)
    expect(conflicts.ourBranch).toBe('main')
    expect(conflicts.theirLabel).toMatch(/^main of /)
    expect(conflicts.files).toEqual([{ path: 'file-1.txt', kind: 'both_modified', markers: 1 }])
  })

  it('shows a conflicting stash restore, without a label, with the stashed work as mine, and Use mine keeps it', async () => {
    const r = repo()
    r.git('branch', 'other')
    put(r.root, 'file-1.txt', 'stashed\n')
    await switchBranch(runner, r.root, { name: 'other', uncommitted: 'stash' })
    await switchBranch(runner, r.root, { name: 'main', uncommitted: 'bring' })
    put(r.root, 'file-1.txt', 'committed meanwhile\n')
    commitAll(r, 'meanwhile')
    await expect(restoreStash(runner, r.root, 'stash@{0}')).rejects.toMatchObject({ code: 'merge_conflicts' })
    const conflicts = await getConflicts(runner, r.root)
    expect(conflicts).toEqual({
      ourBranch: 'main',
      theirLabel: null,
      mineSide: 'theirs',
      files: [{ path: 'file-1.txt', kind: 'both_modified', markers: 1 }]
    })
    await resolveWith(runner, r.root, { path: 'file-1.txt', side: conflicts.mineSide })
    expect(read(r, 'file-1.txt')).toBe('stashed\n')
    expect((await getConflicts(runner, r.root)).files).toEqual([])
  })
})

describe('marker counts in large files', () => {
  it('counts a marker that straddles two read chunks, and only at the start of a line', async () => {
    const r = await conflictedMerge()
    const chunk = 1024 * 1024
    put(r.root, 'both.txt', `${'a'.repeat(chunk - 4)}\n<<<<<<< straddles\n${'b'.repeat(chunk - 10)}<<<<<<< mid-line\n<<<<<<< last`)
    expect((await getConflicts(runner, r.root)).files.find((file) => file.path === 'both.txt')?.markers).toBe(2)
  })
})

describe('red-team regressions', () => {
  it('counts markers of any size git writes (conflict-marker-size), not lines that only look alike', async () => {
    const r = await conflictedMerge()
    put(r.root, 'both.txt', `${'<'.repeat(32)} HEAD\nours\n${'='.repeat(32)}\ntheirs\n${'>'.repeat(32)} topic\n<<<<<<x\n<<<<<<<\n`)
    expect((await getConflicts(runner, r.root)).files.find((file) => file.path === 'both.txt')?.markers).toBe(1)
    await expect(markResolved(runner, r.root, { path: 'both.txt' })).rejects.toMatchObject({ code: 'conflict_markers_remain' })
  })

  // Windows allows no ':' in a file name, so this file cannot exist there.
  it.skipIf(process.platform === 'win32')('reads a conflicted name that looks like pathspec magic literally', async () => {
    const r = repo()
    put(r.root, 'foo', 'root foo\n')
    put(r.root, ':/foo', 'base\n')
    put(r.root, ':!x', 'base\n')
    commitAll(r, 'base')
    r.branch('topic')
    put(r.root, ':/foo', 'theirs\n')
    put(r.root, ':!x', 'theirs\n')
    commitAll(r, 'theirs')
    r.switchTo('main')
    put(r.root, ':/foo', 'ours\n')
    put(r.root, ':!x', 'ours\n')
    commitAll(r, 'ours')
    await expect(mergeIntoCurrent(runner, r.root, { branch: 'topic' })).rejects.toMatchObject({ code: 'merge_conflicts' })
    put(r.root, 'foo', 'edited root foo\n')
    await resolveWith(runner, r.root, { path: ':/foo', side: 'theirs' })
    expect(read(r, 'foo')).toBe('edited root foo\n')
    expect(read(r, ':/foo')).toBe('theirs\n')
    put(r.root, ':!x', 'by hand\n')
    await markResolved(runner, r.root, { path: ':!x' })
    expect((await getConflicts(runner, r.root)).files).toEqual([])
    expect(r.git('diff', '--cached', '--name-only').split('\n').sort()).toEqual([':!x', ':/foo'])
  })
})

describe('red-team regressions: submodules and unreadable files', () => {
  it("stages the chosen side's commit of a conflicted submodule", async () => {
    const r = repo()
    const gitlink = (digit: string): void => {
      r.git('update-index', '--add', '--cacheinfo', `160000,${digit.repeat(40)},sub`)
      r.git('commit', '-q', '-m', `sub ${digit}`)
    }
    gitlink('1')
    r.branch('topic')
    gitlink('2')
    r.switchTo('main')
    gitlink('3')
    await expect(mergeIntoCurrent(runner, r.root, { branch: 'topic' })).rejects.toMatchObject({ code: 'merge_conflicts' })
    expect((await getConflicts(runner, r.root)).files).toEqual([{ path: 'sub', kind: 'both_modified', markers: 0 }])
    await resolveWith(runner, r.root, { path: 'sub', side: 'theirs' })
    expect(r.git('ls-files', '--stage', '--', 'sub')).toBe(`160000 ${'2'.repeat(40)} 0\tsub`)
  })

  it('counts an unreadable conflicted file as still conflicted instead of failing every file', async () => {
    const r = await conflictedMerge()
    chmodSync(join(r.root, 'both.txt'), 0o000)
    cleanups.push(() => chmodSync(join(r.root, 'both.txt'), 0o644))
    const files = (await getConflicts(runner, r.root)).files
    expect(files.find((file) => file.path === 'both.txt')?.markers).toBe(1)
    expect(files.find((file) => file.path === 'two.txt')?.markers).toBe(2)
  })
})
