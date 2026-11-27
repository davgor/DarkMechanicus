import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMain } from 'electron'
import { expect, it, vi } from 'vitest'
import { openWorkspace } from '../../core/workspace'
import { withForgeTransfer } from '../../core/repo/forgeBinding'
import { createChatRecords } from '../agents/chatRecords'
import { createChatStore } from '../agents/chatStore'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { copyRepositories, useTemplate } from '../../test/gitTemplate'
import { TEST_STORAGE } from '../../test/workspaceHarness'
import { createGitRunner, type GitRunRequest } from '../git/runner'
import { createFolderRegistry } from './folderRegistry'
import { forgeAgentSessions } from './forgeAgents'
import { createForge, updateForge } from './forgeManifest'
import { startForge } from './forgeService'
import { createTestWorkspacePool as createWorkspacePool } from './__mocks__/projectWorkspaceFixture'

function initializeOrigin(root: string) {
  mkdirSync(root)
  gitIn(root, 'init', '-b', 'main')
  gitIn(root, 'config', 'user.name', 'Test')
  gitIn(root, 'config', 'user.email', 'test@example.test')
  gitIn(root, 'remote', 'add', 'origin', 'https://github.com/owner/tickets.git')
}

// Each repository below is built once for the file and copied per test (see `useTemplate`).
const originTemplate = useTemplate(cleanups => {
  const base = scratchDir('forge-resolver-')
  cleanups.push(base.cleanup)
  initializeOrigin(join(base.path, 'world'))
  return base.path
})

/** A world whose `main` has a local README edit over the initial commit, and a `remote` branch that changed it too. */
const seededTemplate = useTemplate(cleanups => {
  const base = scratchDir('forge-resolver-seeded-')
  cleanups.push(base.cleanup)
  const root = join(base.path, 'world')
  initializeOrigin(root)
  createForge(root, 'owner')
  writeFileSync(join(root, 'README.md'), 'Original\n')
  gitIn(root, 'add', '.')
  gitIn(root, 'commit', '-m', 'Initial world')
  gitIn(root, 'switch', '-c', 'remote')
  writeFileSync(join(root, 'README.md'), 'Remote\n')
  gitIn(root, 'commit', '-am', 'Remote edit')
  const upstream = gitIn(root, 'rev-parse', 'HEAD').trim()
  gitIn(root, 'switch', 'main')
  writeFileSync(join(root, 'README.md'), 'Local\n')
  return { root, upstream }
})

/** Like Git's own test suite, disposable fixtures need real objects, not power-loss hardware flushes. */
function unflushed(request: GitRunRequest): GitRunRequest {
  return { ...request, env: { ...request.env, GIT_TEST_FSYNC: '0' } }
}

function resolverFixture(options: { initializedWorld?: boolean; onConflict?: Parameters<typeof startForge>[1]['onConflict']; beforeRun?: (args: readonly string[]) => Promise<void> } = {}) {
  const cleanups: Array<() => void> = []
  const base = copyRepositories(originTemplate(), cleanups)
  const root = join(base, 'world')
  const home = join(base, 'home')
  if (options.initializedWorld) createForge(root, 'owner')
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  registry.track(root)
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Resolver fixture', serverInfo: { name: 'fixture', version: '1' }, ...TEST_STORAGE }), home)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const call = async (name: string, ...args: unknown[]) => handlers.get('forge:' + name)!({} as Electron.IpcMainInvokeEvent, ...args)
  const events: string[] = []
  const runner = createGitRunner()
  let upstream = ''
  const forge = startForge({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    home, registry, pool, session: { getAccount: () => null, getToken: () => null },
    cleanup: () => undefined, pickDirectory: async () => null, publish: async () => undefined,
    onConflict: options.onConflict ?? (async world => { events.push('resolve ' + world) }),
    onSynced: async () => { events.push('archive') },
    runner: { run: async req => {
      await options.beforeRun?.(req.args)
      if (req.kind !== 'network') return runner.run(unflushed(req))
      if (req.args.includes('fetch')) writeFileSync(join(root, '.git/FETCH_HEAD'), upstream + "\t\tbranch 'main'\n")
      if (req.args.includes('push')) { upstream = gitIn(root, 'rev-parse', 'HEAD').trim(); events.push('push') }
      return { code: 0, stderr: '', stdout: req.args.includes('ls-remote') ? upstream : '' }
    } }
  })
  return { root, call, events, forge, registry, pool, setUpstream: (sha: string) => { upstream = sha }, cleanup: () => { forge.stop(); pool.closeAll(); for (const cleanup of cleanups) cleanup() } }
}

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Puts the seeded template's repository and working tree over the fixture's freshly initialized world. */
function seedConflict(fixture: ReturnType<typeof resolverFixture>) {
  const seeded = seededTemplate()
  cpSync(seeded.root, fixture.root, { recursive: true })
  fixture.setUpstream(seeded.upstream)
}

