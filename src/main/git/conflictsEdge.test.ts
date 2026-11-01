/** Merge conflict edge cases on real temporary repositories: ordering, labels, marker wording and message refusals. */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { commitMerge, getConflicts, markResolved } from './conflicts'
import { GitError, GitInputError } from './errors'
import { createGitRunner } from './runner'

const runner = createGitRunner()
const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

/** `main` merging `topic`, with each of `files` changed differently on both sides; `two.txt` conflicts in two hunks. */
function conflicted(files: string[]): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  const write = (side: string): void => {
    for (const file of files) {
      put(r.root, file, `${side} first\nkeep\nkeep\nkeep\nkeep\n${side} last\n`)
    }
    r.git('add', '-A')
    r.git('commit', '-q', '-m', side)
  }
  write('base')
  r.branch('topic')
  write('theirs')
  r.switchTo('main')
  write('ours')
  expect(() => r.git('merge', '-q', '--no-edit', 'topic')).toThrow()
  return r
}

describe('getConflicts edge cases', () => {
  it('orders files by their UTF-16 path, not by the UTF-8 byte order git reports them in', async () => {
    const r = conflicted(['\uFF41.txt', '\u{1F600}.txt'])
    const paths = (await getConflicts(runner, r.root)).files.map((file) => file.path)
    expect(paths).toEqual(['\u{1F600}.txt', '\uFF41.txt'])
  })

  it('names no other side when git left an empty merge message', async () => {
    const r = conflicted(['two.txt'])
    writeFileSync(resolve(r.root, r.git('rev-parse', '--git-path', 'MERGE_MSG')), '\n')
    const state = await getConflicts(runner, r.root)
    expect(state.theirLabel).toBeNull()
    expect(state.ourBranch).toBe('main')
    expect(state.files).toEqual([{ path: 'two.txt', kind: 'both_modified', markers: 2 }])
  })
})

describe('markResolved with several markers', () => {
  it('refuses with the plural count and stages nothing', async () => {
    const r = conflicted(['two.txt'])
    const failure = markResolved(runner, r.root, { path: 'two.txt' })
    await expect(failure).rejects.toBeInstanceOf(GitError)
    await expect(failure).rejects.toMatchObject({ code: 'conflict_markers_remain' })
    await expect(failure).rejects.toThrow('two.txt still has 2 conflict markers.')
    expect(r.git('diff', '--name-only', '--diff-filter=U')).toBe('two.txt')
  })
})

describe('commitMerge message', () => {
  it('refuses a description without a summary and leaves the merge in progress', async () => {
    const r = conflicted(['two.txt'])
    put(r.root, 'two.txt', 'settled\n')
    r.git('add', 'two.txt')
    await expect(commitMerge(runner, r.root, { summary: '  ', description: 'why' })).rejects.toThrow(
      new GitInputError('A merge commit message needs a summary.')
    )
    expect(r.git('rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBe(r.rev('topic'))
    expect(r.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(2)
  })
})
