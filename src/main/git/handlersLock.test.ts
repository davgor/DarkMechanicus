/**
 * The per-repository operation lock, on real repositories: a write handler waits for the operation ahead of it and
 * then checks the repository as that one left it; reads and cancel never wait. A gated runner forces the order.
 */
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitResult } from '../../shared/git/api'
import { gatedRunner } from '../../test/gatedRunner'
import { isolateGitConfig, remoteRepos, teammatePushes } from '../../test/gitRemotes'
import { put, scratchDir } from '../../test/gitScratch'
import { createGitHandlers, type GitHandlers } from './handlers'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'

const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

/**
 * Long enough for an unlocked handler to read, check and write; a locked one must still be waiting after it. A real
 * wait: the handlers run real git processes, so fake timers cannot stand in, and "not yet" has no event to await.
 * The end states asserted afterwards fail without the lock on their own; this only shows the wait.
 */
const SETTLE_MS = 400

function handlersFor(root: string, runner: GitRunner): GitHandlers {
  return createGitHandlers({
    registry: { resolve: (folder) => (folder === root ? folder : null) },
    runner,
    trashItem: () => Promise.resolve(),
    openPath: () => Promise.resolve(''),
    session: { getAccount: () => null, getToken: () => null },
    client: { listOpenPullRequests: () => Promise.resolve([]) },
    onProgress: () => undefined,
    onUnexpectedError: (error) => {
      throw error
    }
  })
}

function code(result: GitResult<unknown>): string {
  if (result.ok) {
    throw new Error('expected a failure')
  }
  return result.error.code
}

function ok<T>(result: GitResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  }
  return result.data
}

/** Whether `promise` has settled, checked after `ms`. */
async function settledAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  await new Promise((resolve) => setTimeout(resolve, ms))
  return settled
}

const isCommand = (name: string) => (request: GitRunRequest) => request.args.includes(name)
const note = { summary: 'note', description: '', files: [{ path: 'note.txt', oldPath: null }] }

describe('a commit started while a conflicting pull runs', () => {
  it('waits for the pull, then is refused with the merge left intact', async () => {
    const { local, other } = remoteRepos(cleanups)
    teammatePushes(other, 'shared.txt')
    put(local.root, 'shared.txt', 'mine\n')
    local.git('add', '.')
    const mine = local.commit('mine')
    put(local.root, 'note.txt', 'note\n')
    const runner = gatedRunner(createGitRunner(), isCommand('pull'))
    const handlers = handlersFor(local.root, runner)
    const pulling = handlers.pull(local.root, { operationId: 'op-pull' })
    await runner.reached
    const before = runner.calls.length
    const committing = handlers.commit(local.root, note)
    expect(await settledAfter(committing, SETTLE_MS)).toBe(false)
    // While it waits the commit has only looked up which repository it is in.
    expect(runner.calls.slice(before).map((request) => request.args)).toEqual([['rev-parse', '--show-toplevel']])
    runner.release()
    expect(code(await pulling)).toBe('merge_conflicts')
    // A conflicted merge is in progress, which commit refuses before it touches the index.
    expect(code(await committing)).toBe('operation_in_progress')
    expect(local.git('rev-parse', '-q', '--verify', 'MERGE_HEAD')).not.toBe('')
    expect(local.rev('HEAD')).toBe(mine)
    expect(local.git('status', '--porcelain', '--', 'note.txt')).toBe('?? note.txt')
  })
})

describe('read-only handlers and cancel while an operation holds the lock', () => {
  it('reads the state and lists branches without waiting', async () => {
    const { local, other } = remoteRepos(cleanups)
    teammatePushes(other, 'team.txt')
    const runner = gatedRunner(createGitRunner(), isCommand('pull'))
    const handlers = handlersFor(local.root, runner)
    const pulling = handlers.pull(local.root, { operationId: 'op-pull' })
    await runner.reached
    expect(ok(await handlers.getState(local.root)).kind).toBe('repository')
    expect(ok(await handlers.listBranches(local.root)).current).toBe('main')
    runner.release()
    ok(await pulling)
  })

  it('cancels a running pull while a commit waits behind it, and the commit then runs', async () => {
    const { local } = remoteRepos(cleanups)
    const bin = scratchDir('dm-slow-pack-')
    cleanups.push(bin.cleanup)
    const slowPack = join(bin.path, 'slow-upload-pack')
    writeFileSync(slowPack, '#!/bin/sh\nsleep 30\nexec git-upload-pack "$@"\n')
    chmodSync(slowPack, 0o755)
    local.git('config', 'remote.origin.uploadpack', slowPack)
    put(local.root, 'note.txt', 'note\n')
    const runner = gatedRunner(createGitRunner(), isCommand('pull'))
    const handlers = handlersFor(local.root, runner)
    const pulling = handlers.pull(local.root, { operationId: 'op-pull' })
    await runner.reached
    runner.release()
    const committing = handlers.commit(local.root, note)
    expect(await settledAfter(committing, SETTLE_MS)).toBe(false)
    expect(ok(await handlers.cancelOperation(local.root, 'op-pull'))).toEqual({ cancelled: true })
    expect(code(await pulling)).toBe('cancelled')
    const { oid } = ok(await committing)
    expect(local.rev('HEAD')).toBe(oid)
    expect(local.git('show', '--name-only', '--format=', 'HEAD')).toBe('note.txt')
  })
})

describe('an undo started while a push runs', () => {
  it('waits for the push, then is refused because the commit is now pushed', async () => {
    const { local } = remoteRepos(cleanups)
    const mine = local.commit('mine')
    const runner = gatedRunner(createGitRunner(), isCommand('push'))
    const handlers = handlersFor(local.root, runner)
    const pushing = handlers.push(local.root, { operationId: 'op-push' })
    await runner.reached
    const undoing = handlers.undoLastCommit(local.root)
    expect(await settledAfter(undoing, SETTLE_MS)).toBe(false)
    runner.release()
    ok(await pushing)
    const refused = await undoing
    expect(code(refused)).toBe('invalid_input')
    expect(refused).toMatchObject({ error: { message: expect.stringContaining('already pushed') } })
    expect(local.rev('HEAD')).toBe(mine)
    expect(local.rev('origin/main')).toBe(mine)
  })
})

describe('a pull request checkout', () => {
  it('switches and fast-forwards without a concurrent write in between', async () => {
    const { local } = remoteRepos(cleanups)
    const main = local.rev('HEAD')
    local.branch('pr/7')
    const first = local.commit('first')
    const second = local.commit('second')
    local.git('push', '-q', 'origin', `${second}:refs/pull/7/head`)
    local.switchTo('main')
    local.git('branch', '-f', 'pr/7', first)
    // Held after the switch to pr/7, before its fast-forward.
    const runner = gatedRunner(createGitRunner(), (request) => request.args[0] === 'merge' && request.args[1] === '--ff-only')
    const handlers = handlersFor(local.root, runner)
    const checkingOut = handlers.checkoutPullRequest(local.root, { number: 7, uncommitted: 'bring' })
    await runner.reached
    const switching = handlers.switchBranch(local.root, { name: 'main', uncommitted: 'bring' })
    expect(await settledAfter(switching, SETTLE_MS)).toBe(false)
    expect(local.git('branch', '--show-current')).toBe('pr/7')
    runner.release()
    ok(await checkingOut)
    expect(local.rev('pr/7')).toBe(second)
    ok(await switching)
    expect(local.git('branch', '--show-current')).toBe('main')
    expect(local.rev('main')).toBe(main)
    expect(existsSync(join(local.root, '.git', 'MERGE_HEAD'))).toBe(false)
  })
})