it.each([new Error('Agent unavailable'), 'Agent unavailable'])('reports resolver failures, serializes background polling and stops repair after untracking: %s', async failure => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const entered = pending<void>(), result = pending<void>()
  let attempts = 0, commands = 0
  const fixture = resolverFixture({
    onConflict: async () => {
      attempts++
      if (attempts === 1) throw failure
      entered.resolve()
      await result.promise
    },
    beforeRun: async () => { commands++ }
  })
  try {
    seedConflict(fixture)
    await expect(fixture.call('sync', fixture.root)).rejects.toBe(failure)
    expect((await fixture.call('status', fixture.root)).error).toBe('Agent unavailable')
    expect(gitIn(fixture.root, 'ls-files', '-u')).toContain('README.md')
    await vi.advanceTimersByTimeAsync(15_000)
    await entered.promise
    const duringRepair = commands
    await vi.advanceTimersByTimeAsync(30_000)
    expect(attempts).toBe(2)
    expect(commands).toBe(duringRepair)
    result.reject(failure)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect((await fixture.call('status', fixture.root)).error).toBe('Agent unavailable')
    fixture.registry.untrack(fixture.root)
    const beforeUntrack = commands
    await vi.advanceTimersByTimeAsync(300_000)
    expect(commands).toBe(beforeUntrack)
    expect(attempts).toBe(2)
    expect(fixture.events).not.toContain('push')
  } finally { result.resolve(); fixture.cleanup(); vi.useRealTimers() }
})

it('does not retain a resolver failure on a replacement world attachment or publish the old merge', async () => {
  const entered = pending<void>(), result = pending<void>()
  const fixture = resolverFixture({
    onConflict: async () => { entered.resolve(); await result.promise }
  })
  const { root, registry, call, events } = fixture
  try {
    seedConflict(fixture)
    const syncing = call('sync', root)
    const failure = expect(syncing).rejects.toThrow('Previous resolver failed')
    await entered.promise
    registry.untrack(root)
    registry.track(root)
    result.reject(new Error('Previous resolver failed'))
    await failure
    expect(await call('status', root)).toEqual({ last: null, error: null })
    expect(gitIn(root, 'ls-files', '-u')).toContain('README.md')
    expect(events).toEqual([])
  } finally { result.resolve(); fixture.cleanup() }
})

it('will not grant a nested tracked folder a resolver for its parent repository merge', async () => {
  const fixture = resolverFixture()
  const { root, registry, call, events } = fixture
  try {
    seedConflict(fixture)
    gitIn(root, 'commit', '-am', 'Local edit')
    expect(() => gitIn(root, 'merge', 'remote')).toThrow()
    const nested = join(root, 'Nested')
    mkdirSync(nested)
    createForge(nested, 'owner')
    registry.track(nested)
    await expect(call('sync', nested)).rejects.toThrow('must be the root of its ticket repository')
    expect(gitIn(root, 'ls-files', '-u')).toContain('README.md')
    expect(events).toEqual([])
  } finally { fixture.cleanup() }
})

