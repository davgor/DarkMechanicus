import { realpathSync, statSync } from 'node:fs'
import { DomainError, toErrorShape } from '../../core/errors'
import { forgeBindingEpoch, withForgeOwnerAuthority } from '../../core/repo/forgeBinding'
import { readProject } from '../../core/repo/initialize'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { assertContained } from '../../core/repo/paths'
import { resolveStorageMode } from '../../core/repo/storageMode'
import { openWorkspace, type Workspace } from '../../core/workspace'
import type { OwnerResult, Work, WorkspaceRequest, WorkspaceResponse } from './workspaceClient'
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
}

type WorkerPort = Pick<Electron.ParentPort, 'on' | 'postMessage'>

class WorkspaceOwner {
  private workspace: Workspace | undefined
  private path: string | undefined
  private binding: string | undefined
  private closed = false

  constructor(private readonly options: WorkerOptions) {}

  async operate(request: WorkspaceRequest): Promise<OwnerResult> {
    if (this.closed) throw new DomainError('conflict', 'This project worker is closed.')
    if (request.type === 'close') {
      this.closed = true
      this.closeWorkspace()
      return { value: undefined }
    }
    const { home, ownerPid } = this.options
    return withForgeOwnerAuthority({ home, ownerPid, path: request.path, authority: request.authority }, () => this.run(request))
  }

  private closeWorkspace(): void {
    const current = this.workspace
    this.workspace = undefined
    current?.close()
  }

  private open(path: string, work: Work): Workspace {
    const { home, version } = this.options
    this.workspace ??= openWorkspace({
      repoRoot: path, role: 'desktop', label: 'Desktop', transport: 'desktop', pid: process.pid,
      deferOpenReconcile: work.kind === 'native' && work.name === 'reconcileMember',
      homeDir: home, serverInfo: { name: 'darkmechanicus-desktop', version }
    })
    if (this.workspace.repoRoot !== path) {
      this.closeWorkspace()
      throw new DomainError('conflict', 'The Forge binding changed while opening the project.', { bindingChanged: true })
    }
    this.path = path
    this.binding = identity(path, home)
    return this.workspace
  }

  private async run(request: Extract<WorkspaceRequest, { type: 'work' }>): Promise<OwnerResult> {
    const { home } = this.options
    const { path, work, expected } = request
    let before: string
    try { before = identity(path, home) }
    catch (error) { return this.revokeMoved(request, error) }
    this.assertBinding(path, before, expected)
    const workspace = this.workspace ?? this.open(path, work)
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

  private async revokeMoved({ path, work, expected }: Extract<WorkspaceRequest, { type: 'work' }>, error: unknown): Promise<OwnerResult> {
    // A POSIX checkout can move while its terminal is running. Use only the existing handle.
    if (this.workspace === undefined || path !== this.path || expected !== this.binding
      || (error as NodeJS.ErrnoException).code !== 'ENOENT' || work.kind !== 'native' || work.name !== 'revokeChatGrant') throw error
    return { value: await runWorkspaceOperation(this.workspace, work, this.options.home), binding: this.binding }
  }
}

function storageCommand(work: Extract<WorkspaceRequest, { type: 'work' }>['work']): boolean {
  return work.kind === 'command' && (work.name === 'initializeRepository' || work.name === 'switchStorageMode')
}

/** One project per port. Queued callbacks cannot overlap inside the utility. */
export function serveWorkspaceOwner(options: WorkerOptions, parentPort: WorkerPort): void {
  const instance = new WorkspaceOwner(options)
  const { generation } = options
  let queued = Promise.resolve()
  parentPort.on('message', ({ data }: { data: WorkspaceRequest }) => {
    if (data.generation !== generation) return
    queued = queued.then(async () => {
      const id = data.id
      let response: WorkspaceResponse
      try { response = { id, generation, ok: true, result: await instance.operate(data) } }
      catch (error) { response = { id, generation, ok: false, error: toErrorShape(error) } }
      parentPort.postMessage(response)
    })
  })
}
