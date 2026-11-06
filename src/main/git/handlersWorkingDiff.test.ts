/** `git:getWorkingDiff` reads only paths git reports, with the kind and old path from status, never outside the repository. */
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitResult } from '../../shared/git/api'
import type { FileDiff } from '../../shared/git/diff'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { put, scratchDir } from '../../test/gitScratch'
import { linkDirectory } from '../../test/tempRepo'
import { canCreateFileSymlinks } from '../../test/symlinks'
import { findInStatus, requireStatus } from './commit'
import { readWorkingDiff } from './diff'
import { createGitHandlers, type GitHandlers } from './handlers'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

const runner = createGitRunner()

/** Handlers over the real runner, recording requests; `extraUntracked` is appended to what `git status` reports. */
function setup(root: string, extraUntracked: string[] = []): { handlers: GitHandlers; requests: GitRunRequest[] } {
  const requests: GitRunRequest[] = []
  const recording: GitRunner = {
    run: async (request) => {
      requests.push(request)
      const result = await runner.run(request)
      const extra = request.args[0] === 'status' ? extraUntracked.map((path) => `? ${path}\0`).join('') : ''
      return { ...result, stdout: result.stdout + extra }
    }
  }
  const handlers = createGitHandlers({
    registry: { resolve: (folder) => (folder === root ? folder : null) },
    runner: recording,
    trashItem: () => Promise.resolve(),
    openPath: () => Promise.resolve(''),
    session: { getAccount: () => null, getToken: () => null },
    client: { listOpenPullRequests: () => Promise.reject(new Error('not used')) },
    onProgress: () => undefined,
    onUnexpectedError: (error) => {
      throw error
    }
  })
  return { handlers, requests }
}

function repo(): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  r.git('config', 'core.autocrlf', 'false')
  return r
}

function outside(): string {
  const dir = scratchDir()
  cleanups.push(dir.cleanup)
  return dir.path
}

// A small stand-in for the file system root: a junction to C: makes git walk the whole drive when it scans for untracked files.
function fakeRoot(): string {
  const root = outside()
  put(root, 'etc/hosts', 'localhost 127.0.0.1\n')
  return root
}

function failure(result: GitResult<unknown>): { code: string; message: string } {
  if (result.ok) {
    throw new Error('expected a failure')
  }
  return result.error
}

function data(result: GitResult<FileDiff>): FileDiff {
  if (!result.ok) {
    throw new Error(`expected a diff, got ${result.error.code}: ${result.error.message}`)
  }
  return result.data
}

const diffRuns = (requests: GitRunRequest[]): GitRunRequest[] => requests.filter((request) => request.args[0] === 'diff')

describe('getWorkingDiff through a symlinked directory', () => {
  it('refuses l/etc/hosts when l -> / and returns no file content', async () => {
    const r = repo()
    linkDirectory(fakeRoot(), join(r.root, 'l'))
    const { handlers, requests } = setup(r.root)
    for (const kind of ['untracked', 'modified', 'added'] as const) {
      const result = await handlers.getWorkingDiff(r.root, { path: 'l/etc/hosts', oldPath: null, kind })
      expect(failure(result).code).toBe('invalid_input')
      expect(JSON.stringify(result)).not.toContain('localhost')
    }
    expect(diffRuns(requests)).toEqual([])
  })

  it('refuses a file under a symlink to a folder outside the repository', async () => {
    const r = repo()
    const secret = outside()
    put(secret, 'secret.txt', 'top secret\n')
    linkDirectory(secret, join(r.root, 's'))
    const { handlers, requests } = setup(r.root)
    const result = await handlers.getWorkingDiff(r.root, { path: 's/secret.txt', oldPath: null, kind: 'untracked' })
    expect(failure(result).code).toBe('invalid_input')
    expect(JSON.stringify(result)).not.toContain('top secret')
    expect(diffRuns(requests)).toEqual([])
  })

  it('refuses an untracked path whose parent folder really lies outside the repository, even if status reports it', async () => {
    const r = repo()
    const secret = outside()
    put(secret, 'secret.txt', 'top secret\n')
    linkDirectory(secret, join(r.root, 's'))
    linkDirectory(fakeRoot(), join(r.root, 'l'))
    const { handlers, requests } = setup(r.root, ['s/secret.txt', 'l/etc/hosts'])
    for (const path of ['s/secret.txt', 'l/etc/hosts']) {
      const result = await handlers.getWorkingDiff(r.root, { path, oldPath: null, kind: 'untracked' })
      expect(failure(result).code).toBe('invalid_input')
      expect(JSON.stringify(result)).not.toMatch(/top secret|localhost/)
    }
    expect(diffRuns(requests)).toEqual([])
  })

  it.skipIf(!canCreateFileSymlinks())('diffs an untracked out -> /etc/hosts as a symlink showing only its target path (needs file symlink rights)', async () => {
    const r = repo()
    symlinkSync('/etc/hosts', join(r.root, 'out'))
    const { handlers } = setup(r.root)
    const result = await handlers.getWorkingDiff(r.root, { path: 'out', oldPath: null, kind: 'untracked' })
    const diff = data(result)
    expect(diff.kind).toBe('text')
    expect(diff.newMode).toBe('120000')
    expect(JSON.stringify(result)).toContain('/etc/hosts')
    expect(JSON.stringify(result)).not.toContain('localhost')
  })
})