it('coalesces concurrent opens of one world while its startup health check is still preparing', async () => {
  const entered = pending<void>(), release = pending<void>()
  let healthChecks = 0
  const fixture = resolverFixture({ initializedWorld: true, beforeRun: async args => {
    if (args.includes('symbolic-ref')) { healthChecks++; entered.resolve(); await release.promise }
  } })
  try {
    const first = fixture.forge.openWorld(fixture.root)
    await entered.promise
    const second = fixture.forge.openWorld(fixture.root)
    release.resolve()
    await fixture.forge.ready
    expect(await Promise.all([first, second])).toEqual([fixture.root, fixture.root])
    expect(healthChecks).toBe(1)
    expect(fixture.events).toEqual([])
    expect(readFileSync(join(fixture.root, 'FORGE-REPOSITORIES.md'), 'utf8')).toContain('Keep this Forge World repository on main')
  } finally { release.resolve(); fixture.cleanup() }
})

it('shares an in-flight sync between concurrent requests instead of committing and pushing twice', async () => {
  const entered = pending<void>(), release = pending<void>()
  let probes = 0
  const fixture = resolverFixture({ beforeRun: async args => {
    if (args.includes('ls-remote')) { probes++; entered.resolve(); await release.promise }
  } })
  try {
    createForge(fixture.root, 'owner')
    writeFileSync(join(fixture.root, 'README.md'), 'One committed change')
    const first = fixture.call('sync', fixture.root)
    await entered.promise
    const second = fixture.call('sync', fixture.root)
    release.resolve()
    await Promise.all([first, second])
    expect(probes).toBe(1)
    expect(fixture.events).toEqual(['push', 'archive'])
    expect(gitIn(fixture.root, 'show', 'HEAD:README.md')).toBe('One committed change')
    expect((await fixture.call('status', fixture.root)).error).toBeNull()
  } finally { release.resolve(); fixture.cleanup() }
})

it('reports an unexpected startup dependency failure without initializing or publishing the world', async () => {
  const fixture = resolverFixture({ initializedWorld: true, beforeRun: async () => { throw 'Git executable unavailable' } })
  try {
    await fixture.forge.ready
    expect((await fixture.call('status', fixture.root)).error).toBe('Git executable unavailable')
    expect(existsSync(join(fixture.root, 'FORGE-REPOSITORIES.md'))).toBe(false)
    expect(fixture.events).toEqual([])
    expect(gitIn(fixture.root, 'branch', '--show-current').trim()).toBe('main')
  } finally { fixture.cleanup() }
})

it('reports a non-Error network failure without claiming publication or starting a merge resolver', async () => {
  const fixture = resolverFixture({ beforeRun: async args => { if (args.includes('ls-remote')) throw 'Network disconnected' } })
  try {
    createForge(fixture.root, 'owner')
    writeFileSync(join(fixture.root, 'README.md'), 'Preserve local edits')
    await expect(fixture.call('sync', fixture.root)).rejects.toBe('Network disconnected')
    expect(await fixture.call('status', fixture.root)).toEqual({ last: null, error: 'Network disconnected' })
    expect(fixture.events).toEqual([])
    expect(gitIn(fixture.root, 'show', 'HEAD:README.md')).toBe('Preserve local edits')
  } finally { fixture.cleanup() }
})

