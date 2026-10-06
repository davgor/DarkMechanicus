import { afterEach, describe, expect, it } from 'vitest'
import type { GitResult } from '../../shared/git/api'
import { createGitRepo } from '../../test/gitRepo'
import { put, scratchDir } from '../../test/gitScratch'
import { createGitHandlers, type GitHandlers } from './handlers'
import { createGitRunner } from './runner'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function setup(): { handlers: GitHandlers; track(path: string): void; trashed: string[] } {
  const tracked = new Set<string>()
  const trashed: string[] = []
  const handlers = createGitHandlers({
    registry: { resolve: (folder) => (tracked.has(folder) ? folder : null) },
    runner: createGitRunner(),
    trashItem: (path) => {
      trashed.push(path)
      return Promise.resolve()
    },
    onUnexpectedError: (error) => {
      throw error
    }
  })
  return { handlers, track: (path) => tracked.add(path), trashed }
}

function failure(result: GitResult<unknown>): { code: string; message: string; detail?: string } {
  if (result.ok) {
    throw new Error('expected a failure')
  }
  return result.error
}

function repo(): ReturnType<typeof createGitRepo> {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  r.git('config', 'core.autocrlf', 'false')
  return r
}

describe('commit, undoLastCommit and discardChanges handlers', () => {
  it('commits the chosen files, then undoes the commit and returns its message', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    put(r.root, 'b.txt', 'b\n')
    const { handlers, track } = setup()
    track(r.root)
    const committed = await handlers.commit(r.root, { summary: 'Add a', description: 'why', files: [{ path: 'a.txt', oldPath: null }] })
    expect(committed.ok && committed.data.oid).toBe(r.rev('HEAD'))
    expect(await handlers.undoLastCommit(r.root)).toEqual({ ok: true, data: { summary: 'Add a', description: 'why' } })
  })

  it('maps an empty summary, an empty list and a malformed request to invalid_input', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    const { handlers, track } = setup()
    track(r.root)
    const files = [{ path: 'a.txt', oldPath: null }]
    expect(failure(await handlers.commit(r.root, { summary: ' ', description: '', files })).code).toBe('invalid_input')
    expect(failure(await handlers.commit(r.root, { summary: 'x', description: '', files: [] })).code).toBe('invalid_input')
    expect(failure(await handlers.commit(r.root, { summary: 'x', files })).code).toBe('invalid_input')
  })
})

describe('write handlers refusals', () => {
  it('refuses paths outside the repository and paths that are not changed, trashing nothing', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    const { handlers, track, trashed } = setup()
    track(r.root)
    for (const path of ['../a.txt', 'nope.txt', 'C:/Windows/x', '/etc/passwd']) {
      expect(failure(await handlers.commit(r.root, { summary: 'x', description: '', files: [{ path, oldPath: null }] })).code).toBe('invalid_input')
      expect(failure(await handlers.discardChanges(r.root, { files: [{ path, oldPath: null, kind: 'untracked' }] })).code).toBe('invalid_input')
    }
    expect(trashed).toEqual([])
  })

  it('discards through the injected trash', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'a\n')
    const { handlers, track, trashed } = setup()
    track(r.root)
    const result = await handlers.discardChanges(r.root, { files: [{ path: 'a.txt', oldPath: null, kind: 'untracked' }] })
    expect(result.ok).toBe(true)
    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toMatch(/a\.txt$/)
  })

  it('refuses untracked folders as unauthorized, touching nothing', async () => {
    const dir = scratchDir()
    cleanups.push(dir.cleanup)
    const { handlers, trashed } = setup()
    const files = [{ path: 'a', oldPath: null }]
    expect(failure(await handlers.commit(dir.path, { summary: 'x', description: '', files })).code).toBe('unauthorized')
    expect(failure(await handlers.undoLastCommit(dir.path)).code).toBe('unauthorized')
    expect(failure(await handlers.discardChanges(dir.path, { files: [{ path: 'a', oldPath: null, kind: 'untracked' }] })).code).toBe('unauthorized')
    expect(trashed).toEqual([])
  })
})
