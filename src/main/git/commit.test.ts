import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { removeScratch } from '../../test/removeScratch'
import { commitFiles, undoLastCommit } from './commit'
import { GitError, GitInputError } from './errors'
import { createGitRunner } from './runner'

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
  r.git('config', 'core.autocrlf', 'false')
  return r
}

function emptyRepo(): string {
  const dir = scratchDir()
  cleanups.push(dir.cleanup)
  gitIn(dir.path, 'init', '-q', '-b', 'main')
  gitIn(dir.path, 'config', 'user.name', 'Test')
  gitIn(dir.path, 'config', 'user.email', 'test@example.com')
  return dir.path
}

const file = (path: string, oldPath: string | null = null) => ({ path, oldPath })

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('commitFiles', () => {
  it('commits only the chosen files, even when another file was staged earlier', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    put(r.root, 'b.txt', 'b\n')
    put(r.root, 'c.txt', 'c\n')
    r.git('add', '--', 'b.txt')
    const { oid } = await commitFiles(runner, r.root, { summary: 'Add a', description: '', files: [file('a.txt')] })
    expect(oid).toBe(r.rev('HEAD'))
    expect(r.git('show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual(['a.txt'])
    const status = r.git('status', '--porcelain')
    expect(status).toContain('?? b.txt')
    expect(status).toContain('?? c.txt')
    expect(status).not.toContain('A  b.txt')
  })

  it('commits a rename with both paths', async () => {
    const r = repo()
    r.git('mv', 'file-1.txt', 'renamed.txt')
    await commitFiles(runner, r.root, { summary: 'Rename', description: '', files: [file('renamed.txt', 'file-1.txt')] })
    expect(r.git('show', '--name-status', '--format=', 'HEAD')).toMatch(/^R\d+\s+file-1\.txt\s+renamed\.txt$/)
    expect(r.git('status', '--porcelain')).toBe('')
  })

  it('commits a deletion', async () => {
    const r = repo()
    r.git('rm', '-q', '-f', '--', 'file-1.txt')
    await commitFiles(runner, r.root, { summary: 'Delete', description: '', files: [file('file-1.txt')] })
    expect(r.git('show', '--name-status', '--format=', 'HEAD')).toBe('D\tfile-1.txt')
  })

  it('makes the first commit of an unborn repository', async () => {
    const root = emptyRepo()
    put(root, 'a.txt', 'a\n')
    put(root, 'b.txt', 'b\n')
    gitIn(root, 'add', '--', 'b.txt')
    const { oid } = await commitFiles(runner, root, { summary: 'First', description: '', files: [file('a.txt')] })
    expect(oid).toBe(gitIn(root, 'rev-parse', 'HEAD').trim())
    expect(gitIn(root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('a.txt')
  })
})

describe('commitFiles messages and refusals', () => {
  it('writes a summary-only message', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    await commitFiles(runner, r.root, { summary: '  Just a summary  ', description: '  \n', files: [file('a.txt')] })
    expect(r.git('log', '-1', '--format=%B')).toBe('Just a summary')
  })

  it('writes the summary, a blank line and the description', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    await commitFiles(runner, r.root, { summary: 'Title', description: '\nLine one\nLine two\n\n', files: [file('a.txt')] })
    expect(r.git('log', '-1', '--format=%B')).toBe('Title\n\nLine one\nLine two')
  })

  it('refuses an empty summary and an empty file list with invalid_input', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    const head = r.rev('HEAD')
    expect(await rejection(commitFiles(runner, r.root, { summary: '  ', description: '', files: [file('a.txt')] }))).toBeInstanceOf(GitInputError)
    expect(await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files: [] }))).toBeInstanceOf(GitInputError)
    expect(r.rev('HEAD')).toBe(head)
  })
})

describe('commitFiles guards', () => {
  it('refuses paths that are not in the current status, or that leave the repository', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    expect(await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files: [file('file-1.txt')] }))).toBeInstanceOf(GitInputError)
    expect(await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files: [file('../a.txt')] }))).toBeInstanceOf(GitInputError)
    expect(await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files: [file('a.txt', 'nope.txt')] }))).toBeInstanceOf(GitInputError)
  })

  it('refuses while a merge is in progress with operation_in_progress', async () => {
    const r = repo()
    r.branch('other')
    put(r.root, 'm.txt', 'other\n')
    r.git('add', '--', 'm.txt')
    r.git('commit', '-q', '-m', 'other')
    r.switchTo('main')
    put(r.root, 'm.txt', 'main\n')
    r.git('add', '--', 'm.txt')
    r.git('commit', '-q', '-m', 'main')
    expect(() => r.git('merge', 'other')).toThrow()
    const error = await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files: [file('m.txt')] }))
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('operation_in_progress')
  })

  it('returns git_failed with the hook output when pre-commit fails', async () => {
    const r = repo()
    const hook = join(r.root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    put(r.root, 'a.txt', 'a\n')
    const head = r.rev('HEAD')
    const error = await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files: [file('a.txt')] }))
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('git_failed')
    expect((error as GitError).detail).toContain('hook says no')
    expect(r.rev('HEAD')).toBe(head)
  })
})

describe('undoLastCommit', () => {
  it('puts the changes back and returns the message', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    await commitFiles(runner, r.root, { summary: 'Title', description: 'Body text', files: [file('a.txt')] })
    const before = r.git('rev-parse', 'HEAD~1')
    const message = await undoLastCommit(runner, r.root)
    expect(message).toEqual({ summary: 'Title', description: 'Body text' })
    expect(r.rev('HEAD')).toBe(before)
    expect(readFileSync(join(r.root, 'a.txt'), 'utf8')).toBe('a\n')
    expect(r.git('status', '--porcelain')).toContain('a.txt')
  })

  it('undoes the root commit', async () => {
    const root = emptyRepo()
    put(root, 'a.txt', 'a\n')
    await commitFiles(runner, root, { summary: 'First', description: '', files: [file('a.txt')] })
    expect(await undoLastCommit(runner, root)).toEqual({ summary: 'First', description: '' })
    expect(() => gitIn(root, 'rev-parse', '--verify', '-q', 'HEAD')).toThrow()
    expect(gitIn(root, 'status', '--porcelain')).toContain('a.txt')
  })

  it('is refused once the commit is on a remote branch', async () => {
    const r = repo()
    const bare = mkdtempSync(join(tmpdir(), 'dm-bare-'))
    cleanups.push(() => removeScratch(bare))
    gitIn(bare, 'init', '-q', '--bare')
    r.git('remote', 'add', 'origin', bare)
    r.git('push', '-q', 'origin', 'main')
    const error = await rejection(undoLastCommit(runner, r.root))
    expect(error).toBeInstanceOf(GitInputError)
    expect((error as Error).message).toMatch(/already pushed/)
  })

  it('is refused for a merge commit', async () => {
    const r = repo()
    r.branch('other')
    r.commit('on other')
    r.switchTo('main')
    r.commit('on main')
    r.merge('other')
    const error = await rejection(undoLastCommit(runner, r.root))
    expect(error).toBeInstanceOf(GitInputError)
    expect((error as Error).message).toMatch(/merge commit/)
  })

  it('is refused when there are no commits', async () => {
    const root = emptyRepo()
    const error = await rejection(undoLastCommit(runner, root))
    expect(error).toBeInstanceOf(GitInputError)
    expect((error as Error).message).toMatch(/no commits/)
  })
})