// A junction on Windows, which needs no privilege to make; a symlink elsewhere.
describe('getWorkingDiff through a linked folder', () => {
  it('refuses an untracked file under a linked folder that holds no such subfolder, even if status reports it', async () => {
    const r = repo()
    // As l -> C:\ is on Windows: C:\ holds no etc, so l/etc/hosts has no real folder at all.
    linkDirectory(outside(), join(r.root, 'l'))
    const { handlers, requests } = setup(r.root, ['l/etc/hosts'])
    const result = await handlers.getWorkingDiff(r.root, { path: 'l/etc/hosts', oldPath: null, kind: 'untracked' })
    expect(failure(result).code).toBe('invalid_input')
    expect(diffRuns(requests)).toEqual([])
  })
})

describe('getWorkingDiff takes the path from status', () => {
  it('refuses a path git does not report before any diff runs', async () => {
    const r = repo()
    put(r.root, 'real.txt', 'real\n')
    const { handlers, requests } = setup(r.root)
    for (const path of ['ghost.txt', 'file-1.txt']) {
      for (const kind of ['modified', 'untracked'] as const) {
        expect(failure(await handlers.getWorkingDiff(r.root, { path, oldPath: null, kind })).code).toBe('invalid_input')
      }
    }
    expect(diffRuns(requests)).toEqual([])
  })

  it("uses a renamed file's oldPath from status, whatever the request says", async () => {
    const r = repo()
    r.git('mv', 'file-1.txt', 'moved.txt')
    const { handlers } = setup(r.root)
    for (const oldPath of [null, 'other.txt']) {
      const diff = data(await handlers.getWorkingDiff(r.root, { path: 'moved.txt', oldPath, kind: 'modified' }))
      expect(diff.oldPath).toBe('file-1.txt')
      expect(diff.path).toBe('moved.txt')
    }
  })

  it('uses the kind from status, whatever the request says', async () => {
    const r = repo()
    put(r.root, 'file-1.txt', 'changed\n')
    const { handlers, requests } = setup(r.root)
    const asUntracked = data(await handlers.getWorkingDiff(r.root, { path: 'file-1.txt', oldPath: null, kind: 'untracked' }))
    const expected = await readWorkingDiff(runner, r.root, findInStatus(await requireStatus(runner, r.root), 'file-1.txt'))
    expect(asUntracked).toEqual(expected)
    expect(diffRuns(requests).every((request) => !request.args.includes('--no-index'))).toBe(true)
  })
})

describe('getWorkingDiff diffs are unchanged', () => {
  function changes(r: GitRepo): void {
    put(r.root, 'keep.txt', 'keep\n')
    put(r.root, 'gone.txt', 'gone\n')
    put(r.root, 'old-name.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n')
    r.git('add', '.')
    r.git('commit', '-m', 'more')
    put(r.root, 'file-1.txt', 'edited\n')
    put(r.root, 'added.txt', 'added\n')
    r.git('add', 'added.txt')
    r.git('rm', '-q', 'gone.txt')
    r.git('mv', 'old-name.txt', 'new-name.txt')
    put(r.root, 'new-name.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n')
    put(r.root, 'sub/new.txt', 'brand new\n')
  }

  it.each([
    ['modified', 'file-1.txt'],
    ['added', 'added.txt'],
    ['deleted', 'gone.txt'],
    ['renamed', 'new-name.txt'],
    ['untracked', 'sub/new.txt']
  ])('returns the %s diff of %s as before', async (kind, path) => {
    const r = repo()
    changes(r)
    const entry = findInStatus(await requireStatus(runner, r.root), path)
    expect(entry.kind).toBe(kind)
    const { handlers } = setup(r.root)
    const diff = data(await handlers.getWorkingDiff(r.root, { path, oldPath: entry.oldPath, kind: entry.kind }))
    expect(diff.kind).toBe('text')
    expect(diff).toEqual(await readWorkingDiff(runner, r.root, entry))
  })

  it('keeps force raising the size limit', async () => {
    const r = repo()
    put(r.root, 'big.txt', 'x'.repeat(99).concat('\n').repeat(30_000))
    const { handlers } = setup(r.root)
    const request = { path: 'big.txt', oldPath: null, kind: 'untracked' as const }
    expect(data(await handlers.getWorkingDiff(r.root, request)).kind).toBe('too_large')
    expect(data(await handlers.getWorkingDiff(r.root, { ...request, force: true })).kind).toBe('text')
  })
})
