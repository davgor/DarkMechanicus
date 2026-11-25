import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from '../../test/workspaceHarness'
import { gitIn } from '../../test/gitScratch'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { dbProjectDir } from '../../core/repo/storageMode'
import { bindForge, currentForgeTransfer, FORGE_POINTER, withForgeTransfer } from '../../core/repo/forgeBinding'
import type { Work, WorkspaceRequest, WorkspaceResponse } from './workspaceClient'
import { serveWorkspaceOwner } from './workspaceOwnerRuntime'

const harness = new Set<ReturnType<typeof createHarness>>()
const closers = new Set<() => Promise<unknown>>()
afterEach(async () => {
  for (const close of closers) await close()
  closers.clear()
  for (const fixture of harness) fixture.cleanup()
  harness.clear()
})

function fixture() {
  const h = createHarness()
  harness.add(h)
  return h
}

function owner(home: string, generation = 1) {
  const parent = new EventEmitter()
  const child = new EventEmitter()
  const observed: WorkspaceResponse[] = []
  serveWorkspaceOwner({ home, generation, version: '1.0.0-test', ownerPid: process.pid }, {
    on(_event, listener) { child.on('message', listener); return this as Electron.ParentPort },
    postMessage(response: WorkspaceResponse) {
      observed.push(response)
      parent.emit('reply:' + response.id, response)
    }
  })
  let next = 0
  function send(request: WorkspaceRequest): Promise<WorkspaceResponse> {
    return new Promise(resolve => {
      parent.once('reply:' + request.id, resolve)
      child.emit('message', { data: request })
    })
  }
  function work(path: string, work: Work, expected?: string): Promise<WorkspaceResponse> {
    return send({ type: 'work', generation, id: ++next, path, work, expected, authority: currentForgeTransfer() })
  }
  function close() { return send({ type: 'close', generation, id: ++next }) }
  closers.add(close)
  return { work, close, observed, child }
}

