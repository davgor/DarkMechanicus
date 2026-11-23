import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMain } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { openWorkspace } from '../../core/workspace'
import { FORGE_CONFIG } from '../../core/repo/forgeReference'
import { bindForge, boundForgeRoot } from '../../core/repo/forgeBinding'
import { nodeFs } from '../../core/repo/nodeFs'
import { projectKey } from '../../core/repo/storageMode'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner, type GitRunRequest } from '../git/runner'
import { createFolderRegistry } from './folderRegistry'
import { createForge, updateForge } from './forgeManifest'
import { startForge } from './forgeService'
import { createTestWorkspacePool as createWorkspacePool } from './__mocks__/projectWorkspaceFixture'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
const worldUrl = 'https://github.com/example/world.git'
const config = { version: 1, worldRepository: worldUrl, projectFolder: 'Software' }
function gitRepository(path: string) {
  mkdirSync(path)
  gitIn(path, 'init', '-b', 'main')
  gitIn(path, 'config', 'user.name', 'Bootstrap fixture')
  gitIn(path, 'config', 'user.email', 'fixture@example.test')
}

function fixtureTransport(bare: string) {
  const git = createGitRunner()
  const networkRequests: string[][] = []
  let networkUnavailable = false
  let localGitObserver: ((request: GitRunRequest) => void) | undefined
  return {
    networkRequests,
    offline(value: boolean) { networkUnavailable = value },
    afterLocalGit(observer: (request: GitRunRequest) => void) { localGitObserver = observer },
    async run(request: GitRunRequest) {
      if (request.kind !== 'network') {
        const result = await git.run(request)
        localGitObserver?.(request)
        return result
      }
      networkRequests.push([...request.args])
      if (networkUnavailable) throw new Error('The fixture remote is unavailable.')
      return git.run({ ...request, args: [
        '-c', 'url.' + pathToFileURL(bare).href + '.insteadOf=' + worldUrl,
        ...request.args.map(arg => arg === 'protocol.allow=never' ? 'protocol.file.allow=always' : arg)
      ] })
    }
  }
}

