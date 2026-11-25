import { DomainError } from '../../core/errors'
import type { ForgeTransferAuthority } from '../../core/repo/forgeBinding'
import {
  exclusiveWork, workspaceClient, type OperationResult, type OwnerResult, type OwnerTransport, type ProjectWorkspace, type SyncMode,
  type SyncResult, type SyncValue, type Work
} from './workspaceClient'

export interface WorkspacePool {
  get(path: string): ProjectWorkspace
  background(path: string): ProjectWorkspace
  /** A Forge member's reconcile on the project's sync lane; the owner keeps serving while it runs. */
  reconcile(path: string): Promise<SyncResult>
  heartbeatAll(): void
  close(path: string): Promise<void>
  closeAll(): Promise<void>
}

interface PoolOptions {
  open(generation: number): OwnerTransport
  canonical(path: string): string
  authority?(): ForgeTransferAuthority | undefined
  onError?(path: string, error: unknown): void
  idleMs?: number
}

interface Job {
  work: Work
  authority: ForgeTransferAuthority | undefined
  background: boolean
  fence?: string
  resolve(value: unknown): void
  reject(error: unknown): void
}

interface Waiter {
  resolve(value: SyncValue): void
  reject(error: unknown): void
}

/** One reconcile on the sync lane, shared by every request that joined it before it started. */
interface LaneJob {
  mode: SyncMode
  authority: ForgeTransferAuthority | undefined
  waiters: Waiter[]
}

/** At most one reconcile runs per project, with at most one pending behind it. */
interface Lane {
  running?: LaneJob
  pending?: LaneJob
  finishedAt?: number
}

interface Entry {
  path: string
  client: ProjectWorkspace
  background: ProjectWorkspace
  jobs: Job[]
  temporary: boolean
  lane: Lane
  /** When the owner last served a foreground request. */
  usedAt: number
  owner?: OwnerTransport
  running?: Job
  heartbeat?: Promise<unknown>
  binding?: string
  idle?: NodeJS.Timeout
  closing?: Promise<void>
  resolveClosing?: () => void
  retiring?: Promise<void>
}

const OWNER_LIMIT = 2
const IDLE_MS = 60_000
/** A heartbeat with nothing to join skips its reconcile when one finished this recently. */
const RECONCILE_GAP_MS = 15_000
/** Background admission never retires an owner that served a foreground request this recently. */
const PROTECTED_MS = 60_000
/** A pending reconcile takes the strongest mode of the requests that joined it. */
const MODE_RANK: Record<SyncMode, number> = { heartbeat: 0, member: 1, explicit: 2 }

function closingWork(work: Work): boolean {
  return work.kind === 'native' && (work.name === 'revokeChatGrant' || work.name === 'endYolo')
}

const closed = () => new DomainError('conflict', 'This project workspace was closed. Refresh the folder before continuing.')
const stale = (operation: string) => new DomainError('conflict', 'The project was closed while this operation ran. Refresh to confirm its result.',
  { operation, completion: 'stale' })

class Pool implements WorkspacePool {
  private readonly entries = new Map<string, Entry>()
  private readonly owners = new Set<Entry>()
  private generation = 0
  private stopping = false
  private backgroundBusy = false
  private wake?: NodeJS.Timeout

  constructor(private readonly options: PoolOptions) {}

  get(path: string): ProjectWorkspace {
    return this.entry(this.options.canonical(path), false).client
  }

  background(path: string): ProjectWorkspace {
    return this.entry(this.options.canonical(path), false).background
  }

  private entry(path: string, temporary: boolean): Entry {
    if (this.stopping) throw closed()
    const previous = this.entries.get(path)
    if (previous !== undefined) {
      if (!temporary) previous.temporary = false
      return previous
    }
    const entry: Entry = {
      path,
      jobs: [],
      temporary,
      lane: {},
      usedAt: Number.NEGATIVE_INFINITY,
      background: workspaceClient(path, () => !this.stopping && entry.closing === undefined,
        work => this.submit(entry, work, true)),
      client: workspaceClient(path, () => !this.stopping && entry.closing === undefined,
        work => this.submit(entry, work, false))
    }
    this.entries.set(path, entry)
    return entry
  }

