import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readLocalGitOrigin } from '../../core/repo/git'
import { LocalGitOriginConfigCache } from '../../core/repo/gitOriginConfig'
import { writeForgeRecipebook } from '../../core/repo/forgeSetupStorage'
import type { ForgeProvisionRequest } from '../../shared/desktop/forgeSetup'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createFolderRegistry } from './folderRegistry'
import { ForgeGit } from './forgeGit'
import { createForge, updateForge } from './forgeManifest'
import type { ForgeProvisionIntent, ProvisionDestination } from './forgeProvisioning'
import { createForgeProvisioningWork } from './forgeProvisioningWork'
import type { ForgePublishedRepository } from './forgePublish'
import { bundledForgeRecipes } from './forgeScaffold'

vi.mock('../../core/repo/git', async importOriginal => {
  const actual = await importOriginal<typeof import('../../core/repo/git')>()
  return { ...actual, readLocalGitOrigin: vi.fn(actual.readLocalGitOrigin) }
})

const account = { id: 42, login: 'fixture-owner' }
const worldRemote: ForgePublishedRepository = { id: 600, name: 'mature-world', owner: 'team', ownerId: 141,
  visibility: 'private', url: 'https://github.com/team/mature-world.git', provenance: null }
const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })

function fixture(initializedGit = true) {
  const scratch = scratchDir('forge-admission-')
  cleanups.push(scratch.cleanup)
  const home = join(scratch.path, 'app-data')
  const world = join(scratch.path, 'mature-world')
  const parent = join(scratch.path, 'code')
  for (const path of [home, world, parent]) mkdirSync(path)
  if (initializedGit) {
    gitIn(world, 'init', '--initial-branch=main')
    gitIn(world, 'remote', 'add', 'origin', worldRemote.url)
  }
  createForge(world, 'team')
  const state = { remote: worldRemote as ForgePublishedRepository | null, chosen: parent as string | null,
    login: account.login, addedAt: '2026-01-01T01:00:00.000Z', beforePick: () => {} }
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home, now: () => state.addedAt })
  registry.track(world)
  const inspectRemote = vi.fn(async () => state.remote)
  const pickDirectory = vi.fn(async () => { state.beforePick(); return state.chosen })
  const session = { getAccount: () => ({ login: state.login }), getToken: () => 'test-only-token' }
  const work = createForgeProvisioningWork({
    home, registry, session, pickDirectory, git: new ForgeGit(session),
    publisher: { inspectRemote, account: async () => account, findRemote: async () => null,
      createRemote: async () => { throw new Error('Preflight must not create a repository.') } },
    pool: { get: () => { throw new Error('Preflight must not open a ticket store.') }, close: async () => {} },
    discover: async () => { throw new Error('Preflight must not discover source.') },
    withWorld: async (_root, change) => change(),
    synchronize: async () => { throw new Error('Preflight must not synchronize.') }
  })
  const request: ForgeProvisionRequest = { world: { kind: 'existing', folder: world },
    code: { name: 'software', visibility: 'private', recipeId: 'boosterseat-react' } }
  const intent = (destination: ProvisionDestination): ForgeProvisionIntent => ({
    id: randomUUID(), request, account, destination, phase: 'checking', state: 'running', message: null
  })
  return { world, parent, home, state, registry, work, request, intent, inspectRemote, pickDirectory }
}

it('keeps an existing team Forge World and pins the selected custom recipe before code creation', async () => {
  const f = fixture()
  const book = bundledForgeRecipes()
  const base = book.recipes.find(recipe => recipe.id === 'boosterseat-react')!
  const custom = { ...base, id: 'custom.react', title: 'Team React', baseRecipeId: base.id }
  writeForgeRecipebook(f.world, null, { ...book, recipes: [...book.recipes, custom] })
  f.request.code!.recipeId = custom.id
  const selected = await f.work.prepare(f.request, account)
  expect(selected).toMatchObject({
    parent: f.parent, parentIdentity: expect.any(String), recipeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    existingWorld: { path: f.world, url: worldRemote.url, remoteId: worldRemote.id, addedAt: f.state.addedAt }
  })
  const operation = f.intent(selected!)
  await expect(f.work.world(operation, undefined)).resolves.toMatchObject({ path: f.world, identity: selected!.existingWorld!.identity })
  f.state.remote = { ...worldRemote, id: worldRemote.id + 1 }
  await expect(f.work.world(operation, undefined)).rejects.toThrow('confirmed GitHub repository changed')
  expect(f.inspectRemote.mock.calls).toHaveLength(3)
})

