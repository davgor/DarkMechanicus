import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitIn, put, samePath, scratchDir } from '../../test/gitScratch'
import { seedForgeFixture } from '../../test/forgeFixture'
import { createGitHandlers } from './handlers'
import { createGitRunner, type GitRunner } from './runner'
import { GitError } from './errors'
import type { GitProgressEvent } from '../../shared/git/api'

let scratch: ReturnType<typeof scratchDir>
let world: string
let member: string
let code: string
beforeEach(() => {
  scratch = scratchDir('dm-forge-git-target-')
  world = join(scratch.path, 'World')
  member = join(world, 'Project')
  code = join(scratch.path, 'code')
  for (const path of [member, code]) mkdirSync(path, { recursive: true })
  for (const path of [world, code]) {
    gitIn(path, 'init', '--initial-branch=main')
    gitIn(path, 'config', 'user.name', 'Forge Test')
    gitIn(path, 'config', 'user.email', 'forge@example.test')
    gitIn(path, 'config', 'maintenance.auto', 'false')
  }
  gitIn(world, 'remote', 'add', 'origin', 'https://github.com/example/world.git')
  gitIn(code, 'remote', 'add', 'origin', 'https://github.com/example/code.git')
  seedForgeFixture(world, 'example', [{ folder: 'Project', repository: 'example/code' }])
  put(world, '.gitignore', '*/.darkmechanicus/local/\n')
  put(member, '.darkmechanicus/local/source-checkout.json', JSON.stringify({ checkout: code }))
  put(world, 'ticket.txt', 'ticket baseline\n')
  put(code, 'code.txt', 'code baseline\n')
  for (const path of [world, code]) { gitIn(path, 'add', '.'); gitIn(path, 'commit', '-m', 'baseline') }
})
afterEach(() => scratch.cleanup())

function handlers(runner: GitRunner = createGitRunner(), events: GitProgressEvent[] = []) {
  const tracked = new Set([world, member])
  return createGitHandlers({ registry: { resolve: path => tracked.has(path) ? path : null }, runner,
    trashItem: async () => {}, openPath: async () => '', session: { getAccount: () => null, getToken: () => null },
    client: { listOpenPullRequests: async () => { throw new Error('unused') } }, onProgress: event => events.push(event), onUnexpectedError: () => {} })
}

