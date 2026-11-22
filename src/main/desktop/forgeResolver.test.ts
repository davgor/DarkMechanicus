import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { createWorkspacePool } from './workspacePool'

function initializeOrigin(root: string) {
  mkdirSync(root)
  gitIn(root, 'init', '-b', 'main')
  gitIn(root, 'config', 'user.name', 'Test')
  gitIn(root, 'config', 'user.email', 'test@example.test')
  gitIn(root, 'remote', 'add', 'origin', 'https://github.com/owner/tickets.git')
}

function resolverFixture() {
  const fixture = scratchDir('forge-resolver-')
  const root = join(fixture.path, 'world')
  const home = join(fixture.path, 'home')
  initializeOrigin(root)
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  registry.track(root)
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Resolver fixture', serverInfo: { name: 'fixture', version: '1' } }))
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const call = async (name: string, ...args: unknown[]) => handlers.get('forge:' + name)!({} as Electron.IpcMainInvokeEvent, ...args)
  const events: string[] = []
  const runner = createGitRunner()
  let upstream = ''
  const forge = startForge({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    home, registry, pool, session: { getAccount: () => null, getToken: () => null },
    cleanup: () => undefined, pickDirectory: async () => null, publish: async () => undefined,
    onConflict: async (_world, member) => { events.push('resolve ' + member) },
    onSynced: async () => { events.push('archive') },
    runner: { run: async req => {
      if (req.kind !== 'network') return runner.run(req)
      if (req.args.includes('fetch')) writeFileSync(join(root, '.git/FETCH_HEAD'), upstream + "\t\tbranch 'main'\n")
      if (req.args.includes('push')) { upstream = gitIn(root, 'rev-parse', 'HEAD').trim(); events.push('push') }
      return { code: 0, stderr: '', stdout: req.args.includes('ls-remote') ? upstream : '' }
    } }
  })
  return { root, call, events, setUpstream: (sha: string) => { upstream = sha }, cleanup: () => { forge.stop(); pool.closeAll(); fixture.cleanup() } }
}

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
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, role: 'desktop', transport: 'desktop', label: 'Reservation fixture' }))
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
