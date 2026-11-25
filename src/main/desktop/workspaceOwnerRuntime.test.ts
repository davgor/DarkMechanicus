import { afterEach, expect, it, vi } from 'vitest'
import { AsyncResource } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from '../../test/workspaceHarness'
import { gitIn } from '../../test/gitScratch'
import { resolveLayout } from '../../core/repo/layout'
import { bindForge, currentForgeTransfer, FORGE_POINTER, withForgeTransfer } from '../../core/repo/forgeBinding'
import { inThreadLane, type SyncLane } from './syncLane'
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

function owner(home: string, generation = 1, lane?: SyncLane) {
  const parent = new EventEmitter()
  const child = new EventEmitter()
  const observed: WorkspaceResponse[] = []
  serveWorkspaceOwner({ home, generation, version: '1.0.0-test', ownerPid: process.pid, ...(lane ? { lane } : {}) }, {
    on(_event, listener) { child.on('message', listener); return this as Electron.ParentPort },
    postMessage(response: WorkspaceResponse) {
      observed.push(response)
      parent.emit('reply:' + response.id, response)
    }
  })
  let next = 0
  // A utility receives a request with no async context of the sender's: only the authority the request carries counts.
  const deliver = AsyncResource.bind((request: WorkspaceRequest) => { child.emit('message', { data: request }) })
  function send(request: WorkspaceRequest): Promise<WorkspaceResponse> {
    return new Promise(resolve => {
      parent.once('reply:' + request.id, resolve)
      deliver(request)
    })
  }
  function work(path: string, work: Work, expected?: string): Promise<WorkspaceResponse> {
    return send({ type: 'work', generation, id: ++next, path, work, expected, authority: currentForgeTransfer() })
  }
  function sync(path: string, mode: 'heartbeat' | 'member' | 'explicit', expected?: string): Promise<WorkspaceResponse> {
    return send({ type: 'sync', generation, id: ++next, path, mode, expected, authority: currentForgeTransfer() })
  }
  function close() { return send({ type: 'close', generation, id: ++next }) }
  closers.add(close)
  return { work, sync, close, observed, child }
}

/** A lane whose reconciles wait at a barrier before they run. */
function heldLane() {
  const inner = inThreadLane()
  let release: () => void = () => undefined
  const barrier = new Promise<void>(resolve => { release = resolve })
  const entered: string[] = []
  const finished: string[] = []
  const lane: SyncLane = {
    async reconcile(request) {
      entered.push(request.mode)
      await barrier
      try { return await inner.reconcile(request) } finally { finished.push(request.mode) }
    },
    release: () => inner.release(),
    close: () => inner.close()
  }
  return { lane, release, entered, finished }
}

