import { execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeAll, expect, it, onTestFailed, vi } from 'vitest'
import { readLocalGitOrigin } from '../../core/repo/git'
import { readForgeRecipebook, readForgeSetupWorkflow } from '../../core/repo/forgeSetupStorage'
import { openWorkspace } from '../../core/workspace'
import type { ForgeProvisionStatus } from '../../shared/desktop/forgeSetup'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner, type GitRunRequest } from '../git/runner'
import { createTestWorkspacePool } from './__mocks__/projectWorkspaceFixture'
import { createFolderRegistry } from './folderRegistry'
import { ForgeGit } from './forgeGit'
import { createForge, parseForge, updateForge } from './forgeManifest'
import type { ForgeProvisionIntent } from './forgeProvisioning'
import { createForgeProvisioningWork } from './forgeProvisioningWork'
import type { ForgePublishedRepository } from './forgePublish'
import { startForge } from './forgeService'

const trace = vi.hoisted(() => ({ start: 0, spans: [] as Array<{ name: string; start: number; end?: number }> }))

function span(name: string): () => void {
  const start = trace.start
  const timing: typeof trace.spans[number] = { name, start: Math.round(performance.now() - start) }
  trace.spans.push(timing)
  return () => { timing.end = Math.round(performance.now() - start) }
}

function reportTrace(test: string, reason: string): void {
  const open = trace.spans.filter(timing => timing.end === undefined)
  const slow = trace.spans.filter(timing => (timing.end ?? 0) - timing.start > 250)
  const phases = trace.spans.filter(timing => !timing.name.startsWith('git:') && !timing.name.startsWith('guard:'))
  const git = trace.spans.filter(timing => timing.name.startsWith('git:'))
  const guards = trace.spans.filter(timing => timing.name.startsWith('guard:'))
  const gitMs = git.reduce((sum, timing) => sum + (timing.end === undefined ? 0 : timing.end - timing.start), 0)
  const guardMs = guards.reduce((sum, timing) => sum + (timing.end === undefined ? 0 : timing.end - timing.start), 0)
  const commands: Record<string, { count: number; sumMs: number; maxMs: number }> = {}
  for (const timing of git) {
    const entry = commands[timing.name] ??= { count: 0, sumMs: 0, maxMs: 0 }
    const elapsed = (timing.end ?? timing.start) - timing.start
    entry.count++
    entry.sumMs += elapsed
    entry.maxMs = Math.max(entry.maxMs, elapsed)
  }
  process.stdout.write(JSON.stringify({ test, reason, wallMs: Math.round(performance.now() - trace.start), gitStarts: git.length, gitMs,
    guardMs, commands, phases, open, slow }) + '\n')
}

function gitLabel(args: readonly string[]): string {
  return args.find(arg => ['init', 'remote', 'rev-parse', 'ls-files', 'rev-list', 'ls-tree', 'add', 'commit',
    'status', 'ls-remote', 'push', 'update-ref', 'branch', 'symbolic-ref', 'fetch', 'merge', 'diff', 'var', 'log', 'config'].includes(arg)) ?? '?'
}

function timedGuard(request: GitRunRequest): GitRunRequest {
  const verify = request.beforeStart
  if (verify === undefined) return request
  return { ...request, beforeStart: () => {
    const end = span('guard:' + gitLabel(request.args))
    try { verify() }
    finally { end() }
  } }
}

function tracedChild(name: string, open: () => ChildProcess): ChildProcess {
  const end = span(name)
  try {
    const child = open()
    child.once('close', end)
    return child
  } catch (error) {
    end()
    throw error
  }
}

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual,
    execFileSync(command: string, args: string[], options: unknown) {
      const end = span('git:sync:' + gitLabel(args))
      try { return Reflect.apply(actual.execFileSync, undefined, [command, args, options]) }
      finally { end() }
    },
    spawn(command: string, args: readonly string[], options: unknown) {
      return tracedChild('git:child:' + gitLabel(args), () => Reflect.apply(actual.spawn, undefined, [command, args, options]))
    },
    execFile(command: string, args: readonly string[], ...options: unknown[]) {
      return tracedChild('git:exec:' + gitLabel(args), () => Reflect.apply(actual.execFile, undefined, [command, args, ...options]))
    }
  }
})