it.each(['nested repository', 'initialized ticket project'])('refuses creating a world over a %s without changing its files', async invalid => {
  const fixture = resolverFixture()
  try {
    let selected = fixture.root
    if (invalid === 'nested repository') {
      selected = join(fixture.root, 'Nested')
      mkdirSync(selected)
      fixture.registry.track(selected)
    } else await fixture.pool.get(fixture.root).initializeRepository({ name: 'Existing tickets', mode: 'db' })
    const before = gitIn(fixture.root, 'status', '--porcelain')
    await expect(fixture.call('create', selected)).rejects.toThrow(invalid === 'nested repository' ? 'Git repository root' : 'dedicated ticket repository')
    expect(existsSync(join(selected, 'forge-world.json'))).toBe(false)
    expect(gitIn(fixture.root, 'status', '--porcelain')).toBe(before)
    expect(fixture.events).toEqual([])
  } finally { fixture.cleanup() }
})

it('refuses a replaced symbolic manifest before creating a member ticket store', async () => {
  const fixture = resolverFixture()
  try {
    createForge(fixture.root, 'owner')
    const manifest = join(fixture.root, 'forge-world.json'), target = join(fixture.root, 'directory')
    renameSync(manifest, join(fixture.root, 'original-manifest.json'))
    mkdirSync(target)
    symlinkSync(target, manifest, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fixture.call('add', fixture.root, 'owner/Alpha', 'Alpha')).rejects.toThrow('Invalid Forge World manifest')
    expect(existsSync(join(fixture.root, 'Alpha'))).toBe(false)
    expect(fixture.events).toEqual([])
  } finally { fixture.cleanup() }
})

it.each(['forge-world.json', 'README.md'])('opens a world-scoped resolver for conflicting %s and archives after the merge reaches origin', async (conflictFile) => {
  const { root, call, events, setUpstream, cleanup } = resolverFixture()
  try {
    await call('create', root)
    await call('add', root, 'owner/Alpha', 'Alpha')
    writeFileSync(join(root, 'README.md'), 'Original directions\n')
    await call('sync', root)
    await expect(call('add', root, 'owner/Alpha', 'Alias')).rejects.toThrow('already tracked')
    await expect(call('interval', root, 0)).rejects.toThrow()
    gitIn(root, 'switch', '-c', 'remote')
    updateForge(root, w => { w.syncMinutes = 19 })
    writeFileSync(join(root, 'README.md'), 'Remote directions\n')
    gitIn(root, 'commit', '-am', 'Change interval remotely')
    setUpstream(gitIn(root, 'rev-parse', 'HEAD').trim())
    gitIn(root, 'switch', 'main')
    await call('interval', root, 7)
    if (conflictFile === 'README.md') {
      updateForge(root, w => { w.syncMinutes = 5 })
      writeFileSync(join(root, 'README.md'), 'Local directions\n')
    }
    events.length = 0
    await expect(call('sync', root)).rejects.toThrow()
    expect(events).toEqual(['resolve ' + root])
    expect((await call('status', root)).error).toBeTruthy()
    writeFileSync(join(root, 'forge-world.json'), gitIn(root, 'show', 'remote:forge-world.json'))
    writeFileSync(join(root, 'README.md'), 'Combined directions\n')
    gitIn(root, 'add', 'forge-world.json', 'README.md')
    gitIn(root, 'commit', '-m', 'Resolve ticket settings conflict')
    await call('sync', root)
    expect(events).toEqual(['resolve ' + root, 'push', 'archive'])
    expect((await call('status', root)).error).toBeNull()
    expect(JSON.parse(readFileSync(join(root, 'forge-world.json'), 'utf8')).syncMinutes).toBe(19)
  } finally { cleanup() }
})

interface ConflictingClones {
  root: string
  remote: string
  peer: string
  home: string
  url: string
  cleanup(): void
}

const CLONES_URL = 'https://github.com/owner/tickets.git'