async function fixture(localWorld = false) {
  const scratch = scratchDir('forge-bootstrap-')
  cleanups.push(scratch.cleanup)
  const root = scratch.path, home = join(root, 'fresh-home'), source = join(root, 'code'), seed = join(root, 'seed'), bare = join(root, 'remote.git')
  gitRepository(source); gitRepository(seed)
  gitIn(source, 'remote', 'add', 'origin', 'https://github.com/example/software.git')
  writeFileSync(join(source, FORGE_CONFIG), JSON.stringify(config))
  createForge(seed, 'example')
  updateForge(seed, world => { world.projects.push({ folder: 'Software', repository: 'https://github.com/example/software.git' }) })
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Bootstrap fixture' }), home)
  cleanups.push(() => pool.closeAll())
  const seededMember = join(seed, 'Software')
  const project = pool.get(seededMember)
  await project.initializeRepository({ name: 'Software', mode: 'repo' })
  const card = await project.createKanbanCard({ title: 'Portable task' })
  await pool.close(seededMember)
  gitIn(seed, 'add', '-A'); gitIn(seed, 'commit', '-m', 'Portable world')
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), homeDir: home, dmHome: home })
  registry.track(source)
  if (localWorld) {
    gitIn(seed, 'remote', 'add', 'origin', worldUrl)
    registry.track(seed)
    bindForge(home, source, seededMember, '')
  } else gitIn(root, 'clone', '--bare', seed, bare)
  const transport = fixtureTransport(bare)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const forge = startForge({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    home, registry, pool, session: { getAccount: () => ({ login: 'example', host: 'github.com' }), getToken: () => null },
    pickDirectory: async () => source, cleanup: () => undefined, publish: async () => { throw new Error('Existing world only') },
    onConflict: async () => { throw new Error('Unexpected merge conflict') }, onSynced: async () => undefined,
    runner: transport
  })
  cleanups.push(forge.stop)
  await forge.ready
  const call = async (name: string, ...args: unknown[]) => handlers.get('forge:' + name)!({} as Electron.IpcMainInvokeEvent, ...args)
  return {
    source, home, forge, pool, registry, call, card, world: seed, member: seededMember,
    restore: (member: string) => call('restore', member, 'db'), ...transport
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function changeSourceOrigin({ source }: Fixture): void {
  gitIn(source, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git')
}

function rotateAttachment({ registry, world }: Fixture): void {
  registry.untrack(world)
  registry.track(world)
}

function changeProjectMapping({ world }: Fixture): void {
  updateForge(world, manifest => { manifest.projects[0]!.repository = 'https://github.com/example/other.git' })
}

function secondSourceOrigin(f: Fixture, change: (f: Fixture) => void): () => boolean {
  let count = 0
  f.afterLocalGit(request => {
    if (request.cwd !== f.source || !request.args.includes('get-url')) return
    if (++count === 2) change(f)
  })
  return () => count === 2
}

it('opens a config-only source checkout on a fresh machine, retrieves the world and restores the same tickets', async () => {
  const f = await fixture()
  expect(f.registry.list().filter(folder => folder.forgeWorld)).toHaveLength(0)
  expect(() => boundForgeRoot(nodeFs, f.home, f.source)).toThrow('retrieve its Forge World')
  const member = await f.forge.openProject(f.source)
  expect(member).toBe(join(f.home, 'forge-worlds', 'example', 'world', 'Software'))
  expect((await f.pool.get(member).getKanbanCard({ cardId: f.card.id })).title).toBe('Portable task')
  expect(boundForgeRoot(nodeFs, f.home, f.source)).toBe(member)
  expect(JSON.parse(readFileSync(join(member, '.darkmechanicus/local/source-checkout.json'), 'utf8'))).toEqual({ checkout: f.source })
  expect(existsSync(join(f.source, '.darkmechanicus'))).toBe(false)
  f.networkRequests.length = 0
  f.offline(true)
  expect(await f.forge.openProject(f.source)).toBe(member)
  expect(f.networkRequests).toEqual([])
  gitIn(f.source, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git')
  await expect(f.forge.openProject(f.source)).rejects.toThrow('linked code repository')
  expect(f.networkRequests).toEqual([])
  gitIn(f.source, 'remote', 'set-url', 'origin', 'https://github.com/example/software.git')
  f.offline(false)
  expect(f.registry.list().filter(folder => folder.forgeWorld)).toHaveLength(1)
  await f.restore(member)
  expect(existsSync(join(f.source, FORGE_CONFIG))).toBe(false)
  expect(existsSync(join(f.source, 'FORGE-WORLD.md'))).toBe(false)
  expect((await f.pool.get(f.source).getKanbanCard({ cardId: f.card.id })).title).toBe('Portable task')
})

it('retrieves from the configured remote instead of trusting a binding outside the tracked world', async () => {
  const f = await fixture()
  const unrelated = join(f.home, 'unrelated', 'Software')
  mkdirSync(unrelated, { recursive: true })
  bindForge(f.home, f.source, unrelated, '')
  expect(boundForgeRoot(nodeFs, f.home, f.source)).toBe(unrelated)
  f.offline(true)
  await expect(f.forge.openProject(f.source)).rejects.toThrow('remote is unavailable')
  expect(f.networkRequests).toHaveLength(1)
  expect(f.networkRequests[0]).toContain('clone')
  expect(f.registry.list().some(folder => folder.path === unrelated)).toBe(false)
})

it.each([
  { subject: 'root attachment', change: rotateAttachment },
  { subject: 'project mapping', change: changeProjectMapping },
  { subject: 'code origin', change: changeSourceOrigin }
])('refuses a local open when its $subject changes after Git has verified the source', async ({ change }) => {
  const f = await fixture(true)
  const crossedBoundary = secondSourceOrigin(f, change)
  f.offline(true)
  await expect(f.forge.openProject(f.source)).rejects.toMatchObject({
    code: 'conflict', message: 'The Forge World project or its linked checkout changed while opening.'
  })
  expect(crossedBoundary()).toBe(true)
  expect(f.networkRequests).toEqual([])
})

it('looks for the configured world if the bound world no longer has the expected origin', async () => {
  const f = await fixture(true)
  gitIn(f.world, 'remote', 'set-url', 'origin', 'https://github.com/example/wrong-world.git')
  f.offline(true)
  await expect(f.forge.openProject(f.source)).rejects.toThrow('remote is unavailable')
  expect(f.networkRequests).toHaveLength(1)
  expect(f.networkRequests[0]).toEqual(expect.arrayContaining(['clone', worldUrl]))
})

it('retrieves the configured world when the machine-local binding is unreadable', async () => {
  const f = await fixture(true)
  const binding = join(f.home, 'forge-bindings', projectKey(f.source) + '.link.json')
  writeFileSync(binding, '{')
  f.offline(true)
  await expect(f.forge.openProject(f.source)).rejects.toThrow('remote is unavailable')
  expect(f.networkRequests).toHaveLength(1)
  expect(f.networkRequests[0]).toContain('ls-remote')
})

it('requires a verified checkout hint before opening a local binding offline', async () => {
  const f = await fixture(true)
  unlinkSync(join(f.member, '.darkmechanicus/local/source-checkout.json'))
  expect(boundForgeRoot(nodeFs, f.home, f.source)).toBe(f.member)
  f.offline(true)
  await expect(f.forge.openProject(f.source)).rejects.toThrow('remote is unavailable')
  expect(f.networkRequests).toHaveLength(1)
  expect(f.networkRequests[0]).toContain('ls-remote')
})

it('refuses to substitute the old member for a different project named by the source', async () => {
  const f = await fixture(true)
  const pointer = join(f.source, 'FORGE-WORLD.md')
  const note = readFileSync(pointer, 'utf8').replace('Project folder: Software', 'Project folder: Renamed')
  writeFileSync(pointer, note)
  writeFileSync(join(f.source, FORGE_CONFIG), JSON.stringify({ ...config, projectFolder: 'Renamed' }))
  bindForge(f.home, f.source, f.member, note)
  expect(boundForgeRoot(nodeFs, f.home, f.source)).toBe(f.member)
  await expect(f.forge.openProject(f.source)).rejects.toThrow('different Forge World project')
  expect(f.networkRequests).toEqual([])
})

it('reports a missing tracked world or removed manifest member without opening an owner', async () => {
  const f = await fixture(true)
  const reconcile = vi.spyOn(f.pool, 'reconcile')
  const parked = f.world + '-moved'
  renameSync(f.world, parked)
  try {
    expect(await f.call('memberStatus', f.world, f.member)).toEqual({ readiness: 'removed', syncing: false, error: null })
  } finally { renameSync(parked, f.world) }
  updateForge(f.world, manifest => { manifest.projects = [] })
  expect(await f.call('memberStatus', f.world, f.member)).toEqual({ readiness: 'removed', syncing: false, error: null })
  await expect(f.call('memberStatus', null, f.member)).rejects.toMatchObject({ code: 'invalid_input' })
  expect(reconcile).not.toHaveBeenCalled()
  expect(f.networkRequests).toEqual([])
})

it('reports incomplete member metadata and retains the health error across readiness reads', async () => {
  const f = await fixture(true)
  unlinkSync(join(f.member, '.darkmechanicus/project.json'))
  expect(await f.call('memberStatus', f.world, f.member)).toEqual({ readiness: 'preparing', syncing: false, error: null })
  rotateAttachment(f)
  expect(await f.call('memberStatus', f.world, f.member)).toMatchObject({ readiness: 'preparing', syncing: true })
  await expect(f.forge.openWorld(f.world)).rejects.toThrow('metadata is missing')
  let checked = 0
  f.afterLocalGit(() => { checked += 1 })
  for (const _ of [1, 2]) {
    expect(await f.call('memberStatus', f.world, f.member)).toMatchObject({
      readiness: 'preparing', syncing: false, error: expect.stringContaining('metadata is missing')
    })
  }
  expect(checked).toBe(0)
  expect(f.networkRequests).toEqual([])
})

it('upgrades a valid legacy pointer without changing its text', async () => {
  const f = await fixture()
  unlinkSync(join(f.source, FORGE_CONFIG))
  const note = '# Ticket source control\n\nForge World: ' + worldUrl + '\nProject folder: Software\n'
  writeFileSync(join(f.source, 'FORGE-WORLD.md'), note)
  const member = await f.forge.openProject(f.source)
  expect(JSON.parse(readFileSync(join(f.source, FORGE_CONFIG), 'utf8'))).toEqual(config)
  expect(readFileSync(join(f.source, 'FORGE-WORLD.md'), 'utf8')).toBe(note)
  expect(boundForgeRoot(nodeFs, f.home, f.source)).toBe(member)
})

it('refuses a configuration whose member belongs to another code repository without binding or initializing the source', async () => {
  const f = await fixture()
  gitIn(f.source, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git')
  await expect(f.forge.openProject(f.source)).rejects.toThrow('linked code repository')
  expect(() => boundForgeRoot(nodeFs, f.home, f.source)).toThrow('retrieve its Forge World')
  expect(existsSync(join(f.source, '.darkmechanicus'))).toBe(false)
  expect(JSON.parse(readFileSync(join(f.source, FORGE_CONFIG), 'utf8'))).toEqual(config)
})
