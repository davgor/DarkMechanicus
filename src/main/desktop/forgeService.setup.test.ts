import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { expect, it, onTestFinished, vi } from 'vitest'
import { pendingForgeTransfer } from '../../core/repo/forgeBinding'
import { readForgeSetupWorkflow } from '../../core/repo/forgeSetupStorage'
import { openWorkspace } from '../../core/workspace'
import type { ForgeRecipebook, ForgeSetupDetection, ForgeSetupFile, ForgeSetupProjectView } from '../../shared/desktop/forgeSetup'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { TEST_STORAGE } from '../../test/workspaceHarness'
import { createGitRunner } from '../git/runner'
import { createTestWorkspacePool } from './__mocks__/projectWorkspaceFixture'
import { createFolderRegistry } from './folderRegistry'
import { createForge, updateForge } from './forgeManifest'
import { createForgeRepositoryPublisher } from './forgePublish'
import { startForge } from './forgeService'

const software = 'https://github.com/example/software.git'

function evidence(repository: string, node = '22'): ForgeSetupDetection {
  return { detectorVersion: 1, status: 'detected', source: { repository, commit: 'a'.repeat(40) },
    facts: [{ kind: 'node', source: '.nvmrc', value: node }] }
}

function initialize(root: string, repository: string) {
  mkdirSync(root)
  gitIn(root, 'init', '--initial-branch=main')
  gitIn(root, 'remote', 'add', 'origin', repository)
}

function setupServices(home: string) {
  const noAgent = async () => { throw new Error('No agent is selected for this fixture') }
  return {
    file: join(home, 'setup.json'), scratch: join(home, 'setup-scratch'), preferred: () => null, agent: () => null,
    getStandards: async () => undefined, findChat: () => undefined, getChat: () => null,
    createChat: noAgent, start: vi.fn(noAgent), hasInput: () => false, running: () => false, announce: () => undefined
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { resolve, promise }
}

function fixture(legacy = false) {
  const scratch = scratchDir('forge-setup-service-')
  const home = join(scratch.path, 'home')
  const world = join(scratch.path, 'World')
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  const pool = createTestWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop',
    label: 'Setup service fixture', serverInfo: { name: 'fixture', version: '1' }, ...TEST_STORAGE }), home)
  initialize(world, 'https://github.com/example/tickets.git')
  if (legacy) createForge(world, 'example')
  registry.track(world)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const call = async <T = unknown>(name: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(name)
    if (handler === undefined) throw new Error('Missing IPC handler ' + name)
    return handler({} as Electron.IpcMainInvokeEvent, ...args)
  }
  const state = { failPush: false }
  const network: Array<readonly string[]> = []
  const imported: Array<{ member: string; file: ReturnType<typeof readForgeSetupWorkflow>; pushes: number }> = []
  const git = createGitRunner()
  const session = { getAccount: () => ({ login: 'example', host: 'github.com' }), getToken: () => null }
  const discover = vi.fn(async (repository: string) => evidence(repository))
  const setup = setupServices(home)
  const service = startForge({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    home, registry, pool, session, pickDirectory: async () => null, cleanup: () => undefined,
    publish: async () => { throw new Error('This test never publishes a repository') },
    onConflict: async () => { throw new Error('Unexpected Git conflict') }, onSynced: async () => undefined,
    onImported: async member => { imported.push({ member, file: readForgeSetupWorkflow(member), pushes: network.filter(args => args.includes('push')).length }) },
    provisioning: { journal: join(home, 'provisioning.json'), discover,
      publisher: createForgeRepositoryPublisher(session, async () => { throw new Error('This test never calls the GitHub write API') }) },
    setup,
    runner: { run: async request => {
      if (request.kind !== 'network') return git.run(request)
      request.beforeStart?.()
      network.push(request.args)
      if (request.args.includes('push') && state.failPush) throw new Error('Fixture remote offline')
      return { code: 0, stdout: '', stderr: '' }
    } }
  })
  onTestFinished(async () => {
    await service.stop()
    await service.ready
    await pool.closeAll()
    scratch.cleanup()
  })
  return { world, home, scratch: scratch.path, registry, pool, call, state, network, imported, discover, start: setup.start, ready: service.ready }
}