const clonesTemplate = useTemplate(cleanups => {
  const fixture = scratchDir('forge-scheduled-')
  cleanups.push(fixture.cleanup)
  const root = join(fixture.path, 'world')
  const remote = join(fixture.path, 'origin.git')
  const peer = join(fixture.path, 'peer')
  gitIn(fixture.path, 'init', '--bare', '--initial-branch=main', remote)
  gitIn(fixture.path, 'clone', remote, root)
  gitIn(root, 'config', 'user.name', 'Test')
  gitIn(root, 'config', 'user.email', 'test@example.test')
  createForge(root, 'owner')
  writeFileSync(join(root, 'README.md'), 'Original directions\n')
  gitIn(root, 'add', '.')
  gitIn(root, 'commit', '-m', 'Initial world')
  gitIn(root, 'push', 'origin', 'main')
  gitIn(fixture.path, 'clone', remote, peer)
  gitIn(peer, 'config', 'user.name', 'Peer')
  gitIn(peer, 'config', 'user.email', 'peer@example.test')
  writeFileSync(join(peer, 'README.md'), 'Peer directions\n')
  writeFileSync(join(peer, 'peer.txt'), 'Compatible peer work')
  gitIn(peer, 'add', 'peer.txt')
  gitIn(peer, 'commit', '-am', 'Peer change')
  gitIn(peer, 'push', 'origin', 'main')
  writeFileSync(join(root, 'README.md'), 'Local directions\n')
  writeFileSync(join(root, 'local.txt'), 'Compatible local work')
  // The world's origin then names no folder, so a copy keeps it; `scheduledFixture` maps it to the copy's own bare
  // origin. The peer's origin names the template's, which `copyRepositories` rewrites to the copy's.
  gitIn(root, 'remote', 'set-url', 'origin', CLONES_URL)
  return fixture.path
})

function conflictingClones(): ConflictingClones {
  const cleanups: Array<() => void> = []
  const path = copyRepositories(clonesTemplate(), cleanups)
  return { root: join(path, 'world'), remote: join(path, 'origin.git'), peer: join(path, 'peer'), home: join(path, 'home'), url: CLONES_URL,
    cleanup: () => { for (const cleanup of cleanups) cleanup() } }
}

it('leaves an off-main world and its index untouched when startup or open encounters a pending forced transfer', async () => {
  const { root, home, peer, cleanup } = conflictingClones()
  gitIn(root, 'switch', '-c', 'preserve-pending')
  await expect(withForgeTransfer(home, peer, { target: join(root, 'Incoming'), force: true }, async (_phase, advance) => {
    advance(1)
    throw new Error('Interrupted export')
  })).rejects.toThrow('Interrupted export')
  const snapshot = () => [gitIn(root, 'branch', '--show-current'), gitIn(root, 'rev-parse', 'HEAD'), gitIn(root, 'ls-files', '--stage'), gitIn(root, 'status', '--porcelain')]
  const before = snapshot()
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  registry.track(root)
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, role: 'desktop', transport: 'desktop', label: 'Reservation fixture', ...TEST_STORAGE }), home)
  const forge = startForge({ handle: () => undefined }, {
    home, registry, pool, session: { getAccount: () => null, getToken: () => null },
    cleanup: () => undefined, pickDirectory: async () => null, publish: async () => undefined,
    onConflict: async () => undefined, onSynced: async () => undefined
  })
  try {
    await forge.ready
    expect(snapshot()).toEqual(before)
    await expect(forge.openWorld(root)).rejects.toThrow('conversion is pending')
    expect(snapshot()).toEqual(before)
  } finally { forge.stop(); pool.closeAll(); cleanup() }
})

