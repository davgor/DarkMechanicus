import { afterEach, expect, it, vi } from 'vitest'
import { createHarness } from '../../test/workspaceHarness'
import { runWorkspaceOperation } from './workspaceOperations'
import { DomainError } from '../../core/errors'
import type { OwnerResult, OwnerTransport, SyncMode, Work } from './workspaceClient'
import { createWorkspacePool } from './workspacePool'

function barrier<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(idleMs?: number) {
  const live = new Set<number>()
  const retired: number[] = []
  const admitted: { project: string; name: string; generation: number; expected: string | undefined }[] = []
  let max = 0
  const overrides = new Map<string, () => Promise<OwnerResult>>()
  const onError = vi.fn()
  const reply = (project: string, name: string) => overrides.get(project + ':' + name)?.() ?? { value: project, binding: 'binding-' + project }
  function open(generation: number): OwnerTransport {
    live.add(generation)
    max = Math.max(max, live.size)
    return {
      async run(project: string, work: Work, _authority, expected) {
        const name = work.kind === 'heartbeat' ? 'heartbeat' : work.name
        admitted.push({ project, name, generation, expected })
        return reply(project, name)
      },
      async sync(project: string, mode: SyncMode, _authority, expected) {
        admitted.push({ project, name: 'sync:' + mode, generation, expected })
        return overrides.get(project + ':sync')?.() ?? { value: { result: synced(project), hasLocalCache: true }, binding: 'binding-' + project }
      },
      async close() { live.delete(generation); retired.push(generation) }
    }
  }
  const pool = createWorkspacePool({ canonical: p => p === 'a-link' ? 'a' : p, open, onError, ...(idleMs === undefined ? {} : { idleMs }) })
  const named = (project: string) => admitted.filter(row => row.project === project).map(row => row.name)
  // Owner requests only: an owner's open-time reconcile follows on its lane.
  const ran = () => admitted.filter(row => !row.name.startsWith('sync:'))
  return { pool, admitted, named, ran, retired, live, overrides, max: () => max, onError }
}

function synced(project: string) {
  return { imported: [project], unchanged: [], conflicts: [], profileConflicts: [], kanbanConflicts: [], rejected: [], branchChanged: false, pausedRuns: [] }
}

afterEach(() => vi.useRealTimers())

it('serves reads and a mutation on the same project while its lane reconcile is held, and keeps two owner slots', async () => {
  const { pool, named, overrides, max, live } = fixture()
  expect(pool.get('a-link')).toBe(pool.get('a'))
  expect(live.size).toBe(0)
  const held = barrier<OwnerResult>()
  overrides.set('a:sync', () => held.promise)
  let released = false
  const reconcile = pool.reconcile('a').finally(() => { expect(released).toBe(true) })
  const epic = pool.get('a').getEpic({ epicId: 'ep_1' })
  const cards = pool.get('a-link').listKanbanCards({})
  const write = pool.get('a').createKanbanCard({ title: 'Mutation during reconcile' })
  await expect(Promise.all([epic, cards, write])).resolves.toEqual(['a', 'a', 'a'])
  const mailbox = pool.background('mailbox').call('listMailboxRoutes', ['mailbox_chat'])
  expect(await pool.get('b').getProject()).toBe('b')
  expect(named('a')).toEqual(['sync:member', 'getEpic', 'listKanbanCards', 'createKanbanCard'])
  released = true
  held.resolve({ value: { result: synced('a'), hasLocalCache: false }, binding: 'binding-a' })
  await expect(reconcile).resolves.toEqual({ result: synced('a'), hasLocalCache: false })
  await mailbox
  expect(max()).toBe(2)
  await pool.closeAll()
  expect(live.size).toBe(0)
})

it('runs an explicit reconcile command on the lane and returns its unchanged result shape', async () => {
  const { pool, named, overrides } = fixture()
  const held = barrier<OwnerResult>()
  overrides.set('a:sync', () => held.promise)
  const explicit = pool.get('a').reconcileRepository()
  await expect(pool.get('a').getProject()).resolves.toBe('a')
  held.resolve({ value: { result: synced('explicit'), hasLocalCache: true }, binding: 'binding-a' })
  await expect(explicit).resolves.toEqual(synced('explicit'))
  expect(named('a').slice(0, 2)).toEqual(['sync:explicit', 'getProject'])
  await pool.closeAll()
})

