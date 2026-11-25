import { realpathSync, statSync } from 'node:fs'
import { requireCapability } from '../../core/authz'
import { DomainError, toErrorShape } from '../../core/errors'
import { forgeBindingEpoch, withForgeOwnerAuthority } from '../../core/repo/forgeBinding'
import { readProject } from '../../core/repo/initialize'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { assertContained } from '../../core/repo/paths'
import { resolveStorageMode } from '../../core/repo/storageMode'
import { openWorkspace, type Workspace } from '../../core/workspace'
import { inThreadLane, type SyncLane } from './syncLane'
import { exclusiveWork, type OwnerResult, type SyncValue, type WorkspaceRequest, type WorkspaceResponse } from './workspaceClient'
import { runWorkspaceOperation } from './workspaceOperations'

function identity(path: string, base: string): string {
  if (realpathSync.native(path) !== path) throw new DomainError('conflict', 'The tracked folder moved.')
  const root = statSync(path, { bigint: true })
  const mode = resolveStorageMode({ repoRoot: path, homeDir: base, fs: nodeFs })
  const layout = resolveLayout(path, { mode, homeDir: base })
  if (nodeFs.exists(layout.dmDir) || nodeFs.isSymlink(layout.dmDir)) assertContained(layout, nodeFs, layout.dbFile)
  const db = statSync(layout.dbFile, { bigint: true, throwIfNoEntry: false })
  if (db && db.nlink !== 1n) throw new DomainError('conflict', 'The project database has unexpected hard links.')
  const project = readProject(layout, nodeFs)
  return JSON.stringify([
    String(root.dev), String(root.ino), mode, project?.projectId ?? null, forgeBindingEpoch(nodeFs, base, path),
    db ? [String(db.dev), String(db.ino)] : null
  ])
}

interface WorkerOptions {
  generation: number
  home: string
  version: string
  ownerPid: number
  /** The sync lane. The utility entry passes its worker thread; an in-process host reconciles on a second connection of its own thread. */
  lane?: SyncLane
}

type WorkerPort = Pick<Electron.ParentPort, 'on' | 'postMessage'>
type WorkRequest = Extract<WorkspaceRequest, { type: 'work' }>
type SyncRequest = Extract<WorkspaceRequest, { type: 'sync' }>

class WorkspaceOwner {
  private workspace: Workspace | undefined
  private path: string | undefined
  private binding: string | undefined
  private closed = false
  private readonly lane: SyncLane
  /** The lane reconcile in progress; at most one, as the pool admits. */
  private syncing: Promise<unknown> | undefined

  constructor(private readonly options: WorkerOptions) {
    this.lane = options.lane ?? inThreadLane()
  }

  async operate(request: Exclude<WorkspaceRequest, SyncRequest>): Promise<OwnerResult> {
    if (this.closed) throw new DomainError('conflict', 'This project worker is closed.')
    if (request.type === 'close') {
      this.closed = true
      // The lane stops before the owner's own connection closes.
      await this.syncing?.catch(() => undefined)
      await this.lane.close()
      this.closeWorkspace()
      return { value: undefined }
    }
    const { home, ownerPid } = this.options
    return withForgeOwnerAuthority({ home, ownerPid, path: request.path, authority: request.authority }, () => this.run(request))
  }

  /**
   * Admits a lane reconcile on the owner's queue: the durable binding is checked and the owner's session opened as for
   * any work. The reconcile itself then runs on the lane while the queue serves other work; `finish` completes it on the
   * queue again.
   */
  admitSync(request: SyncRequest): { reconciled: Promise<SyncValue> } {
    if (this.closed) throw new DomainError('conflict', 'This project worker is closed.')
    const { home, ownerPid } = this.options
    const { path, expected, mode, authority } = request
    const before = withForgeOwnerAuthority({ home, ownerPid, path, authority }, () => identity(path, home))
    this.assertBinding(path, before, expected)
    const workspace = withForgeOwnerAuthority({ home, ownerPid, path, authority }, () => this.workspace ?? this.open(path))
    if (mode === 'heartbeat' && !workspace.isInitialized()) return { reconciled: Promise.resolve({ result: null, hasLocalCache: false }) }
    const ctx = workspace.ctx()
    if (mode === 'explicit') requireCapability(ctx.session, 'repo.reconcile')
    const reconciled = this.lane.reconcile({ path, home, ownerPid, mode, authority, sessionId: ctx.session.id, machineId: ctx.machineId })
    this.syncing = reconciled.finally(() => { if (this.syncing === tracked) this.syncing = undefined })
    const tracked = this.syncing
    return { reconciled }
  }