async function timed<T>(name: string, effect: () => T | Promise<T>): Promise<T> {
  const end = span(name)
  try { return await effect() }
  finally { end() }
}

afterEach(({ task }) => reportTrace(task.name, 'finished'))

beforeAll(() => {
  const pathKeys = Object.keys(process.env).filter(key => key.toUpperCase() === 'PATH')
  if (process.platform !== 'win32') return
  try {
    const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 3000 }
    const resolved = execFileSync('where.exe', ['git.exe'], options)
    const execPath = execFileSync('git', ['--exec-path'], options).trim()
    process.stdout.write(JSON.stringify({ probe: 'worker Git resolution', pathKeys, git: resolved.trim().split(/\r?\n/),
      execPath, execPathHasGit: existsSync(join(execPath, 'git.exe')) }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ probe: 'worker Git resolution', pathKeys, error: (error as NodeJS.ErrnoException).code }) + '\n')
  }
})

vi.mock('../../core/repo/git', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/repo/git')>()
  return { ...actual, readLocalGitOrigin: vi.fn(actual.readLocalGitOrigin) }
})

function fixturePublisher(remoteRoot: string) {
  const account = { id: 117, login: 'example' }
  const remotes = new Map<string, ForgePublishedRepository>()
  const created: string[] = []
  const creation = { loseCodeResponse: true, beforeFind: (_name: string) => {}, initializer: (_name: string, _directory: string) => {} }
  const publisher: NonNullable<Parameters<typeof startForge>[1]['provisioning']>['publisher'] = {
    async account() { return account },
    async inspectRemote(_owner, url) { return remotes.get(basename(url, '.git')) ?? null },
    async findRemote(_owner, name) { creation.beforeFind(name); return remotes.get(name) ?? null },
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
  const state = { offline: false, codePush: 'normal' as 'normal' | 'unreceived' | 'lost-response', upstream: true, codePushes: 0,
    beforeWorldPush: (_root: string) => {}, beforeCodePush: (_root: string) => {} }
  function beforeCodePush(root: string) {
    state.codePushes++
    state.beforeCodePush(root)
    if (state.codePush === 'unreceived') throw new Error('The Git server did not receive the code push')
  }
  const runner: NonNullable<Parameters<typeof startForge>[1]['runner']> = {
    async run(request) {
      request = timedGuard(request)
      gitCommands.push(request.args)
      if (!state.upstream && request.args.includes('--set-upstream-to=origin/main')) throw new Error('Local upstream configuration interrupted')
      if (request.kind !== 'network') return real.run(request)
      if (state.offline) throw new Error('Fixture Git remote is unavailable')
      network.push(request.cwd)
      const args = request.args.map(arg => arg.startsWith('https://github.com/example/') ? join(remoteRoot, basename(arg)) : arg)
      const push = args.includes('push')
      const codePush = push && args.includes(join(remoteRoot, 'software.git'))
      if (codePush) beforeCodePush(request.cwd)
      else if (push) state.beforeWorldPush(request.cwd)
      const result = await real.run({ ...request, args: ['-c', 'protocol.file.allow=always', ...args.filter((arg, index) =>
        arg !== 'protocol.allow=never' && args[index + 1] !== 'protocol.allow=never')] })
      if (codePush && state.codePush === 'lost-response') throw new Error('The Git server accepted the push before the response was lost')
      return result
    }
  }
  return { runner, gitCommands, network, state }
}

function tracedScratch() {
  trace.start = performance.now()
  trace.spans = []
  onTestFailed(({ task }) => reportTrace(task.name, 'failed'))
  const allocated = scratchDir('forge-provision-native-adapter-')
  return { ...allocated, cleanup() {
    const end = span('scratch cleanup (sync)')
    try { allocated.cleanup() }
    finally { end() }
  } }
}

function fixture() {
  const scratch = tracedScratch()
  const home = join(scratch.path, 'home')
  const destination = join(scratch.path, 'code')
  mkdirSync(destination)
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  const pool = createTestWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Fixture' }), home)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const invoke = async (name: string, ...args: unknown[]) => timed(name, () => handlers.get(name)!({} as IpcMainInvokeEvent, ...args))
  const { account, remotes, created, publisher, creation } = fixturePublisher(scratch.path)
  const { runner, gitCommands, network, state } = fixtureRunner(scratch.path)
  const notified: string[] = []
  const discovery = { before: () => {} }
  const appTimer = vi.spyOn(globalThis, 'setInterval')
  const session = { getAccount: () => account, getToken: () => 'fixture-token' }
  const forge = startForge({ handle: (key, handler) => { handlers.set(key, handler) } }, {
    home, registry, pool, session,
    pickDirectory: async () => destination, cleanup: () => undefined, publish: async () => { throw new Error('Unexpected legacy publish') },
    onSynced: async () => {}, onConflict: async () => { throw new Error('Unexpected conflict') },
    onImported: async member => { notified.push(member) },
    provisioning: {
      journal: join(home, 'provisioning.json'),
      discover: async repository => {
        discovery.before()
        return {
          detectorVersion: 1, status: 'detected', source: { repository, commit: gitIn(join(scratch.path, 'software.git'), 'rev-parse', 'HEAD').trim() },
          facts: [{ kind: 'lockfile', value: 'npm', source: 'package-lock.json' }]
        }
      },
      publisher
    },
    runner
  })
  const tick = appTimer.mock.calls.find(([, interval]) => interval === 15_000)?.[0]
  appTimer.mockRestore()
  const close = async () => {
    await timed('forge stop', () => forge.stop())
    await timed('workspace owner closeAll', () => pool.closeAll())
    scratch.cleanup()
  }
  return { scratch, home, destination, registry, pool, remotes, created, creation, discovery, notified, gitCommands, network, state,
    forge, invoke, tick, close, session, runner, publisher }
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
  const originReads = vi.mocked(readLocalGitOrigin)
  originReads.mockClear()
  try {
    const world = await preexistingWorld(f)
    expect(f.notified).toEqual([])
    const code = { world: { kind: 'existing', folder: world }, code: { name: 'software', visibility: 'private', recipeId: 'boosterseat-react' } }
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
    expect(complete).toMatchObject({ state: 'complete', world, member: join(world, 'software'), checkout })
    expect(f.state.codePushes).toBe(2)
    expect(f.created).toEqual(['software'])
    expect(f.remotes.get('software')?.visibility).toBe('private')
    expect(f.notified).toEqual([join(world, 'software')])
    expect(originReads.mock.calls.filter(([path]) => path === world).length).toBeLessThan(35)
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

it('refuses to push staged code after its Git origin changes at the runner boundary', async () => {
  const f = fixture()
  try {
    const world = await preexistingWorld(f)
    f.state.beforeCodePush = root => gitIn(root, 'remote', 'set-url', 'origin', 'https://github.com/example/different-code.git')
    expect(await f.invoke('forgeSetup:provision', codeFor(world), randomUUID())).toMatchObject({
      state: 'needs-attention', phase: 'code-checkout', message: expect.stringContaining('checkout origin changed')
    })
    expect(gitIn(join(f.scratch.path, 'software.git'), 'branch', '--list')).toBe('')
    expect(existsSync(join(world, 'software'))).toBe(false)
    expect(f.notified).toEqual([])
  } finally { await f.close() }
})

it('does not create code when the World origin changes during remote discovery', async () => {
  const f = fixture()
  try {
    const world = await preexistingWorld(f)
    f.creation.beforeFind = () => gitIn(world, 'remote', 'set-url', 'origin', 'https://github.com/example/replaced-world.git')
    const operation = randomUUID()
    expect(await f.invoke('forgeSetup:provision', codeFor(world), operation)).toMatchObject({
      state: 'needs-attention', phase: 'code-remote', message: expect.stringContaining('origin changed')
    })
    expect(f.created).toEqual([])
    const journal = JSON.parse(readFileSync(join(f.home, 'provisioning.json'), 'utf8')) as { entries: ForgeProvisionIntent[] }
    expect(journal.entries.find(entry => entry.id === operation)?.codeRemote).toBeUndefined()
    expect(existsSync(join(f.destination, 'software'))).toBe(false)
  } finally { await f.close() }
})

const linkedSoftware = { folder: 'PriorAlias', repository: 'https://github.com/example/software.git' }

async function preexistingWorld(f: ReturnType<typeof fixture>): Promise<string> {
  await f.forge.ready
  f.creation.loseCodeResponse = false
  const world = join(f.scratch.path, 'existing-world')
  const bare = join(f.scratch.path, 'tickets.git')
  const url = 'https://github.com/example/tickets.git'
  mkdirSync(world)
  mkdirSync(bare)
  gitIn(bare, 'init', '--bare', '--initial-branch=main')
  gitIn(world, 'init', '--initial-branch=main')
  gitIn(world, 'remote', 'add', 'origin', url)
  createForge(world, 'example')
  gitIn(world, 'add', '--', 'forge-world.json')
  gitIn(world, 'commit', '-m', 'Create pre-existing World fixture')
  gitIn(world, 'push', bare, 'HEAD:refs/heads/main')
  f.remotes.set('tickets', { id: 1, name: 'tickets', owner: 'example', ownerId: 117, visibility: 'private', provenance: null, url })
  f.registry.track(world)
  return world
}

async function worldForMapping(f: ReturnType<typeof fixture>) {
  await f.forge.ready
  f.creation.loseCodeResponse = false
  const status = await f.invoke('forgeSetup:provision', { world: { kind: 'new', name: 'tickets' } }, randomUUID()) as ForgeProvisionStatus
  expect(status).toMatchObject({ state: 'complete', world: expect.any(String) })
  return status.world!
}

function codeFor(world: string) {
  return { world: { kind: 'existing', folder: world }, code: { name: 'software', visibility: 'public', recipeId: 'boosterseat-react' } }
}

async function replayOwnedMember(f: ReturnType<typeof fixture>, operation: string) {
  const journal = JSON.parse(readFileSync(join(f.home, 'provisioning.json'), 'utf8')) as { entries: ForgeProvisionIntent[] }
  const retained = journal.entries.find(entry => entry.id === operation)!
  const work = createForgeProvisioningWork({
    home: f.home, registry: f.registry, pool: f.pool, session: f.session, publisher: f.publisher, git: new ForgeGit(f.session, f.runner),
    pickDirectory: async () => { throw new Error('An owned member cannot require a new picker.') },
    discover: async () => { throw new Error('An owned member cannot require new descriptor discovery.') },
    withWorld: async (_world, effect) => effect(),
    synchronize: async () => { throw new Error('Member replay should not publish the world directly.') }
  })
  return work.member({ ...retained, member: undefined, phase: 'member', state: 'running' }, f.remotes.get('software')!)
}

it('refuses a remote URL already mapped under another member before creating code or opening a local checkout', async () => {
  const f = fixture()
  try {
    const world = await worldForMapping(f)
    await f.invoke('forge:add', world, linkedSoftware.repository, linkedSoftware.folder)
    expect(await f.invoke('forgeSetup:provision', codeFor(world), randomUUID())).toMatchObject({
      state: 'refused', message: expect.stringContaining('already maps this folder or repository')
    })
    expect(f.created).toEqual(['tickets'])
    expect(existsSync(join(f.destination, 'software'))).toBe(false)
    const current = parseForge(readFileSync(join(world, 'forge-world.json'), 'utf8'))
    expect(current.projects).toEqual([linkedSoftware])
  } finally { await f.close() }
})

it('keeps a late conflicting mapping and staged ticket project separate, then resumes the owned receipt after repair', async () => {
  const f = fixture()
  try {
    const world = await preexistingWorld(f)
    f.discovery.before = () => updateForge(world, manifest => { manifest.projects.push(linkedSoftware) })
    const operation = randomUUID()
    expect(await f.invoke('forgeSetup:provision', codeFor(world), operation)).toMatchObject({
      state: 'needs-attention', phase: 'member', message: expect.stringContaining('already maps this folder or repository')
    })
    expect(existsSync(join(world, 'software'))).toBe(false)
    expect(parseForge(readFileSync(join(world, 'forge-world.json'), 'utf8')).projects).toEqual([linkedSoftware])
    expect(f.created).toEqual(['software'])
    expect(f.notified).toEqual([])
    updateForge(world, manifest => { manifest.projects = [] })
    f.discovery.before = () => { throw new Error('Staged preparation evidence already exists') }
    expect(await f.invoke('forgeSetup:resumeProvision', operation)).toMatchObject({ state: 'complete', member: join(world, 'software') })
    expect(f.created).toEqual(['software'])
    expect(f.notified).toEqual([join(world, 'software')])
    await expect(replayOwnedMember(f, operation)).resolves.toMatchObject({ path: join(world, 'software') })
    updateForge(world, manifest => { manifest.projects.push(linkedSoftware) })
    await expect(replayOwnedMember(f, operation)).rejects.toThrow('already maps this folder or repository')
    expect(parseForge(readFileSync(join(world, 'forge-world.json'), 'utf8')).projects).toHaveLength(2)
  } finally { await f.close() }
})

it('preserves the recorded member when its mapping changes at the actual World push boundary', async () => {
  const f = fixture()
  try {
    await f.forge.ready
    f.creation.loseCodeResponse = false
    const operation = randomUUID()
    const bare = join(f.scratch.path, 'tickets.git')
    f.state.beforeWorldPush = root => {
      updateForge(root, manifest => { manifest.projects.push(linkedSoftware) })
      gitIn(root, 'add', '--', 'forge-world.json')
      gitIn(root, 'commit', '-m', 'Edit the world mapping before publication')
    }
    const request = { world: { kind: 'new', name: 'tickets' }, code: { name: 'software', visibility: 'private', recipeId: 'boosterseat-react' } }
    const interrupted = await f.invoke('forgeSetup:provision', request, operation) as ForgeProvisionStatus
    expect(gitIn(bare, 'branch', '--list')).toBe('')
    expect(interrupted).toMatchObject({ state: 'needs-attention', phase: 'publish', message: expect.stringContaining('already maps'), member: expect.any(String) })
    expect(f.notified).toEqual([])

    const world = interrupted.world!
    updateForge(world, manifest => { manifest.projects = [] })
    const networkBeforeResume = f.network.length
    f.state.beforeWorldPush = () => { throw new Error('A record without its mapping must not start a push') }
    expect(await f.invoke('forgeSetup:resumeProvision', operation)).toMatchObject({
      state: 'needs-attention', message: expect.stringContaining('no longer maps the confirmed code repository')
    })
    expect(f.network).toHaveLength(networkBeforeResume)
    expect(f.created).toEqual(['tickets', 'software'])
    expect(f.state.codePushes).toBe(1)
    expect(readForgeSetupWorkflow(interrupted.member!)).not.toBeNull()
    expect(f.notified).toEqual([])
  } finally { await f.close() }
})