function scheduledFixture(
  { root, remote, home, url, cleanup }: ConflictingClones,
  events: Pick<Parameters<typeof startForge>[1], 'onConflict' | 'onSynced'>
) {
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  registry.track(root)
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Scheduled fixture', ...TEST_STORAGE }), home)
  const real = createGitRunner()
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const call = async (name: string) => handlers.get('forge:' + name)!({} as Electron.IpcMainInvokeEvent, root)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const forge = startForge({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    home, registry, pool, session: { getAccount: () => null, getToken: () => null },
    cleanup: () => undefined, pickDirectory: async () => null, publish: async () => undefined,
    ...events,
    runner: { run: request => request.kind !== 'network' ? real.run(unflushed(request)) : real.run(unflushed({ ...request, args: [
      '-c', 'url.' + pathToFileURL(remote).href + '.insteadOf=' + url,
      ...request.args.map(arg => arg === 'protocol.allow=never' ? 'protocol.file.allow=always' : arg)
    ] })) }
  })
  return { call, ready: forge.ready, registry, cleanup: () => { forge.stop(); vi.useRealTimers(); pool.closeAll(); cleanup() } }
}

function scheduledResolverFixture() {
  const clones = conflictingClones()
  const { home } = clones
  const store = createChatStore({ root: join(home, 'chats') })
  const chats = createChatRecords({ store, agentFor: () => null })
  const started = pending<void>(), synced = pending<void>(), nextSync = pending<void>()
  const live = new Set<string>()
  const launches: string[] = []
  let signedIn = false, publications = 0
  const resolver = {
    store, chats, agents: { list: () => [{ id: 'claude' }, { id: 'codex' }] },
    folderDefaults: { get: () => 'claude' },
    registry: { list: () => [] },
    checkAuth: async (id: string) => id === 'claude' ? 'signed_out' as const : signedIn ? 'signed_in' as const : 'unknown' as const,
    agentChats: { start: async () => { throw new Error('A resolver never starts on the GUI.') } },
    terminals: {
      isRunning: (id: string) => live.has(id),
      start: async (ref: { folder: string | null; id: string }) => {
        const agent = store.getChat(ref)!.agent
        launches.push(agent)
        if (agent !== 'codex' || !signedIn) return { state: 'signed_out' as const, message: 'The selected agent is signed out' }
        live.add(ref.id)
        started.resolve()
        return { state: 'running' as const, pid: 7 }
      },
      paste: async () => { throw new Error('Unexpected duplicate resolver prompt') },
      deleteChat: async (ref: { id: string }, archive: () => Promise<unknown>) => { live.delete(ref.id); await archive() }
    }
  }
  const sessions = forgeAgentSessions(resolver)
  const fixture = scheduledFixture(clones, {
    ...sessions,
    onSynced: async path => {
      await sessions.onSynced(path)
      if (++publications === 1) synced.resolve()
      else nextSync.resolve()
    }
  })
  return {
    ...clones, ...fixture, store, chats, started, synced, nextSync, live, launches,
    signIn: () => { signedIn = true }
  }
}

async function verifyStagedMergeStaysLocal(
  { root, remote, call, launches }: { root: string; remote: string; call(name: string): Promise<unknown>; launches: string[] },
  remoteCommit: string
): Promise<void> {
  // The mock resolves the overlapping edit in favor of remote main; Git has already merged the independent files.
  gitIn(root, 'checkout', '--theirs', 'README.md')
  gitIn(root, 'add', 'README.md')
  expect(gitIn(root, 'ls-files', '-u')).toBe('')
  await expect(call('sync')).rejects.toThrow(/merge.*commit/i)
  expect(gitIn(remote, 'rev-parse', 'main').trim()).toBe(remoteCommit)
  expect(gitIn(root, 'rev-parse', 'MERGE_HEAD').trim()).toBe(remoteCommit)
  expect(launches).toEqual(['codex'])
}