it('coalesces heartbeats into one running and one pending reconcile, then skips heartbeats within 15 s of the last', async () => {
  vi.useFakeTimers()
  const { pool, named, overrides } = fixture()
  await pool.get('a').getProject()
  await vi.advanceTimersByTimeAsync(0)
  expect(named('a')).toEqual(['getProject', 'sync:heartbeat'])
  await vi.advanceTimersByTimeAsync(15_000)
  const held = barrier<OwnerResult>()
  overrides.set('a:sync', () => held.promise)
  const member = pool.reconcile('a')
  for (let beat = 0; beat < 5; beat += 1) pool.heartbeatAll()
  const joined = pool.reconcile('a')
  await vi.advanceTimersByTimeAsync(0)
  expect(named('a').filter(name => name.startsWith('sync:'))).toEqual(['sync:heartbeat', 'sync:member'])
  overrides.delete('a:sync')
  held.resolve({ value: { result: synced('first'), hasLocalCache: true }, binding: 'binding-a' })
  await expect(member).resolves.toMatchObject({ result: synced('first') })
  await expect(joined).resolves.toMatchObject({ result: synced('a') })
  expect(named('a').filter(name => name.startsWith('sync:'))).toEqual(['sync:heartbeat', 'sync:member', 'sync:member'])
  pool.heartbeatAll()
  await vi.advanceTimersByTimeAsync(14_000)
  pool.heartbeatAll()
  await vi.advanceTimersByTimeAsync(0)
  expect(named('a').filter(name => name.startsWith('sync:'))).toHaveLength(3)
  await vi.advanceTimersByTimeAsync(1_000)
  pool.heartbeatAll()
  await vi.advanceTimersByTimeAsync(0)
  expect(named('a').filter(name => name.startsWith('sync:'))).toHaveLength(4)
  await pool.closeAll()
})

it('stops the lane on untrack, waits for the running reconcile before closing the owner, and drops its late result', async () => {
  const { pool, overrides, live, retired, onError } = fixture()
  await pool.get('a').getProject()
  const held = barrier<OwnerResult>()
  overrides.set('a:sync', () => held.promise)
  const running = pool.reconcile('a')
  const pending = pool.reconcile('a')
  const closing = pool.close('a')
  await expect(pending).rejects.toMatchObject({ code: 'conflict' })
  await Promise.resolve()
  expect(live.size).toBe(1)
  held.resolve({ value: { result: synced('late'), hasLocalCache: true }, binding: 'binding-a' })
  await expect(running).rejects.toMatchObject({ details: { completion: 'stale' } })
  await closing
  expect(live.size).toBe(0)
  expect(retired).toEqual([1])
  expect(onError).not.toHaveBeenCalled()
  overrides.delete('a:sync')
  await expect(pool.reconcile('a')).resolves.toMatchObject({ result: synced('a') })
  await pool.closeAll()
})

it('never retires an owner the screen used in the last 60 s to admit background work', async () => {
  vi.useFakeTimers()
  const { pool, live, retired, named } = fixture(600_000)
  await Promise.all([pool.get('a').getProject(), pool.get('b').getProject()])
  await vi.advanceTimersByTimeAsync(0)
  expect(live.size).toBe(2)
  const background = pool.reconcile('c')
  const mailbox = pool.background('d').call('listMailboxRoutes', ['mailbox_chat'])
  await vi.advanceTimersByTimeAsync(59_000)
  expect(retired).toEqual([])
  expect(named('c')).toEqual([])
  await pool.get('a').getProject()
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(background).resolves.toMatchObject({ result: synced('c') })
  await expect(mailbox).resolves.toBe('d')
  // b's protection lapsed at 60 s and made room for c; c, which the screen never used, made room for d; a, used at 59 s, stayed.
  expect(retired).toEqual([2, 3])
  expect(live.size).toBe(2)
  await pool.closeAll()
})

it('lets background work take the spare slot while the screen protects the only owner', async () => {
  vi.useFakeTimers()
  const { pool, live, retired } = fixture(600_000)
  await pool.get('a').getProject()
  await expect(pool.reconcile('c')).resolves.toMatchObject({ result: synced('c') })
  expect(retired).toEqual([])
  expect(live.size).toBe(2)
  await pool.closeAll()
})

it('retires two idle owners the screen has not used for 60 s on background pressure', async () => {
  vi.useFakeTimers()
  const { pool, live, retired } = fixture(600_000)
  await Promise.all([pool.get('a').getProject(), pool.get('b').getProject()])
  await vi.advanceTimersByTimeAsync(60_000)
  await pool.reconcile('c')
  expect(retired).toEqual([1, 2])
  expect(live.size).toBe(1)
  await pool.closeAll()
})