  private submit(entry: Entry, work: Work, background: boolean, fence?: string): Promise<unknown> {
    if (this.stopping) return Promise.reject(closed())
    if (entry.closing !== undefined) {
      if (work.kind === 'native' && work.name === 'revokeChatGrant' && entry.binding !== undefined) {
        const expected = entry.binding
        return entry.closing.then(() => this.submit(this.entry(entry.path, true), work, false, expected))
      }
      return Promise.reject(closed())
    }
    // An explicit reconcile still returns its full result, from the lane, while the owner keeps serving.
    if (work.kind === 'command' && work.name === 'reconcileRepository') return this.awaitSync(entry, 'explicit').then(value => value.result)
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    entry.jobs.push({ work, authority: this.options.authority?.(), background, fence, resolve, reject })
    this.pump()
    return promise
  }

  reconcile(path: string): Promise<SyncResult> {
    return this.awaitSync(this.entry(this.options.canonical(path), false), 'member') as Promise<SyncResult>
  }

  heartbeatAll(): void {
    for (const entry of this.owners) {
      if (entry.owner === undefined || entry.closing !== undefined) continue
      // Marking the session alive stays a cheap request on the owner; the reconcile goes to the lane.
      entry.heartbeat ??= this.submit(entry, { kind: 'heartbeat' }, true)
        .catch((error: unknown) => this.options.onError?.(entry.path, error))
        .finally(() => { delete entry.heartbeat })
      this.requestSync(entry, 'heartbeat')
    }
  }

  private awaitSync(entry: Entry, mode: SyncMode): Promise<SyncValue> {
    if (this.stopping || entry.closing !== undefined) return Promise.reject(closed())
    const { promise, resolve, reject } = Promise.withResolvers<SyncValue>()
    this.requestSync(entry, mode, { resolve, reject })
    return promise
  }

  /**
   * Joins the pending reconcile, or queues the one pending reconcile behind the running one. A heartbeat with nothing to
   * join is skipped when a reconcile finished in the last `RECONCILE_GAP_MS`.
   */
  private requestSync(entry: Entry, mode: SyncMode, waiter?: Waiter): void {
    const { lane } = entry
    const pending = lane.pending
    if (pending !== undefined) {
      if (MODE_RANK[mode] > MODE_RANK[pending.mode]) pending.mode = mode
      if (waiter) pending.waiters.push(waiter)
      return
    }
    if (!waiter && !lane.running && lane.finishedAt !== undefined && Date.now() - lane.finishedAt < RECONCILE_GAP_MS) return
    lane.pending = { mode, authority: this.options.authority?.(), waiters: waiter ? [waiter] : [] }
    this.pump()
  }

  private idle(owner: Entry): boolean {
    return !owner.running && !owner.jobs.length && !owner.retiring && !owner.lane.running && !owner.lane.pending
  }

  /**
   * Whether a project without an owner may get one for background work (a job or a lane reconcile). It may while a slot
   * stays free for the screen. Otherwise it retires an idle owner, but never one that served a foreground request in
   * the last `PROTECTED_MS`. When the screen used every owner that recently, it takes the remaining slot: a foreground
   * request for another project may still retire an idle owner, while the background work never retires the screen's.
   */
  private admitBackground(): boolean {
    if (this.owners.size < OWNER_LIMIT - 1) return true
    const now = Date.now()
    const owners = [...this.owners]
    const retirable = owners.find(owner => this.idle(owner) && now - owner.usedAt >= PROTECTED_MS)
    if (retirable) {
      void this.retire(retirable)
      return false
    }
    if (this.owners.size < OWNER_LIMIT && owners.every(owner => now - owner.usedAt < PROTECTED_MS)) return true
    const lapses = owners.filter(owner => this.idle(owner)).map(owner => owner.usedAt + PROTECTED_MS)
    if (lapses.length) this.wakeAt(Math.min(...lapses))
    return false
  }

