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

it('serves reads and a mutation on the same project while its lane reconcile is held, and keeps both screen slots', async () => {
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
  // The screen used both owners just now: the background request took the one process beyond their slots.
  expect(max()).toBe(3)
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

it('skips heartbeats while a reconcile runs or within 15 s of the last, and coalesces requests into one pending reconcile', async () => {
  vi.useFakeTimers()
  const { pool, named, overrides } = fixture()
  await pool.get('a').getProject()
  await vi.advanceTimersByTimeAsync(0)
  expect(named('a')).toEqual(['getProject', 'sync:heartbeat'])
  await vi.advanceTimersByTimeAsync(15_000)
  const syncs = () => named('a').filter(name => name.startsWith('sync:'))
  // Heartbeats while a reconcile runs are skipped: they queue nothing behind it.
  let held = barrier<OwnerResult>()
  overrides.set('a:sync', () => held.promise)
  const member = pool.reconcile('a')
  await vi.advanceTimersByTimeAsync(0)
  for (let beat = 0; beat < 5; beat += 1) pool.heartbeatAll()
  held.resolve({ value: { result: synced('first'), hasLocalCache: true }, binding: 'binding-a' })
  await expect(member).resolves.toMatchObject({ result: synced('first') })
  await vi.advanceTimersByTimeAsync(0)
  expect(syncs()).toEqual(['sync:heartbeat', 'sync:member'])
  // Requests with a waiter coalesce into one pending reconcile behind the running one, at the strongest mode.
  await vi.advanceTimersByTimeAsync(15_000)
  held = barrier<OwnerResult>()
  overrides.set('a:sync', () => held.promise)
  const running = pool.reconcile('a')
  await vi.advanceTimersByTimeAsync(0)
  const joined = [pool.reconcile('a'), pool.reconcile('a')]
  for (let beat = 0; beat < 5; beat += 1) pool.heartbeatAll()
  overrides.delete('a:sync')
  held.resolve({ value: { result: synced('first'), hasLocalCache: true }, binding: 'binding-a' })
  await expect(running).resolves.toMatchObject({ result: synced('first') })
  await expect(Promise.all(joined)).resolves.toMatchObject([{ result: synced('a') }, { result: synced('a') }])
  expect(syncs()).toEqual(['sync:heartbeat', 'sync:member', 'sync:member', 'sync:member'])
  pool.heartbeatAll()
  await vi.advanceTimersByTimeAsync(14_000)
  pool.heartbeatAll()
  await vi.advanceTimersByTimeAsync(0)
  expect(syncs()).toHaveLength(4)
  await vi.advanceTimersByTimeAsync(1_000)
  pool.heartbeatAll()
  await vi.advanceTimersByTimeAsync(0)
  expect(syncs()).toHaveLength(5)
  await pool.closeAll()
})

it('runs a joined pending reconcile under the Forge reservation of the request that joined it', async () => {
  let current: { source: string; target: string; lease: string } | undefined
  const authorities: (string | undefined)[] = []
  const held = barrier<OwnerResult>()
  let first = true
  const pool = createWorkspacePool({
    canonical: path => path,
    authority: () => current,
    open: () => ({
      run: async () => ({ value: 'a', binding: 'binding-a' }),
      async sync(_project, _mode, authority) {
        authorities.push(authority?.lease)
        if (first) { first = false; return held.promise }
        return { value: { result: synced('a'), hasLocalCache: true }, binding: 'binding-a' }
      },
      close: async () => undefined
    })
  })
  try {
    await pool.get('a').getProject()
    // The owner's open-time reconcile is running; a member reconcile asked outside any conversion is pending behind it.
    await vi.waitFor(() => expect(authorities).toEqual([undefined]))
    const member = pool.reconcile('a')
    current = { source: 'a', target: 'a-member', lease: 'conversion-lease' }
    // The conversion's own reconcile joins that pending job, and the job must then run under its reservation.
    const converted = pool.get('a').reconcileRepository()
    current = undefined
    held.resolve({ value: { result: synced('first'), hasLocalCache: true }, binding: 'binding-a' })
    await expect(converted).resolves.toMatchObject({ imported: ['a'] })
    await expect(member).resolves.toMatchObject({ result: { imported: ['a'] } })
    expect(authorities).toEqual([undefined, 'conversion-lease'])
  } finally {
    await pool.closeAll()
  }
})

it('admits the screen\'s explicit reconcile as foreground: it marks the owner used and logs when slow', async () => {
  vi.useFakeTimers()
  const warn = vi.fn()
  const live = new Set<string>()
  const retired: string[] = []
  const held = barrier<OwnerResult>()
  const pool = createWorkspacePool({
    canonical: path => path,
    slowLog: { warn },
    open: (generation) => {
      const name = 'g' + generation
      let project = ''
      live.add(name)
      return {
        run: async (path: string) => { project = path; return { value: path, binding: 'binding-' + path } },
        async sync(path: string, mode: SyncMode) {
          project = path
          if (path === 'b' && mode === 'explicit') return held.promise
          return { value: { result: synced(path), hasLocalCache: true }, binding: 'binding-' + path }
        },
        close: async () => { live.delete(name); retired.push(project) }
      }
    }
  })
  try {
    // a and c hold the two screen slots; b has no owner yet.
    await pool.get('a').getProject()
    await vi.advanceTimersByTimeAsync(0)
    await pool.get('c').getProject()
    await vi.advanceTimersByTimeAsync(0)
    // The screen's reconcile of b takes a screen slot, retiring the least recently used idle owner (a), never a third process.
    const explicit = pool.get('b').reconcileRepository()
    await vi.advanceTimersByTimeAsync(0)
    expect(retired).toEqual(['a'])
    expect(live.size).toBe(2)
    await vi.advanceTimersByTimeAsync(1_500)
    held.resolve({ value: { result: synced('b'), hasLocalCache: true }, binding: 'binding-b' })
    await expect(explicit).resolves.toMatchObject({ imported: ['b'] })
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([expect.stringMatching(/^Slow workspace operation command reconcileRepository: queue wait \d+ ms, run 15\d\d ms$/)])
    // b was just used by the screen, so background work cannot retire it.
    const mailbox = pool.background('d').call('listMailboxRoutes', ['mailbox_chat'])
    await vi.advanceTimersByTimeAsync(0)
    await expect(mailbox).resolves.toBe('d')
    expect(retired).not.toContain('b')
  } finally {
    await pool.closeAll()
  }
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
  const { pool, live, retired, named, overrides } = fixture(600_000)
  await Promise.all([pool.get('a').getProject(), pool.get('b').getProject()])
  await vi.advanceTimersByTimeAsync(0)
  expect(live.size).toBe(2)
  // Both owners are protected: the reconcile opens the one process beyond the screen's slots at once.
  const held = barrier<OwnerResult>()
  overrides.set('c:sync', () => held.promise)
  const background = pool.reconcile('c')
  await vi.advanceTimersByTimeAsync(0)
  expect(named('c')).toEqual(['sync:member'])
  expect(live.size).toBe(3)
  // With no process left, further background work waits for the protection to lapse rather than retire a or b.
  const mailbox = pool.background('d').call('listMailboxRoutes', ['mailbox_chat'])
  await vi.advanceTimersByTimeAsync(59_000)
  expect(retired).toEqual([])
  expect(named('d')).toEqual([])
  await pool.get('a').getProject()
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(mailbox).resolves.toBe('d')
  // b's protection lapsed at 60 s and made room for d; a, used at 59 s, stayed.
  expect(retired).toEqual([2])
  held.resolve({ value: { result: synced('c'), hasLocalCache: true }, binding: 'binding-c' })
  await expect(background).resolves.toMatchObject({ result: synced('c') })
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
    async sync() { return { value: { result: null, hasLocalCache: true }, binding: 'original store' } },
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
      sync: async () => ({ value: { result: null, hasLocalCache: false }, binding: 'binding-a' }),
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