describe('Forge project Source control targets', () => {
  it('reads and commits only code for the project, and only tickets for the world root', async () => {
    const api = handlers()
    const worldHead = gitIn(world, 'rev-parse', 'HEAD')
    put(code, 'code.txt', 'changed code\n')
    put(world, 'ticket.txt', 'changed ticket\n')
    const state = await api.getState(member)
    expect(state).toMatchObject({ ok: true, data: { kind: 'repository', status: { files: [{ path: 'code.txt' }] } } })
    if (!state.ok || state.data.kind !== 'repository') throw new Error('Expected linked code repository')
    expect(samePath(state.data.status.root)).toBe(samePath(code))
    expect(await api.commit(member, { summary: 'Code only', description: '', files: [{ path: 'code.txt', oldPath: null }] })).toMatchObject({ ok: true })
    expect(gitIn(world, 'rev-parse', 'HEAD')).toBe(worldHead)
    expect(gitIn(code, 'show', 'HEAD:code.txt')).toBe('changed code\n')
    const codeHead = gitIn(code, 'rev-parse', 'HEAD')
    expect(await api.commit(world, { summary: 'Tickets only', description: '', files: [{ path: 'ticket.txt', oldPath: null }] })).toMatchObject({ ok: true })
    expect(gitIn(code, 'rev-parse', 'HEAD')).toBe(codeHead)
    expect(gitIn(world, 'show', 'HEAD:ticket.txt')).toBe('changed ticket\n')
  })

  it('returns available code metadata but keeps an arbitrary untracked code-path request unauthorized', async () => {
    const api = handlers()
    expect(await api.getTarget(member)).toEqual({ ok: true, data: { kind: 'available', path: code, displayPath: code, repository: 'https://github.com/example/code.git' } })
    expect(await api.getTarget(world)).toEqual({ ok: true, data: { kind: 'available', path: world, displayPath: world } })
    expect(await api.getState(code)).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })

  it('keeps URLs and directions available when code is absent and refuses every attempted write instead of falling back to tickets', async () => {
    writeFileSync(join(member, '.darkmechanicus/local/source-checkout.json'), JSON.stringify({ checkout: join(scratch.path, 'missing') }))
    const api = handlers()
    const head = gitIn(world, 'rev-parse', 'HEAD')
    const target = await api.getTarget(member)
    expect(target).toMatchObject({ ok: true, data: { kind: 'unavailable', repository: 'https://github.com/example/code.git', directions: expect.stringContaining('outside the Forge World') } })
    expect(await api.getState(member)).toMatchObject({ ok: false, error: { code: 'checkout_unavailable' } })
    expect(await api.initRepository(member)).toMatchObject({ ok: false, error: { code: 'checkout_unavailable' } })
    expect(await api.commit(member, { summary: 'Wrong target', description: '', files: [{ path: 'ticket.txt', oldPath: null }] })).toMatchObject({ ok: false, error: { code: 'checkout_unavailable' } })
    expect(gitIn(world, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(world, 'ticket.txt'), 'utf8')).toBe('ticket baseline\n')
  })

  it('refuses a stale checkout whose origin belongs to a different project', async () => {
    gitIn(code, 'remote', 'set-url', 'origin', 'https://github.com/example/wrong.git')
    const api = handlers()
    expect(await api.getTarget(member)).toMatchObject({ ok: true, data: { kind: 'unavailable', reason: expect.stringContaining('origin does not match') } })
    expect(await api.createBranch(member, { name: 'unwanted', startPoint: 'current' })).toMatchObject({ ok: false, error: { code: 'checkout_unavailable' } })
    expect(gitIn(code, 'branch', '--list', 'unwanted')).toBe('')
  })
})

describe('Forge project checkout trust after startup', () => {
  it.each(['index', 'HEAD'] as const)('refuses a private checkout hint introduced into %s after an earlier successful lookup', async location => {
    const api = handlers()
    expect(await api.getTarget(member)).toMatchObject({ ok: true, data: { kind: 'available', path: code } })
    const hint = 'Project/.darkmechanicus/local/source-checkout.json'
    gitIn(world, 'add', '--force', hint)
    if (location === 'HEAD') {
      gitIn(world, 'commit', '-m', 'Unsafe imported private hint')
      gitIn(world, 'rm', '--cached', hint)
    }
    const codeHead = gitIn(code, 'rev-parse', 'HEAD')
    put(code, 'code.txt', 'must remain uncommitted\n')
    expect(await api.getTarget(member)).toMatchObject({ ok: true, data: {
      kind: 'unavailable', repository: 'https://github.com/example/code.git', reason: expect.stringContaining('tracked machine-private state')
    } })
    expect(await api.commit(member, { summary: 'Unsafe target', description: '', files: [{ path: 'code.txt', oldPath: null }] })).toMatchObject({ ok: false, error: { code: 'checkout_unavailable' } })
    expect(gitIn(code, 'rev-parse', 'HEAD')).toBe(codeHead)
  })
})