  private wakeAt(at: number): void {
    clearTimeout(this.wake)
    this.wake = setTimeout(() => { delete this.wake; this.pump() }, Math.max(0, at - Date.now()))
    this.wake.unref()
  }

  private canStart(entry: Entry, job: Job): boolean {
    if (entry.running || entry.retiring || (job.background && this.backgroundBusy)) return false
    // Work that moves or replaces the store never overlaps the lane's own connection.
    if (exclusiveWork(job.work) && entry.lane.running) return false
    if (entry.owner) return true
    if (job.background) return this.admitBackground()
    if (this.owners.size < OWNER_LIMIT) return true
    // Free an idle process before a foreground request needs another slot. Busy projects keep their
    // owner and queue so a process can never be reused for a different project during an operation.
    const idle = [...this.owners].find(owner => this.idle(owner))
    if (idle) void this.retire(idle)
    return false
  }

  private canStartLane(entry: Entry): boolean {
    if (entry.lane.running || !entry.lane.pending || entry.retiring || entry.closing) return false
    const next = entry.jobs[0]
    if ((entry.running && exclusiveWork(entry.running.work)) || (next && exclusiveWork(next.work))) return false
    return entry.owner !== undefined || this.admitBackground()
  }

  private pump(): void {
    for (const entry of this.entries.values()) {
      const job = entry.jobs[0]
      if (job && this.canStart(entry, job)) {
        entry.jobs.shift()
        entry.running = job
        if (job.background) this.backgroundBusy = true
        else entry.usedAt = Date.now()
        void this.run(entry, job)
      }
      if (this.canStartLane(entry)) void this.runLane(entry)
    }
  }

  private ownerFor(entry: Entry): OwnerTransport {
    if (entry.owner === undefined) {
      entry.owner = this.options.open(++this.generation)
      this.owners.add(entry)
      delete entry.lane.finishedAt
      // An owner opens without reconciling; its open-time reconcile follows on the lane.
      if (!entry.temporary && !entry.lane.running) queueMicrotask(() => { if (!entry.closing && !this.stopping) this.requestSync(entry, 'heartbeat') })
    }
    return entry.owner
  }

  private async run(entry: Entry, job: Job): Promise<void> {
    try {
      const value = await this.executeJob(entry, job)
      this.finishJob(entry, job)
      job.resolve(value)
    } catch (error) {
      this.finishJob(entry, job)
      job.reject(error)
    }
  }

  private async executeJob(entry: Entry, job: Job): Promise<unknown> {
    if (job.work.kind !== 'heartbeat') clearTimeout(entry.idle)
    try {
      const owner = this.ownerFor(entry)
      const result = await owner.run(entry.path, job.work, job.authority, job.fence ?? entry.binding)
      return await this.resolveJob(entry, job, owner, result)
    } catch (error) {
      await this.recover(entry, error)
      throw error
    }
  }

  private async recover(entry: Entry, error: unknown): Promise<void> {
    if (error instanceof DomainError) {
      if (error.details?.['ownerStopped'] === true) await this.retire(entry)
      if (error.details?.['bindingChanged'] === true) await this.invalidate(entry)
    }
  }

  private async resolveJob(entry: Entry, job: Job, owner: OwnerTransport, { value, binding }: OwnerResult): Promise<unknown> {
    if (entry.closing && !closingWork(job.work)) {
      if (job.work.kind === 'native' && job.work.name === 'issueChatGrant') {
        const { grant } = value as OperationResult<'issueChatGrant'>
        await owner.run(entry.path, { kind: 'native', name: 'revokeChatGrant', args: [grant.id, false] }, job.authority, binding)
      }
      throw stale(job.work.kind)
    }
    await this.adopt(entry, binding)
    return value
  }

  private async adopt(entry: Entry, binding: string | undefined): Promise<void> {
    if (binding === undefined) return
    if (entry.binding !== undefined && entry.binding !== binding) await this.invalidate(entry)
    entry.binding = binding
  }

