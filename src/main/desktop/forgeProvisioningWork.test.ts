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
  const creation = { loseCodeResponse: true, initializer: (_name: string, _directory: string) => {} }
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
      creation.initializer(name, bare)
      if (name === 'software' && creation.loseCodeResponse) throw new Error('Lost POST response after creation')
      return receipt
    }
  }
  return { account, remotes, created, publisher, creation }
}

function fixtureRunner(remoteRoot: string) {
  const real = createGitRunner()
  const network: string[] = []
  const gitCommands: (readonly string[])[] = []
  const state = { offline: false, codePush: 'normal' as 'normal' | 'unreceived' | 'lost-response', upstream: true, codePushes: 0 }
  const runner: NonNullable<Parameters<typeof startForge>[1]['runner']> = {
    async run(request) {
      gitCommands.push(request.args)
      if (!state.upstream && request.args.includes('--set-upstream-to=origin/main')) throw new Error('Local upstream configuration interrupted')
      if (request.kind !== 'network') return real.run(request)
      if (state.offline) throw new Error('Fixture Git remote is unavailable')
      network.push(request.cwd)
      const args = request.args.map(arg => arg.startsWith('https://github.com/example/') ? join(remoteRoot, basename(arg)) : arg)
      const codePush = args.includes('push') && args.includes(join(remoteRoot, 'software.git'))
      if (codePush) {
        state.codePushes++
        if (state.codePush === 'unreceived') throw new Error('The Git server did not receive the code push')
      }
      const result = await real.run({ ...request, args: ['-c', 'protocol.file.allow=always', ...args.filter((arg, index) =>
        arg !== 'protocol.allow=never' && args[index + 1] !== 'protocol.allow=never')] })
      if (codePush && state.codePush === 'lost-response') throw new Error('The Git server accepted the push before the response was lost')
      return result
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
  const { account, remotes, created, publisher, creation } = fixturePublisher(scratch.path)
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
  const close = async () => { await forge.stop(); await pool.closeAll(); scratch.cleanup() }
  return { scratch, destination, registry, pool, remotes, created, creation, notified, gitCommands, network, state, forge, invoke, tick, close }
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

it('resumes an existing-world code push from real remote refs without replaying a verified commit', async () => {
  const f = fixture()
  try {
    await f.forge.ready
    f.creation.loseCodeResponse = false
    const worldOnly = await f.invoke('forgeSetup:provision', { world: { kind: 'new', name: 'tickets' } }, randomUUID()) as ForgeProvisionStatus
    expect(worldOnly).toMatchObject({ state: 'complete' })
    expect(f.notified).toEqual([])
    const code = { world: { kind: 'existing', folder: worldOnly.world }, code: { name: 'software', visibility: 'private', recipeId: 'boosterseat-react' } }
    const operation = randomUUID()
    f.state.codePush = 'unreceived'
    const interrupted = await f.invoke('forgeSetup:provision', code, operation)
    expect(interrupted).toMatchObject({ phase: 'code-checkout', state: 'needs-attention', message: expect.stringContaining('has not confirmed the code push') })
    const checkout = join(f.destination, 'software')
    const commit = gitIn(checkout, 'rev-parse', 'HEAD').trim()
    expect(f.state.codePushes).toBe(1)
    f.state.codePush = 'lost-response'
    f.state.upstream = false
    expect(await f.invoke('forgeSetup:resumeProvision', operation)).toMatchObject({ state: 'needs-attention', message: 'Local upstream configuration interrupted' })
    expect(gitIn(join(f.scratch.path, 'software.git'), 'rev-parse', 'HEAD').trim()).toBe(commit)
    expect(f.state.codePushes).toBe(2)
    f.state.upstream = true
    const complete = await f.invoke('forgeSetup:resumeProvision', operation)
    expect(complete).toMatchObject({ state: 'complete', world: worldOnly.world, member: join(worldOnly.world!, 'software'), checkout })
    expect(f.state.codePushes).toBe(2)
    expect(f.created).toEqual(['tickets', 'software'])
    expect(f.remotes.get('software')?.visibility).toBe('private')
    expect(f.notified).toEqual([join(worldOnly.world!, 'software')])
  } finally { await f.close() }
})

it('preserves another commit in a newly created code remote and leaves publication pending', async () => {
  const f = fixture()
  try {
    await f.forge.ready
    f.creation.loseCodeResponse = false
    let previous = ''
    f.creation.initializer = (name, bare) => {
      if (name !== 'software') return
      const seed = join(f.scratch.path, 'unrelated-work')
      mkdirSync(seed)
      gitIn(seed, 'init', '--initial-branch=main')
      gitIn(seed, 'commit', '--allow-empty', '-m', 'Another Git client published')
      gitIn(seed, 'push', bare, 'HEAD:refs/heads/main')
      previous = gitIn(seed, 'rev-parse', 'HEAD').trim()
    }
    const request = { world: { kind: 'new', name: 'tickets' }, code: { name: 'software', visibility: 'public', recipeId: 'boosterseat-react' } }
    expect(await f.invoke('forgeSetup:provision', request, randomUUID())).toMatchObject({
      state: 'needs-attention', phase: 'code-checkout', message: expect.stringContaining('already contains different work')
    })
    expect(previous).toMatch(/^[a-f0-9]{40}$/)
    expect(gitIn(join(f.scratch.path, 'software.git'), 'rev-parse', 'HEAD').trim()).toBe(previous)
    expect(f.state.codePushes).toBe(0)
    expect(f.notified).toEqual([])
  } finally { await f.close() }
})
