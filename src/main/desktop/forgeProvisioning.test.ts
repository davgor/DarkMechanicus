import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenameRetryNote } from '../../core/repo/forgeManifest'
import { refuseRenames, releaseRenames, renamesAsked } from '../../test/busyRename'
import { scratchDir } from '../../test/gitScratch'
import { createForgeProvisioning, type ForgeProvisioningWork } from './forgeProvisioning'
import { ForgeCreationRefused, type ForgePublishedRepository } from './forgePublish'

// vi.mock factories run before the file's static imports, so the helper is loaded from inside the factory.
vi.mock('node:fs', async original => (await import('../../test/busyRename')).withBusyRename(await original()))

const cleanups: Array<() => void> = []
afterEach(() => {
  releaseRenames()
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const accounts = { owner: { login: 'owner', id: 42 }, changed: { login: 'other', id: 77 } }
const createRequest = {
  world: { kind: 'new' as const, name: 'tickets' },
  code: { name: 'code', visibility: 'private' as const, recipeId: 'react' }
}

function fixture() {
  const scratch = scratchDir('dm-forge-provision-')
  cleanups.push(scratch.cleanup)
  const file = join(scratch.path, 'provisioning.json')
  const calls: string[] = []
  const remotes = new Map<string, ForgePublishedRepository>()
  const change = { account: accounts.owner, fail: '', refused: '', disappear: false, cancel: false, invalidParent: false, signedOut: false,
    beforeCreate: undefined as ((name: string) => Promise<void>) | undefined, beforePrepare: undefined as (() => Promise<void>) | undefined }
  const work: ForgeProvisioningWork = {
    async prepare() {
      await change.beforePrepare?.()
      if (change.invalidParent) throw new Error('The checkout parent contains unrelated files.')
      return change.cancel ? null : { parent: scratch.path }
    },
    async assertCurrent() {},
    async account() { return change.account },
    currentLogin: () => change.signedOut ? null : change.account.login,
    async findRemote(_account, name) {
      calls.push('inspect ' + name)
      return change.disappear ? null : remotes.get(name) ?? null
    },
    async createRemote({ account, name, visibility, provenance }) {
      calls.push('create ' + name)
      await change.beforeCreate?.(name)
      if (change.refused === name) throw new ForgeCreationRefused('GitHub refused creation before any effect.')
      const repo = {
        id: remotes.size + 1, owner: account.login, ownerId: account.id, name, visibility,
        url: 'https://github.com/' + account.login + '/' + name + '.git', provenance
      }
      remotes.set(name, repo)
      if (change.fail === name) throw new Error('The HTTP response was lost.')
      return repo
    },
    async world() { calls.push('world'); return { path: join(scratch.path, 'world'), identity: 'app-owned world' } },
    async code() { calls.push('code'); return { path: join(scratch.path, 'code'), commit: 'a'.repeat(40), identity: 'checkout' } },
    async member() { calls.push('member'); return { path: join(scratch.path, 'world', 'code'), identity: 'project' } },
    async publish() { calls.push('publish'); if (change.fail === 'publish') throw new Error('Publish blocked.') }
  }
  const operation = randomUUID()
  return { calls, remotes, start: (onRetry?: RenameRetryNote) => createForgeProvisioning(file, work, onRetry), change, file, operation }
}

function barrier() {
  let open = () => {}
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

it('recovers a lost create response across a fresh journal reader without another POST', async () => {
  const f = fixture()
  f.change.fail = 'code'
  const first = await f.start().provision(createRequest, f.operation)
  expect(first).toMatchObject({ state: 'needs-attention', phase: 'code-remote' })
  f.change.fail = ''
  const resumed = await f.start().resumeProvision(f.operation)
  expect(resumed).toMatchObject({ state: 'complete', phase: 'complete' })
  expect(f.calls).toEqual([
    'inspect tickets', 'create tickets', 'world', 'inspect code', 'create code',
    'inspect tickets', 'inspect code', 'code', 'member', 'publish'
  ])
})

it('leaves an ambiguous creation pending when discovery cannot see it', async () => {
  const f = fixture()
  f.change.fail = 'tickets'
  await f.start().provision(createRequest, f.operation)
  f.change.disappear = true
  const pending = await f.start().resumeProvision(f.operation)
  expect(pending).toMatchObject({ phase: 'world-remote', state: 'needs-attention', message: expect.stringContaining('creation') })
  expect(f.calls.filter(call => call.startsWith('create'))).toEqual(['create tickets'])
})

it('does not adopt a same-name repository with unrelated provenance after a lost response', async () => {
  const f = fixture()
  f.change.fail = 'tickets'
  await f.start().provision(createRequest, f.operation)
  const intended = f.remotes.get('tickets')!
  f.remotes.set('tickets', { ...intended, id: 40, provenance: 'unrelated' })
  const pending = await f.start().resumeProvision(f.operation)
  expect(pending).toMatchObject({ state: 'needs-attention', phase: 'world-remote', message: expect.stringContaining('different') })
  expect(f.calls).not.toContain('world')
  expect(f.calls.filter(call => call.startsWith('create'))).toEqual(['create tickets'])
})

it('keeps checkout and member receipts after publish fails and rejects an account switch', async () => {
  const f = fixture()
  f.change.fail = 'publish'
  const first = await f.start().provision(createRequest, f.operation)
  expect(first).toMatchObject({ state: 'needs-attention', phase: 'publish', member: expect.any(String) })
  f.change.account = accounts.changed
  await expect(f.start().provisioning()).resolves.toEqual([])
  expect(await f.start().resumeProvision(f.operation)).toMatchObject({ state: 'needs-attention', message: expect.stringContaining('account') })
  expect(f.calls.filter(call => call === 'publish')).toHaveLength(1)
  f.change.account = accounts.owner
  f.change.fail = ''
  expect(await f.start().resumeProvision(f.operation)).toMatchObject({ state: 'complete' })
  expect(f.calls.filter(call => call === 'create tickets' || call === 'create code' || call === 'world' || call === 'code' || call === 'member'))
    .toEqual(['create tickets', 'world', 'create code', 'code', 'member'])
})

it('does not create a remote from a cancelled checkout picker, and supports world-only creation', async () => {
  const f = fixture()
  f.change.cancel = true
  await expect(f.start().provision(createRequest, f.operation)).resolves.toBeNull()
  expect(f.calls).toEqual([])
  f.change.cancel = false
  expect(await f.start().provision({ world: createRequest.world }, f.operation)).toMatchObject({ state: 'complete', world: expect.any(String) })
  expect(f.calls).toEqual(['inspect tickets', 'create tickets', 'world', 'publish'])
})

it('binds the client operation to the exact account and request and returns its previous receipt', async () => {
  const f = fixture()
  f.change.fail = 'publish'
  expect(await f.start().provision(createRequest, f.operation)).toMatchObject({ id: f.operation, state: 'needs-attention' })
  expect(await f.start().provision(createRequest, f.operation)).toMatchObject({ id: f.operation, phase: 'publish', state: 'needs-attention' })
  expect(await f.start().provision({ ...createRequest, agent: 'claude' }, f.operation)).toMatchObject({ state: 'refused' })
  f.change.account = accounts.changed
  expect(await f.start().provision(createRequest, f.operation)).toMatchObject({ state: 'refused' })
  expect(await f.start().provision(createRequest, 'not-an-operation')).toMatchObject({ state: 'refused' })
  expect(f.calls.filter(call => call.startsWith('create'))).toEqual(['create tickets', 'create code'])
})

it('reports a definite local refusal without reserving a repository name or creating a remote', async () => {
  const f = fixture()
  f.change.invalidParent = true
  expect(await f.start().provision(createRequest, f.operation)).toMatchObject({ state: 'refused', message: expect.stringContaining('unrelated files') })
  expect(await f.start().provisioning()).toEqual([])
  expect(f.calls).toEqual([])
  f.change.invalidParent = false
  expect(await f.start().provision(createRequest, f.operation)).toMatchObject({ id: f.operation, state: 'complete' })
})

it('accepts a portable custom recipe identifier with a period and rejects an invalid identifier before effects', async () => {
  const f = fixture()
  const input = (recipeId: string) => ({ ...createRequest, code: { ...createRequest.code, recipeId } })
  expect(await f.start().provision(input('custom_react'), f.operation)).toMatchObject({ state: 'refused' })
  expect(f.calls).toEqual([])
  expect(await f.start().provision(input('custom.react'), f.operation)).toMatchObject({
    id: f.operation, state: 'complete', request: { code: { recipeId: 'custom.react' } }
  })
})

it('resumes a known POST refusal without replaying the already confirmed world creation', async () => {
  const f = fixture()
  f.change.refused = 'code'
  expect(await f.start().provision(createRequest, f.operation)).toMatchObject({ phase: 'code-remote', state: 'needs-attention' })
  expect(f.remotes.has('code')).toBe(false)
  f.change.refused = ''
  expect(await f.start().resumeProvision(f.operation)).toMatchObject({ state: 'complete' })
  expect(f.calls.filter(call => call.startsWith('create'))).toEqual(['create tickets', 'create code', 'create code'])
})

it('preserves unreadable provisioning history and refuses new creation', async () => {
  const f = fixture()
  const damaged = '{"version":1,"entries":'
  writeFileSync(f.file, damaged)
  await expect(f.start().provisioning()).rejects.toThrow('journal could not be read')
  await expect(f.start().provision(createRequest, f.operation)).rejects.toThrow('journal could not be read')
  expect(readFileSync(f.file, 'utf8')).toBe(damaged)
  expect(f.calls).toEqual([])
})

it('waits for an issued remote operation on shutdown and leaves later phases available to resume', async () => {
  const f = fixture()
  let release = () => {}
  const remoteReceipt = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { f.change.beforeCreate = async () => { resolve(); await remoteReceipt } })
  const active = f.start()
  const result = active.provision(createRequest, f.operation)
  await started
  const stopping = active.stop()
  release()
  await stopping
  expect(await result).toMatchObject({ state: 'needs-attention', phase: 'world-remote', message: expect.stringContaining('stopping') })
  expect(f.calls).toEqual(['inspect tickets', 'create tickets'])
  expect(await f.start().resumeProvision(f.operation)).toMatchObject({ state: 'complete' })
  expect(f.calls.filter(call => call === 'create tickets')).toHaveLength(1)
})

it('reports a live operation and leaves its restart receipt visible without posting twice on racing submits', async () => {
  const f = fixture()
  const bothPickers = barrier()
  const picked = barrier()
  const issued = barrier()
  const confirmed = barrier()
  let choices = 0
  f.change.beforePrepare = async () => { if (++choices === 2) bothPickers.open(); await picked.promise }
  f.change.beforeCreate = async () => { issued.open(); await confirmed.promise }
  const active = f.start()
  const first = active.provision(createRequest, f.operation)
  const second = active.provision(createRequest, f.operation)
  try {
    await bothPickers.promise
    picked.open()
    await issued.promise
    expect(await Promise.race([first, second])).toMatchObject({ id: f.operation, state: 'running' })
    expect(await active.provisioning()).toMatchObject([{ id: f.operation, state: 'running' }])
    expect(await f.start().provisioning()).toMatchObject([{ id: f.operation, state: 'needs-attention', message: expect.stringContaining('interrupted') }])
    const competing = await active.provision(createRequest, randomUUID())
    expect(competing).toMatchObject({ state: 'refused', message: expect.stringContaining('uses one of these repository names') })
  } finally { picked.open(); confirmed.open(); await Promise.all([first, second]) }
  expect(f.calls.filter(call => call.startsWith('create'))).toEqual(['create tickets', 'create code'])
  f.change.signedOut = true
  expect(await active.provisioning()).toEqual([])
})

it('blocks partial publication from a copied or malformed local creation marker', async () => {
  const f = fixture()
  const creation = f.start()
  expect(await creation.provision({ world: createRequest.world }, f.operation)).toMatchObject({ state: 'complete' })
  const world = join(dirname(f.file), 'world')
  const other = join(dirname(f.file), 'another-world')
  for (const root of [world, other]) {
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'forge-provisioning'), f.operation + '\n')
  }
  expect(() => creation.assertWorldPublished(world)).not.toThrow()
  expect(() => creation.assertWorldPublished(other)).toThrow('published Forge World checkout changed')
  writeFileSync(join(other, '.git', 'forge-provisioning'), randomUUID() + '\n')
  expect(() => creation.assertWorldPublished(other)).toThrow('creation receipt cannot be verified')
  writeFileSync(join(other, '.git', 'forge-provisioning'), 'invalid local data')
  expect(() => creation.assertWorldPublished(other)).toThrow('creation receipt cannot be verified')
})