it('lazily initializes the requested project and refuses a different path or injected operation', async () => {
  const h = fixture()
  const worker = owner(h.homeDir, 4)
  expect(existsSync(resolveLayout(h.root).dbFile)).toBe(false)
  worker.child.emit('message', { data: { type: 'close', generation: 3, id: 0 } })
  const initialized = await worker.work(h.root, { kind: 'command', name: 'initializeRepository', input: { name: 'Owner' } })
  expect(initialized).toMatchObject({ ok: true, generation: 4, result: { binding: expect.any(String) } })
  expect(existsSync(resolveLayout(h.root).dbFile)).toBe(true)
  await expect(worker.work(h.root, { kind: 'native', name: 'attachment', args: ['missing'] })).resolves.toMatchObject({ ok: true, result: { value: null } })
  await expect(worker.work(h.root, { kind: 'native', name: 'exec', args: [] } as unknown as Work))
    .resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  await expect(worker.work(h.root, { kind: 'command', name: 'claimTicket', input: {} } as unknown as Work))
    .resolves.toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  const otherPath = join(h.root, 'other')
  mkdirSync(otherPath)
  await expect(worker.work(otherPath, { kind: 'heartbeat' })).resolves.toMatchObject({ ok: false, error: { details: { bindingChanged: true } } })
  await expect(worker.close()).resolves.toMatchObject({ ok: true })
  await expect(worker.work(h.root, { kind: 'heartbeat' })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(worker.observed.every(response => response.generation === 4)).toBe(true)
})

it('never uses a stale durable binding after reopening a replacement checkout', async () => {
  const h = fixture()
  const first = owner(h.homeDir)
  const initialized = await first.work(h.root, { kind: 'command', name: 'initializeRepository', input: { name: 'Original' } })
  if (!initialized.ok || initialized.result.binding === undefined) throw new Error('Failed to bind original fixture')
  await first.close()
  const replacement = owner(h.homeDir)
  const parked = h.root + '-original'
  renameSync(h.root, parked)
  mkdirSync(h.root)
  try {
    await expect(replacement.work(h.root, { kind: 'native', name: 'revokeChatGrant', args: ['unknown-grant', true] }, initialized.result.binding))
      .resolves.toMatchObject({ ok: false, error: { details: { bindingChanged: true } } })
    expect(existsSync(resolveLayout(h.root).dbFile)).toBe(false)
  } finally {
    rmdirSync(h.root)
    renameSync(parked, h.root)
  }
})

it('validates the live reservation on the receiving end before admitting a migration operation', async () => {
  const h = fixture()
  const worker = owner(h.homeDir)
  const target = join(h.root, 'destination')
  const work: Work = { kind: 'native', name: 'initialized', args: [] }
  let stale: ReturnType<typeof currentForgeTransfer>
  await withForgeTransfer(h.homeDir, h.root, target, async () => {
    stale = currentForgeTransfer()
    await expect(worker.work(h.root, work)).resolves.toMatchObject({ ok: true, result: { value: false } })
  })
  const reply = new Promise<WorkspaceResponse>(resolve => {
    const replyPort: Pick<Electron.ParentPort, 'on' | 'postMessage'> = {
      on(_event, listener) {
        listener({ data: { type: 'work', generation: 7, id: 1, path: h.root, work, expected: undefined, authority: stale }, ports: [] })
        return this as Electron.ParentPort
      },
      postMessage: resolve
    }
    serveWorkspaceOwner({ generation: 7, home: h.homeDir, ownerPid: process.pid, version: '1.0.0-test' }, replyPort)
  })
  await expect(reply).resolves.toMatchObject({ ok: false, error: { code: 'conflict', message: 'The Forge conversion reservation ended.' } })
})

it('uses the first explicit member reconcile as the cold import instead of consuming it on open', async () => {
  const h = fixture()
  const source = h.open('desktop')
  await source.initializeRepository({ name: 'Portable history' })
  const card = await source.createKanbanCard({ title: 'Persisted portable card' })
  // The desktop registry resolves short or aliased TEMP paths before posting owner work.
  const clone = realpathSync.native(h.cloneTracked())
  const alias = join(h.homeDir, 'clone-alias')
  symlinkSync(clone, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const worker = owner(h.homeDir)
  const reconcile: Work = { kind: 'native', name: 'reconcileMember', args: [] }
  await expect(worker.work(alias, reconcile)).resolves.toMatchObject({
    ok: false, error: { code: 'conflict', message: 'The tracked folder moved.' }
  })
  expect(existsSync(resolveLayout(clone).dbFile)).toBe(false)
  const first = await worker.work(clone, reconcile)
  if (!first.ok) throw new Error(first.error.message)
  expect(first.result.value).toMatchObject({
    hasLocalCache: false, result: { imported: expect.arrayContaining(['kanban:' + card.id]), rejected: [] }
  })
  const second = await worker.work(clone, reconcile, first.result.binding)
  expect(second).toMatchObject({ ok: true, result: { value: { hasLocalCache: true, result: { imported: [], rejected: [] } } } })
})


it('refuses a hard-linked database before admitting workspace operations', async () => {
  const h = fixture()
  const source = h.open('desktop')
  await source.initializeRepository({ name: 'Linked database' })
  source.close()
  const database = resolveLayout(h.root).dbFile
  const secondName = join(h.homeDir, 'linked.sqlite')
  const before = readFileSync(database)
  linkSync(database, secondName)
  const worker = owner(h.homeDir)
  await expect(worker.work(h.root, { kind: 'command', name: 'createKanbanCard', input: { title: 'Must not write' } }))
    .resolves.toMatchObject({ ok: false, error: { code: 'conflict', message: 'The project database has unexpected hard links.' } })
  expect(readFileSync(secondName)).toEqual(before)
})

it('refuses a source path whose link would open a different project inside the owner', async () => {
  const h = fixture()
  const member = join(h.homeDir, 'member')
  mkdirSync(member)
  const pointer = `Forge World: https://github.com/example/world.git
Project folder: Member
`
  writeFileSync(join(h.root, FORGE_POINTER), pointer)
  bindForge(h.homeDir, h.root, member, pointer)
  const worker = owner(h.homeDir)
  await expect(worker.work(h.root, { kind: 'command', name: 'initializeRepository', input: { name: 'Must not initialize' } }))
    .resolves.toMatchObject({ ok: false, error: { code: 'conflict', details: { bindingChanged: true } } })
  expect(existsSync(resolveLayout(member).projectFile)).toBe(false)
})

it('fences replies when project metadata changes after work admission', async () => {
  const h = fixture()
  const worker = owner(h.homeDir)
  const initialized = await worker.work(h.root, { kind: 'command', name: 'initializeRepository', input: { name: 'Original' } })
  expect(initialized.ok).toBe(true)
  const projectFile = resolveLayout(h.root).projectFile
  const replacement = JSON.parse(readFileSync(projectFile, 'utf8'))
  replacement.projectId = 'pj_00000000000000000000000999'
  // Schedule the replacement from the owner’s first canonical identity check, after the request
  // reaches the queue head. It then lands before the operation's asynchronous result is returned.
  const identity = vi.spyOn(realpathSync, 'native').mockImplementationOnce(() => {
    queueMicrotask(() => writeFileSync(projectFile, JSON.stringify(replacement)))
    return h.root
  })
  try {
    await expect(worker.work(h.root, { kind: 'native', name: 'initialized', args: [] })).resolves.toMatchObject({
      ok: false, error: { code: 'conflict', details: { bindingChanged: true, completion: 'stale' } }
    })
  } finally { identity.mockRestore() }
})

it('uses a moved open handle only for a grant revocation with the exact durable binding', async () => {
  const h = fixture()
  const worker = owner(h.homeDir)
  await worker.work(h.root, { kind: 'command', name: 'initializeRepository', input: { name: 'Original grant owner' } })
  const issued = await worker.work(h.root, { kind: 'native', name: 'issueChatGrant', args: [{ role: 'worker', label: 'Moved grant' }] })
  if (!issued.ok) throw new Error(issued.error.message)
  const { binding, value } = issued.result
  const grantId = (value as { grant: { id: string } }).grant.id
  const path = vi.spyOn(realpathSync, 'native')
  const missing = () => path.mockImplementationOnce(() => {
    throw Object.assign(new Error('The original folder disappeared.'), { code: 'ENOENT' })
  })
  try {
    missing()
    await expect(worker.work(h.root, { kind: 'native', name: 'revokeChatGrant', args: [grantId, false] }, 'new binding'))
      .resolves.toMatchObject({ ok: false, error: { message: 'The original folder disappeared.' } })
    missing()
    await expect(worker.work(h.root, { kind: 'command', name: 'createKanbanCard', input: { title: 'Refused' } }, binding))
      .resolves.toMatchObject({ ok: false, error: { message: 'The original folder disappeared.' } })
    missing()
    await expect(worker.work(h.root, { kind: 'native', name: 'revokeChatGrant', args: [grantId, false] }, binding))
      .resolves.toMatchObject({ ok: true, result: { binding, value: false } })
  } finally { path.mockRestore() }
  await worker.close()
  expect(await h.open('desktop').listGrants()).toEqual([expect.objectContaining({ id: grantId, active: false })])
})

it('publishes a confirmed storage change under its new binding and rejects the old generation fence', async () => {
  const h = fixture()
  gitIn(h.root, 'init', '-b', 'main')
  const worker = owner(h.homeDir)
  const original = await worker.work(h.root, { kind: 'command', name: 'initializeRepository', input: { name: 'Portable project', mode: 'repo' } })
  if (!original.ok) throw new Error(original.error.message)
  const switchMode: Work = { kind: 'command', name: 'switchStorageMode', input: { mode: 'db', confirmed: true } }
  await expect(worker.work(h.root, switchMode, original.result.binding)).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining('commit') } })
  gitIn(h.root, 'add', '.darkmechanicus')
  gitIn(h.root, 'commit', '-m', 'Track the portable store')
  const moved = await worker.work(h.root, switchMode, original.result.binding)
  if (!moved.ok) throw new Error(moved.error.message)
  expect(moved.result).toMatchObject({ value: { mode: 'db', cleanupPending: false }, binding: expect.any(String) })
  expect(moved.result.binding).not.toBe(original.result.binding)
  const read: Work = { kind: 'command', name: 'getStorageStatus', input: undefined }
  await expect(worker.work(h.root, read, original.result.binding)).resolves.toMatchObject({ ok: false, error: { details: { bindingChanged: true } } })
  await expect(worker.work(h.root, read, moved.result.binding)).resolves.toMatchObject({ ok: true, result: { value: { storage: { mode: 'db' } } } })
})

