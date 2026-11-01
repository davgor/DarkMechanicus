/** Fetch, pull and push against a local bare repository (a file-path `origin`) and a second clone that pushes to it. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitProgressEvent } from '../../shared/git/api'
import type { RepoState, RepoStatus } from '../../shared/git/status'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from './runner'
import { readRepoState } from './status'
import { createSync, type Sync } from './sync'

const runner = createGitRunner()
const signedOut = { getAccount: () => null, getToken: () => null }
const cleanups: Array<() => void> = []

beforeEach(() => {
  // Neither the person's global config (pull.rebase, helpers) nor the system one takes part.
  const home = scratchDir('dm-sync-home-')
  cleanups.push(home.cleanup)
  writeFileSync(join(home.path, 'gitconfig'), '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home.path, 'gitconfig'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

interface Remotes {
  /** The repository under test, tracking `origin/main`. */
  local: GitRepo
  /** Another clone of the same bare `origin`, standing in for a teammate. */
  other: string
  bare: string
}

function identity(path: string): void {
  gitIn(path, 'config', 'user.name', 'Test')
  gitIn(path, 'config', 'user.email', 'test@example.com')
}

function remotes(): Remotes {
  const local = createGitRepo()
  const bare = scratchDir()
  const others = scratchDir()
  cleanups.push(local.cleanup, bare.cleanup, others.cleanup)
  gitIn(bare.path, 'init', '-q', '--bare', '-b', 'main')
  identity(local.root)
  local.git('remote', 'add', 'origin', bare.path)
  local.git('push', '-q', '-u', 'origin', 'main')
  const other = join(others.path, 'other')
  gitIn(others.path, 'clone', '-q', bare.path, other)
  identity(other)
  return { local, other, bare: bare.path }
}

function teammateCommits(other: string, file: string, count = 1): void {
  for (let i = 1; i <= count; i += 1) {
    put(other, file, `teammate ${i}\n`)
    gitIn(other, 'add', '.')
    gitIn(other, 'commit', '-q', '-m', `teammate ${i}`)
  }
  gitIn(other, 'push', '-q', 'origin', 'HEAD')
}

function setup(): { sync: Sync; events: GitProgressEvent[] } {
  const events: GitProgressEvent[] = []
  return { sync: createSync({ runner, session: signedOut, onProgress: (event) => events.push(event), env: {} }), events }
}

function statusOf(state: RepoState): RepoStatus {
  if (state.kind !== 'repository') {
    throw new Error(`expected a repository, got ${state.kind}`)
  }
  return state.status
}

describe('fetch', () => {
  it('updates behind and the last-fetched time, with progress percentages', async () => {
    const { local, other } = remotes()
    teammateCommits(other, 'team.txt', 3)
    const { sync, events } = setup()
    expect(statusOf(await readRepoState(runner, local.root)).lastFetchedAt).toBeNull()
    const before = Date.now()
    const status = statusOf(await sync.run('fetch', local.root, 'op-1'))
    expect(status.branch).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 3 })
    expect(status.lastFetchedAt).not.toBeNull()
    expect(Date.parse(status.lastFetchedAt ?? '')).toBeGreaterThanOrEqual(before - 2000)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.folder === local.root && event.operationId === 'op-1' && event.operation === 'fetch')).toBe(true)
    expect(events.some((event) => typeof event.percent === 'number' && event.percent > 0)).toBe(true)
  })
})