  private async runLane(entry: Entry): Promise<void> {
    const job = entry.lane.pending
    if (job === undefined) return
    delete entry.lane.pending
    entry.lane.running = job
    let outcome: { ok: true; value: SyncValue } | { ok: false; error: unknown }
    try {
      const owner = this.ownerFor(entry)
      const { value, binding } = await owner.sync(entry.path, job.mode, job.authority, entry.binding)
      // Generation fence: a result arriving after its owner closed or was replaced is dropped.
      if (entry.closing || entry.owner !== owner) throw stale('reconcile')
      await this.adopt(entry, binding)
      outcome = { ok: true, value: value as SyncValue }
    } catch (error) {
      await this.recover(entry, error)
      outcome = { ok: false, error }
    }
    delete entry.lane.running
    entry.lane.finishedAt = Date.now()
    if (!outcome.ok && !job.waiters.length && !entry.closing && !this.stopping) this.options.onError?.(entry.path, outcome.error)
    for (const waiter of job.waiters) {
      if (outcome.ok) waiter.resolve(outcome.value)
      else waiter.reject(outcome.error)
    }
    if (!entry.running && !entry.jobs.length) {
      if (entry.closing) void this.finishClose(entry)
      else if (entry.owner && job.waiters.length) this.armIdle(entry)
    }
    this.pump()
  }

  private finishJob(entry: Entry, job: Job): void {
    delete entry.running
    if (job.background) this.backgroundBusy = false
    else entry.usedAt = Date.now()
    if (!entry.jobs.length) {
      if (entry.closing) {
        if (!entry.lane.running) void this.finishClose(entry)
      } else if (entry.temporary) void this.close(entry.path)
      else if (entry.owner && job.work.kind !== 'heartbeat') this.armIdle(entry)
    }
    this.pump()
  }

  private async invalidate(entry: Entry): Promise<void> {
    // A changed durable identity invalidates all existing clients and queued work immediately.
    void this.close(entry.path)
    await this.finishClose(entry)
  }

  private armIdle(entry: Entry): void {
    clearTimeout(entry.idle)
    entry.idle = setTimeout(() => {
      if (!this.idle(entry) || entry.closing) this.armIdle(entry)
      else void this.retire(entry)
    }, this.options.idleMs ?? IDLE_MS)
    entry.idle.unref()
  }

  private retire(entry: Entry): Promise<void> {
    if (entry.retiring) return entry.retiring
    clearTimeout(entry.idle)
    const owner = entry.owner
    if (!owner) return Promise.resolve()
    delete entry.owner
    entry.retiring = owner.close()
      .catch((error: unknown) => this.options.onError?.(entry.path, error))
      .finally(() => {
        delete entry.retiring
        this.owners.delete(entry)
        this.pump()
      })
    return entry.retiring
  }

  close(path: string): Promise<void> {
    const entry = this.entries.get(path)
    if (!entry) return Promise.resolve()
    if (!entry.closing) {
      entry.closing = new Promise(resolve => { entry.resolveClosing = resolve })
      for (const waiting of entry.jobs.splice(0)) {
        if (closingWork(waiting.work)) entry.jobs.push(waiting)
        else waiting.reject(closed())
      }
      // The lane stops: its pending reconcile is dropped, and the owner closes only after a running one finishes.
      const pending = entry.lane.pending
      delete entry.lane.pending
      for (const waiter of pending?.waiters ?? []) waiter.reject(closed())
      if (!entry.running && !entry.jobs.length && !entry.lane.running) void this.finishClose(entry)
    }
    return entry.closing
  }

  private async finishClose(entry: Entry): Promise<void> {
    await this.retire(entry)
    if (this.entries.get(entry.path) === entry) this.entries.delete(entry.path)
    entry.resolveClosing?.()
  }

  async closeAll(): Promise<void> {
    this.stopping = true
    clearTimeout(this.wake)
    await Promise.all([...this.entries.keys()].map(path => this.close(path)))
  }
}

export function createWorkspacePool(options: PoolOptions): WorkspacePool {
  return new Pool(options)
}