it('rejects overlapping world and code names and missing operation receipts before effects', async () => {
  const f = fixture()
  const creation = f.start()
  const duplicate = { ...createRequest, code: { ...createRequest.code, name: 'TICKETS' } }
  await expect(creation.provision(duplicate, f.operation)).resolves.toMatchObject({ state: 'refused', message: expect.stringContaining('separate repository names') })
  await expect(creation.provision({ world: { kind: 'existing', folder: '/known' } }, f.operation)).resolves.toMatchObject({
    state: 'refused', message: expect.stringContaining('new code repository')
  })
  await expect(creation.resumeProvision(f.operation)).rejects.toThrow('operation no longer exists')
  await expect(creation.resumeProvision('malformed')).rejects.toThrow('operation no longer exists')
  expect(f.calls).toEqual([])
})

describe('a busy rename onto the creation journal', () => {
  it('asks again after one busy refusal and journals the creation within 300 ms', async () => {
    const f = fixture()
    const onRetry = vi.fn<RenameRetryNote>()
    let firstCreate: number | undefined
    f.change.beforeCreate = async () => { firstCreate ??= performance.now() }
    refuseRenames('EPERM')
    const started = performance.now()
    const result = await f.start(onRetry).provision(createRequest, f.operation)
    expect(result).toMatchObject({ state: 'complete', phase: 'complete' })
    expect((firstCreate ?? Infinity) - started).toBeLessThan(300)
    expect(onRetry.mock.calls).toEqual([['EPERM', f.file]])
    expect(renamesAsked()).toBeGreaterThan(2)
    expect(JSON.parse(readFileSync(f.file, 'utf8')).entries).toMatchObject([{ id: f.operation, state: 'complete' }])
    expect(readdirSync(dirname(f.file))).not.toContainEqual(expect.stringMatching(/^provisioning\.json\./))
  })

  it('throws the last busy refusal after the bound and writes no journal', async () => {
    const f = fixture()
    const onRetry = vi.fn<RenameRetryNote>()
    refuseRenames('EPERM', 'EACCES', 'EBUSY', 'EPERM')
    await expect(f.start(onRetry).provision(createRequest, f.operation)).rejects.toThrow('EPERM: rename refused')
    expect(renamesAsked()).toBe(4)
    expect(onRetry.mock.calls).toEqual([['EPERM', f.file], ['EACCES', f.file], ['EBUSY', f.file]])
    expect(existsSync(f.file)).toBe(false)
    expect(readdirSync(dirname(f.file))).not.toContainEqual(expect.stringMatching(/^provisioning\.json/))
    expect(f.calls).toEqual([])
  })

  it('throws any other error at once without asking again', async () => {
    const f = fixture()
    const onRetry = vi.fn<RenameRetryNote>()
    refuseRenames('ENOENT')
    await expect(f.start(onRetry).provision(createRequest, f.operation)).rejects.toThrow('ENOENT: rename refused')
    expect(renamesAsked()).toBe(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(existsSync(f.file)).toBe(false)
  })
})
