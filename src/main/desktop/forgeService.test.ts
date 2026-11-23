import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ownedPaths } from '../../core/repo/paths'
import { resolveLayout } from '../../core/repo/layout'
import type { IpcMain } from 'electron'
import { afterAll, beforeAll, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { openWorkspace } from '../../core/workspace'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { createFolderRegistry } from './folderRegistry'
import { forgeKickoff, updateForge } from './forgeManifest'
import { startForge } from './forgeService'
import { createTestWorkspacePool as createWorkspacePool } from './__mocks__/projectWorkspaceFixture'
import { bindToolingGrant, holdToolingWorkflow, retireToolingWorkflow } from '../../core/services/toolingHold'
import { dbProjectDir } from '../../core/repo/storageMode'
import { bindForge, pendingForgeTransfer } from '../../core/repo/forgeBinding'
import { ensureForgeConfig } from '../../core/repo/forgeReference'
import { nodeFs } from '../../core/repo/nodeFs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

function initializeCheckout(dir: string, repository: string): void {
  mkdirSync(dir)
  gitIn(dir, 'init', '-b', 'main')
  gitIn(dir, 'config', 'user.name', 'Test')
  gitIn(dir, 'config', 'user.email', 'test@example.test')
  gitIn(dir, 'remote', 'add', 'origin', 'https://github.com/example/' + repository + '.git')
}

type NetworkFailure = string | ((args: readonly string[]) => boolean) | null

function networkFailureAt(failure: NetworkFailure, args: readonly string[]): string | undefined {
  if (typeof failure === 'function') return failure(args) ? 'final restore publication' : undefined
  return failure && args.includes(failure) ? failure : undefined
}

function fixture(seed?: { source: string; world: string }) {
  const scratch = scratchDir('forge-convert-')
  const home = join(scratch.path, 'home')
  const source = join(scratch.path, 'Software')
  const world = join(scratch.path, 'TicketStore')
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Desktop fixture', serverInfo: { name: 'fixture', version: '1' } }), home)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const call = async (name: string, ...args: unknown[]) => handlers.get('forge:' + name)!({} as Electron.IpcMainInvokeEvent, ...args)
  for (const dir of [source, world]) {
    if (seed) cpSync(dir === world ? seed.world : seed.source, dir, { recursive: true })
    else initializeCheckout(dir, dir === world ? 'tickets' : 'software')
    registry.track(dir)
  }
  const real = createGitRunner()
  const published: string[] = []
  const probes: string[] = []
  const syncReceipts: Array<() => void> = []
  let picked: string | null = source
  let failingNetwork: NetworkFailure = null
  const forge = startForge({ handle: (key, handler) => { handlers.set(key, handler) } }, {
    home, registry, pool, session: { getAccount: () => ({ login: 'example', host: 'github.com' }), getToken: () => null },
    pickDirectory: async () => picked, cleanup: () => undefined, publish: async name => { published.push(name) },
    onSynced: async () => { syncReceipts.shift()?.() }, onConflict: async () => { throw new Error('Unexpected conflict') },
    runner: { run: async req => {
      if (req.args.includes('push')) probes.push(req.cwd)
      if (req.kind !== 'network') return real.run(req)
      const failure = networkFailureAt(failingNetwork, req.args)
      if (failure !== undefined) throw new Error('Injected network failure at ' + failure)
      if (req.args.includes('clone')) {
        const dir = req.args.at(-1)!
        mkdirSync(dir)
        gitIn(dir, 'init', '-b', 'main')
        gitIn(dir, 'remote', 'add', 'origin', req.args.at(-2)!)
        gitIn(dir, 'config', 'user.name', 'Test')
        gitIn(dir, 'config', 'user.email', 'test@example.test')
      }
      return { code: 0, stdout: '', stderr: '' }
    } }
  })
  return { pool, source, world, home, registry, call, forge, published, probes, pick(path: string | null) { picked = path },
    nextSync: () => new Promise<void>(resolve => { syncReceipts.push(resolve) }),
    failNetwork(command: NetworkFailure) { failingNetwork = command },
    async close() {
      forge.stop()
      await forge.ready
      await pool.closeAll()
      scratch.cleanup()
    } }
}

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url))
let crashBundle: ReturnType<typeof scratchDir>
let emptyWorldSeed: ReturnType<typeof fixture>
let crashSeed: ReturnType<typeof fixture>
let crashCardId: string

