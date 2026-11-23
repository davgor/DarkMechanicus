import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { expect, it, vi } from 'vitest'
import { readForgeRecipebook, readForgeSetupWorkflow } from '../../core/repo/forgeSetupStorage'
import { openWorkspace } from '../../core/workspace'
import type { ForgeProvisionStatus } from '../../shared/desktop/forgeSetup'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { createTestWorkspacePool } from './__mocks__/projectWorkspaceFixture'
import { createFolderRegistry } from './folderRegistry'
import type { ForgePublishedRepository } from './forgePublish'
import { startForge } from './forgeService'

function fixturePublisher(remoteRoot: string) {
  const account = { id: 117, login: 'example' }
  const remotes = new Map<string, ForgePublishedRepository>()
  const created: string[] = []
  const publisher: NonNullable<Parameters<typeof startForge>[1]['provisioning']>['publisher'] = {
    async account() { return account },
    async inspectRemote(_owner, url) { return remotes.get(basename(url, '.git')) ?? null },
    async findRemote(_owner, name) { return remotes.get(name) ?? null },
    async createRemote({ account: owner, name, visibility, provenance }) {
      const bare = join(remoteRoot, name + '.git')
      mkdirSync(bare)
      gitIn(bare, 'init', '--bare', '--initial-branch=main')
      const receipt = { id: remotes.size + 1, name, owner: owner.login, ownerId: owner.id, visibility, provenance,
        url: 'https://github.com/example/' + name + '.git' }
      created.push(name)
      remotes.set(name, receipt)
      if (name === 'software') throw new Error('Lost POST response after creation')
      return receipt
    }
  }
  return { account, remotes, created, publisher }
}

function fixtureRunner(remoteRoot: string) {
  const real = createGitRunner()
  const network: string[] = []
  const gitCommands: (readonly string[])[] = []
  const state = { offline: false }
  const runner: NonNullable<Parameters<typeof startForge>[1]['runner']> = {
    async run(request) {
      gitCommands.push(request.args)
      if (request.kind !== 'network') return real.run(request)
      if (state.offline) throw new Error('Fixture Git remote is unavailable')
      network.push(request.cwd)
      const args = request.args.map(arg => arg.startsWith('https://github.com/example/') ? join(remoteRoot, basename(arg)) : arg)
      return real.run({ ...request, args: ['-c', 'protocol.file.allow=always', ...args.filter((arg, index) =>
        arg !== 'protocol.allow=never' && args[index + 1] !== 'protocol.allow=never')] })
    }
  }
  return { runner, gitCommands, network, state }
}

function fixture() {
  const scratch = scratchDir('forge-provision-native-adapter-')
  const home = join(scratch.path, 'home')
  const destination = join(scratch.path, 'code')
  mkdirSync(destination)
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  const pool = createTestWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Fixture' }), home)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const invoke = async (name: string, ...args: unknown[]) => handlers.get(name)!({} as IpcMainInvokeEvent, ...args)
  const { account, remotes, created, publisher } = fixturePublisher(scratch.path)
  const { runner, gitCommands, network, state } = fixtureRunner(scratch.path)
  const notified: string[] = []
  const appTimer = vi.spyOn(globalThis, 'setInterval')
  const forge = startForge({ handle: (key, handler) => { handlers.set(key, handler) } }, {
    home, registry, pool, session: { getAccount: () => account, getToken: () => 'fixture-token' },
    pickDirectory: async () => destination, cleanup: () => undefined, publish: async () => { throw new Error('Unexpected legacy publish') },
    onSynced: async () => {}, onConflict: async () => { throw new Error('Unexpected conflict') },
    onImported: async member => { notified.push(member) },
    provisioning: {
      journal: join(home, 'provisioning.json'),
      discover: async repository => ({
        detectorVersion: 1, status: 'detected', source: { repository, commit: gitIn(join(scratch.path, 'software.git'), 'rev-parse', 'HEAD').trim() },
        facts: [{ kind: 'lockfile', value: 'npm', source: 'package-lock.json' }]
      }),
      publisher
    },
    runner
  })
  const tick = appTimer.mock.calls.find(([, interval]) => interval === 15_000)?.[0]
  appTimer.mockRestore()
  return { scratch, destination, registry, pool, remotes, created, notified, gitCommands, network, state, forge, invoke, tick }
}

