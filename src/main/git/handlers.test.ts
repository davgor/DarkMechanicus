import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitResult } from '../../shared/git/api'
import { createGitRepo } from '../../test/gitRepo'
import { put, scratchDir } from '../../test/gitScratch'
import { GitError } from './errors'
import { createGitHandlers, type GitHandlers } from './handlers'
import { createGitRunner, type GitRunner } from './runner'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function setup(runner: GitRunner = createGitRunner()): { handlers: GitHandlers; track(path: string): void; unexpected: unknown[]; trashed: string[] } {
  const trashed: string[] = []
  const tracked = new Set<string>()
  const unexpected: unknown[] = []
  const handlers = createGitHandlers({
    registry: { resolve: (folder) => (tracked.has(folder) ? folder : null) },
    runner,
    trashItem: (path) => {
      trashed.push(path)
      return Promise.resolve()
    },
    onUnexpectedError: (error) => unexpected.push(error)
  })
  return { handlers, track: (path) => tracked.add(path), unexpected, trashed }
}

function failure(result: GitResult<unknown>): { code: string; message: string; detail?: string } {
  if (result.ok) {
    throw new Error('expected a failure')
  }
  return result.error
}

function plainFolder(): string {
  const dir = scratchDir()
  cleanups.push(dir.cleanup)
  return dir.path
}

function repo(): ReturnType<typeof createGitRepo> {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  return r
}

const request = (path: string) => ({ path, oldPath: null, kind: 'modified' as const })

describe('getState', () => {
  it('returns the state of a tracked repository', async () => {
    const r = repo()
    put(r.root, 'new.txt', 'hi\n')
    const { handlers, track } = setup()
    track(r.root)
    const result = await handlers.getState(r.root)
    expect(result.ok && result.data.kind === 'repository' && result.data.status.files.map((f) => f.path)).toContain('new.txt')
  })

  it('reports a tracked plain folder as not_repository', async () => {
    const folder = plainFolder()
    const { handlers, track } = setup()
    track(folder)
    expect(await handlers.getState(folder)).toEqual({ ok: true, data: { kind: 'not_repository' } })
  })

  it('refuses an untracked folder as unauthorized', async () => {
    const r = repo()
    const { handlers } = setup()
    expect(failure(await handlers.getState(r.root)).code).toBe('unauthorized')
  })

  it.each([[undefined], [null], [''], [42], [{}]])('refuses malformed folder %j as invalid_input', async (bad) => {
    const { handlers } = setup()
    expect(failure(await handlers.getState(bad)).code).toBe('invalid_input')
  })
})

describe('getWorkingDiff', () => {
  it('returns the diff of a changed file in a tracked repository', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'one\n')
    r.git('add', 'a.txt')
    r.git('commit', '-m', 'a')
    put(r.root, 'a.txt', 'two\n')
    const { handlers, track } = setup()
    track(r.root)
    const result = await handlers.getWorkingDiff(r.root, request('a.txt'))
    expect(result.ok && result.data.kind).toBe('text')
  })

  it('refuses an untracked folder as unauthorized', async () => {
    const r = repo()
    const { handlers } = setup()
    expect(failure(await handlers.getWorkingDiff(r.root, request('a.txt'))).code).toBe('unauthorized')
  })

})

describe('getWorkingDiff path checks', () => {
  it.each([
    ['an absolute posix path', '/etc/passwd'],
    ['a drive path', 'C:\\Windows\\win.ini'],
    ['a path leaving the repository', '../outside.txt'],
    ['a nested escape', 'a/../../outside.txt'],
    ['an empty path', ''],
    ['a NUL path', 'a\u0000b']
  ])('refuses %s as invalid_input', async (_name, path) => {
    const r = repo()
    const { handlers, track } = setup()
    track(r.root)
    expect(failure(await handlers.getWorkingDiff(r.root, request(path))).code).toBe('invalid_input')
  })

  it('refuses a bad oldPath as invalid_input', async () => {
    const r = repo()
    const { handlers, track } = setup()
    track(r.root)
    const bad = { path: 'a.txt', oldPath: '../x', kind: 'renamed' }
    expect(failure(await handlers.getWorkingDiff(r.root, bad)).code).toBe('invalid_input')
  })

  it.each([[undefined], [{}], [{ path: 'a', oldPath: null, kind: 'bogus' }], [{ path: 'a', oldPath: null, kind: 'modified', extra: 1 }]])(
    'refuses malformed request %j as invalid_input',
    async (bad) => {
      const r = repo()
      const { handlers, track } = setup()
      track(r.root)
      expect(failure(await handlers.getWorkingDiff(r.root, bad)).code).toBe('invalid_input')
    }
  )

  it('reports a tracked plain folder as not_repository', async () => {
    const folder = plainFolder()
    const { handlers, track } = setup()
    track(folder)
    expect(failure(await handlers.getWorkingDiff(folder, request('a.txt'))).code).toBe('not_repository')
  })
})