  /** On the owner's queue after the lane: the binding still holds, and what the reconcile left to export is flushed. */
  async finishSync(request: SyncRequest, value: SyncValue): Promise<OwnerResult> {
    if (this.closed) throw new DomainError('conflict', 'The project was closed while this operation ran. Refresh to confirm its result.', { completion: 'stale' })
    const { home, ownerPid } = this.options
    const { path, authority } = request
    return withForgeOwnerAuthority({ home, ownerPid, path, authority }, async () => {
      const after = identity(path, home)
      if (this.binding !== after) {
        throw new DomainError('conflict', 'The project storage changed while this operation ran. Refresh to confirm its result.', { bindingChanged: true, completion: 'stale' })
      }
      // As after any reconcile in a workspace; a failed export stays in the outbox, and a branch change exports nothing.
      if (value.result !== null) await this.workspace?.flushPortableState().catch(() => undefined)
      return { value, binding: after }
    })
  }

  private closeWorkspace(): void {
    const current = this.workspace
    this.workspace = undefined
    current?.close()
  }

  private open(path: string): Workspace {
    const { home, version } = this.options
    // The owner never reconciles on its own connection: its open-time and heartbeat reconciles run on the lane.
    this.workspace ??= openWorkspace({
      repoRoot: path, role: 'desktop', label: 'Desktop', transport: 'desktop', pid: process.pid,
      autoReconcile: false, deferOpenReconcile: true, homeDir: home, serverInfo: { name: 'darkmechanicus-desktop', version }
    })
    if (this.workspace.repoRoot !== path) {
      this.closeWorkspace()
      throw new DomainError('conflict', 'The Forge binding changed while opening the project.', { bindingChanged: true })
    }
    this.path = path
    this.binding = identity(path, home)
    return this.workspace
  }

  private async run(request: WorkRequest): Promise<OwnerResult> {
    const { home } = this.options
    const { path, work, expected } = request
    let before: string
    try { before = identity(path, home) }
    catch (error) { return this.revokeMoved(request, error) }
    this.assertBinding(path, before, expected)
    if (exclusiveWork(work)) {
      // The store may move or be replaced: the lane finishes and lets go of its connection first.
      await this.syncing?.catch(() => undefined)
      await this.lane.release()
    }
    const workspace = this.workspace ?? this.open(path)
    const value = await runWorkspaceOperation(workspace, work, home)
    const after = identity(path, home)
    if (this.binding !== after && !storageCommand(work)) {
      throw new DomainError('conflict', 'The project storage changed while this operation ran. Refresh to confirm its result.', { bindingChanged: true, completion: 'stale' })
    }
    this.binding = after
    return { value, binding: after }
  }

  private assertBinding(path: string, actual: string, expected: string | undefined): void {
    if ((expected !== undefined && expected !== actual) || (this.path !== undefined && (path !== this.path || this.binding !== actual))) {
      throw new DomainError('conflict', 'The project storage changed. Reopen the folder before continuing.', { bindingChanged: true })
    }
  }

  private async revokeMoved({ path, work, expected }: WorkRequest, error: unknown): Promise<OwnerResult> {
    // A POSIX checkout can move while its terminal is running. Use only the existing handle.
    if (this.workspace === undefined || path !== this.path || expected !== this.binding
      || (error as NodeJS.ErrnoException).code !== 'ENOENT' || work.kind !== 'native' || work.name !== 'revokeChatGrant') throw error
    return { value: await runWorkspaceOperation(this.workspace, work, this.options.home), binding: this.binding }
  }
}

function storageCommand(work: WorkRequest['work']): boolean {
  return work.kind === 'command' && (work.name === 'initializeRepository' || work.name === 'switchStorageMode')
}

/**
 * One project per port. Queued callbacks cannot overlap inside the utility; a lane reconcile is admitted and finished
 * on the queue, and runs on the lane between, while the queue serves the requests that follow it.
 */
export function serveWorkspaceOwner(options: WorkerOptions, parentPort: WorkerPort): void {
  const instance = new WorkspaceOwner(options)
  const { generation } = options
  let queued = Promise.resolve()
  const reply = (id: number, outcome: () => Promise<OwnerResult>) => {
    queued = queued.then(async () => {
      let response: WorkspaceResponse
      try { response = { id, generation, ok: true, result: await outcome() } }
      catch (error) { response = { id, generation, ok: false, error: toErrorShape(error) } }
      parentPort.postMessage(response)
    })
  }
  parentPort.on('message', ({ data }: { data: WorkspaceRequest }) => {
    if (data.generation !== generation) return
    if (data.type !== 'sync') return reply(data.id, () => instance.operate(data))
    queued = queued.then(() => {
      let admitted: { reconciled: Promise<SyncValue> }
      try { admitted = instance.admitSync(data) }
      catch (error) { return parentPort.postMessage({ id: data.id, generation, ok: false, error: toErrorShape(error) } satisfies WorkspaceResponse) }
      admitted.reconciled.then(
        value => reply(data.id, () => instance.finishSync(data, value)),
        (error: unknown) => reply(data.id, () => Promise.reject(error))
      )
    })
  })
}