/** Every card id on a board response, across its lanes. */
function boardIds(response: WorkspaceResponse): string[] {
  if (!response.ok) throw new Error(response.error.message)
  const board = response.result.value as { lanes: Record<string, { id: string }[]> }
  return Object.values(board.lanes).flat().map(card => card.id)
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

it('admits explicit and member syncs under the live Forge move reservation the request carries', async () => {
  const h = fixture()
  const source = h.open('desktop')
  await source.initializeRepository({ name: 'Converting source' })
  await source.createKanbanCard({ title: 'Exported before the move' })
  const worker = owner(h.homeDir)
  const opened = await worker.work(h.root, { kind: 'native', name: 'initialized', args: [] })
  if (!opened.ok) throw new Error(opened.error.message)
  const binding = opened.result.binding
  await withForgeTransfer(h.homeDir, h.root, join(h.root, 'destination'), async () => {
    // A conversion validates its source with an explicit reconcile and imports a member with a member sync.
    await expect(worker.sync(h.root, 'explicit', binding)).resolves.toMatchObject({ ok: true, result: { value: { result: { rejected: [] } } } })
    await expect(worker.sync(h.root, 'member', binding)).resolves.toMatchObject({ ok: true, result: { value: { result: { rejected: [] } } } })
  })
})

it('uses the first member reconcile on the lane as the cold import instead of consuming it on open', async () => {
  const h = fixture()
  const source = h.open('desktop')
  await source.initializeRepository({ name: 'Portable history' })
  const card = await source.createKanbanCard({ title: 'Persisted portable card' })
  // The desktop registry resolves short or aliased TEMP paths before posting owner work.
  const clone = realpathSync.native(h.cloneTracked())
  const alias = join(h.homeDir, 'clone-alias')
  symlinkSync(clone, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const worker = owner(h.homeDir)
  await expect(worker.sync(alias, 'member')).resolves.toMatchObject({
    ok: false, error: { code: 'conflict', message: 'The tracked folder moved.' }
  })
  expect(existsSync(resolveLayout(clone).dbFile)).toBe(false)
  const first = await worker.sync(clone, 'member')
  if (!first.ok) throw new Error(first.error.message)
  expect(first.result.value).toMatchObject({
    hasLocalCache: false, result: { imported: expect.arrayContaining(['kanban:' + card.id]), rejected: [] }
  })
  const second = await worker.sync(clone, 'member', first.result.binding)
  expect(second).toMatchObject({ ok: true, result: { value: { hasLocalCache: true, result: { imported: [], rejected: [] } } } })
  // The explicit reconcile is ungated and full; a heartbeat with unchanged inputs passes the fingerprint gate.
  await expect(worker.sync(clone, 'explicit', first.result.binding)).resolves.toMatchObject({ ok: true, result: { value: { result: { imported: [] } } } })
  await expect(worker.sync(clone, 'heartbeat', first.result.binding)).resolves.toMatchObject({ ok: true, result: { value: { result: { imported: [] } } } })
})

it('serves an epic read, the Kanban board and a card mutation while its lane reconcile is held at a barrier', async () => {
  const h = fixture()
  const source = h.open('desktop')
  await source.initializeRepository({ name: 'Lane source' })
  const card = await source.createKanbanCard({ title: 'Imported by the lane' })
  const clone = realpathSync.native(h.cloneTracked())
  const { lane, release, entered } = heldLane()
  const worker = owner(h.homeDir, 1, lane)
  const opened = await worker.work(clone, { kind: 'command', name: 'listKanbanCards', input: {} })
  if (!opened.ok) throw new Error(opened.error.message)
  expect(boardIds(opened)).toEqual([])
  const binding = opened.result.binding
  const created = await worker.work(clone, { kind: 'command', name: 'createEpic', input: { title: 'Read while the lane imports' } }, binding)
  if (!created.ok) throw new Error(created.error.message)
  const epicId = (created.result.value as { id: string }).id
  const head = await worker.work(clone, { kind: 'command', name: 'getEventHead', input: undefined }, binding)
  if (!head.ok) throw new Error(head.error.message)

  let released = false
  const reconciled = worker.sync(clone, 'member', binding).then(response => ({ response, released }))
  try {
    await vi.waitFor(() => expect(entered).toEqual(['member']))
    await expect(worker.work(clone, { kind: 'command', name: 'getEpic', input: { epicId } }, binding))
      .resolves.toMatchObject({ ok: true, result: { value: { id: epicId, title: 'Read while the lane imports' } } })
    expect(boardIds(await worker.work(clone, { kind: 'command', name: 'listKanbanCards', input: {} }, binding))).toEqual([])
    await expect(worker.work(clone, { kind: 'command', name: 'createKanbanCard', input: { title: 'Written during the reconcile' } }, binding))
      .resolves.toMatchObject({ ok: true, result: { value: { title: 'Written during the reconcile' } } })
  } finally {
    released = true
    release()
  }
  await expect(reconciled).resolves.toMatchObject({ released: true, response: { ok: true, result: { value: { result: { imported: expect.arrayContaining(['kanban:' + card.id]) } } } } })
  // The reconcile's import is one `repository.reconciled` event, which the renderer refetches on.
  const events = await worker.work(clone, { kind: 'command', name: 'listEvents', input: { sinceSeq: head.result.value } }, binding)
  if (!events.ok) throw new Error(events.error.message)
  expect((events.result.value as { events: { kind: string }[] }).events.filter(event => event.kind === 'repository.reconciled')).toHaveLength(1)
  const board = await worker.work(clone, { kind: 'command', name: 'listKanbanCards', input: {} }, binding)
  expect(boardIds(board)).toContain(card.id)
})

it('closes the lane only after its running reconcile finishes, and replies to that reconcile as stale', async () => {
  const h = fixture()
  const source = h.open('desktop')
  await source.initializeRepository({ name: 'Lane close' })
  const clone = realpathSync.native(h.cloneTracked())
  const { lane, release, entered, finished } = heldLane()
  const worker = owner(h.homeDir, 1, lane)
  const opened = await worker.work(clone, { kind: 'native', name: 'initialized', args: [] })
  if (!opened.ok) throw new Error(opened.error.message)
  const reconciled = worker.sync(clone, 'member', opened.result.binding)
  await vi.waitFor(() => expect(entered).toEqual(['member']))
  const closing = worker.close().then(response => ({ response, laneFinished: [...finished] }))
  release()
  // The close is confirmed only once the lane's reconcile finished; that reconcile's late result is then fenced.
  await expect(closing).resolves.toMatchObject({ response: { ok: true }, laneFinished: ['member'] })
  await expect(reconciled).resolves.toMatchObject({ ok: false, error: { details: { completion: 'stale' } } })
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