it('loads the bundled catalog and guards persisted recipe edits before reporting a local revision', async () => {
  const f = fixture()
  await f.ready
  const bundled = await f.call<ForgeSetupFile<ForgeRecipebook>>('forgeSetup:recipebook')
  expect(bundled.value.recipes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'world' }), expect.objectContaining({ kind: 'scaffold' }), expect.objectContaining({ kind: 'conversion' })
  ]))
  expect(f.network).toEqual([])
  const path = join(f.world, 'forge-recipes.yaml')
  expect(existsSync(path)).toBe(false)
  await f.call('forge:create', f.world)
  expect(await f.call('forgeSetup:recipebook', f.world)).toEqual(bundled)
  const original = readFileSync(path, 'utf8')

  await expect(f.call('forgeSetup:saveRecipebook', f.world, null)).rejects.toThrow('Supply the current Forge recipe book revision')
  const withoutScaffoldFiles = { ...bundled.value, recipes: bundled.value.recipes.map(recipe =>
    recipe.kind === 'scaffold' ? { ...recipe, assets: recipe.assets.slice(1) } : recipe) }
  await expect(f.call('forgeSetup:saveRecipebook', f.world, {
    expectedSha256: bundled.sha256, value: withoutScaffoldFiles
  })).rejects.toThrow('missing required scaffold files')
  expect(readFileSync(path, 'utf8')).toBe(original)

  const authored = { ...bundled.value, recipes: bundled.value.recipes.map(recipe =>
    recipe.kind === 'world' ? { ...recipe, notes: 'Review the shared ticket conventions.' } : recipe) }
  f.state.failPush = true
  const saved = await f.call<ForgeSetupFile<ForgeRecipebook>>('forgeSetup:saveRecipebook', f.world, { expectedSha256: bundled.sha256, value: authored })
  await expect(f.call('forge:sync', f.world)).rejects.toThrow('Fixture remote offline')
  expect(saved).toMatchObject({ value: authored })
  expect(saved.sha256).not.toBe(bundled.sha256)
  expect(await f.call('forge:status', f.world)).toMatchObject({ error: 'Fixture remote offline' })
  expect(await f.call('forgeSetup:recipebook', f.world)).toEqual(saved)
  await expect(f.call('forgeSetup:saveRecipebook', f.world, { expectedSha256: bundled.sha256, value: bundled.value })).rejects.toThrow('changed')
  expect(await f.call('forgeSetup:recipebook', f.world)).toEqual(saved)
})

it('imports link-only setup before publication and fences an in-flight descriptor refresh to the original mapping', async () => {
  const f = fixture(true)
  await f.ready
  const member = join(f.world, 'Software')
  expect(await f.call('forgeSetup:recipebook', f.world)).toBeNull()
  expect(existsSync(join(f.world, 'forge-recipes.yaml'))).toBe(false)
  await expect(f.call('forgeSetup:project', f.world)).rejects.toThrow('tracked and initialized Forge World project')
  await f.call('forge:add', f.world, software, 'Software')

  const imported = await f.call<ForgeSetupProjectView>('forgeSetup:project', member)
  expect(imported).toMatchObject({ member, repository: software, state: 'needs-discovery',
    onboarding: { state: 'needs-attention', chatId: null }, value: { value: { detection: evidence(software) } } })
  expect(f.imported).toEqual([{ member, file: imported.value, pushes: 0 }])
  expect(f.network.some(args => args.includes('push'))).toBe(true)
  expect(f.network.some(args => args.includes('clone'))).toBe(false)
  expect(f.start).not.toHaveBeenCalled()
  expect(f.discover.mock.calls).toEqual([[software]])

  const steps = [{ id: 'install', kind: 'command', title: 'Install dependencies', cwd: '.', program: 'npm', args: ['ci'] }]
  const saved = await f.call<ForgeSetupProjectView>('forgeSetup:saveWorkflow', member, {
    expectedSha256: imported.value!.sha256, workflow: { state: 'configured', steps }, notes: 'Keep the approved setup.'
  })
  await f.call('forge:sync', f.world)
  expect(saved).toMatchObject({ state: 'configured', value: { value: { workflow: { steps } } } })

  const requested = deferred<string>()
  const pending = deferred<ForgeSetupDetection>()
  f.discover.mockImplementationOnce(async repository => { requested.resolve(repository); return pending.promise })
  const refresh = f.call('forgeSetup:refresh', member)
  const repository = await Promise.race([requested.promise, refresh.then(() => { throw new Error('Refresh did not request descriptors') })])
  updateForge(f.world, world => { world.projects[0].repository = 'https://github.com/example/replacement.git' })
  pending.resolve(evidence(software, '24'))
  await expect(refresh).rejects.toThrow('member or its code mapping changed')
  expect(repository).toBe(software)
  expect(readForgeSetupWorkflow(member)).toEqual(saved.value)
  await expect(f.call('forgeSetup:project', member)).rejects.toThrow('workflow belongs to a different code repository')
  expect(f.start).not.toHaveBeenCalled()
})