/** Ages a file past the owner's settle window, so its stamp may be trusted. */
function settle(file: string): void {
  const past = new Date(Date.now() - 60_000)
  utimesSync(file, past, past)
}

async function warmOwner(name: string) {
  const h = fixture()
  const worker = owner(h.homeDir)
  const initialized = await worker.work(h.root, { kind: 'command', name: 'initializeRepository', input: { name } })
  if (!initialized.ok || initialized.result.binding === undefined) throw new Error('Failed to initialize the fixture')
  const projectFile = resolveLayout(h.root).projectFile
  settle(projectFile)
  const read: Work = { kind: 'native', name: 'initialized', args: [] }
  await expect(worker.work(h.root, read, initialized.result.binding)).resolves.toMatchObject({ ok: true })
  return { h, worker, read, projectFile, binding: initialized.result.binding }
}

// The operation itself (a reconcile, say) reads what it needs; the owner's own identity check reads nothing.
it('checks identity without reading an unchanged project.json once its stamp is known', async () => {
  const { h, worker, read, projectFile, binding } = await warmOwner('Stamped')
  const stacks: string[] = []
  const original = nodeFs.readFile
  const reads = vi.spyOn(nodeFs, 'readFile').mockImplementation((path) => { const stack = new Error().stack ?? ''; if (path === projectFile && stack.includes('workspaceOwnerRuntime.ts')) stacks.push(stack); return original(path) })
  try {
    await expect(worker.work(h.root, read, binding)).resolves.toMatchObject({ ok: true, result: { binding } })
    await expect(worker.work(h.root, { kind: 'heartbeat' }, binding)).resolves.toMatchObject({ ok: true, result: { binding } })
    expect(stacks).toEqual([])
  } finally { reads.mockRestore() }
})

