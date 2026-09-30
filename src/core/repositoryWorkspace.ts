import type { CommandApi, CommandName } from '../shared/domain/api'
import type {
  FlushResultView,
  InitializeResultView,
  ReconcileResultView,
  SessionRole
} from '../shared/domain/views'
import { capabilitiesForRole, type Capability } from './authz'
import { createSystemClock, type Clock } from './clock'
import { COMMANDS } from './commands'
import type { WorkspaceCore } from './commands/types'
import type { Ctx } from './context'
import { openDatabase, type Db } from './db/database'
import { migrate } from './db/migrations'
import { fail } from './errors'
import { createIdGenerator, type IdGenerator } from './ids'
import { getMeta, META_KEYS, setMeta } from './meta'
import { findRepositoryRoot } from './repo/discovery'
import { flushOutbox } from './repo/finalizer'
import { createGitAdapter } from './repo/git'
import { reconcileRepository } from './repo/importer'
import { ensureMachineId, initializeRepository, readProject } from './repo/initialize'
import { resolveLayout } from './repo/layout'
import { nodeFs } from './repo/nodeFs'
import type { ProjectRecord } from './repo/portable'
import type { FsAdapter, GitAdapter, RepoLayout } from './repo/types'
import { parseInput } from './schemas'
import { completeSavedRevision } from './services/plans'
import { endSession, registerSession, touchSession } from './services/sessions'

export interface OpenWorkspaceOptions {
  /** Repository root (already resolved/canonical). */
  repoRoot: string
  role: SessionRole
  label: string
  transport: 'stdio' | 'desktop' | 'in_process'
  /** Explicit user authorization for an agent session to save plans. */
  allowSave?: boolean
  pid?: number | null
  clock?: Clock
  ids?: IdGenerator
  fs?: FsAdapter
  git?: GitAdapter
  /** Reconcile tracked records on open and on heartbeat (default true). */
  autoReconcile?: boolean
  serverInfo?: { name: string; version: string }
}

/** One repository opened by one session. Implements the full command contract. */
export interface Workspace extends CommandApi {
  readonly repoRoot: string
  sessionId(): string | null
  isInitialized(): boolean
  /** Marks the session alive and picks up tracked-record changes (MCP heartbeat / desktop poll). */
  heartbeat(): void
  close(): void
}

interface Store {
  db: Db
  project: ProjectRecord
  ctx: Ctx
}

function bindProject(db: Db, project: ProjectRecord): void {
  const known = getMeta(db, META_KEYS.projectId)
  if (known !== null && known !== project.projectId) {
    fail(
      'project_mismatch',
      'The local database belongs to a different project than .darkmechanicus/project.json. Remove .darkmechanicus/local/ to rebuild it from tracked records.',
      { databaseProjectId: known, projectId: project.projectId }
    )
  }
  db.tx(() => {
    setMeta(db, META_KEYS.projectId, project.projectId)
    setMeta(db, META_KEYS.projectName, project.name)
    setMeta(db, META_KEYS.keyPrefix, project.keyPrefix)
  })
}

class RepositoryWorkspace implements WorkspaceCore {
  readonly repoRoot: string
  readonly layout: RepoLayout
  readonly fs: FsAdapter
  readonly git: GitAdapter
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly options: OpenWorkspaceOptions
  private store: Store | null = null

  constructor(options: OpenWorkspaceOptions) {
    this.options = options
    this.fs = options.fs ?? nodeFs
    this.repoRoot =
      options.transport === 'stdio' ? findRepositoryRoot(options.repoRoot, this.fs) : options.repoRoot
    this.layout = resolveLayout(this.repoRoot)
    this.git = options.git ?? createGitAdapter(this.repoRoot, { fs: this.fs })
    this.clock = options.clock ?? createSystemClock()
    this.ids = options.ids ?? createIdGenerator(() => this.clock.nowMs())
    if (this.fs.exists(this.layout.projectFile)) {
      this.openStore()
    }
  }

  get role(): SessionRole {
    return this.options.role
  }

  roleCapabilities(): Capability[] {
    return capabilitiesForRole(this.options.role, { allowSave: this.options.allowSave === true })
  }

  isInitialized(): boolean {
    return this.store !== null
  }

  sessionId(): string | null {
    return this.store?.ctx.session.id ?? null
  }

  project(): ProjectRecord {
    return this.requireStore().project
  }

  db(): Db | null {
    return this.store?.db ?? null
  }

  ctx(): Ctx {
    return this.requireStore().ctx
  }

  private requireStore(): Store {
    if (!this.store && this.fs.exists(this.layout.projectFile)) {
      // Another session (e.g. an agent over MCP) initialized the repository after this one opened.
      this.openStore()
    }
    if (!this.store) {
      fail('not_initialized', `${this.repoRoot} is not initialized for Dark Mechanicus. Run initialize_repository first.`)
    }
    return this.store
  }

  private openStore(): void {
    const project = readProject(this.layout, this.fs)
    if (!project) {
      fail('not_initialized', `${this.repoRoot} has no valid .darkmechanicus/project.json.`)
    }
    this.fs.mkdirp(this.layout.localDir)
    const db = openDatabase(this.layout.dbFile)
    try {
      this.store = this.createStore(db, project)
    } catch (error: unknown) {
      db.close()
      throw error
    }
    if (this.options.autoReconcile !== false) {
      this.reconcile()
    }
    this.safeFlush()
  }