it('queues real conflicts at the interval, waits for a signed-in resolver and publishes its finished merge', async () => {
  const fixture = scheduledResolverFixture()
  const { root, remote, peer, store, chats, started, synced, nextSync, live, launches } = fixture
  const remoteCommit = gitIn(remote, 'rev-parse', 'main').trim()
  try {
    await fixture.ready
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(fixture.call('sync')).rejects.toThrow(/sign in to an agent/i)
    expect(launches).toEqual([])
    expect(chats.listChats(root)).toEqual([])
    expect(gitIn(root, 'ls-files', '-u')).toContain('README.md')
    expect(gitIn(root, 'show', 'HEAD:README.md')).toBe('Local directions\n')
    expect(gitIn(remote, 'rev-parse', 'main').trim()).toBe(remoteCommit)
    const localCommit = gitIn(root, 'rev-parse', 'HEAD').trim()

    fixture.signIn()
    await vi.advanceTimersByTimeAsync(15_000)
    await started.promise
    const [chat] = chats.listChats(root)
    expect(chat).toMatchObject({ agent: 'codex', folder: root, role: 'worker', allowSave: false })
    expect(chat.firstPrompt).toMatch(/prefer.*remote main.*MERGE_HEAD/i)
    expect(chat.firstPrompt).toMatch(/preserve compatible changes/i)
    expect(launches).toEqual(['codex'])

    await verifyStagedMergeStaysLocal(fixture, remoteCommit)
    gitIn(root, 'commit', '-m', 'Resolve overlapping edit in favor of remote main')

    await vi.advanceTimersByTimeAsync(15_000)
    await synced.promise
    expect(gitIn(remote, 'rev-list', '--parents', '-n', '1', 'main').trim().split(' ').slice(1)).toEqual([localCommit, remoteCommit])
    gitIn(peer, 'pull', '--ff-only')
    expect(readFileSync(join(peer, 'README.md'), 'utf8')).toBe('Peer directions\n')
    expect(readFileSync(join(peer, 'local.txt'), 'utf8')).toBe('Compatible local work')
    expect(readFileSync(join(peer, 'peer.txt'), 'utf8')).toBe('Compatible peer work')
    expect(store.getChat(chat)).toMatchObject({ archived: true })
    expect(live.size).toBe(0)

    // A fresh change must wait the configured five minutes after recovery, then publish without IPC.
    const published = gitIn(remote, 'rev-parse', 'main')
    writeFileSync(join(root, 'after-repair.txt'), 'Next interval')
    await vi.advanceTimersByTimeAsync(285_000)
    expect(gitIn(remote, 'rev-parse', 'main')).toBe(published)
    await vi.advanceTimersByTimeAsync(15_000)
    await nextSync.promise
    expect(gitIn(remote, 'show', 'main:after-repair.txt')).toBe('Next interval')
    expect(gitIn(root, 'status', '--porcelain')).toBe('')
    expect(launches).toEqual(['codex'])
  } finally { fixture.cleanup() }
})

it('recovers a persisted manifest conflict after startup with an empty registry cache', async () => {
  const clones = conflictingClones()
  const { root, remote, peer } = clones
  updateForge(peer, world => { world.syncMinutes = 12 })
  gitIn(peer, 'commit', '-am', 'Remote interval')
  gitIn(peer, 'push', 'origin', 'main')
  updateForge(root, world => { world.syncMinutes = 7 })
  gitIn(root, 'add', '.')
  gitIn(root, 'commit', '-m', 'Local interval')
  expect(() => gitIn(root, 'pull', '--no-rebase', remote, 'main')).toThrow()
  expect(gitIn(root, 'ls-files', '-u')).toContain('forge-world.json')
  const launches: string[] = []
  const fixture = scheduledFixture(clones, {
    onConflict: async world => { launches.push(world) },
    onSynced: async () => { throw new Error('An unresolved merge must not publish') }
  })
  try {
    await fixture.ready
    expect(fixture.registry.list().find(folder => folder.path === root)).toMatchObject({ forgeIssue: true, available: false })
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(fixture.call('sync')).rejects.toThrow()
    expect(launches).toEqual([root])
    expect(fixture.registry.list().find(folder => folder.path === root)).toMatchObject({ forgeWorld: { syncMinutes: 7 }, available: true })
    expect(gitIn(root, 'ls-files', '-u')).toContain('forge-world.json')
  } finally { fixture.cleanup() }
})