it('coalesces a pending heartbeat, keeps FIFO, and still retires quiet owners at the idle deadline', async () => {
  vi.useFakeTimers()
  const { pool, live, admitted, overrides } = fixture()
  const handle = pool.get('a')
  await handle.getProject()
  const held = barrier<OwnerResult>()
  overrides.set('a:heartbeat', () => held.promise)
  pool.heartbeatAll()
  pool.heartbeatAll()
  expect(admitted.filter(row => row.name === 'heartbeat')).toHaveLength(1)
  held.resolve({ value: undefined, binding: 'binding-a' })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(live.size).toBe(0)
  expect(handle.current).toBe(true)
  expect(await handle.getProject()).toBe('a')
  expect(admitted.at(-1)).toMatchObject({ generation: 2, expected: 'binding-a' })
  await pool.closeAll()
})

it('returns uncertain completion after losing a committed response and reopens only for subsequent commands', async () => {
  const { pool, ran, overrides } = fixture()
  const durable: string[] = []
  await pool.get('a').getProject()
  overrides.set('a:createKanbanCard', async () => {
    durable.push('saved once')
    throw new DomainError('internal', 'Worker stopped', { ownerStopped: true, completion: 'unknown' })
  })
  overrides.set('a:listKanbanCards', async () => ({ value: [...durable], binding: 'binding-a' }))
  await expect(pool.get('a').createKanbanCard({ title: 'saved once' })).rejects.toMatchObject({ details: { completion: 'unknown' } })
  await expect(pool.get('a').listKanbanCards({})).resolves.toEqual(['saved once'])
  expect(ran().map(row => [row.generation, row.name])).toEqual([
    [1, 'getProject'], [1, 'createKanbanCard'], [2, 'listKanbanCards']
  ])
  await pool.closeAll()
})

it('rejects queued writes on untrack and fences a late running reply before reopening the path', async () => {
  const { pool, admitted, overrides, live } = fixture()
  const handle = pool.get('a')
  const held = barrier<OwnerResult>()
  overrides.set('a:createKanbanCard', () => held.promise)
  const running = handle.createKanbanCard({ title: 'already admitted' })
  const waiting = handle.createKanbanCard({ title: 'still queued' })
  const closed = pool.close('a')
  await expect(waiting).rejects.toMatchObject({ code: 'conflict' })
  expect(handle.current).toBe(false)
  expect(live.size).toBe(1)
  held.resolve({ value: 'committed', binding: 'binding-a' })
  await expect(running).rejects.toMatchObject({ details: { completion: 'stale' } })
  await closed
  expect(live.size).toBe(0)
  expect(admitted.map(row => row.name)).toEqual(['createKanbanCard'])
  expect(pool.get('a')).not.toBe(handle)
  await expect(handle.getProject()).rejects.toMatchObject({ code: 'conflict' })
  await pool.closeAll()
  expect(() => pool.get('a')).toThrow('workspace was closed')
})

it('invalidates old clients before delivering an authorized storage transition result', async () => {
  const { pool, overrides, admitted } = fixture()
  const old = pool.get('a')
  await old.getProject()
  overrides.set('a:switchStorageMode', async () => ({ value: 'moved', binding: 'replacement' }))
  await expect(old.switchStorageMode({ mode: 'db', confirmed: true })).resolves.toBe('moved')
  expect(old.current).toBe(false)
  expect(pool.get('a')).not.toBe(old)
  await pool.get('a').getProject()
  expect(admitted.at(-1)).toMatchObject({ generation: 2, expected: undefined })
  await pool.closeAll()
})

it('revokes a terminal credential that commits after untrack begins, before ending its owner', async () => {
  const fixture = createHarness()
  const store = fixture.open('desktop')
  await store.initializeRepository({ name: 'Late grant' })
  const committed = barrier<void>()
  const delivery = barrier<void>()
  const calls: string[] = []
  const pool = createWorkspacePool({ canonical: path => path, open: () => ({
    async run(path, work) {
      expect(path).toBe(fixture.root)
      calls.push(work.kind === 'heartbeat' ? 'heartbeat' : work.name)
      const value = await runWorkspaceOperation(store, work, fixture.homeDir)
      if (work.kind === 'native' && work.name === 'issueChatGrant') {
        committed.resolve()
        await delivery.promise
      }
      return { value, binding: 'original store' }
    },
    async close() { calls.push('close'); store.close() }
  }) })
  try {
    const client = pool.get(fixture.root)
    const grant = client.call('issueChatGrant', { role: 'reviewer', label: 'Racing untrack' })
    await committed.promise
    expect((await store.listGrants()).at(-1)?.active).toBe(true)
    const closing = pool.close(fixture.root)
    delivery.resolve()
    await expect(grant).rejects.toMatchObject({ details: { completion: 'stale' } })
    await closing
    const reopened = fixture.open('desktop')
    expect(await reopened.listGrants()).toEqual([expect.objectContaining({ label: 'Racing untrack', active: false })])
    expect(calls).toEqual(['issueChatGrant', 'revokeChatGrant', 'close'])
  } finally {
    delivery.resolve()
    await pool.closeAll()
    fixture.cleanup()
  }
})

