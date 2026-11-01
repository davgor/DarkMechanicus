import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { GitResult } from '../../shared/git/api'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import { createGitHandlers, type GitHandlers } from './handlers'
import { createGitRunner } from './runner'

const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

/** Handlers over a repository merging `topic` into `main` with `a.txt` and `b.txt` both modified. */
function setup(): { handlers: GitHandlers; r: GitRepo; opened: string[] } {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  put(r.root, 'a.txt', 'base\n')
  put(r.root, 'b.txt', 'base\n')
  r.git('add', '-A')
  r.git('commit', '-q', '-m', 'base')
  r.branch('topic')
  put(r.root, 'a.txt', 'theirs\n')
  put(r.root, 'b.txt', 'theirs\n')
  r.git('commit', '-q', '-am', 'theirs')
  r.switchTo('main')
  put(r.root, 'a.txt', 'ours\n')
  put(r.root, 'b.txt', 'ours\n')
  r.git('commit', '-q', '-am', 'ours')
  expect(() => r.git('merge', '-q', 'topic')).toThrow()
  const opened: string[] = []
  const handlers = createGitHandlers({
    registry: { resolve: (folder) => (folder === r.root ? folder : null) },
    runner: createGitRunner(),
    trashItem: () => Promise.resolve(),
    openPath: (path) => {
      opened.push(path)
      return Promise.resolve('')
    },
    session: { getAccount: () => null, getToken: () => null },
    client: { listOpenPullRequests: () => Promise.reject(new Error('not used')) },
    onProgress: () => undefined,
    onUnexpectedError: (error) => {
      throw error
    }
  })
  return { handlers, r, opened }
}

function data<T>(result: GitResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  }
  return result.data
}

function code(result: GitResult<unknown>): string {
  if (result.ok) {
    throw new Error('expected a failure')
  }
  return result.error.code
}

describe('conflict handlers', () => {
  it('lists, resolves, refuses, marks resolved and commits the merge', async () => {
    const { handlers, r } = setup()
    expect(data(await handlers.getConflicts(r.root))).toMatchObject({ ourBranch: 'main', theirLabel: 'topic', files: [{ path: 'a.txt' }, { path: 'b.txt' }] })
    expect(code(await handlers.markResolved(r.root, { path: 'a.txt' }))).toBe('conflict_markers_remain')
    expect(code(await handlers.commitMerge(r.root, {}))).toBe('merge_conflicts')
    data(await handlers.resolveWith(r.root, { path: 'a.txt', side: 'theirs' }))
    put(r.root, 'b.txt', 'merged\n')
    data(await handlers.markResolved(r.root, { path: 'b.txt' }))
    const { oid } = data(await handlers.commitMerge(r.root, { summary: 'Merged', description: '' }))
    expect(r.rev('HEAD')).toBe(oid)
  })

  it('opens a conflicted file through the injected openPath, and nothing outside the repository', async () => {
    const { handlers, r, opened } = setup()
    data(await handlers.openInEditor(r.root, 'a.txt'))
    expect(code(await handlers.openInEditor(r.root, '../repo/a.txt'))).toBe('invalid_input')
    expect(code(await handlers.openInEditor(r.root, join(r.root, 'a.txt')))).toBe('invalid_input')
    expect(code(await handlers.openInEditor(r.root, 42))).toBe('invalid_input')
    expect(opened).toEqual([join(r.root, 'a.txt')])
  })

  it('aborts the merge', async () => {
    const { handlers, r } = setup()
    expect(code(await handlers.abortOperation(r.root))).toBe('invalid_input')
    expect(data(await handlers.abortMerge(r.root))).toMatchObject({ status: { inProgress: null, files: [] } })
  })

  it('validates every request and refuses untracked folders', async () => {
    const { handlers, r } = setup()
    expect(code(await handlers.getConflicts('/not/tracked'))).toBe('unauthorized')
    expect(code(await handlers.abortMerge('/not/tracked'))).toBe('unauthorized')
    expect(code(await handlers.resolveWith(r.root, { path: 'a.txt', side: 'both' }))).toBe('invalid_input')
    expect(code(await handlers.resolveWith(r.root, { path: 'a.txt', side: 'ours', extra: 1 }))).toBe('invalid_input')
    expect(code(await handlers.resolveWith(r.root, { path: '/etc/passwd', side: 'ours' }))).toBe('invalid_input')
    expect(code(await handlers.markResolved(r.root, { path: '' }))).toBe('invalid_input')
    expect(code(await handlers.commitMerge(r.root, { summary: 3 }))).toBe('invalid_input')
    expect(code(await handlers.commitMerge(r.root, null))).toBe('invalid_input')
  })
})