it('still rejects a changed project, a hard-linked database, a new binding and a moved folder on a warm owner', async () => {
  const changed = await warmOwner('Project change')
  const replacement = JSON.parse(readFileSync(changed.projectFile, 'utf8'))
  replacement.projectId = 'pj_00000000000000000000000998'
  writeFileSync(changed.projectFile + '.new', JSON.stringify(replacement))
  renameSync(changed.projectFile + '.new', changed.projectFile)
  settle(changed.projectFile)
  await expect(changed.worker.work(changed.h.root, changed.read, changed.binding))
    .resolves.toMatchObject({ ok: false, error: { code: 'conflict', details: { bindingChanged: true } } })

  const linked = await warmOwner('Linked later')
  linkSync(resolveLayout(linked.h.root).dbFile, join(linked.h.homeDir, 'linked-later.sqlite'))
  await expect(linked.worker.work(linked.h.root, linked.read, linked.binding))
    .resolves.toMatchObject({ ok: false, error: { code: 'conflict', message: 'The project database has unexpected hard links.' } })

  const bound = await warmOwner('Bound later')
  const member = join(bound.h.homeDir, 'member')
  mkdirSync(member)
  bindForge(bound.h.homeDir, bound.h.root, member, '')
  await expect(bound.worker.work(bound.h.root, bound.read, bound.binding))
    .resolves.toMatchObject({ ok: false, error: { code: 'conflict', details: { bindingChanged: true } } })

  // Windows refuses to rename a folder whose database is open, so the folder's real path moves instead.
  const moved = await warmOwner('Moved later')
  const elsewhere = vi.spyOn(realpathSync, 'native').mockImplementationOnce(() => moved.h.root + '-elsewhere')
  try {
    await expect(moved.worker.work(moved.h.root, moved.read, moved.binding))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict', message: 'The tracked folder moved.' } })
  } finally { elsewhere.mockRestore() }
})

it('rejects a storage change made outside a warm owner', async () => {
  const { h, worker, read, binding } = await warmOwner('Mode change')
  // A database-only project file in the home directory switches the folder's storage mode.
  const dbProject = dbProjectDir(h.root, h.homeDir)
  mkdirSync(dbProject, { recursive: true })
  writeFileSync(join(dbProject, 'project.json'), readFileSync(resolveLayout(h.root).projectFile, 'utf8'))
  await expect(worker.work(h.root, read, binding))
    .resolves.toMatchObject({ ok: false, error: { code: 'conflict', details: { bindingChanged: true } } })
})
