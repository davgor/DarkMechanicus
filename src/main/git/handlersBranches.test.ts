import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function setup(): { handlers: GitHandlers; r: GitRepo } {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  const handlers = createGitHandlers({
    registry: { resolve: (folder) => (folder === r.root ? folder : null) },
    runner: createGitRunner(),
    trashItem: () => Promise.resolve(),
    openPath: () => Promise.resolve(''),
    session: { getAccount: () => null, getToken: () => null },
    onProgress: () => undefined,
    onUnexpectedError: (error) => {
      throw error
    }
  })
  return { handlers, r }
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

describe('branch and stash handlers', () => {
  it('checks branch names', async () => {
    const { handlers, r } = setup()
    expect(data(await handlers.checkBranchName(r.root, 'feature/a'))).toEqual({ valid: true, normalized: 'feature/a' })
    expect(data(await handlers.checkBranchName(r.root, 'a..b'))).toEqual({ valid: false, normalized: null })
  })

  it('creates a branch, switches away leaving a stash, comes back and restores it', async () => {
    const { handlers, r } = setup()
    data(await handlers.createBranch(r.root, { name: 'topic', startPoint: 'current' }))
    r.commit('topic work')
    put(r.root, 'file-1.txt', 'wip\n')
    data(await handlers.switchBranch(r.root, { name: 'main', uncommitted: 'stash' }))
    data(await handlers.switchBranch(r.root, { name: 'topic', uncommitted: 'bring' }))
    const [stash] = data(await handlers.listStashes(r.root))
    expect(stash).toMatchObject({ ref: 'stash@{0}', branch: 'topic', files: [{ path: 'file-1.txt', oldPath: null, kind: 'modified' }] })
    data(await handlers.restoreStash(r.root, 'stash@{0}'))
    expect(data(await handlers.listStashes(r.root))).toEqual([])
    expect(r.git('status', '--porcelain')).toBe('M file-1.txt')
  })

  it('renames, merges and deletes a branch in a tracked repository', async () => {
    const { handlers, r } = setup()
    r.branch('topic')
    r.commit('topic work')
    data(await handlers.renameBranch(r.root, { from: 'topic', to: 'feature' }))
    data(await handlers.switchBranch(r.root, { name: 'main', uncommitted: 'bring' }))
    data(await handlers.mergeIntoCurrent(r.root, { branch: 'feature' }))
    data(await handlers.deleteBranch(r.root, { name: 'feature', deleteRemote: false, force: false }))
    const list = data(await handlers.listBranches(r.root))
    expect(list).toMatchObject({ current: 'main', defaultBranch: 'main' })
    expect(list.branches.map((branch) => branch.name)).toEqual(['main'])
  })

  it('discards a stash', async () => {
    const { handlers, r } = setup()
    r.git('branch', 'other')
    put(r.root, 'file-1.txt', 'wip\n')
    data(await handlers.switchBranch(r.root, { name: 'other', uncommitted: 'stash' }))
    data(await handlers.switchBranch(r.root, { name: 'main', uncommitted: 'bring' }))
    data(await handlers.discardStash(r.root, 'stash@{0}'))
    expect(data(await handlers.listStashes(r.root))).toEqual([])
  })
})

describe('branch and stash handler refusals', () => {
  it('maps git refusals to their codes and bad names to invalid_input', async () => {
    const { handlers, r } = setup()
    r.git('branch', 'taken')
    expect(code(await handlers.createBranch(r.root, { name: 'taken', startPoint: 'current' }))).toBe('branch_exists')
    expect(code(await handlers.createBranch(r.root, { name: '-f', startPoint: 'current' }))).toBe('invalid_input')
    expect(code(await handlers.switchBranch(r.root, { name: '@{-1}', uncommitted: 'bring' }))).toBe('invalid_input')
    expect(code(await handlers.deleteBranch(r.root, { name: 'main', deleteRemote: false, force: true }))).toBe('invalid_input')
    expect(code(await handlers.restoreStash(r.root, 'stash@{0}; rm -rf'))).toBe('invalid_input')
  })

  it('refuses untracked folders and malformed requests', async () => {
    const { handlers, r } = setup()
    expect(code(await handlers.listBranches('/elsewhere'))).toBe('unauthorized')
    expect(code(await handlers.listStashes('/elsewhere'))).toBe('unauthorized')
    expect(code(await handlers.createBranch('/elsewhere', { name: 'x', startPoint: 'current' }))).toBe('unauthorized')
    const malformed: Array<[keyof GitHandlers, unknown]> = [
      ['checkBranchName', 7],
      ['checkBranchName', 'x'.repeat(5000)],
      ['createBranch', { name: 'x', startPoint: 'elsewhere' }],
      ['createBranch', { name: 'x' }],
      ['switchBranch', { name: 'x', uncommitted: 'discard' }],
      ['renameBranch', { from: 'x' }],
      ['deleteBranch', { name: 'x', deleteRemote: false }],
      ['deleteBranch', { name: 'x', deleteRemote: false, force: false, extra: 1 }],
      ['mergeIntoCurrent', { branch: 3 }],
      ['restoreStash', 5],
      ['discardStash', null]
    ]
    for (const [method, request] of malformed) {
      const call = handlers[method] as (folder: unknown, request: unknown) => Promise<GitResult<unknown>>
      expect(code(await call(r.root, request)), `${method} ${JSON.stringify(request).slice(0, 60)}`).toBe('invalid_input')
    }
  })
})
