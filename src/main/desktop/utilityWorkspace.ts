import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { DomainError } from '../../core/errors'
import type { ForgeTransferAuthority } from '../../core/repo/forgeBinding'
import type { OwnerResult, OwnerTransport, SyncMode, Work, WorkspaceRequest, WorkspaceResponse } from './workspaceClient'

interface Pending {
  id: number
  mayWrite: boolean
  resolve(value: OwnerResult): void
  reject(error: unknown): void
}

function lost(uncertain: boolean): DomainError {
  return new DomainError('internal', uncertain
    ? 'The project worker stopped before confirming this operation. Its changes may have committed. Refresh the project to check before trying again.'
    : 'The project worker stopped. Open the project again to continue.',
  { ownerStopped: true, completion: uncertain ? 'unknown' : 'unavailable' })
}

// Workspace open can reconcile and register a session before any command. After that, keep the
// known SQL-only summary reads definite. Other read models may expire leases or update durable state.
const READ_ONLY_WHEN_OPEN: ReadonlySet<string> = new Set(['getProject', 'getEventHead', 'getKanbanOpenCount'])

type Slot = 'work' | 'sync'
type Outgoing = Omit<Extract<WorkspaceRequest, { type: 'work' }>, 'generation' | 'id'> | Omit<Extract<WorkspaceRequest, { type: 'sync' }>, 'generation' | 'id'> | { type: 'close' }

/** One work request and one sync-lane reconcile may be in flight at once; each slot holds at most one. */
class UtilityOwner implements OwnerTransport {
  private sequence = 0
  private readonly pending = new Map<Slot, Pending>()
  private stopped = false
  private opened = false
  private readonly exited: Promise<void>

  constructor(private readonly child: UtilityProcess, private readonly generation: number) {
    this.exited = new Promise(resolve => child.once('exit', () => {
      this.stopped = true
      const pending = [...this.pending.values()]
      this.pending.clear()
      for (const request of pending) request.reject(lost(request.mayWrite))
      resolve()
    }))
    child.on('message', (message: WorkspaceResponse) => this.receive(message))
  }

  private receive(message: WorkspaceResponse): void {
    if (message.generation !== this.generation) return
    const slot = [...this.pending].find(([, request]) => request.id === message.id)?.[0]
    const pending = slot === undefined ? undefined : this.pending.get(slot)
    if (slot === undefined || pending === undefined) return
    this.pending.delete(slot)
    if (message.ok) {
      if (slot === 'work') this.opened = message.result.binding !== undefined
      pending.resolve(message.result)
    }
    else pending.reject(new DomainError(message.error.code, message.error.message, message.error.details))
  }

  private send(slot: Slot, input: Outgoing, writes: boolean): Promise<OwnerResult> {
    if (this.stopped) return Promise.reject(lost(false))
    if (this.pending.has(slot)) return Promise.reject(new Error('Project worker received overlapping requests.'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(slot, { id, mayWrite: writes, resolve, reject })
      try {
        const request = { ...input, id, generation: this.generation } as WorkspaceRequest
        this.child.postMessage(request)
      } catch {
        this.pending.delete(slot)
        reject(lost(false))
      }
    })
  }

  run(path: string, work: Work, authority?: ForgeTransferAuthority, expected?: string): Promise<OwnerResult> {
    const mayWrite = !this.opened || work.kind !== 'command' || !READ_ONLY_WHEN_OPEN.has(work.name)
    return this.send('work', { type: 'work', path, work, authority, expected }, mayWrite)
  }

  sync(path: string, mode: SyncMode, authority?: ForgeTransferAuthority, expected?: string): Promise<OwnerResult> {
    return this.send('sync', { type: 'sync', path, mode, authority, expected }, true)
  }

  async close(): Promise<void> {
    if (!this.stopped) {
      try { await this.send('work', { type: 'close' }, true) }
      finally { this.child.kill(); await this.exited }
    } else await this.exited
  }
}

export function openUtilityWorkspace(generation: number, home: string, version: string): OwnerTransport {
  const child = utilityProcess.fork(join(__dirname, 'workspaceOwner.js'), [String(generation), String(process.pid), home, version], {
    serviceName: 'Dark Mechanicus project'
  })
  return new UtilityOwner(child, generation)
}
