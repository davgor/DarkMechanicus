import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { IpcMain } from 'electron'
import { expect, it, vi } from 'vitest'
import { openWorkspace } from '../../core/workspace'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { createFolderRegistry } from './folderRegistry'
import { forgeKickoff } from './forgeManifest'
import { startForge } from './forgeService'
import { createWorkspacePool } from './workspacePool'
import { bindToolingGrant, holdToolingWorkflow, retireToolingWorkflow } from '../../core/services/toolingHold'
import { dbProjectDir } from '../../core/repo/storageMode'
import { pendingForgeTransfer } from '../../core/repo/forgeBinding'
import { nodeFs } from '../../core/repo/nodeFs'

function fixture() {
  const scratch = scratchDir('forge-convert-')
  const home = join(scratch.path, 'home')
  const source = join(scratch.path, 'Software')
  const world = join(scratch.path, 'TicketStore')
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Desktop fixture', serverInfo: { name: 'fixture', version: '1' } }))
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const call = async (name: string, ...args: unknown[]) => handlers.get('forge:' + name)!({} as Electron.IpcMainInvokeEvent, ...args)
  for (const dir of [source, world]) {
    mkdirSync(dir)
    gitIn(dir, 'init', '-b', 'main')
    gitIn(dir, 'config', 'user.name', 'Test')
    gitIn(dir, 'config', 'user.email', 'test@example.test')
    gitIn(dir, 'remote', 'add', 'origin', 'https://github.com/example/' + (dir === world ? 'tickets' : 'software') + '.git')
    registry.track(dir)
  }
  const real = createGitRunner()
  const published: string[] = []
  const probes: string[] = []
  let picked: string | null = source
  let failingNetwork: string | null = null
  const forge = startForge({ handle: (key, handler) => { handlers.set(key, handler) } }, {
    home, registry, pool, session: { getAccount: () => ({ login: 'example', host: 'github.com' }), getToken: () => null },
    pickDirectory: async () => picked, cleanup: () => undefined, publish: async name => { published.push(name) },
    onSynced: async () => undefined, onConflict: async () => { throw new Error('Unexpected conflict') },
    runner: { run: async req => {
      if (req.args.includes('--show-toplevel')) probes.push(req.cwd)
      if (req.kind !== 'network') return real.run(req)
      if (failingNetwork && req.args.includes(failingNetwork)) throw new Error('Injected network failure at ' + failingNetwork)
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
    failNetwork(command: string | null) { failingNetwork = command },
    close() { forge.stop(); pool.closeAll(); scratch.cleanup() } }
}

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
  } finally { worker.close(); f.close() }
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
  } finally { fault?.mockRestore(); f.close() }
})

it('restores source writes on a definite prepublish force failure and binds force intent across uncertain push recovery', async () => {
  const f = fixture()
  try {
    const source = f.pool.get(f.source)
    await source.initializeRepository({ name: 'Recovery fixture', mode: 'db' })
    const card = await source.createKanbanCard({ title: 'Do not lose' })
    await f.call('create', f.world)
    const exportFailure = vi.spyOn(source, 'exportForge').mockImplementationOnce(() => { throw new Error('Injected export failure') })
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
  } finally { f.close() }
})

it('converts a real SQLite project, follows its source note and restores the same card to the code repo', async () => {
  const { pool, source, world, call, forge, close } = fixture()
  try {
    const original = pool.get(source)
    await original.initializeRepository({ name: 'Software', mode: 'db' })
    const card = await original.createKanbanCard({ title: 'Keep me' })
    await call('create', world)
    await call('convert', world, source)
    expect(readFileSync(join(source, 'FORGE-WORLD.md'), 'utf8')).toContain('example/tickets.git')
    const member = await forge.openProject(source)
    expect(member).toBe(join(world, 'Software'))
    expect(forgeKickoff(member)).toContain('https://github.com/example/software.git')
    expect(forgeKickoff(source)).toBe('')
    expect((await pool.get(member).getStorageStatus()).storage.mode).toBe('forge')
    await expect(pool.get(member).switchStorageMode({ mode: 'db', confirmed: true })).rejects.toThrow('Ticket source control')
    expect((await pool.get(member).getKanbanCard({ cardId: card.id })).title).toBe('Keep me')
    await call('restore', member, 'repo')
    expect(existsSync(join(source, 'FORGE-WORLD.md'))).toBe(false)
    expect((await pool.get(source).getKanbanCard({ cardId: card.id })).title).toBe('Keep me')
  } finally { close() }
})

it('syncs only worlds at the configured interval and stops when the bridge closes', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const { world, call, forge, probes, close } = fixture()
  try {
    await call('create', world)
    probes.length = 0
    vi.advanceTimersByTime(15_000)
    expect(probes).toEqual([world])
    await call('sync', world)
    vi.advanceTimersByTime(285_000)
    expect(probes).toEqual([world])
    vi.advanceTimersByTime(15_000)
    expect(probes).toEqual([world, world])
    await call('sync', world)
    await call('interval', world, 1)
    vi.advanceTimersByTime(45_000)
    expect(probes).toHaveLength(2)
    vi.advanceTimersByTime(15_000)
    expect(probes).toEqual([world, world, world])
    await call('sync', world)
    forge.stop()
    vi.advanceTimersByTime(300_000)
    expect(probes).toHaveLength(3)
  } finally { close(); vi.useRealTimers() }
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
  } finally { close() }
})

it('moves an uninitialized checkout into a world, validates its pointer and restores SQLite', async () => {
  const { pool, source, world, call, forge, pick, close } = fixture()
  const member = join(world, basename(source))
  try {
    await call('create', world)
    await call('pickConvert', world)
    const note = join(source, 'FORGE-WORLD.md')
    const original = readFileSync(note, 'utf8')
    expect(original).toContain('Project folder: Software')
    const card = await pool.get(member).createKanbanCard({ title: 'New world ticket' })
    writeFileSync(note, 'unrecognized')
    await expect(forge.openProject(source)).rejects.toThrow('Cannot read')
    writeFileSync(note, original.replace('Project folder: Software', 'Project folder: Missing'))
    await expect(forge.openProject(source)).rejects.toThrow('does not contain')
    await expect(call('restore', member, 'db')).rejects.toThrow('linked to this project')
    writeFileSync(note, original)
    pick(world)
    await expect(call('restore', member, 'db')).rejects.toThrow('linked code repository')
    pick(source)
    expect(await call('restore', member, 'db')).toBe(source)
    expect((await pool.get(source).getStorageStatus()).storage.mode).toBe('db')
    expect((await pool.get(source).getKanbanCard({ cardId: card.id })).title).toBe('New world ticket')
    expect(existsSync(note)).toBe(false)
    expect(existsSync(join(source, '.darkmechanicus'))).toBe(false)
  } finally { close() }
})

it('refuses conversion and restoration of planner-only holds without moving ticket state or retiring the incident', async () => {
  const { pool, source, world, home, registry, call, forge, close } = fixture()
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
    await call('create', world)
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
  } finally { close() }
})