it('initializes setup knowledge while converting a tracked code checkout without existing ticket records', async () => {
  const f = fixture(true)
  await f.ready
  const source = join(f.scratch, 'Software')
  const member = join(f.world, 'Software')
  initialize(source, software)
  f.registry.track(source)
  await f.call('forge:convert', f.world, source)

  const result = await f.call<ForgeSetupProjectView>('forgeSetup:project', member)
  expect(result).toMatchObject({ state: 'needs-discovery', value: { value: { detection: evidence(software), revision: 1 } },
    onboarding: { state: 'needs-attention', chatId: null } })
  expect(gitIn(f.world, 'show', 'HEAD:Software/.darkmechanicus/knowledge/forge-setup/workflow.yaml')).toContain('.nvmrc')
  expect(f.discover.mock.calls).toEqual([[software]])
  expect(f.registry.list().find(folder => folder.path === source)).toBeUndefined()
  expect(f.network.some(args => args.includes('clone'))).toBe(false)
})

async function forceDiscovery(f: ReturnType<typeof fixture>) {
  await f.ready
  const source = join(f.scratch, 'Software')
  const member = join(f.world, 'Software')
  initialize(source, software)
  f.registry.track(source)
  const tickets = f.pool.get(source)
  await tickets.initializeRepository({ name: 'Original tickets', mode: 'db' })
  const card = await tickets.createKanbanCard({ title: 'Keep this ticket in its authoritative store' })

  const requested = deferred<string>()
  const pending = deferred<ForgeSetupDetection>()
  f.discover.mockImplementationOnce(async repository => { requested.resolve(repository); return pending.promise })
  const result = f.call('forge:convert', f.world, source, { force: true })
  const repository = await Promise.race([requested.promise, result.then(() => { throw new Error('Migration did not request descriptors') })])
  return { result, repository, source, member, tickets, card, finishDiscovery: () => pending.resolve(evidence(software)) }
}

it.each([
  { change: 'replacement', args: ['set-url', 'origin', 'https://github.com/example/replacement.git'] },
  { change: 'removal', args: ['remove', 'origin'] }
])('keeps the original tickets after origin $change during forced migration discovery', async ({ args }) => {
  const f = fixture(true)
  const { result, repository, source, member, tickets, card, finishDiscovery } = await forceDiscovery(f)
  try { gitIn(source, 'remote', ...args) } finally { finishDiscovery() }

  const outcome = await result.then(() => 'resolved', (error: unknown) => error)
  expect({ outcome, sourceTracked: f.registry.has(source), memberCreated: existsSync(member),
    pointerPublished: existsSync(join(source, '.forge-world.json')), pushed: f.network.some(args => args.includes('push')) }).toEqual({
    outcome: expect.objectContaining({ code: 'conflict', message: expect.stringMatching(/code.*origin.*changed/i) }),
    sourceTracked: true, memberCreated: false, pointerPublished: false, pushed: false
  })
  expect(repository).toBe(software)
  expect(pendingForgeTransfer(f.home, source)).toBeNull()
  expect(await tickets.getKanbanCard({ cardId: card.id })).toMatchObject({ id: card.id, title: 'Keep this ticket in its authoritative store' })
})

it('completes forced migration when the rechecked origin still identifies the same code repository', async () => {
  const f = fixture(true)
  const { result, source, member, card, finishDiscovery } = await forceDiscovery(f)
  try { gitIn(source, 'remote', 'set-url', 'origin', 'git@github.com:Example/Software.git') } finally { finishDiscovery() }

  await result
  expect(f.registry.has(source)).toBe(false)
  expect(pendingForgeTransfer(f.home, source)).toBeNull()
  expect(f.network.some(args => args.includes('push'))).toBe(true)
  expect(readForgeSetupWorkflow(member)?.value.detection).toEqual(evidence(software))
  expect(await f.pool.get(member).getKanbanCard({ cardId: card.id })).toMatchObject({ id: card.id, title: 'Keep this ticket in its authoritative store' })
})
