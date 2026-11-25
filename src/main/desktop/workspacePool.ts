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
  /** Receives one warning per operation whose queue wait plus run time exceeds `SLOW_OPERATION_MS`. */
  slowLog?: { warn(message: string): void }
  idleMs?: number
}

interface Job {
  work: Work
  authority: ForgeTransferAuthority | undefined
  background: boolean
  fence?: string
  /** `performance.now()` when the job was queued. */
  queuedAt: number
  resolve(value: unknown): void
  reject(error: unknown): void
}

interface Waiter {
  resolve(value: SyncValue): void
  reject(error: unknown): void
  /** `performance.now()` when a foreground request (the screen's explicit reconcile) joined, for the slow-operation log. */
  queuedAt?: number
}

/** One reconcile on the sync lane, shared by every request that joined it before it started. */
interface LaneJob {
  mode: SyncMode
  authority: ForgeTransferAuthority | undefined
  /** A foreground request joined: the job is admitted and counted as the screen's use of its owner. */
  foreground: boolean
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

/** Owner processes that serve the screen. */
const OWNER_LIMIT = 2
/** Background work (a lane reconcile, a background job) never takes a screen slot: it may open one process more. */
const PROCESS_LIMIT = OWNER_LIMIT + 1
const IDLE_MS = 60_000
/** A heartbeat with nothing to join skips its reconcile when one finished this recently. */
const RECONCILE_GAP_MS = 15_000
/** Background admission never retires an owner that served a foreground request this recently. */
const PROTECTED_MS = 60_000
/** A pending reconcile takes the strongest mode of the requests that joined it. */
const MODE_RANK: Record<SyncMode, number> = { heartbeat: 0, member: 1, explicit: 2 }
/** An operation whose queue wait plus run time exceeds this is logged (name and timings only). */
const SLOW_OPERATION_MS = 1_000
function closingWork(work: Work): boolean {
  return work.kind === 'native' && (work.name === 'revokeChatGrant' || work.name === 'endYolo')
}

/**
 * A request joining the pending reconcile raises it to its mode. A request made under a Forge transfer reservation
 * carries it into the job it joins, as its own job would have: the conversion's reconcile must run with it, and one
 * conversion holds a project at a time, so the latest reservation wins. The screen's request makes the job foreground.
 */
function joinPending(pending: LaneJob, request: { mode: SyncMode; authority: ForgeTransferAuthority | undefined; foreground: boolean; waiter: Waiter | undefined }): void {
  if (MODE_RANK[request.mode] > MODE_RANK[pending.mode]) pending.mode = request.mode
  if (request.authority !== undefined) pending.authority = request.authority
  if (request.foreground) pending.foreground = true
  if (request.waiter) pending.waiters.push(request.waiter)
}

/** Work that moves or replaces the store runs or is next on the owner's queue: the lane waits for it. */
function exclusiveAhead(entry: Entry): boolean {
  const next = entry.jobs[0]
  return (entry.running !== undefined && exclusiveWork(entry.running.work)) || (next !== undefined && exclusiveWork(next.work))
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
    if (work.kind === 'command' && work.name === 'reconcileRepository') return this.awaitSync(entry, 'explicit', !background).then(value => value.result)
    const result = new Promise((resolve, reject) => {
      entry.jobs.push({ work, authority: this.options.authority?.(), background, fence, queuedAt: performance.now(), resolve, reject })
    })
    this.pump()
    return result
  }