it('creates and resumes a real private world, separate public code checkout and one durable ticket member', async () => {
  const { scratch, destination, registry, pool, remotes, created, notified, gitCommands, network, state, forge, invoke, tick } = fixture()
  try {
    await forge.ready
    const operation = randomUUID()
    const request = { world: { kind: 'new', name: 'tickets' }, code: { name: 'software', visibility: 'public', recipeId: 'boosterseat-react' } }
    const partial = await invoke('forgeSetup:provision', request, operation) as ForgeProvisionStatus
    expect(partial).toMatchObject({ id: operation, state: 'needs-attention', phase: 'code-remote', world: expect.any(String) })
    const sync = (folder: string) => invoke('forge:sync', folder)
    await expect(sync(partial.world!)).rejects.toThrow('Resume Forge World creation')
    const commandsBeforeTick = gitCommands.length
    expect(tick).toBeDefined()
    tick!()
    expect(gitCommands).toHaveLength(commandsBeforeTick)
    expect(network).toEqual([])
    const result = await invoke('forgeSetup:resumeProvision', operation) as ForgeProvisionStatus
    expect(result).toMatchObject({ id: operation, state: 'complete', message: null })
    const { world, member, checkout } = result as Required<ForgeProvisionStatus>
    expect(created).toEqual(['tickets', 'software'])
    expect(remotes.get('tickets')?.visibility).toBe('private')
    expect(remotes.get('software')?.visibility).toBe('public')
    expect(checkout).toBe(join(destination, 'software'))
    expect(member).toBe(join(world, 'software'))
    expect(registry.list().find(folder => folder.path === member)).toMatchObject({ forgeParent: world, initialized: true })
    expect(readForgeRecipebook(world)?.value.recipes.map(recipe => recipe.id)).toEqual(['forge-world', 'boosterseat-react', 'boosterseat-electron'])
    expect(readForgeSetupWorkflow(member)?.value.workflow).toMatchObject({ state: 'needs-discovery', steps: expect.arrayContaining([expect.objectContaining({ program: 'npm', args: ['ci'] })]) })
    expect(JSON.parse(readFileSync(join(checkout, '.forge-world.json'), 'utf8'))).toMatchObject({ projectFolder: 'software', worldRepository: remotes.get('tickets')?.url })
    expect(JSON.parse(readFileSync(join(member, '.darkmechanicus', 'local', 'source-checkout.json'), 'utf8'))).toEqual({ checkout })
    expect(gitIn(join(scratch.path, 'tickets.git'), 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('.darkmechanicus/local')
    expect(gitIn(join(scratch.path, 'software.git'), 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('src/App.tsx')
    expect(gitIn(checkout, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(checkout, '.github', 'workflows'))).toBe(false)
    expect(existsSync(join(checkout, 'node_modules'))).toBe(false)
    expect(notified).toEqual([member])
    await expect(sync(world)).resolves.toBeUndefined()
    const book = readForgeRecipebook(world)!
    book.value.recipes[1]!.notes = 'Use the reviewed application checks.'
    state.offline = true
    const saved = await invoke('forgeSetup:saveRecipebook', world, { value: book.value, expectedSha256: book.sha256 })
    expect(saved).not.toMatchObject({ sha256: book.sha256 })
    expect(readForgeRecipebook(world)).toEqual(saved)
    await expect(sync(world)).rejects.toThrow('Fixture Git remote is unavailable')
    expect(await invoke('forge:status', world)).toMatchObject({ error: 'Fixture Git remote is unavailable' })
  } finally {
    await forge.stop()
    await pool.closeAll()
    scratch.cleanup()
  }
})
