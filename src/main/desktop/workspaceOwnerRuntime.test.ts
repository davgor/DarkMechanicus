import { afterEach, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, realpathSync, renameSync, rmdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHarness } from '../../test/workspaceHarness'
import { resolveLayout } from '../../core/repo/layout'
import { currentForgeTransfer, withForgeTransfer } from '../../core/repo/forgeBinding'
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