  reconcile(path: string): Promise<SyncResult> {
    return this.awaitSync(this.entry(this.options.canonical(path), false), 'member', false) as Promise<SyncResult>
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

  private awaitSync(entry: Entry, mode: SyncMode, foreground: boolean): Promise<SyncValue> {
    if (this.stopping || entry.closing !== undefined) return Promise.reject(closed())
    return new Promise((resolve, reject) => this.requestSync(entry, mode, { resolve, reject, ...(foreground ? { queuedAt: performance.now() } : {}) }))
  }

  /**
   * Joins the pending reconcile, or queues the one pending reconcile behind the running one. A heartbeat with nothing to
   * join is skipped while a reconcile runs or when one finished in the last `RECONCILE_GAP_MS`.
   */
  private requestSync(entry: Entry, mode: SyncMode, waiter?: Waiter): void {
    const { lane } = entry
    const authority = this.options.authority?.()
    const foreground = waiter?.queuedAt !== undefined
    if (lane.pending !== undefined) return joinPending(lane.pending, { mode, authority, foreground, waiter })
    if (!waiter && (lane.running || (lane.finishedAt !== undefined && Date.now() - lane.finishedAt < RECONCILE_GAP_MS))) return
    lane.pending = { mode, authority, foreground, waiters: waiter ? [waiter] : [] }
    this.pump()
  }

  private idle(owner: Entry): boolean {
    return !owner.running && !owner.jobs.length && !owner.retiring && !owner.lane.running && !owner.lane.pending
  }

  /**
   * Whether a project without an owner may get one for background work (a job or a lane reconcile). It may while a slot
   * stays free for the screen. Otherwise it retires an idle owner the screen has not used in the last `PROTECTED_MS`.
   * When only that protection stands in the way, it opens the one process beyond the screen's slots instead of waiting
   * for the protection to lapse; past that, or behind busy owners, it waits. It never retires an owner the screen just used.
   */
  private admitBackground(): boolean {
    if (this.owners.size < OWNER_LIMIT - 1) return true
    const now = Date.now()
    const idle = [...this.owners].filter(owner => this.idle(owner))
    const retirable = idle.find(owner => now - owner.usedAt >= PROTECTED_MS)
    if (retirable) {
      void this.retire(retirable)
      return false
    }
    if (!idle.length) return false
    if (this.owners.size < PROCESS_LIMIT) return true
    this.wakeAt(Math.min(...idle.map(owner => owner.usedAt + PROTECTED_MS)))
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
    return job.background ? this.admitBackground() : this.admitForeground()
  }

  /**
   * A foreground request gets a process while fewer than `OWNER_LIMIT` owners serve the screen (an owner only background
   * work used does not count) and the process limit allows. Otherwise it frees the least recently used idle process.
   * Busy projects keep their owner and queue so a process can never be reused for a different project during an operation.
   */
  private admitForeground(): boolean {
    const owners = [...this.owners]
    const screen = owners.filter(owner => owner.usedAt > Number.NEGATIVE_INFINITY).length
    if (screen < OWNER_LIMIT && owners.length < PROCESS_LIMIT) return true
    const idle = owners.filter(owner => this.idle(owner)).sort((left, right) => left.usedAt - right.usedAt)[0]
    if (idle) void this.retire(idle)
    return false
  }

  private canStartLane(entry: Entry): boolean {
    const pending = entry.lane.pending
    if (entry.lane.running || !pending || entry.retiring || entry.closing || exclusiveAhead(entry)) return false
    if (entry.owner !== undefined) return true
    // The screen's explicit reconcile is admitted as foreground work; heartbeat and member reconciles as background.
    return pending.foreground ? this.admitForeground() : this.admitBackground()
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
      // A reconcile already requested on the lane (a Forge member's import) is this open's reconcile.
      if (!entry.temporary) queueMicrotask(() => { if (!entry.closing && !this.stopping && !entry.lane.running && !entry.lane.pending) this.requestSync(entry, 'heartbeat') })
    }
    return entry.owner
  }

  private async run(entry: Entry, job: Job): Promise<void> {
    const started = performance.now()
    try {
      const value = await this.executeJob(entry, job)
      this.finishJob(entry, job)
      this.noteDuration(job, started)
      job.resolve(value)
    } catch (error) {
      this.finishJob(entry, job)
      this.noteDuration(job, started)
      job.reject(error)
    }
  }

  /** Names only the operation: never its arguments, input or result. */
  private noteDuration(job: Job, started: number): void {
    this.noteSlow(job.work.kind === 'heartbeat' ? 'heartbeat' : `${job.work.kind} ${job.work.name}`, job.queuedAt, started)
  }

  private noteSlow(name: string, queuedAt: number, started: number): void {
    const queueMs = started - queuedAt
    const runMs = performance.now() - started
    if (this.options.slowLog === undefined || queueMs + runMs <= SLOW_OPERATION_MS) return
    this.options.slowLog.warn(`Slow workspace operation ${name}: queue wait ${Math.round(queueMs)} ms, run ${Math.round(runMs)} ms`)
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
    const started = performance.now()
    if (job.foreground) this.useForeground(entry)
    const outcome = await this.syncOnLane(entry, job)
    delete entry.lane.running
    entry.lane.finishedAt = Date.now()
    if (job.foreground) entry.usedAt = Date.now()
    if (!outcome.ok && !job.waiters.length && !entry.closing && !this.stopping) this.options.onError?.(entry.path, outcome.error)
    this.answerLane(job, outcome, started)
    this.settleLane(entry, job)
  }

  private answerLane(job: LaneJob, outcome: { ok: true; value: SyncValue } | { ok: false; error: unknown }, started: number): void {
    for (const waiter of job.waiters) {
      if (waiter.queuedAt !== undefined) this.noteSlow('command reconcileRepository', waiter.queuedAt, started)
      if (outcome.ok) waiter.resolve(outcome.value)
      else waiter.reject(outcome.error)
    }
  }

  /** The screen's explicit reconcile uses its owner: it holds the idle deadline off and protects the owner from retirement. */
  private useForeground(entry: Entry): void {
    entry.usedAt = Date.now()
    clearTimeout(entry.idle)
  }

  private async syncOnLane(entry: Entry, job: LaneJob): Promise<{ ok: true; value: SyncValue } | { ok: false; error: unknown }> {
    try {
      const owner = this.ownerFor(entry)
      const { value, binding } = await owner.sync(entry.path, job.mode, job.authority, entry.binding)
      // Generation fence: a result arriving after its owner closed or was replaced is dropped.
      if (entry.closing || entry.owner !== owner) throw stale('reconcile')
      await this.adopt(entry, binding)
      return { ok: true, value: value as SyncValue }
    } catch (error) {
      await this.recover(entry, error)
      return { ok: false, error }
    }
  }

  private settleLane(entry: Entry, job: LaneJob): void {
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
      this.stopLane(entry)
      if (!entry.running && !entry.jobs.length && !entry.lane.running) void this.finishClose(entry)
    }
    return entry.closing
  }

  /** The lane stops: its pending reconcile is dropped, and the owner closes only after a running one finishes. */
  private stopLane(entry: Entry): void {
    const pending = entry.lane.pending
    delete entry.lane.pending
    for (const waiter of pending?.waiters ?? []) waiter.reject(closed())
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