it('refuses missing local or remote authority before opening the code destination picker', async () => {
  const f = fixture()
  f.state.remote = null
  await expect(f.work.prepare(f.request, account)).rejects.toThrow('could not confirm')
  expect(f.pickDirectory).not.toHaveBeenCalled()
  f.registry.untrack(f.world)
  f.inspectRemote.mockClear()
  await expect(f.work.prepare(f.request, account)).rejects.toThrow('Open the existing Forge World')
  expect(f.inspectRemote).not.toHaveBeenCalled()
  expect(f.pickDirectory).not.toHaveBeenCalled()
  const unlinked = fixture(false)
  await expect(unlinked.work.prepare(unlinked.request, account)).rejects.toThrow('no GitHub origin')
  expect(unlinked.inspectRemote).not.toHaveBeenCalled()
})

it('rejects an unknown saved recipe before opening the checkout picker', async () => {
  const f = fixture()
  f.request.code!.recipeId = 'missing'
  await expect(f.work.prepare(f.request, account)).rejects.toThrow('Choose a recipe in the Forge World recipe book')
  expect(f.pickDirectory).not.toHaveBeenCalled()
})

it('leaves the checkout decision uncommitted for cancel, relative and occupied locations', async () => {
  const f = fixture()
  f.state.chosen = null
  expect(await f.work.prepare(f.request, account)).toBeNull()
  f.state.chosen = 'relative-parent'
  await expect(f.work.prepare(f.request, account)).rejects.toThrow('Choose a local parent')
  f.state.chosen = f.parent
  const existing = join(f.parent, 'software')
  mkdirSync(existing)
  writeFileSync(join(existing, 'keep.txt'), 'personal files')
  await expect(f.work.prepare(f.request, account)).rejects.toThrow('checkout folder already exists')
  expect(readFileSync(join(existing, 'keep.txt'), 'utf8')).toBe('personal files')
})

