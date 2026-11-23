import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMain } from 'electron'
import { afterEach, expect, it } from 'vitest'
import { openWorkspace } from '../../core/workspace'
import { FORGE_CONFIG } from '../../core/repo/forgeReference'
import { boundForgeRoot } from '../../core/repo/forgeBinding'
import { nodeFs } from '../../core/repo/nodeFs'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { createFolderRegistry } from './folderRegistry'
import { createForge, updateForge } from './forgeManifest'
import { startForge } from './forgeService'
import { createTestWorkspacePool as createWorkspacePool } from './__mocks__/projectWorkspaceFixture'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })
const worldUrl = 'https://github.com/example/world.git'
const config = { version: 1, worldRepository: worldUrl, projectFolder: 'Software' }
function gitRepository(path: string) {
  mkdirSync(path)
  gitIn(path, 'init', '-b', 'main')
  gitIn(path, 'config', 'user.name', 'Bootstrap fixture')
  gitIn(path, 'config', 'user.email', 'fixture@example.test')
}

async function fixture() {
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
  const project = pool.get(join(seed, 'Software'))
  await project.initializeRepository({ name: 'Software', mode: 'repo' })
  const card = await project.createKanbanCard({ title: 'Portable task' })
  await pool.close(join(seed, 'Software'))
  gitIn(seed, 'add', '-A'); gitIn(seed, 'commit', '-m', 'Portable world')
  gitIn(root, 'clone', '--bare', seed, bare)
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), homeDir: home, dmHome: home })
  registry.track(source)
  const runner = createGitRunner()
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const forge = startForge({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    home, registry, pool, session: { getAccount: () => ({ login: 'example', host: 'github.com' }), getToken: () => null },
    pickDirectory: async () => source, cleanup: () => undefined, publish: async () => { throw new Error('Existing world only') },
    onConflict: async () => { throw new Error('Unexpected merge conflict') }, onSynced: async () => undefined,
    runner: { run: request => request.kind !== 'network' ? runner.run(request) : runner.run({ ...request, args: [
      '-c', 'url.' + pathToFileURL(bare).href + '.insteadOf=' + worldUrl,
      ...request.args.map(arg => arg === 'protocol.allow=never' ? 'protocol.file.allow=always' : arg)
    ] }) }
  })
  cleanups.push(forge.stop)
  const restore = async (member: string) => handlers.get('forge:restore')!({} as Electron.IpcMainInvokeEvent, member, 'db')
  return { source, home, forge, pool, registry, restore, card }
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
  expect(await f.forge.openProject(f.source)).toBe(member)
  expect(f.registry.list().filter(folder => folder.forgeWorld)).toHaveLength(1)
  await f.restore(member)
  expect(existsSync(join(f.source, FORGE_CONFIG))).toBe(false)
  expect(existsSync(join(f.source, 'FORGE-WORLD.md'))).toBe(false)
  expect((await f.pool.get(f.source).getKanbanCard({ cardId: f.card.id })).title).toBe('Portable task')
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