describe('pull', () => {
  it('merges, even when the repository is configured to rebase', async () => {
    const { local, other } = remotes()
    teammateCommits(other, 'team.txt')
    local.git('config', 'pull.rebase', 'true')
    local.commit('mine')
    const { sync, events } = setup()
    const status = statusOf(await sync.run('pull', local.root, 'op-pull'))
    expect(status.branch).toMatchObject({ ahead: 2, behind: 0 })
    expect(status.inProgress).toBeNull()
    expect(local.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    expect(status.lastFetchedAt).not.toBeNull()
    expect(events.every((event) => event.operation === 'pull')).toBe(true)
  })

  it('returns merge_conflicts for a conflicting change, and the state shows the merge', async () => {
    const { local, other } = remotes()
    teammateCommits(other, 'shared.txt')
    put(local.root, 'shared.txt', 'mine\n')
    local.git('add', '.')
    local.git('commit', '-q', '-m', 'mine')
    const { sync } = setup()
    await expect(sync.run('pull', local.root, 'op')).rejects.toMatchObject({ code: 'merge_conflicts' })
    const status = statusOf(await readRepoState(runner, local.root))
    expect(status.inProgress).toBe('merge')
    expect(status.files).toEqual([{ path: 'shared.txt', oldPath: null, kind: 'conflicted' }])
  })
})

describe('push and publish', () => {
  it('pushes to the upstream, with progress', async () => {
    const { local, bare } = remotes()
    local.commit('one')
    const head = local.commit('two')
    const { sync, events } = setup()
    const status = statusOf(await sync.run('push', local.root, 'op-push'))
    expect(status.branch).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 })
    expect(gitIn(bare, 'rev-parse', 'main').trim()).toBe(head)
    expect(events.some((event) => event.phase === 'Writing objects' && event.percent === 100)).toBe(true)
  })

  it('publishes a branch without an upstream and sets it', async () => {
    const { local, bare } = remotes()
    local.branch('topic')
    const head = local.commit('topic work')
    const { sync } = setup()
    const status = statusOf(await sync.run('push', local.root, 'op'))
    expect(status.branch).toMatchObject({ name: 'topic', upstream: 'origin/topic', ahead: 0, behind: 0 })
    expect(gitIn(bare, 'rev-parse', 'topic').trim()).toBe(head)
  })

  it('rejects a non-fast-forward push, and never forces it', async () => {
    const { local, other, bare } = remotes()
    teammateCommits(other, 'team.txt')
    const theirs = gitIn(bare, 'rev-parse', 'main').trim()
    local.commit('mine')
    const { sync } = setup()
    await expect(sync.run('push', local.root, 'op')).rejects.toMatchObject({ code: 'rejected_non_fast_forward' })
    expect(gitIn(bare, 'rev-parse', 'main').trim()).toBe(theirs)
  })

  it('refuses to push or pull a detached HEAD', async () => {
    const { local } = remotes()
    local.git('checkout', '-q', '--detach')
    const { sync } = setup()
    await expect(sync.run('push', local.root, 'a')).rejects.toThrow(/branch/)
    await expect(sync.run('pull', local.root, 'b')).rejects.toThrow(/branch/)
  })
})

describe('remote selection', () => {
  it('fails remote_not_found with neither an upstream nor origin', async () => {
    const r = createGitRepo()
    cleanups.push(r.cleanup)
    const { sync } = setup()
    await expect(sync.run('fetch', r.root, 'op')).rejects.toMatchObject({ code: 'remote_not_found' })
  })

  it('publishes a branch that tracks a differently named branch under its own name, leaving that branch alone', async () => {
    const { local, bare } = remotes()
    const main = gitIn(bare, 'rev-parse', 'main').trim()
    local.git('switch', '-q', '-c', 'feature', '--track', 'origin/main')
    const head = local.commit('feature work')
    const { sync } = setup()
    const status = statusOf(await sync.run('push', local.root, 'op'))
    expect(gitIn(bare, 'rev-parse', 'main').trim()).toBe(main)
    expect(gitIn(bare, 'rev-parse', 'feature').trim()).toBe(head)
    expect(status.branch).toMatchObject({ name: 'feature', upstream: 'origin/feature', ahead: 0 })
  })

  it("pushes to git's push remote (remote.pushDefault) and pulls from the upstream", async () => {
    const { local, bare } = remotes()
    const fork = scratchDir()
    cleanups.push(fork.cleanup)
    gitIn(fork.path, 'init', '-q', '--bare', '-b', 'main')
    local.git('remote', 'add', 'fork', fork.path)
    local.git('config', 'remote.pushDefault', 'fork')
    const main = gitIn(bare, 'rev-parse', 'main').trim()
    const head = local.commit('mine')
    const { sync } = setup()
    await sync.run('push', local.root, 'op')
    expect(gitIn(fork.path, 'rev-parse', 'main').trim()).toBe(head)
    expect(gitIn(bare, 'rev-parse', 'main').trim()).toBe(main)
    expect(local.git('rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main')
  })

  it('refuses a remote whose name starts with "-", which git pull would read as an option', async () => {
    const { local, bare } = remotes()
    local.git('config', 'remote.-x.url', bare)
    local.git('config', 'remote.-x.fetch', '+refs/heads/*:refs/remotes/-x/*')
    local.git('config', 'branch.main.remote', '-x')
    const { sync } = setup()
    await expect(sync.run('pull', local.root, 'op')).rejects.toThrow(/starts with "-"/)
  })
})