// Compile the actual source checkout once. Every scenario still kills a separate process,
// but does not start a TSX transformer for the whole application graph inside its timeout.
beforeAll(async () => {
  const seedStarted = Date.now()
  // Copy only these two prepared repositories. Each test creates its own registry,
  // machine home, bindings, and stores before converting or restoring any data.
  emptyWorldSeed = fixture()
  await emptyWorldSeed.call('create', emptyWorldSeed.world)
  emptyWorldSeed.forge.stop()
  await emptyWorldSeed.pool.closeAll()
  crashSeed = fixture(emptyWorldSeed)
  const source = crashSeed.pool.get(crashSeed.source)
  await source.initializeRepository({ name: 'Crash recovery', mode: 'repo' })
  const card = await source.createKanbanCard({ title: 'Only one restart' })
  crashCardId = card.id
  await source.playKanbanCard({ cardId: card.id })
  await crashSeed.forge.ready
  crashSeed.forge.stop()
  await crashSeed.pool.closeAll()
  // Each case copies only these closed repositories. Home, registry, bindings and
  // journals are fresh, and no conversion has run in this immutable seed.
  expect(existsSync(join(crashSeed.world, 'Software'))).toBe(false)
  expect(existsSync(join(crashSeed.source, 'FORGE-WORLD.md'))).toBe(false)
  expect(pendingForgeTransfer(crashSeed.home, crashSeed.source)).toBeNull()
  if (process.env.DM_FORGE_TEST_TIMINGS === '1') process.stderr.write(`Closed pre-migration seed prepared once in ${Date.now() - seedStarted}ms\n`)
  crashBundle = scratchDir('forge-crash-bundle-')
  buildSync({
    stdin: { contents: crashFixtureSource(), resolveDir: sourceRoot },
    outfile: join(crashBundle.path, 'crash.cjs'), bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', loader: { '.md': 'text' }, logLevel: 'warning',
    // The disposable bundle resolves native dependencies from this test's checkout,
    // including Fireguard snapshots, rather than from the temporary folder or user home.
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(join(sourceRoot, 'package.json'))});` }
  })
})
afterAll(async () => {
  crashBundle?.cleanup()
  await crashSeed?.close()
  await emptyWorldSeed?.close()
})

function crashFixtureSource(): string {
  return `
    import { syncBuiltinESMExports } from 'node:module';
    import { openWorkspace } from './src/core/workspace';
    import { createFolderRegistry } from './src/main/desktop/folderRegistry';
    import { createTestWorkspacePool as createWorkspacePool } from './src/main/desktop/__mocks__/projectWorkspaceFixture';
    import { startForge } from './src/main/desktop/forgeService';
    import { createGitRunner } from './src/main/git/runner';
    async function main() {
    const fs = require('node:fs'); const rename = fs.renameSync; const mkdir = fs.mkdirSync;
    const { home, source, world, point, spawnedAt } = JSON.parse(process.argv[2]);
    process.stderr.write('Fixture modules loaded at ' + (Date.now() - spawnedAt) + 'ms\\n');
    fs.mkdirSync = (path, options) => {
      const result = mkdir(path, options);
      if (point === 'member' && String(path).replaceAll('\\\\', '/').endsWith('/TicketStore/Software')) process.exit(91);
      if (point === 'staging' && String(path).replaceAll('\\\\', '/').endsWith('/.darkmechanicus.preparing/local')) process.exit(91);
      return result;
    };
    fs.renameSync = (from, to) => {
      rename(from, to);
      const path = String(to).replaceAll('\\\\', '/');
      if ((point === 'reservation' && path.endsWith('.move.json') && JSON.parse(fs.readFileSync(to, 'utf8')).phase === 1) ||
          (point === 'checkpoint' && path.endsWith('/.darkmechanicus.preparing/local/migration-records.json')) ||
          (point === 'destination' && path.endsWith('/Software/.darkmechanicus')) ||
          (point === 'manifest' && path.endsWith('/TicketStore/forge-world.json'))) process.exit(91);
    }; syncBuiltinESMExports();
    const registry = createFolderRegistry({ file: home + '/folders.json', dmHome: home, homeDir: home });
    const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Crash fixture' }), home);
    const real = createGitRunner(); const handlers = new Map();
    startForge({ handle: (key, handler) => handlers.set(key, handler) }, {
      home, registry, pool, session: { getAccount: () => ({login:'example',host:'github.com'}), getToken: () => null },
      pickDirectory: async () => source, cleanup() {}, publish: async () => {}, onSynced: async () => {}, onConflict: async () => {},
      runner: { run: req => req.kind === 'network' ? Promise.resolve({code:0,stdout:'',stderr:''}) : real.run(req) }
    });
    process.stderr.write('Conversion started at ' + (Date.now() - spawnedAt) + 'ms\\n');
    await handlers.get('forge:convert')({}, world, source, {force:true}); process.exit(92);
    }
    void main();`
}

function interruptExport(f: ReturnType<typeof fixture>, point: 'reservation' | 'member' | 'staging' | 'checkpoint' | 'destination' | 'manifest') {
  const spawnedAt = Date.now()
  const result = spawnSync(process.execPath, [join(crashBundle.path, 'crash.cjs'), JSON.stringify({ home: f.home, source: f.source, world: f.world, point, spawnedAt })], {
    cwd: sourceRoot, encoding: 'utf8', windowsHide: true
  })
  return { ...result, stderr: result.stderr + `Child exited at ${Date.now() - spawnedAt}ms\n` }
}

it.each(['reservation', 'member', 'staging', 'checkpoint', 'destination', 'manifest'] as const)('resumes force exactly once after process death at %s', async point => {
  const started = Date.now()
  const timings: string[] = []
  const mark = (phase: string) => timings.push(`${point}: ${phase} at ${Date.now() - started}ms`)
  const emitTimings = () => { process.stderr.write(timings.join('\n') + '\n') }
  onTestFailed(emitTimings)
  if (process.env.DM_FORGE_TEST_TIMINGS === '1') onTestFinished(emitTimings)
  const f = fixture(crashSeed)
  mark('fixture')
  try {
    const crashed = interruptExport(f, point)
    mark('crashed: ' + crashed.stderr.trim())
    expect(crashed.status, crashed.stderr).toBe(91)
    expect(pendingForgeTransfer(f.home, f.source)).toBe(join(f.world, 'Software'))
    await expect(f.pool.get(f.source).getStorageStatus()).rejects.toThrow('conversion is pending')
    await expect(f.pool.get(join(f.world, 'Software')).getStorageStatus()).rejects.toThrow('conversion is pending')
    await expect(f.call('sync', f.world)).rejects.toThrow('conversion is pending')
    expect(await f.forge.openProject(f.source)).toBe(join(f.world, 'Software'))
    mark('recovered')
    const dest = f.pool.get(join(f.world, 'Software'))
    expect((await dest.getKanbanCard({ cardId: crashCardId })).lane).toBe('backlog')
    expect(dest.ctx().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kanban_events WHERE card_id = ? AND kind = 'migration_restarted'", crashCardId)?.n).toBe(1)
    expect(pendingForgeTransfer(f.home, f.source)).toBeNull()
  } finally { await f.close() }
})

it('requires a live foreign source process to exit before restoring, even after its SQLite handle closed', async () => {
  const f = fixture()
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const exited = once(child, 'exit')
  const worker = openWorkspace({ repoRoot: f.source, homeDir: f.home, role: 'orchestrator', transport: 'in_process', label: 'Legacy process', pid: child.pid })
  try {
    await f.pool.get(f.source).initializeRepository({ name: 'Legacy handle proof', mode: 'db' })
    await worker.getProject()
    await f.call('create', f.world)
    await f.call('convert', f.world, f.source, { force: true })
    worker.close()
    const member = join(f.world, 'Software')
    await expect(f.call('restore', member, 'db')).rejects.toThrow('other processes')
    expect(existsSync(join(f.source, 'FORGE-WORLD.md'))).toBe(true)
    child.kill()
    await exited
    expect(await f.call('restore', member, 'db')).toBe(f.source)
  } finally { child.kill(); await exited; worker.close(); await f.close() }
})

it.each(['receipt', 'unrelated', 'owner'] as const)('keeps a resumed %s integrity failure and its persistent fence for inspection', async changed => {
  const f = fixture(crashSeed)
  try {
    const crashed = interruptExport(f, changed === 'receipt' ? 'manifest' : changed === 'owner' ? 'checkpoint' : 'reservation')
    expect(crashed.status, crashed.stderr).toBe(91)
    const member = join(f.world, 'Software')
    let path: string
    if (changed === 'unrelated') {
      mkdirSync(member)
      path = join(member, 'unrelated.txt')
    } else {
      path = join(member, changed === 'receipt' ? '.darkmechanicus/local/forge-export.json' : '.darkmechanicus.preparing/local/forge-owner.json')
    }
    const bytes = changed === 'unrelated' ? 'Unrelated data must survive' : JSON.stringify({ force: true, source: '/other', member, projectId: 'other' })
    writeFileSync(path, bytes)
    await expect(f.forge.openProject(f.source)).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    expect(pendingForgeTransfer(f.home, f.source)).toBe(member)
    await expect(f.call('sync', f.world)).rejects.toThrow('conversion is pending')
    expect(existsSync(join(f.source, '.darkmechanicus/project.json'))).toBe(true)
  } finally { await f.close() }
})

it('directs an uninitialized force source to normal migration without creating a destination', async () => {
  const f = fixture()
  try {
    await f.call('create', f.world)
    await expect(f.call('convert', f.world, f.source, { force: true })).rejects.toThrow('normal migration')
    expect(existsSync(join(f.world, 'Software'))).toBe(false)
    expect(pendingForgeTransfer(f.home, f.source)).toBeNull()
    await f.call('convert', f.world, f.source)
    expect(existsSync(join(f.source, 'FORGE-WORLD.md'))).toBe(true)
  } finally { await f.close() }
})

it.each([null, 'force', { force: false }, { force: true, unexpected: true }])('refuses malformed force IPC options %j without changing either store', async options => {
  const f = fixture()
  try {
    const source = f.pool.get(f.source)
    await source.initializeRepository({ name: 'IPC validation', mode: 'db' })
    const before = await source.getProject()
    await f.call('create', f.world)
    await expect(f.call('convert', f.world, f.source, options)).rejects.toThrow('valid Forge migration option')
    expect(await source.getProject()).toEqual(before)
    expect(existsSync(join(f.world, 'Software'))).toBe(false)
    expect(pendingForgeTransfer(f.home, f.source)).toBeNull()
  } finally { await f.close() }
})

it.each(['repo', 'db'] as const)('force converts %s live claims, keeps a private source backup and fences the old handle', async mode => {
  const f = fixture()
  const worker = openWorkspace({ repoRoot: f.source, homeDir: f.home, transport: 'in_process', role: 'orchestrator', label: 'Old worker', serverInfo: { name: 'fixture', version: '1' } })
  try {
    await f.pool.get(f.source).initializeRepository({ name: 'Force fixture', mode })
    const card = await f.pool.get(f.source).createKanbanCard({ title: 'Live work' })
    await f.pool.get(f.source).playKanbanCard({ cardId: card.id })
    const claim = await worker.claimKanbanCard({ cardId: card.id })
    await f.call('create', f.world)
    await f.call('convert', f.world, f.source, { force: true })
    const member = join(f.world, 'Software')
    expect((await f.pool.get(member).getKanbanCard({ cardId: card.id })).lane).toBe('backlog')
    expect(existsSync(join(member, '.darkmechanicus/local/pre-forge-source/project.json'))).toBe(true)
    expect(existsSync(join(f.source, 'FORGE-WORLD.md'))).toBe(true)
    await expect(worker.heartbeatKanbanCard({ attemptId: claim.attemptId, claimToken: claim.claimToken! })).rejects.toThrow('Reconnect')
    const reconnected = openWorkspace({ repoRoot: f.source, homeDir: f.home, transport: 'in_process', role: 'orchestrator', label: 'Reconnected worker' })
    try { expect((await reconnected.getKanbanCard({ cardId: card.id })).lane).toBe('backlog') }
    finally { reconnected.close() }
    expect(gitIn(f.world, 'ls-files').split('\n').some(p => p.includes('/local/'))).toBe(false)
    if (process.platform === 'win32') await expect(f.call('restore', member, mode)).rejects.toThrow('Close every session')
    await expect(worker.heartbeatKanbanCard({ attemptId: claim.attemptId, claimToken: claim.claimToken! })).rejects.toThrow('Reconnect')
    worker.close()
    expect(await f.call('restore', member, mode)).toBe(f.source)
    expect((await f.pool.get(f.source).getKanbanCard({ cardId: card.id })).lane).toBe('backlog')
    expect((await f.pool.get(f.source).getStorageStatus()).storage.mode).toBe(mode)
  } finally { worker.close(); await f.close() }
})

it('resumes force retirement after some portable paths have already moved to the verified backup', async () => {
  const f = fixture()
  const rename = nodeFs.rename
  let fault: ReturnType<typeof vi.spyOn> | undefined
  try {
    const source = f.pool.get(f.source)
    await source.initializeRepository({ name: 'Interrupted retirement', mode: 'repo' })
    const card = await source.createKanbanCard({ title: 'Preserved through interruption' })
    await f.call('create', f.world)
    fault = vi.spyOn(nodeFs, 'rename').mockImplementation((from, to) => {
      if (from === join(f.source, '.darkmechanicus/project.json')) throw new Error('Injected retirement interruption')
      rename(from, to)
    })
    await expect(f.call('convert', f.world, f.source, { force: true })).rejects.toThrow('retirement interruption')
    fault.mockRestore()
    expect(pendingForgeTransfer(f.home, f.source)).toBe(join(f.world, 'Software'))
    const backup = join(f.world, 'Software/.darkmechanicus/local/pre-forge-source')
    expect(existsSync(join(backup, 'kanban', card.id, 'card.json'))).toBe(true)
    expect(await f.forge.openProject(f.source)).toBe(join(f.world, 'Software'))
    expect(existsSync(join(backup, 'project.json'))).toBe(true)
    expect((await f.pool.get(join(f.world, 'Software')).getKanbanCard({ cardId: card.id })).title).toBe(card.title)
    expect(pendingForgeTransfer(f.home, f.source)).toBeNull()
  } finally { fault?.mockRestore(); await f.close() }
})

it('restores source writes on a definite prepublish force failure and binds force intent across uncertain push recovery', async () => {
  const f = fixture()
  try {
    const source = f.pool.get(f.source)
    await source.initializeRepository({ name: 'Recovery fixture', mode: 'db' })
    const card = await source.createKanbanCard({ title: 'Do not lose' })
    await f.call('create', f.world)
    const originalCall = source.call
    const exportFailure = vi.spyOn(source, 'call').mockImplementation(async (operation, ...args) => {
      if (operation === 'exportForge') throw new Error('Injected export failure')
      return originalCall(operation, ...args as never)
    })
    await expect(f.call('convert', f.world, f.source, { force: true })).rejects.toThrow('Injected export')
    exportFailure.mockRestore()
    expect(pendingForgeTransfer(f.home, f.source)).toBeNull()
    expect((await source.getKanbanCard({ cardId: card.id })).title).toBe('Do not lose')
    await source.createKanbanCard({ title: 'Source remains writable' })
    f.failNetwork('ls-remote')
    await expect(f.call('convert', f.world, f.source, { force: true })).rejects.toThrow('Injected network')
    expect(pendingForgeTransfer(f.home, f.source)).toBe(join(f.world, 'Software'))
    await expect(source.createKanbanCard({ title: 'Blocked after sync began' })).rejects.toThrow('conversion is pending')
    f.failNetwork('push')
    await expect(f.call('convert', f.world, f.source, { force: true })).rejects.toThrow('Injected network')
    expect(pendingForgeTransfer(f.home, f.source)).toBe(join(f.world, 'Software'))
    await expect(f.call('convert', f.world, f.source)).rejects.toThrow('same migration option')
    f.failNetwork(null)
    expect(await f.forge.openProject(f.source)).toBe(join(f.world, 'Software'))
    expect(pendingForgeTransfer(f.home, f.source)).toBeNull()
  } finally { await f.close() }
})

it('converts a real SQLite project, follows its source note and restores the same card to the code repo', async () => {
  const { pool, source, world, call, forge, close } = fixture(emptyWorldSeed)
  try {
    const original = pool.get(source)
    await original.initializeRepository({ name: 'Software', mode: 'db' })
    const card = await original.createKanbanCard({ title: 'Keep me' })
    await call('convert', world, source)
    expect(readFileSync(join(source, 'FORGE-WORLD.md'), 'utf8')).toContain('example/tickets.git')
    expect(JSON.parse(readFileSync(join(source, '.forge-world.json'), 'utf8'))).toEqual({ version: 1, worldRepository: 'https://github.com/example/tickets.git', projectFolder: 'Software' })
    const member = await forge.openProject(source)
    expect(member).toBe(join(world, 'Software'))
    expect(forgeKickoff(member)).toContain('https://github.com/example/software.git')
    expect(forgeKickoff(source)).toBe('')
    expect((await pool.get(member).getStorageStatus()).storage.mode).toBe('forge')
    await expect(pool.get(member).switchStorageMode({ mode: 'db', confirmed: true })).rejects.toThrow('Ticket source control')
    expect((await pool.get(member).getKanbanCard({ cardId: card.id })).title).toBe('Keep me')
    await call('restore', member, 'repo')
    expect(existsSync(join(source, 'FORGE-WORLD.md'))).toBe(false)
    expect(existsSync(join(source, '.forge-world.json'))).toBe(false)
    expect((await pool.get(source).getKanbanCard({ cardId: card.id })).title).toBe('Keep me')
  } finally { await close() }
})

it('syncs only worlds at the configured interval and stops when the bridge closes', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const { world, call, forge, probes, nextSync, close } = fixture()
  try {
    await call('create', world)
    probes.length = 0
    await vi.advanceTimersByTimeAsync(285_000)
    expect(probes).toEqual([])
    const first = nextSync()
    await vi.advanceTimersByTimeAsync(15_000)
    await first
    expect(probes).toEqual([world])
    await vi.advanceTimersByTimeAsync(285_000)
    expect(probes).toEqual([world])
    const second = nextSync()
    await vi.advanceTimersByTimeAsync(15_000)
    await second
    expect(probes).toEqual([world, world])
    await call('interval', world, 1)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(probes).toHaveLength(2)
    const third = nextSync()
    await vi.advanceTimersByTimeAsync(15_000)
    await third
    expect(probes).toEqual([world, world, world])
    forge.stop()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(probes).toHaveLength(3)
  } finally { await close(); vi.useRealTimers() }
})

it('publishes under the signed-in owner, reuses the checkout and resolves a tracked remote on open', async () => {
  const { source, home, registry, call, forge, published, pick, close } = fixture()
  try {
    expect(await forge.openProject(source)).toBe(source)
    await expect(call('connect', source, 'other/tickets', true)).rejects.toThrow('signed-in account')
    expect(published).toEqual([])
    const root = await call('connect', source, 'example/Forge', true)
    expect(root).toBe(join(home, 'forge-worlds', 'example', 'Forge'))
    expect(published).toEqual(['Forge'])
    expect(await call('connect', source, 'example/Forge', false)).toBe(root)
    await call('add', root, 'example/software', 'Code')
    const member = join(root, 'Code')
    expect(await forge.openProject(root)).toBe(root)
    expect(await forge.openProject(source)).toBe(member)
    expect(registry.list().find(f => f.path === root)?.forgeWorld?.projects).toEqual([{ folder: 'Code', repository: 'https://github.com/example/software.git' }])
    expect(registry.list().find(f => f.path === root)?.name).toBe('Forge World example')
    await expect(call('convert', root, member)).rejects.toThrow('source code project')
    await expect(call('convert', root, source)).rejects.toThrow('already exists')
    await expect(call('restore', root, 'repo')).rejects.toThrow('Select a Forge World project')
    await expect(call('restore', member, 'invalid')).rejects.toThrow('SQLite only')
    pick(null)
    expect(await call('restore', member, 'db')).toBeNull()
    await call('pickConvert', root)
    expect(registry.list().filter(f => f.forgeParent === root).map(f => f.name)).toEqual(['Code'])
  } finally { await close() }
})

it('moves an uninitialized checkout into a world, validates its pointer and restores SQLite', async () => {
  const { pool, source, world, call, forge, pick, close } = fixture(emptyWorldSeed)
  const member = join(world, basename(source))
  try {
    await call('pickConvert', world)
    const note = join(source, 'FORGE-WORLD.md')
    const original = readFileSync(note, 'utf8')
    expect(original).toContain('Project folder: Software')
    const card = await pool.get(member).createKanbanCard({ title: 'New world ticket' })
    writeFileSync(note, 'unrecognized')
    await expect(forge.openProject(source)).rejects.toThrow('Cannot read')
    writeFileSync(note, original.replace('Project folder: Software', 'Project folder: Missing'))
    await expect(forge.openProject(source)).rejects.toThrow('disagree')
    await expect(call('restore', member, 'db')).rejects.toThrow('disagree')
    writeFileSync(note, original)
    pick(world)
    await expect(call('restore', member, 'db')).rejects.toThrow('linked code repository')
    pick(source)
    expect(await call('restore', member, 'db')).toBe(source)
    expect((await pool.get(source).getStorageStatus()).storage.mode).toBe('db')
    expect((await pool.get(source).getKanbanCard({ cardId: card.id })).title).toBe('New world ticket')
    expect(existsSync(note)).toBe(false)
    expect(existsSync(join(source, '.darkmechanicus'))).toBe(false)
  } finally { await close() }
})

async function seedLinkedTicket(f: ReturnType<typeof fixture>, title: string) {
  await f.forge.ready
  const folder = basename(f.source)
  const member = join(f.world, folder)
  mkdirSync(member)
  const tickets = f.pool.get(member)
  await tickets.initializeRepository({ name: folder, mode: 'repo' })
  const card = await tickets.createKanbanCard({ title })
  const worldRepository = 'https://github.com/example/tickets.git'
  updateForge(f.world, world => world.projects.push({ folder, repository: 'https://github.com/example/software.git' }))
  const note = `# Ticket source control\n\nForge World: ${worldRepository}\nProject folder: ${folder}\n`
  writeFileSync(join(f.source, 'FORGE-WORLD.md'), note)
  ensureForgeConfig(f.source, { version: 1, worldRepository, projectFolder: folder })
  bindForge(f.home, f.source, member, note)
  f.registry.untrack(f.source)
  gitIn(f.world, 'add', '--', 'forge-world.json', folder)
  gitIn(f.world, 'commit', '-m', 'Prepare an already linked ticket project')
  return { member, card }
}

it('resumes a restore from the source pointer after the final publication was interrupted', async () => {
  const f = fixture(emptyWorldSeed)
  try {
    const { member, card } = await seedLinkedTicket(f, 'Restored after publication interruption')
    const memberStore = join(member, '.darkmechanicus')
    f.failNetwork(args => args.includes('push') && !existsSync(memberStore))
    await expect(f.call('restore', member, 'db')).rejects.toThrow('final restore publication')
    expect(existsSync(memberStore)).toBe(false)
    expect(existsSync(join(f.source, 'FORGE-WORLD.md'))).toBe(true)
    expect(pendingForgeTransfer(f.home, member)).toBe(f.source + '/db')
    f.failNetwork(null)
    expect(await f.forge.openProject(f.source)).toBe(f.source)
    expect(pendingForgeTransfer(f.home, member)).toBeNull()
    expect(existsSync(join(f.source, 'FORGE-WORLD.md'))).toBe(false)
    expect(existsSync(join(f.source, '.forge-world.json'))).toBe(false)
    const restored = f.pool.get(f.source)
    expect(await restored.getKanbanCard({ cardId: card.id })).toMatchObject({ title: card.title })
    expect((await restored.listKanbanCards({})).lanes.backlog.map(value => value.id)).toEqual([card.id])
  } finally { await f.close() }
})

it('refuses conversion and restoration of planner-only holds without moving ticket state or retiring the incident', async () => {
  const { pool, source, world, home, registry, call, forge, close } = fixture(emptyWorldSeed)
  try {
    const original = pool.get(source)
    await original.initializeRepository({ name: 'Held planner', mode: 'db' })
    const card = await original.createKanbanCard({ title: 'Unfinished planning' })
    const grant = await original.issueGrant({ role: 'planner', label: 'Held planner' })
    bindToolingGrant(original.ctx(), grant.grant.id, 'chat_source')
    holdToolingWorkflow(original.ctx(), { id: 'chat_source', incidentId: 'source_incident' })
    const planner = openWorkspace({ repoRoot: source, homeDir: home, role: 'planner', transport: 'cli', label: 'Planner', grantToken: grant.token })
    await expect(planner.createKanbanCard({ title: 'Premature progress' })).rejects.toMatchObject({ code: 'invalid_state' })
    planner.close()
    const member = join(world, 'Software')
    await expect(call('convert', world, source)).rejects.toThrow('tooling recovery')
    await expect(call('convert', world, source, { force: true })).rejects.toThrow('tooling recovery')
    expect(original.ctx().db.all('SELECT chat_id, incident_id FROM tooling_holds')).toEqual([{ chat_id: 'chat_source', incident_id: 'source_incident' }])
    expect((await original.getKanbanCard({ cardId: card.id })).title).toBe('Unfinished planning')
    expect(registry.resolve(source)).toBe(source)
    expect(existsSync(join(source, 'FORGE-WORLD.md'))).toBe(false)
    expect(existsSync(member)).toBe(false)
    expect(pendingForgeTransfer(home, source)).toBeNull()
    retireToolingWorkflow(original.ctx(), 'chat_source')
    await call('convert', world, source)
    expect(await forge.openProject(source)).toBe(member)
    const linked = pool.get(member)
    const linkedGrant = await linked.issueGrant({ role: 'planner', label: 'Held member planner' })
    bindToolingGrant(linked.ctx(), linkedGrant.grant.id, 'chat_member')
    holdToolingWorkflow(linked.ctx(), { id: 'chat_member', incidentId: 'member_incident' })
    const pointer = readFileSync(join(source, 'FORGE-WORLD.md'), 'utf8')
    await expect(call('restore', member, 'db')).rejects.toThrow('tooling recovery')
    expect(linked.ctx().db.all('SELECT chat_id, incident_id FROM tooling_holds')).toEqual([{ chat_id: 'chat_member', incident_id: 'member_incident' }])
    expect((await linked.getKanbanCard({ cardId: card.id })).title).toBe('Unfinished planning')
    expect(readFileSync(join(source, 'FORGE-WORLD.md'), 'utf8')).toBe(pointer)
    expect(existsSync(dbProjectDir(source, home))).toBe(false)
    expect(existsSync(join(member, '.darkmechanicus'))).toBe(true)
    expect(pendingForgeTransfer(home, member)).toBeNull()
    retireToolingWorkflow(linked.ctx(), 'chat_member')
    await call('restore', member, 'db')
    expect((await pool.get(source).getKanbanCard({ cardId: card.id })).title).toBe('Unfinished planning')
  } finally { await close() }
})

it('reports preparing until the local member owner reconciles and does no remote Git work for readiness', async () => {
  const { world, call, pool, probes, close } = fixture()
  let release = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  const reconcile = pool.reconcile
  let prepared: ReturnType<typeof reconcile> | undefined
  const intercept = vi.spyOn(pool, 'reconcile').mockImplementation(path => (prepared ??= blocked.then(() => reconcile(path))))
  try {
    await call('create', world)
    probes.length = 0
    const member = join(world, 'LocalOnly')
    mkdirSync(member)
    await pool.get(member).initializeRepository({ name: 'Local tickets' })
    updateForge(world, manifest => manifest.projects.push({ folder: 'LocalOnly', repository: 'https://github.com/example/code.git' }))
    expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'preparing', syncing: true })
    expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'preparing', syncing: true })
    expect(intercept).toHaveBeenCalledTimes(1)
    release()
    await prepared
    expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'ready' })
    expect(probes).toEqual([])
  } finally {
    release()
    intercept.mockRestore()
    await close()
  }
})

