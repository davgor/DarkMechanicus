import { afterEach, expect, it, vi } from 'vitest'
import { createHarness } from '../../test/workspaceHarness'
import { runWorkspaceOperation } from './workspaceOperations'
import { DomainError } from '../../core/errors'
import type { OwnerResult, OwnerTransport, Work } from './workspaceClient'
import { createWorkspacePool } from './workspacePool'

function barrier<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const live = new Set<number>()
  const retired: number[] = []
  const admitted: { project: string; name: string; generation: number; expected: string | undefined }[] = []
  let max = 0
  const overrides = new Map<string, () => Promise<OwnerResult>>()
  const onError = vi.fn()
  function open(generation: number): OwnerTransport {
    live.add(generation)
    max = Math.max(max, live.size)
    return {
      async run(project: string, work: Work, _authority, expected) {
        const name = work.kind === 'heartbeat' ? 'heartbeat' : work.name
        admitted.push({ project, name, generation, expected })
        return overrides.get(project + ':' + name)?.() ?? { value: project, binding: 'binding-' + project }
      },
      async close() { live.delete(generation); retired.push(generation) }
    }
  }
  const pool = createWorkspacePool({ canonical: p => p === 'a-link' ? 'a' : p, open, onError })
  return { pool, admitted, retired, live, overrides, max: () => max, onError }
}

afterEach(() => vi.useRealTimers())

it('keeps one canonical project FIFO while a locked project and two background requests leave the foreground slot available', async () => {
  const { pool, admitted, overrides, max, live } = fixture()
  expect(pool.get('a-link')).toBe(pool.get('a'))
  expect(live.size).toBe(0)
  const held = barrier<OwnerResult>()
  overrides.set('a:reconcileMember', () => held.promise)
  const reconcile = pool.reconcile('a')
  expect(pool.reconcile('a-link')).toBe(reconcile)
  const write = pool.get('a').createKanbanCard({ title: 'Mutation after reconcile' })
  const mailbox = pool.background('mailbox').call('listMailboxRoutes', ['mailbox_chat'])
  const otherBackground = pool.reconcile('c')
  expect(await pool.get('b').getProject()).toBe('b')
  expect(admitted.map(row => [row.project, row.name])).toEqual([['a','reconcileMember'], ['b','getProject']])
  held.resolve({ value: 'a', binding: 'binding-a' })
  await Promise.all([reconcile, write, otherBackground, mailbox])
  expect(admitted.filter(row => row.project === 'a').map(row => row.name)).toEqual(['reconcileMember','createKanbanCard'])
  expect(admitted.find(row => row.project === 'c')?.name).toBe('reconcileMember')
  expect(admitted.find(row => row.project === 'mailbox')?.name).toBe('listMailboxRoutes')
  expect(max()).toBe(2)
  await pool.closeAll()
  expect(live.size).toBe(0)
})

it('retires two idle owners on background pressure to keep a second slot available', async () => {
  const { pool, live, retired } = fixture()
  await Promise.all([pool.get('a').getProject(), pool.get('b').getProject()])
  expect(live.size).toBe(2)
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
  const { pool, admitted, overrides } = fixture()
  const durable: string[] = []
  await pool.get('a').getProject()
  overrides.set('a:createKanbanCard', async () => {
    durable.push('saved once')
    throw new DomainError('internal', 'Worker stopped', { ownerStopped: true, completion: 'unknown' })
  })
  overrides.set('a:listKanbanCards', async () => ({ value: [...durable], binding: 'binding-a' }))
  await expect(pool.get('a').createKanbanCard({ title: 'saved once' })).rejects.toMatchObject({ details: { completion: 'unknown' } })
  await expect(pool.get('a').listKanbanCards({})).resolves.toEqual(['saved once'])
  expect(admitted.map(row => [row.generation, row.name])).toEqual([
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
  const { pool, admitted, overrides, live } = fixture()
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
  expect(admitted.map(row => row.name)).toEqual(['getProject', 'createKanbanCard', 'revokeChatGrant', 'endYolo'])
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

it('logs an operation slower than one second with its queue wait and run time, never its arguments', async () => {
  const warn = vi.fn()
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  const first = barrier<OwnerResult>()
  const second = barrier<OwnerResult>()
  const held = [first, second]
  const pool = createWorkspacePool({
    canonical: path => path,
    slowLog: { warn },
    open: () => ({
      run: () => held.shift()?.promise ?? Promise.resolve({ value: 'fast', binding: 'binding-a' }),
      close: async () => undefined
    })
  })
  try {
    const secret = 'Secret card title that must not be logged'
    const slowRun = pool.get('a').getKanbanCard({ cardId: 'kc_secret_argument' })
    const queued = pool.get('a').createKanbanCard({ title: secret })
    now = 1_500
    first.resolve({ value: 'slow run', binding: 'binding-a' })
    await slowRun
    now = 1_800
    second.resolve({ value: 'queued', binding: 'binding-a' })
    await queued
    now = 1_800
    await pool.get('a').getProject()
    expect(warn.mock.calls).toEqual([
      ['Slow workspace operation command getKanbanCard: queue wait 0 ms, run 1500 ms'],
      ['Slow workspace operation command createKanbanCard: queue wait 1500 ms, run 300 ms']
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Secret|kc_secret_argument/)
  } finally {
    clock.mockRestore()
    await pool.closeAll()
  }
})
