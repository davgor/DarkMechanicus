import { DomainError } from '../../core/errors'
import type { ForgeTransferAuthority } from '../../core/repo/forgeBinding'
import { workspaceClient, type OperationResult, type OwnerResult, type OwnerTransport, type ProjectWorkspace, type Work } from './workspaceClient'

export interface WorkspacePool {
  get(path: string): ProjectWorkspace
  background(path: string): ProjectWorkspace
  reconcile(path: string): Promise<OperationResult<'reconcileMember'>>
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

interface Entry {
  path: string
  client: ProjectWorkspace
  background: ProjectWorkspace
  jobs: Job[]
  temporary: boolean
  owner?: OwnerTransport
  running?: Job
  heartbeat?: Promise<unknown>
  reconcile?: Promise<OperationResult<'reconcileMember'>>
  binding?: string
  idle?: NodeJS.Timeout
  closing?: Promise<void>
  resolveClosing?: () => void
  retiring?: Promise<void>
}

const OWNER_LIMIT = 2
const IDLE_MS = 60_000
/** An operation whose queue wait plus run time exceeds this is logged (name and timings only). */
const SLOW_OPERATION_MS = 1_000
function closingWork(work: Work): boolean {
  return work.kind === 'native' && (work.name === 'revokeChatGrant' || work.name === 'endYolo')
}

const closed = () => new DomainError('conflict', 'This project workspace was closed. Refresh the folder before continuing.')

class Pool implements WorkspacePool {
  private readonly entries = new Map<string, Entry>()
  private readonly owners = new Set<Entry>()
  private generation = 0
  private stopping = false
  private backgroundBusy = false

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
    const result = new Promise((resolve, reject) => {
      entry.jobs.push({ work, authority: this.options.authority?.(), background, fence, queuedAt: performance.now(), resolve, reject })
    })
    this.pump()
    return result
  }

  reconcile(path: string): Promise<OperationResult<'reconcileMember'>> {
    const entry = this.entry(this.options.canonical(path), false)
    entry.reconcile ??= (this.submit(entry, { kind: 'native', name: 'reconcileMember', args: [] }, true) as Promise<OperationResult<'reconcileMember'>>)
      .finally(() => { delete entry.reconcile })
    return entry.reconcile
  }

  heartbeatAll(): void {
    for (const entry of this.owners) {
      if (entry.owner === undefined || entry.closing !== undefined || entry.heartbeat !== undefined) continue
      entry.heartbeat = this.submit(entry, { kind: 'heartbeat' }, true)
        .catch((error: unknown) => this.options.onError?.(entry.path, error))
        .finally(() => { delete entry.heartbeat })
    }
  }

  private canStart(entry: Entry, job: Job): boolean {
    if (entry.running || entry.retiring || (job.background && this.backgroundBusy)) return false
    if (entry.owner) return true
    if (this.owners.size < (job.background ? OWNER_LIMIT - 1 : OWNER_LIMIT)) return true
    // Free an idle process before a foreground request needs another slot. Busy projects keep their
    // owner and queue so a process can never be reused for a different project during an operation.
    const idle = [...this.owners].find(owner => !owner.running && !owner.jobs.length && !owner.retiring)
    if (idle) void this.retire(idle)
    return false
  }

  private pump(): void {
    for (const entry of this.entries.values()) {
      const job = entry.jobs[0]
      if (!job || !this.canStart(entry, job)) continue
      entry.jobs.shift()
      entry.running = job
      if (job.background) this.backgroundBusy = true
      void this.run(entry, job)
    }
  }

  private ownerFor(entry: Entry): OwnerTransport {
    if (entry.owner === undefined) {
      entry.owner = this.options.open(++this.generation)
      this.owners.add(entry)
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
    const queueMs = started - job.queuedAt
    const runMs = performance.now() - started
    if (this.options.slowLog === undefined || queueMs + runMs <= SLOW_OPERATION_MS) return
    const name = job.work.kind === 'heartbeat' ? 'heartbeat' : `${job.work.kind} ${job.work.name}`
    this.options.slowLog.warn(`Slow workspace operation ${name}: queue wait ${Math.round(queueMs)} ms, run ${Math.round(runMs)} ms`)
  }

  private async executeJob(entry: Entry, job: Job): Promise<unknown> {
    if (job.work.kind !== 'heartbeat') clearTimeout(entry.idle)
    try {
      const owner = this.ownerFor(entry)
      const result = await owner.run(entry.path, job.work, job.authority, job.fence ?? entry.binding)
      return await this.resolveJob(entry, job, owner, result)
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.details?.['ownerStopped'] === true) await this.retire(entry)
        if (error.details?.['bindingChanged'] === true) await this.invalidate(entry)
      }
      throw error
    }
  }

  private async resolveJob(entry: Entry, job: Job, owner: OwnerTransport, { value, binding }: OwnerResult): Promise<unknown> {
    if (entry.closing && !closingWork(job.work)) {
      if (job.work.kind === 'native' && job.work.name === 'issueChatGrant') {
        const { grant } = value as OperationResult<'issueChatGrant'>
        await owner.run(entry.path, { kind: 'native', name: 'revokeChatGrant', args: [grant.id, false] }, job.authority, binding)
      }
      throw new DomainError('conflict', 'The project was closed while this operation ran. Refresh to confirm its result.',
        { operation: job.work.kind, completion: 'stale' })
    }
    if (binding !== undefined) {
      if (entry.binding !== undefined && entry.binding !== binding) await this.invalidate(entry)
      entry.binding = binding
    }
    return value
  }

  private finishJob(entry: Entry, job: Job): void {
    delete entry.running
    if (job.background) this.backgroundBusy = false
    if (!entry.jobs.length) {
      if (entry.closing) void this.finishClose(entry)
      else if (entry.temporary) void this.close(entry.path)
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
      if (entry.running || entry.jobs.length || entry.closing) this.armIdle(entry)
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
      if (!entry.running && !entry.jobs.length) void this.finishClose(entry)
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
    await Promise.all([...this.entries.keys()].map(path => this.close(path)))
  }
}

export function createWorkspacePool(options: PoolOptions): WorkspacePool {
  return new Pool(options)
}