it('finishes admitted credential cleanup in order during untrack without running a queued edit', async () => {
  const { pool, ran, overrides, live } = fixture()
  const original = pool.get('a')
  const background = pool.background('a')
  await original.getProject()
  expect(background.current).toBe(true)

  const held = barrier<OwnerResult>()
  overrides.set('a:createKanbanCard', () => held.promise)
  const writing = original.createKanbanCard({ title: 'Already admitted' })
  const waiting = original.createKanbanCard({ title: 'Still queued' })
  const revoke = original.call('revokeChatGrant', 'grant', true)
  const endYolo = original.call('endYolo', 'grant')
  const closing = pool.close('a')
  expect(pool.close('a')).toBe(closing)
  expect(background.current).toBe(false)
  await expect(waiting).rejects.toMatchObject({ code: 'conflict' })

  held.resolve({ value: undefined, binding: 'binding-a' })
  await expect(writing).rejects.toMatchObject({ details: { completion: 'stale' } })
  await Promise.all([revoke, endYolo, closing])
  expect(ran().map(row => row.name)).toEqual(['getProject', 'createKanbanCard', 'revokeChatGrant', 'endYolo'])
  expect(live.size).toBe(0)
  await pool.closeAll()
  await expect(original.getProject()).rejects.toMatchObject({ code: 'conflict' })
})

it('reopens for a late revocation with the old exact binding and reuses it if the project is opened in the meantime', async () => {
  const { pool, admitted, overrides, live } = fixture()
  const original = pool.get('a')
  await original.getProject()
  await pool.close('a')
  expect(live.size).toBe(0)
  const started = barrier<void>()
  const held = barrier<OwnerResult>()
  overrides.set('a:revokeChatGrant', () => { started.resolve(); return held.promise })

  const cleanup = original.call('revokeChatGrant', 'grant', false)
  await started.promise
  expect(admitted.at(-1)).toMatchObject({ generation: 2, expected: 'binding-a', name: 'revokeChatGrant' })
  const current = pool.get('a')
  expect(current).not.toBe(original)
  const summary = current.getProject()
  held.resolve({ value: false, binding: 'binding-a' })
  await expect(cleanup).resolves.toBe(false)
  await expect(summary).resolves.toBe('a')
  expect(admitted.at(-1)).toMatchObject({ generation: 2, name: 'getProject' })
  expect(live.size).toBe(1)
  await pool.closeAll()
})

it('invalidates all callers after a binding error while leaving ordinary workspace failures recoverable', async () => {
  const { pool, overrides, admitted, live } = fixture()
  const original = pool.get('a')
  await original.getProject()
  overrides.set('a:listEpics', async () => { throw new Error('Unexpected local error') })
  await expect(original.listEpics()).rejects.toThrow('Unexpected local error')
  expect(original.current).toBe(true)

  overrides.set('a:listEpics', async () => {
    throw new DomainError('conflict', 'The project storage changed.', { bindingChanged: true })
  })
  await expect(original.listEpics()).rejects.toMatchObject({ details: { bindingChanged: true } })
  expect(original.current).toBe(false)
  expect(live.size).toBe(0)
  await expect(pool.get('a').getProject()).resolves.toBe('a')
  expect(admitted.at(-1)).toMatchObject({ generation: 2, expected: undefined })
  await pool.closeAll()
})

it('does not evict a project whose operation spans the idle deadline', async () => {
  vi.useFakeTimers()
  const { pool, overrides, live } = fixture()
  const original = pool.get('a')
  await original.getProject()
  const held = barrier<OwnerResult>()
  overrides.set('a:createKanbanCard', () => held.promise)
  const write = original.createKanbanCard({ title: 'Still in progress' })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(live.size).toBe(1)
  held.resolve({ value: 'done', binding: 'binding-a' })
  await expect(write).resolves.toBe('done')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(live.size).toBe(0)
  await pool.closeAll()
})
