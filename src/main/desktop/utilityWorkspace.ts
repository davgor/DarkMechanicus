import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { DomainError } from '../../core/errors'
import type { ForgeTransferAuthority } from '../../core/repo/forgeBinding'
import type { OwnerResult, OwnerTransport, Work, WorkspaceRequest, WorkspaceResponse } from './workspaceClient'

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

class UtilityOwner implements OwnerTransport {
  private sequence = 0
  private pending: Pending | undefined
  private stopped = false
  private opened = false
  private readonly exited: Promise<void>

  constructor(private readonly child: UtilityProcess, private readonly generation: number) {
    this.exited = new Promise(resolve => child.once('exit', () => {
      this.stopped = true
      const pending = this.pending
      this.pending = undefined
      pending?.reject(lost(pending.mayWrite))
      resolve()
    }))
    child.on('message', (message: WorkspaceResponse) => this.receive(message))
  }

  private receive(message: WorkspaceResponse): void {
    const pending = this.pending
    if (!pending || message.generation !== this.generation || message.id !== pending.id) return
    this.pending = undefined
    if (message.ok) {
      this.opened = message.result.binding !== undefined
      pending.resolve(message.result)
    }
    else pending.reject(new DomainError(message.error.code, message.error.message, message.error.details))
  }

  private send(input: Omit<Extract<WorkspaceRequest, { type: 'work' }>, 'generation' | 'id'> | { type: 'close' }, writes: boolean): Promise<OwnerResult> {
    if (this.stopped) return Promise.reject(lost(false))
    if (this.pending) return Promise.reject(new Error('Project worker received overlapping requests.'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      this.pending = { id, mayWrite: writes, resolve, reject }
      try {
        const request: WorkspaceRequest = { ...input, id, generation: this.generation }
        this.child.postMessage(request)
      } catch {
        this.pending = undefined
        reject(lost(false))
      }
    })
  }

  run(path: string, work: Work, authority?: ForgeTransferAuthority, expected?: string): Promise<OwnerResult> {
    const mayWrite = !this.opened || work.kind !== 'command' || !READ_ONLY_WHEN_OPEN.has(work.name)
    return this.send({ type: 'work', path, work, authority, expected }, mayWrite)
  }

  async close(): Promise<void> {
    if (!this.stopped) {
      try { await this.send({ type: 'close' }, true) }
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