it('rejects a nested or linked code checkout parent', async () => {
  const f = fixture()
  f.state.chosen = f.world
  await expect(f.work.prepare(f.request, account)).rejects.toThrow('outside all tracked ticket')
  const alias = join(f.home, 'linked-parent')
  symlinkSync(f.parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
  f.state.chosen = alias
  await expect(f.work.prepare(f.request, account)).rejects.toThrow('not an ordinary directory')
})

it('revalidates the world origin after the native picker and refuses a new attachment generation', async () => {
  const f = fixture()
  f.state.beforePick = () => { gitIn(f.world, 'remote', 'set-url', 'origin', 'https://github.com/team/a-different-world.git') }
  await expect(f.work.prepare(f.request, account)).rejects.toThrow('origin changed')
  gitIn(f.world, 'remote', 'set-url', 'origin', worldRemote.url)
  f.state.beforePick = () => {}
  const operation = f.intent((await f.work.prepare(f.request, account))!)
  f.registry.untrack(f.world)
  f.state.addedAt = '2026-01-02T01:00:00.000Z'
  f.registry.track(f.world)
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('untracked or its origin changed')
})

it('checks the latest mapping after the native picker before recording creation intent', async () => {
  const f = fixture()
  f.state.beforePick = () => updateForge(f.world, manifest => {
    manifest.projects.push({ folder: 'ExistingAlias', repository: 'https://github.com/fixture-owner/software.git' })
  })
  await expect(f.work.prepare(f.request, account)).rejects.toThrow('already maps this folder or repository')
  expect(f.pickDirectory).toHaveBeenCalledOnce()
})

it('rejects a published receipt pointing at a different tracked clone of the same Forge World', async () => {
  const f = fixture()
  const destination = (await f.work.prepare(f.request, account))!
  const operation = f.intent(destination)
  operation.world = await f.work.world(operation, undefined)
  await expect(f.work.assertCurrent(operation)).resolves.toBeUndefined()

  const mirror = join(f.home, '..', 'other-world-checkout')
  mkdirSync(mirror)
  gitIn(mirror, 'init', '--initial-branch=main')
  gitIn(mirror, 'remote', 'add', 'origin', worldRemote.url)
  createForge(mirror, 'team')
  f.registry.track(mirror)
  const stat = lstatSync(mirror, { bigint: true })
  operation.world = { path: mirror, identity: [stat.dev, stat.ino, stat.birthtimeNs].join(':') }
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('Forge World checkout receipt changed')
  operation.world.path = f.world
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('Forge World checkout receipt changed')
})

it('rejects changed origin, worktree, and Git discovery metadata during phase admission', async () => {
  const f = fixture()
  const destination = (await f.work.prepare(f.request, account))!
  const operation = f.intent(destination)
  const { path, identity } = destination.existingWorld!
  operation.world = { path, identity }
  const reads = vi.mocked(readLocalGitOrigin)
  reads.mockClear()

  await f.work.assertCurrent(operation)
  expect(reads).toHaveBeenCalledExactlyOnceWith(f.world, expect.any(LocalGitOriginConfigCache))
  // A new phase must honor a Git admission refusal even if local metadata still matches.
  reads.mockReturnValueOnce(null)
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('no GitHub origin')
  expect(reads).toHaveBeenCalledTimes(2)

  gitIn(f.world, 'remote', 'set-url', 'origin', 'https://github.com/team/replaced-world.git')
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('origin changed')
  expect(reads).toHaveBeenCalledTimes(3)

  gitIn(f.world, 'remote', 'set-url', 'origin', worldRemote.url)
  gitIn(f.world, 'config', '--local', 'core.worktree', f.parent)
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('no GitHub origin')
  expect(reads).toHaveBeenCalledTimes(4)

  gitIn(f.world, 'config', '--local', '--unset', 'core.worktree')
  await f.work.assertCurrent(operation)
  const git = join(f.world, '.git')
  renameSync(join(git, 'HEAD'), join(git, 'temporarily-disconnected-HEAD'))
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('no GitHub origin')
  expect(reads).toHaveBeenCalledTimes(6)
})

it('rejects a checkout origin whose Git metadata changes during the real check', async () => {
  const f = fixture()
  const destination = (await f.work.prepare(f.request, account))!
  const operation = f.intent(destination)
  const reads = vi.mocked(readLocalGitOrigin)
  const verify = reads.getMockImplementation()!
  reads.mockImplementationOnce(path => {
    const current = verify(path)
    gitIn(path, 'remote', 'set-url', 'origin', 'https://github.com/team/replaced-while-checking.git')
    return current
  })
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('metadata changed while verifying its origin')
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('origin changed')
})

it('accepts a linked worktree and detects a later shared Git config change', async () => {
  const f = fixture()
  gitIn(f.world, 'add', '--', 'forge-world.json')
  gitIn(f.world, 'commit', '-m', 'Seed the ticket world')
  const linked = join(f.home, '..', 'linked-world')
  gitIn(f.world, 'worktree', 'add', '-b', 'linked', linked)
  f.registry.track(linked)
  const request = { ...f.request, world: { kind: 'existing' as const, folder: linked } }
  const operation = f.intent((await f.work.prepare(request, account))!)
  const reads = vi.mocked(readLocalGitOrigin)
  reads.mockClear()
  await f.work.assertCurrent(operation)
  await f.work.assertCurrent(operation)
  expect(reads.mock.calls).toEqual([[linked], [linked]])

  gitIn(f.world, 'remote', 'set-url', 'origin', 'https://github.com/team/replaced-shared.git')
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('origin changed')
  expect(reads).toHaveBeenCalledTimes(3)
})

it('refuses a substituted code parent and an account change on an existing receipt', async () => {
  const f = fixture()
  const operation = f.intent((await f.work.prepare(f.request, account))!)
  f.state.login = 'someone-else'
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('Sign back into the GitHub account')
  f.state.login = account.login
  renameSync(f.parent, join(f.home, 'original-parent'))
  mkdirSync(f.parent)
  await expect(f.work.assertCurrent(operation)).rejects.toThrow('parent folder changed')
})
