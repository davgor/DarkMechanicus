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