describe('Forge project history, branches and network identity', () => {
  it('reads code diffs/history and creates a code branch without changing the world branch', async () => {
    const api = handlers()
    put(code, 'code.txt', 'only code changes\n')
    expect(await api.getWorkingDiff(member, { path: 'code.txt', oldPath: null, kind: 'modified' })).toMatchObject({ ok: true, data: { kind: 'text' } })
    const history = await api.getHistory(member, { skip: 0, limit: 10 })
    expect(history).toMatchObject({ ok: true })
    expect(await api.createBranch(member, { name: 'code-work', startPoint: 'current' })).toMatchObject({ ok: true })
    expect(gitIn(code, 'branch', '--show-current').trim()).toBe('code-work')
    expect(gitIn(world, 'branch', '--show-current').trim()).toBe('main')
    const files = await api.getCommitFiles(member, gitIn(code, 'rev-parse', 'HEAD').trim())
    expect(files).toMatchObject({ ok: true, data: [expect.objectContaining({ path: 'code.txt' })] })
  })

  it('reports progress and cancels by the member identity even if its checkout hint changes mid-operation', async () => {
    const real = createGitRunner()
    const events: GitProgressEvent[] = []
    let announce: () => void = () => {}
    const started = new Promise<void>(resolve => { announce = resolve })
    const networkFolders: string[] = []
    const runner: GitRunner = { run: request => {
      if (request.kind !== 'network') return real.run(request)
      networkFolders.push(request.cwd)
      request.onProgress?.('Receiving objects:  50% (1/2)')
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => { request.onExit?.(); reject(new GitError('cancelled', '')) }, { once: true })
        announce()
      })
    } }
    const api = handlers(runner, events)
    const fetching = api.fetch(member, { operationId: 'member-fetch' })
    expect(await Promise.race([started.then(() => 'started'), fetching.then(() => 'ended')])).toBe('started')
    writeFileSync(join(member, '.darkmechanicus/local/source-checkout.json'), JSON.stringify({ checkout: join(scratch.path, 'missing') }))
    expect(await api.cancelOperation(member, 'member-fetch')).toEqual({ ok: true, data: { cancelled: true } })
    expect(await fetching).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(events).toEqual([expect.objectContaining({ folder: member, operationId: 'member-fetch', percent: 50 })])
    expect(networkFolders.map(samePath)).toEqual([samePath(code)])
  })
})


describe('Forge World branch protection', () => {
  it('refuses create, switch, rename and pull request checkout without changing the world', async () => {
    const api = handlers()
    gitIn(world, 'branch', 'topic')
    const head = gitIn(world, 'rev-parse', 'HEAD')
    const refusal = { ok: false, error: { code: 'invalid_input', message: expect.stringContaining('Forge Worlds stay on main') } }
    expect(await api.createBranch(world, { name: 'new-topic', startPoint: 'current' })).toMatchObject(refusal)
    expect(await api.switchBranch(world, { name: 'topic', uncommitted: 'bring' })).toMatchObject(refusal)
    expect(await api.renameBranch(world, { from: 'main', to: 'renamed' })).toMatchObject(refusal)
    expect(await api.checkoutPullRequest(world, { number: 1, uncommitted: 'bring' })).toMatchObject(refusal)
    expect(gitIn(world, 'branch', '--show-current').trim()).toBe('main')
    expect(gitIn(world, 'rev-parse', 'HEAD')).toBe(head)
    expect(gitIn(world, 'branch', '--list', 'new-topic', 'renamed')).toBe('')
  })

  it('allows returning a world to main and keeps member code branch changes available', async () => {
    const api = handlers()
    gitIn(world, 'checkout', '-b', 'old-topic')
    expect(await api.switchBranch(world, { name: 'main', uncommitted: 'bring' })).toMatchObject({ ok: true })
    expect(await api.createBranch(member, { name: 'code-topic', startPoint: 'current' })).toMatchObject({ ok: true })
    expect(await api.renameBranch(member, { from: 'code-topic', to: 'code-renamed' })).toMatchObject({ ok: true })
    expect(await api.switchBranch(member, { name: 'main', uncommitted: 'bring' })).toMatchObject({ ok: true })
    expect(gitIn(world, 'branch', '--show-current').trim()).toBe('main')
    expect(gitIn(code, 'branch', '--list', 'code-renamed')).toContain('code-renamed')
  })
})