describe('initRepository', () => {
  it('initializes a tracked plain folder and returns the new state', async () => {
    const folder = plainFolder()
    const { handlers, track } = setup()
    track(folder)
    const result = await handlers.initRepository(folder)
    expect(result.ok && result.data.kind).toBe('repository')
    expect(existsSync(join(folder, '.git'))).toBe(true)
  })

  it('refuses a folder already inside a repository, and a subfolder of one', async () => {
    const r = repo()
    put(r.root, 'sub/x.txt', 'x')
    const { handlers, track } = setup()
    track(r.root)
    track(join(r.root, 'sub'))
    expect(failure(await handlers.initRepository(r.root)).code).toBe('invalid_input')
    expect(failure(await handlers.initRepository(join(r.root, 'sub'))).code).toBe('invalid_input')
    expect(existsSync(join(r.root, 'sub', '.git'))).toBe(false)
  })

  it('refuses an untracked folder as unauthorized and creates nothing', async () => {
    const folder = plainFolder()
    const { handlers } = setup()
    expect(failure(await handlers.initRepository(folder)).code).toBe('unauthorized')
    expect(existsSync(join(folder, '.git'))).toBe(false)
  })
})

describe('error mapping', () => {
  it('maps a GitError to its code and detail', async () => {
    const runner: GitRunner = { run: () => Promise.reject(new GitError('index_locked', 'lock file')) }
    const { handlers, track, unexpected } = setup(runner)
    track('/f')
    const error = failure(await handlers.getState('/f'))
    expect(error).toMatchObject({ code: 'index_locked', detail: 'lock file' })
    expect(unexpected).toEqual([])
  })

  it('logs an unexpected error and returns git_failed without a stack', async () => {
    const boom = new Error('boom at C:\\secret\\path')
    const runner: GitRunner = { run: () => Promise.reject(boom) }
    const { handlers, track, unexpected } = setup(runner)
    track('/f')
    const result = await handlers.getState('/f')
    expect(failure(result).code).toBe('git_failed')
    expect(JSON.stringify(result)).not.toMatch(/secret/)
    expect(unexpected).toEqual([boom])
  })

  it('never throws, even when onUnexpectedError does', async () => {
    const runner: GitRunner = { run: () => Promise.reject(new Error('x')) }
    const handlers = createGitHandlers({
      registry: { resolve: (f) => f },
      runner,
      trashItem: () => Promise.resolve(),
      onUnexpectedError: () => {
        throw new Error('logger down')
      }
    })
    expect(failure(await handlers.getState('/f')).code).toBe('git_failed')
  })
})

describe('history handlers', () => {
  it('returns history, the files of a commit and a file diff for a tracked repository', async () => {
    const r = repo()
    const oid = r.rev('HEAD')
    const { handlers, track } = setup()
    track(r.root)
    const history = await handlers.getHistory(r.root, { skip: 0, limit: 100 })
    expect(history.ok && history.data.commits.map((c) => c.oid)).toEqual([oid])
    const files = await handlers.getCommitFiles(r.root, oid)
    expect(files.ok && files.data).toEqual([{ path: 'file-1.txt', oldPath: null, kind: 'added' }])
    const diff = await handlers.getCommitDiff(r.root, { oid, path: 'file-1.txt', oldPath: null })
    expect(diff.ok && diff.data.kind).toBe('text')
  })

  it('refuses an untracked folder as unauthorized', async () => {
    const r = repo()
    const oid = r.rev('HEAD')
    const { handlers } = setup()
    expect(failure(await handlers.getHistory(r.root, { skip: 0, limit: 10 })).code).toBe('unauthorized')
    expect(failure(await handlers.getCommitFiles(r.root, oid)).code).toBe('unauthorized')
    expect(failure(await handlers.getCommitDiff(r.root, { oid, path: 'a', oldPath: null })).code).toBe('unauthorized')
  })

  it.each([['an option'], ['--output=x'], ['HEAD'], ['abc'], [''], ['g'.repeat(40)], ['a'.repeat(65)]])('refuses oid %j as invalid_input', async (oid) => {
    const r = repo()
    const { handlers, track } = setup()
    track(r.root)
    expect(failure(await handlers.getCommitFiles(r.root, oid)).code).toBe('invalid_input')
    expect(failure(await handlers.getCommitDiff(r.root, { oid, path: 'a', oldPath: null })).code).toBe('invalid_input')
  })

  it.each([[{ skip: 0, limit: 201 }], [{ skip: -1, limit: 10 }], [{ skip: 0 }], [{ skip: 0, limit: 10, extra: 1 }], [undefined]])('refuses history request %j as invalid_input', async (bad) => {
    const r = repo()
    const { handlers, track } = setup()
    track(r.root)
    expect(failure(await handlers.getHistory(r.root, bad)).code).toBe('invalid_input')
  })

  it('refuses paths that leave the repository, and reports a plain folder as not_repository', async () => {
    const r = repo()
    const { handlers, track } = setup()
    track(r.root)
    const oid = r.rev('HEAD')
    expect(failure(await handlers.getCommitDiff(r.root, { oid, path: '../x', oldPath: null })).code).toBe('invalid_input')
    expect(failure(await handlers.getCommitDiff(r.root, { oid, path: 'a', oldPath: '/etc/passwd' })).code).toBe('invalid_input')
    const folder = plainFolder()
    track(folder)
    expect(failure(await handlers.getHistory(folder, { skip: 0, limit: 10 })).code).toBe('not_repository')
  })
})
