import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMain } from 'electron'
import { expect, it, vi } from 'vitest'
import { openWorkspace } from '../../core/workspace'
import { withForgeTransfer } from '../../core/repo/forgeBinding'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { createFolderRegistry } from './folderRegistry'
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

function resolverFixture(options: { initializedWorld?: boolean; onConflict?: Parameters<typeof startForge>[1]['onConflict']; beforeRun?: (args: readonly string[]) => Promise<void> } = {}) {
  const fixture = scratchDir('forge-resolver-')
  const root = join(fixture.path, 'world')
  const home = join(fixture.path, 'home')
  initializeOrigin(root)
  if (options.initializedWorld) createForge(root, 'owner')
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  registry.track(root)
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Resolver fixture', serverInfo: { name: 'fixture', version: '1' } }), home)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const call = async (name: string, ...args: unknown[]) => handlers.get('forge:' + name)!({} as Electron.IpcMainInvokeEvent, ...args)
  const events: string[] = []
  const runner = createGitRunner()
  let upstream = ''
  const forge = startForge({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    home, registry, pool, session: { getAccount: () => null, getToken: () => null },
    cleanup: () => undefined, pickDirectory: async () => null, publish: async () => undefined,
    onConflict: options.onConflict ?? (async (_world, member) => { events.push('resolve ' + member) }),
    onSynced: async () => { events.push('archive') },
    runner: { run: async req => {
      await options.beforeRun?.(req.args)
      if (req.kind !== 'network') return runner.run(req)
      if (req.args.includes('fetch')) writeFileSync(join(root, '.git/FETCH_HEAD'), upstream + "\t\tbranch 'main'\n")
      if (req.args.includes('push')) { upstream = gitIn(root, 'rev-parse', 'HEAD').trim(); events.push('push') }
      return { code: 0, stderr: '', stdout: req.args.includes('ls-remote') ? upstream : '' }
    } }
  })
  return { root, call, events, forge, registry, pool, setUpstream: (sha: string) => { upstream = sha }, cleanup: () => { forge.stop(); pool.closeAll(); fixture.cleanup() } }
}

function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function seedConflict(fixture: ReturnType<typeof resolverFixture>) {
  const { root, setUpstream } = fixture
  createForge(root, 'owner')
  writeFileSync(join(root, 'README.md'), 'Original\n')
  gitIn(root, 'add', '.')
  gitIn(root, 'commit', '-m', 'Initial world')
  gitIn(root, 'switch', '-c', 'remote')
  writeFileSync(join(root, 'README.md'), 'Remote\n')
  gitIn(root, 'commit', '-am', 'Remote edit')
  setUpstream(gitIn(root, 'rev-parse', 'HEAD').trim())
  gitIn(root, 'switch', 'main')
  writeFileSync(join(root, 'README.md'), 'Local\n')
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

function conflictingClones() {
  const fixture = scratchDir('forge-scheduled-')
  const root = join(fixture.path, 'world')
  const remote = join(fixture.path, 'origin.git')
  const peer = join(fixture.path, 'peer')
  const home = join(fixture.path, 'home')
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
  gitIn(peer, 'commit', '-am', 'Peer change')
  gitIn(peer, 'push', 'origin', 'main')
  writeFileSync(join(root, 'README.md'), 'Local directions\n')
  const url = 'https://github.com/owner/tickets.git'
  gitIn(root, 'remote', 'set-url', 'origin', url)
  return { root, remote, peer, home, url, cleanup: fixture.cleanup }
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
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, role: 'desktop', transport: 'desktop', label: 'Reservation fixture' }), home)
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

it('automatically commits, pulls, restarts unresolved repair and pushes a resolved merge between real clones', async () => {
  const { root, remote, peer, home, url, cleanup } = conflictingClones()
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  registry.track(root)
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Scheduled fixture', serverInfo: { name: 'fixture', version: '1' } }))
  const real = createGitRunner()
  const conflicts: string[] = []
  const conflictReceipts: Array<() => void> = []
  const conflicted = () => new Promise<void>(resolve => conflictReceipts.push(resolve))
  let notifySynced: () => void = () => undefined
  const synced = new Promise<void>(resolve => { notifySynced = resolve })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const forge = startForge({ handle: () => undefined }, {
    home, registry, pool, session: { getAccount: () => null, getToken: () => null },
    cleanup: () => undefined, pickDirectory: async () => null, publish: async () => undefined,
    onConflict: async world => { conflicts.push(world); conflictReceipts.shift()?.() },
    onSynced: async () => { notifySynced() },
    runner: { run: request => request.kind !== 'network' ? real.run(request) : real.run({ ...request, args: [
      '-c', 'url.' + pathToFileURL(remote).href + '.insteadOf=' + url,
      ...request.args.map(arg => arg === 'protocol.allow=never' ? 'protocol.file.allow=always' : arg)
    ] }) }
  })
  try {
    await forge.ready
    const first = conflicted()
    await vi.advanceTimersByTimeAsync(15_000)
    await first
    expect(gitIn(root, 'ls-files', '-u')).toContain('README.md')
    expect(gitIn(root, 'show', 'HEAD:README.md')).toBe('Local directions\n')
    // An unresolved merge must wake its existing background resolver on the next tick,
    // not wait the five-minute normal interval or require the person to open its terminal.
    const next = conflicted()
    await vi.advanceTimersByTimeAsync(15_000)
    await next
    expect(conflicts).toEqual([root, root])
    writeFileSync(join(root, 'README.md'), 'Local and peer directions\n')
    gitIn(root, 'add', 'README.md')
    gitIn(root, 'commit', '-m', 'Agent resolves both directions')
    await vi.advanceTimersByTimeAsync(15_000)
    await synced
    expect(gitIn(remote, 'rev-parse', 'main').trim()).toBe(gitIn(root, 'rev-parse', 'HEAD').trim())
    gitIn(peer, 'pull', '--ff-only')
    expect(readFileSync(join(peer, 'README.md'), 'utf8')).toBe('Local and peer directions\n')
    expect(gitIn(root, 'branch', '--show-current').trim()).toBe('main')
    expect(gitIn(root, 'status', '--porcelain')).toBe('')
  } finally { forge.stop(); vi.useRealTimers(); pool.closeAll(); cleanup() }
})