  private createStore(db: Db, project: ProjectRecord): Store {
    migrate(db)
    bindProject(db, project)
    const machineId = ensureMachineId({ layout: this.layout, fs: this.fs, ids: this.ids, clock: this.clock })
    db.tx(() => setMeta(db, META_KEYS.machineId, machineId))
    const session = registerSession(
      { db, clock: this.clock, ids: this.ids },
      {
        role: this.options.role,
        label: this.options.label,
        transport: this.options.transport,
        pid: this.options.pid ?? null,
        capabilities: this.roleCapabilities()
      }
    )
    const ctx: Ctx = {
      db,
      clock: this.clock,
      ids: this.ids,
      session,
      machineId,
      projectId: project.projectId,
      assertBranch: () => this.assertBranch(),
      checkout: () => this.checkout()
    }
    return { db, project, ctx }
  }

  checkout(): { branch: string | null; commit: string | null } {
    const head = this.git.head()
    return { branch: head?.branch ?? null, commit: head?.commit ?? null }
  }

  branchChanged(): boolean {
    const store = this.store
    if (!store) {
      return false
    }
    const recorded = getMeta(store.db, META_KEYS.checkoutBranch)
    return recorded !== null && recorded !== (this.checkout().branch ?? '')
  }

  assertBranch(): void {
    if (this.branchChanged()) {
      const recorded = getMeta(this.requireStore().db, META_KEYS.checkoutBranch) || '(detached)'
      const current = this.checkout().branch ?? '(detached)'
      fail(
        'branch_changed',
        `The coordinating checkout moved from ${recorded} to ${current}. Reconcile the repository before saving or dispatching work; drafts are kept.`,
        { recorded, current }
      )
    }
  }

  initialize(input: { name?: string; keyPrefix?: string }): InitializeResultView {
    const result = initializeRepository(
      { layout: this.layout, fs: this.fs, ids: this.ids, clock: this.clock },
      input
    )
    if (!this.store) {
      this.openStore()
    }
    return {
      projectId: result.projectId,
      name: result.name,
      keyPrefix: result.keyPrefix,
      createdFiles: result.createdFiles,
      alreadyInitialized: result.alreadyInitialized
    }
  }

  reconcile(): ReconcileResultView {
    const store = this.requireStore()
    const result = reconcileRepository({
      db: store.db,
      layout: this.layout,
      fs: this.fs,
      clock: this.clock,
      machineId: store.ctx.machineId,
      git: this.git,
      sessionId: store.ctx.session.id
    })
    return result
  }

  flush(): FlushResultView {
    const store = this.requireStore()
    const outcome = flushOutbox(
      { db: store.db, layout: this.layout, fs: this.fs, clock: this.clock },
      { onSnapshotSaved: (revisionId) => completeSavedRevision(store.ctx, revisionId) }
    )
    return { flushed: outcome.flushed, failed: outcome.failed, errors: outcome.errors }
  }

  /** Flush after a committed mutation; failures stay recorded in the outbox for retry. */
  safeFlush(): void {
    try {
      this.flush()
    } catch {
      // The outbox keeps the entry pending with its error; storage status surfaces it.
    }
  }

  heartbeat(): void {
    if (!this.store) {
      if (this.fs.exists(this.layout.projectFile)) {
        this.openStore()
      }
      return
    }
    touchSession({ db: this.store.db, clock: this.clock }, this.store.ctx.session.id)
    if (this.options.autoReconcile !== false && !this.branchChanged()) {
      this.safeReconcile()
    }
  }

  private safeReconcile(): void {
    try {
      this.reconcile()
      this.safeFlush()
    } catch {
      // A rejected import leaves the last good state; reconcile_repository reports details.
    }
  }

  async execute(name: CommandName, rawInput: unknown): Promise<unknown> {
    const spec = COMMANDS[name]
    // Untrusted input is validated before anything else, whatever state the repository is in.
    const input = spec.schema ? parseInput(spec.schema, rawInput ?? {}, `${name} input`) : undefined
    if (!spec.beforeInit) {
      this.requireStore()
    }
    const run = spec.run as (core: WorkspaceCore, input: unknown) => unknown
    const result = await run(this, input)
    if (spec.mutates && this.store) {
      this.safeFlush()
    }
    return result
  }

  close(): void {
    const store = this.store
    if (!store) {
      return
    }
    this.store = null
    try {
      endSession({ db: store.db, clock: this.clock }, store.ctx.session.id)
    } finally {
      store.db.close()
    }
  }
}

export function openWorkspace(options: OpenWorkspaceOptions): Workspace {
  const core = new RepositoryWorkspace(options)
  const commands: Record<string, (input?: unknown) => Promise<unknown>> = {}
  for (const name of Object.keys(COMMANDS) as CommandName[]) {
    commands[name] = (input?: unknown) => core.execute(name, input)
  }
  const lifecycle = {
    repoRoot: core.repoRoot,
    sessionId: () => core.sessionId(),
    isInitialized: () => core.isInitialized(),
    heartbeat: () => core.heartbeat(),
    close: () => core.close()
  }
  return Object.assign(commands, lifecycle) as unknown as Workspace
}
