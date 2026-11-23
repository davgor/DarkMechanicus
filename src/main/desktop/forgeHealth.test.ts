import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { afterEach, expect, it } from 'vitest'
import { openWorkspace } from '../../core/workspace'
import { boundForgeRoot, forgeBindingEpoch } from '../../core/repo/forgeBinding'
import { FORGE_CONFIG } from '../../core/repo/forgeReference'
import { nodeFs } from '../../core/repo/nodeFs'
import { scratchDir, gitIn } from '../../test/gitScratch'
import { seedForgeFixture } from '../../test/forgeFixture'
import { ForgeGit } from './forgeGit'
import { createForge, updateForge } from './forgeManifest'
import { ensureForgeWorld } from './forgeHealth'
import { FORGE_DIRECTIONS } from './forgeDirections'
import { createFolderRegistry } from './folderRegistry'
import { createTestWorkspacePool as createWorkspacePool } from './__mocks__/projectWorkspaceFixture'
import { startForge } from './forgeService'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })
const git = new ForgeGit({ getAccount: () => null, getToken: () => null })
const worldUrl = 'https://github.com/example/world.git'
function repo(path: string, url: string) {
  mkdirSync(path)
  gitIn(path, 'init', '-b', 'main')
  gitIn(path, 'remote', 'add', 'origin', url)
}
async function fixture() {
  const scratch = scratchDir('forge-health-')
  cleanups.push(scratch.cleanup)
  const home = join(scratch.path, 'home'), root = join(scratch.path, 'world'), source = join(scratch.path, 'code'), member = join(root, 'Software')
  repo(root, worldUrl); repo(source, 'https://github.com/example/software.git')
  seedForgeFixture(root, 'example', [{ folder: 'Software', repository: 'https://github.com/example/software.git' }])
  const workspace = openWorkspace({ repoRoot: member, homeDir: home, role: 'desktop', transport: 'desktop', label: 'Health fixture' })
  await workspace.initializeRepository({ mode: 'repo', name: 'Software' }); workspace.close()
  return { root, home, source, member }
}
function oldBinding(f: Awaited<ReturnType<typeof fixture>>) {
  writeFileSync(join(f.member, '.darkmechanicus/local/source-checkout.json'), JSON.stringify({ checkout: f.source }))
  writeFileSync(join(f.source, 'FORGE-WORLD.md'), 'Forge World: ' + worldUrl + '\nProject folder: Software\n')
}

it('retrofits an old world and known code checkout once without rotating a valid binding on later checks', async () => {
  const f = await fixture(); oldBinding(f)
  await ensureForgeWorld(f.root, { git, home: f.home })
  expect(JSON.parse(readFileSync(join(f.source, FORGE_CONFIG), 'utf8'))).toEqual({ version: 1, worldRepository: worldUrl, projectFolder: 'Software' })
  expect(readFileSync(join(f.root, FORGE_DIRECTIONS), 'utf8')).toContain('darkmechanicus:forge-repositories:')
  expect(boundForgeRoot(nodeFs, f.home, f.source)).toBe(f.member)
  const before = [forgeBindingEpoch(nodeFs, f.home, f.source), readFileSync(join(f.root, FORGE_DIRECTIONS), 'utf8'), readFileSync(join(f.source, FORGE_CONFIG), 'utf8')]
  await ensureForgeWorld(f.root, { git, home: f.home })
  expect([forgeBindingEpoch(nodeFs, f.home, f.source), readFileSync(join(f.root, FORGE_DIRECTIONS), 'utf8'), readFileSync(join(f.source, FORGE_CONFIG), 'utf8')]).toEqual(before)
})

it('keeps a portable world valid when the code checkout is absent on this computer', async () => {
  const f = await fixture()
  writeFileSync(join(f.member, '.darkmechanicus/local/source-checkout.json'), JSON.stringify({ checkout: join(f.home, 'not-cloned') }))
  await ensureForgeWorld(f.root, { git, home: f.home })
  expect(existsSync(join(f.root, FORGE_DIRECTIONS))).toBe(true)
  expect(existsSync(join(f.source, FORGE_CONFIG))).toBe(false)
  expect(existsSync(join(f.home, 'not-cloned'))).toBe(false)
})

it('recovers a missing repository URL only from the matching portable pointer and actual code origin', async () => {
  const f = await fixture(); oldBinding(f)
  const manifest = JSON.parse(readFileSync(join(f.root, 'forge-world.json'), 'utf8'))
  delete manifest.projects[0].repository
  writeFileSync(join(f.root, 'forge-world.json'), JSON.stringify(manifest))
  await ensureForgeWorld(f.root, { git, home: f.home })
  expect(JSON.parse(readFileSync(join(f.root, 'forge-world.json'), 'utf8')).projects).toEqual([{ folder: 'Software', repository: 'https://github.com/example/software.git' }])
})