it('keeps old member preparation errors out of a retracked root generation', async () => {
  const { world, call, pool, registry, forge, close } = fixture()
  let lose: (reason: Error) => void = () => undefined
  const previous = new Promise<never>((_resolve, reject) => { lose = reject })
  const reconcile = pool.reconcile
  const intercept = vi.spyOn(pool, 'reconcile').mockReturnValueOnce(previous)
  try {
    await call('create', world)
    const member = join(world, 'Returning')
    mkdirSync(member)
    await pool.get(member).initializeRepository({ name: 'Returning tickets' })
    updateForge(world, manifest => manifest.projects.push({ folder: 'Returning', repository: 'https://github.com/example/code.git' }))
    expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'preparing' })
    registry.untrack(world)
    expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'removed' })
    registry.track(world)
    await forge.openWorld(world)
    let current: ReturnType<typeof reconcile> | undefined
    intercept.mockImplementation(path => (current ??= reconcile(path)))
    expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'preparing', error: null })
    lose(new Error('Obsolete generation failed'))
    await current
    expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'ready', error: null })
  } finally {
    lose(new Error('Fixture closed'))
    intercept.mockRestore()
    await close()
  }
})

it.each([
  { cached: true, readiness: 'ready' },
  { cached: false, readiness: 'preparing' }
] as const)('uses previously validated cached data after a real rejected import ($cached)', async ({ cached, readiness }) => {
  const { world, home, call, pool, close, registry, forge } = fixture()
  const reconcile = pool.reconcile
  let attempted: ReturnType<typeof reconcile> | undefined
  const read = vi.spyOn(pool, 'reconcile').mockImplementation(path => (attempted = reconcile(path)))
  try {
    await call('create', world)
    const member = join(world, 'CachedMember')
    mkdirSync(member)
    await pool.get(member).initializeRepository({ name: 'Cached board' })
    const card = await pool.get(member).createKanbanCard({ title: 'Portable history to validate' })
    await pool.close(member)
    if (!cached) renameSync(join(member, '.darkmechanicus', 'local'), join(home, 'isolated-before-first-import'))
    writeFileSync(ownedPaths(resolveLayout(member)).kanbanCardFile(card.id), '{')
    updateForge(world, manifest => manifest.projects.push({ folder: 'CachedMember', repository: 'https://github.com/example/code.git' }))
    expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'preparing', syncing: true })
    expect((await attempted)?.result.rejected.length).toBeGreaterThan(0)
    await Promise.resolve()
    expect(await call('memberStatus', world, member)).toMatchObject({ readiness, error: 'Ticket records need reconciliation.' })
    if (!cached) {
      await pool.close(member)
      registry.untrack(world)
      registry.track(world)
      await forge.openWorld(world)
      expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'preparing', syncing: true })
      expect((await attempted)?.hasLocalCache).toBe(false)
      await Promise.resolve()
      expect(await call('memberStatus', world, member)).toMatchObject({ readiness: 'preparing', error: 'Ticket records need reconciliation.' })
    }
  } finally { read.mockRestore(); await close() }
})
