import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileChange } from '../../shared/git/status'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { put } from '../../test/gitScratch'
import { discardFiles } from './discard'
import { GitInputError } from './errors'
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

/** A trash that records the name and content it was handed, at the moment it was handed it. */
function fakeTrash(): { trash(path: string): Promise<void>; items: Array<{ name: string; content: string }> } {
  const items: Array<{ name: string; content: string }> = []
  return {
    items,
    trash(path: string): Promise<void> {
      items.push({ name: path.replace(/^.*[\\/]/, ''), content: readFileSync(path, 'utf8') })
      rmSync(path)
      return Promise.resolve()
    }
  }
}

const change = (path: string, kind: FileChange['kind'], oldPath: string | null = null): FileChange => ({ path, oldPath, kind })

describe('discardFiles', () => {
  it('trashes a copy of a modified file and restores HEAD', async () => {
    const r = repo()
    writeFileSync(join(r.root, 'file-1.txt'), 'my edits\n')
    const trash = fakeTrash()
    const state = await discardFiles(runner, r.root, { files: [change('file-1.txt', 'modified')] }, trash.trash)
    expect(trash.items).toEqual([{ name: 'file-1.txt', content: 'my edits\n' }])
    expect(readFileSync(join(r.root, 'file-1.txt'), 'utf8')).toContain('initial commit')
    expect(state.kind === 'repository' && state.status.files).toEqual([])
  })

  it('restores a deleted file without trashing anything', async () => {
    const r = repo()
    r.git('rm', '-q', '--', 'file-1.txt')
    const trash = fakeTrash()
    await discardFiles(runner, r.root, { files: [change('file-1.txt', 'deleted')] }, trash.trash)
    expect(trash.items).toEqual([])
    expect(existsSync(join(r.root, 'file-1.txt'))).toBe(true)
    expect(r.git('status', '--porcelain')).toBe('')
  })

  it('trashes an untracked file', async () => {
    const r = repo()
    put(r.root, 'sub/new.txt', 'brand new\n')
    const trash = fakeTrash()
    await discardFiles(runner, r.root, { files: [change('sub/new.txt', 'untracked')] }, trash.trash)
    expect(trash.items).toEqual([{ name: 'new.txt', content: 'brand new\n' }])
  })
})

describe('discardFiles added and renamed files', () => {
  it('un-stages an added file and trashes it', async () => {
    const r = repo()
    put(r.root, 'added.txt', 'added\n')
    r.git('add', '--', 'added.txt')
    const trash = fakeTrash()
    await discardFiles(runner, r.root, { files: [change('added.txt', 'added')] }, trash.trash)
    expect(trash.items).toEqual([{ name: 'added.txt', content: 'added\n' }])
    expect(r.git('status', '--porcelain')).not.toContain('added.txt')
  })

  it('trashes the new file of a rename and restores the old path', async () => {
    const r = repo()
    const original = readFileSync(join(r.root, 'file-1.txt'), 'utf8')
    r.git('mv', 'file-1.txt', 'moved.txt')
    const trash = fakeTrash()
    await discardFiles(runner, r.root, { files: [change('moved.txt', 'renamed', 'file-1.txt')] }, trash.trash)
    expect(trash.items).toEqual([{ name: 'moved.txt', content: original }])
    expect(readFileSync(join(r.root, 'file-1.txt'), 'utf8')).toBe(original)
    expect(existsSync(join(r.root, 'moved.txt'))).toBe(false)
    expect(r.git('status', '--porcelain')).toBe('')
  })

  it('leaves files that were not chosen alone', async () => {
    const r = repo()
    writeFileSync(join(r.root, 'file-1.txt'), 'edit\n')
    put(r.root, 'keep.txt', 'keep\n')
    const trash = fakeTrash()
    await discardFiles(runner, r.root, { files: [change('file-1.txt', 'modified')] }, trash.trash)
    expect(readFileSync(join(r.root, 'keep.txt'), 'utf8')).toBe('keep\n')
  })

  it('refuses paths that are not in the status or that leave the repository, trashing nothing', async () => {
    const r = repo()
    writeFileSync(join(r.root, 'file-1.txt'), 'edit\n')
    const trash = fakeTrash()
    await expect(
      discardFiles(runner, r.root, { files: [change('file-1.txt', 'modified'), change('ghost.txt', 'untracked')] }, trash.trash)
    ).rejects.toBeInstanceOf(GitInputError)
    await expect(discardFiles(runner, r.root, { files: [change('../outside.txt', 'untracked')] }, trash.trash)).rejects.toBeInstanceOf(GitInputError)
    await expect(discardFiles(runner, r.root, { files: [] }, trash.trash)).rejects.toBeInstanceOf(GitInputError)
    expect(trash.items).toEqual([])
    expect(readFileSync(join(r.root, 'file-1.txt'), 'utf8')).toBe('edit\n')
  })
})