it('recovers an unlisted ticket folder only when its local code pointer identifies this exact world and member', async () => {
  const f = await fixture(); oldBinding(f)
  updateForge(f.root, world => { world.projects = [] })
  await ensureForgeWorld(f.root, { git, home: f.home })
  expect(JSON.parse(readFileSync(join(f.root, 'forge-world.json'), 'utf8')).projects).toEqual([{ folder: 'Software', repository: 'https://github.com/example/software.git' }])
  expect(boundForgeRoot(nodeFs, f.home, f.source)).toBe(f.member)
})

it('refuses a checkout replaced by a directory link without writing into its new target', async () => {
  const f = await fixture(); oldBinding(f)
  const moved = f.source + '-moved'
  renameSync(f.source, moved)
  symlinkSync(moved, f.source, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(ensureForgeWorld(f.root, { git, home: f.home })).rejects.toThrow('symbolic link')
  expect(existsSync(join(moved, FORGE_CONFIG))).toBe(false)
})

it.each(['staged', 'committed'] as const)('refuses a %s private checkout hint before repairing code configuration or bindings', async state => {
  const f = await fixture(); oldBinding(f)
  gitIn(f.root, 'add', '--force', 'Software/.darkmechanicus/local/source-checkout.json')
  if (state === 'committed') {
    gitIn(f.root, 'config', 'user.name', 'Health fixture')
    gitIn(f.root, 'config', 'user.email', 'health@example.test')
    gitIn(f.root, 'commit', '-m', 'Untrusted remote private hint')
  }
  const before = readFileSync(join(f.source, 'FORGE-WORLD.md'), 'utf8')
  await expect(ensureForgeWorld(f.root, { git, home: f.home })).rejects.toThrow('machine-private')
  expect(existsSync(join(f.source, FORGE_CONFIG))).toBe(false)
  expect(existsSync(join(f.root, FORGE_DIRECTIONS))).toBe(false)
  expect(forgeBindingEpoch(nodeFs, f.home, f.source)).toBeNull()
  expect(readFileSync(join(f.source, 'FORGE-WORLD.md'), 'utf8')).toBe(before)
})

it('does not turn a code configuration or nested folder into a Forge World', async () => {
  const f = await fixture()
  writeFileSync(join(f.source, FORGE_CONFIG), JSON.stringify({ version: 1, worldRepository: worldUrl, projectFolder: 'Software' }))
  await expect(ensureForgeWorld(f.source, { git, home: f.home })).rejects.toThrow('metadata is missing')
  expect(existsSync(join(f.source, FORGE_DIRECTIONS))).toBe(false)
  createForge(f.member, 'example')
  await expect(ensureForgeWorld(f.member, { git, home: f.home })).rejects.toThrow('repository root')
  expect(existsSync(join(f.member, FORGE_DIRECTIONS))).toBe(false)
})

it('refuses conflicting code remotes and unresolved mappings without overwriting them', async () => {
  const f = await fixture(); oldBinding(f)
  gitIn(f.source, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git')
  await expect(ensureForgeWorld(f.root, { git, home: f.home })).rejects.toThrow('does not match')
  expect(existsSync(join(f.source, FORGE_CONFIG))).toBe(false)
  const manifest = JSON.parse(readFileSync(join(f.root, 'forge-world.json'), 'utf8'))
  delete manifest.projects[0].repository
  writeFileSync(join(f.root, 'forge-world.json'), JSON.stringify(manifest))
  writeFileSync(join(f.source, 'FORGE-WORLD.md'), 'Forge World: https://github.com/example/other-world.git\nProject folder: Software\n')
  await expect(ensureForgeWorld(f.root, { git, home: f.home })).rejects.toThrow('mapping')
  expect(JSON.parse(readFileSync(join(f.root, 'forge-world.json'), 'utf8')).projects[0].repository).toBeUndefined()
})

it('checks every tracked world on startup and reports one bad world without preventing repairs to another', async () => {
  const bad = await fixture(), good = await fixture()
  oldBinding(bad); oldBinding(good)
  gitIn(bad.source, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git')
  const registry = createFolderRegistry({ file: join(good.home, 'folders.json'), homeDir: good.home, dmHome: good.home })
  registry.track(bad.root); registry.track(good.root)
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: good.home, role: 'desktop', transport: 'desktop', label: 'Startup fixture' }), good.home)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const forge = startForge({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    registry, pool, home: good.home, session: { getAccount: () => null, getToken: () => null }, pickDirectory: async () => null,
    cleanup: () => undefined, publish: async () => undefined, onConflict: async () => undefined, onSynced: async () => undefined
  })
  cleanups.push(() => { forge.stop(); pool.closeAll() })
  await forge.ready
  expect(existsSync(join(good.source, FORGE_CONFIG))).toBe(true)
  const status = await handlers.get('forge:status')!({} as Electron.IpcMainInvokeEvent, bad.root)
  expect(status.error).toContain('does not match')
})
