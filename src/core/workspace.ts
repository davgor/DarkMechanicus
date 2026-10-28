import { homedir } from 'node:os'
import type { CommandApi, CommandName } from '../shared/domain/api'
import type {
  DefinitionOfDoneCheck,
  FlushResultView,
  InitializeResultView,
  ReconcileResultView,
  SessionRole
} from '../shared/domain/views'
import { capabilitiesForRole, type Capability } from './authz'
import { createSystemClock, type Clock } from './clock'
import { COMMANDS } from './commands/index'
import type { WorkspaceCore } from './commands/types'
import type { Ctx } from './context'
import { openDatabase, type Db } from './db/database'
import { migrate } from './db/migrations'
import { fail } from './errors'
import { createIdGenerator, type IdGenerator } from './ids'
import { getMeta, META_KEYS, setMeta } from './meta'
import { findRepositoryRoot } from './repo/discovery'
import { createFileHashCache } from './repo/fileHashes'
import { flushOutbox } from './repo/finalizer'
import { createGitAdapter } from './repo/git'
import { reconcileRepository } from './repo/importer'
import { ensureMachineId, initializeRepository, readProject } from './repo/initialize'
import { resolveLayout } from './repo/layout'
import { nodeFs } from './repo/nodeFs'
import type { ProjectRecord } from './repo/portable'
import { resolveHomeDir, resolveStorageMode, type StorageMode } from './repo/storageMode'
import { assertGrantUsable, redeemGrant, type RedeemedGrant } from './services/grants'
import type { FsAdapter, GitAdapter, RepoLayout } from './repo/types'
import { parseInput } from './schemas'
import { completeSavedRevision } from './services/plans'
import { endSession, registerSession, touchSession } from './services/sessions'

export interface OpenWorkspaceOptions {
  /** Repository root (already resolved/canonical). */
  repoRoot: string
  role: SessionRole
  label: string
  transport: 'stdio' | 'desktop' | 'in_process' | 'cli'
  /**
   * Storage mode. Omitted (the normal case) it is resolved from the home directory, so every
   * process agrees on how an existing folder is set up; pass it to initialize a new folder a
   * particular way.
   */
  mode?: StorageMode
  /** The Dark Mechanicus home directory; defaults to `$DARKMECHANICUS_HOME` or `~/.darkmechanicus`. */
  homeDir?: string
  /** Explicit user authorization for an agent session to save plans. */
  allowSave?: boolean
  /**
   * A grant token (`cli` transport only). The session's role and capabilities come from the grant
   * a person issued, never from `role`/`allowSave`, which a local caller could set for itself.
   * Without one a CLI session is a `reader` and may only read.
   */
  grantToken?: string
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
  /**
   * Runs a command by name with input that has not been validated yet; the command's own schema
   * checks it. For a caller dispatching over the whole table, such as the CLI, rather than one
   * that knows which command it wants.
   */
  execute(name: CommandName, input: unknown): Promise<unknown>
  close(): void
}

interface Store {
  db: Db
  project: ProjectRecord
  ctx: Ctx
}

/** The canonical form of a repository root, or the path itself when it cannot be resolved. */
function canonicalRoot(path: string, fs: FsAdapter): string {
  try {
    return fs.realpath(path)
  } catch {
    return path
  }
}

/**
 * How to recover from a database that belongs to another project. In `repo` mode the database is a
 * cache of the tracked records and can simply be rebuilt. In `db` mode it is the only copy of the
 * project, so the advice must never be to delete it.
 */
function mismatchAdvice(layout: RepoLayout): string {
  if (layout.mode === 'repo') {
    return 'The local database belongs to a different project than .darkmechanicus/project.json. Remove .darkmechanicus/local/ to rebuild it from tracked records.'
  }
  return `The database in ${layout.localDir} belongs to a different project than ${layout.projectFile}. It is the only copy of that project's work, so do not delete it: move the whole project directory aside, or restore the project.json that belongs to it.`
}

/** A CLI session that presented no grant: it observes, and changes nothing. */
const UNGRANTED_CLI_CAPABILITIES: readonly Capability[] = ['read']

function bindProject(db: Db, layout: RepoLayout, project: ProjectRecord): void {
  const known = getMeta(db, META_KEYS.projectId)
  if (known !== null && known !== project.projectId) {
    fail('project_mismatch', mismatchAdvice(layout), { databaseProjectId: known, projectId: project.projectId })
  }
  db.tx(() => {
    setMeta(db, META_KEYS.projectId, project.projectId)
    setMeta(db, META_KEYS.projectName, project.name)
    setMeta(db, META_KEYS.keyPrefix, project.keyPrefix)
  })
}

class RepositoryWorkspace implements WorkspaceCore {
  readonly repoRoot: string
  readonly homeDir: string
  /** Re-resolved when `initialize` sets the folder up in a mode other than the one it resolved to. */
  layout: RepoLayout
  readonly fs: FsAdapter
  readonly git: GitAdapter
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly options: OpenWorkspaceOptions
  private store: Store | null = null
  /** What the presented grant conferred, or null for a session that presented none. */
  private granted: RedeemedGrant | null = null
  /** Comment and profile files read by earlier reconciles, so unchanged ones are not read again. */
  private readonly fileHashes = createFileHashCache()

  constructor(options: OpenWorkspaceOptions) {
    this.options = options
    this.fs = options.fs ?? nodeFs
    this.homeDir = options.homeDir ?? resolveHomeDir(process.env, homedir())
    // Always canonical: a database-only project is keyed by this path, so two spellings of one
    // folder must never resolve to two projects (or to none, which would set the checkout up).
    this.repoRoot =
      options.transport === 'stdio'
        ? findRepositoryRoot(options.repoRoot, this.fs, this.homeDir)
        : canonicalRoot(options.repoRoot, this.fs)
    this.layout = this.layoutFor(options.mode ?? this.resolvedMode())
    this.git = options.git ?? createGitAdapter(this.repoRoot, { fs: this.fs })
    this.clock = options.clock ?? createSystemClock()
    this.ids = options.ids ?? createIdGenerator(() => this.clock.nowMs())
    if (this.fs.exists(this.layout.projectFile)) {
      this.openStore()
    }
  }

  /** How the folder is already set up, read from the home directory. */
  private resolvedMode(): StorageMode {
    return resolveStorageMode({ repoRoot: this.repoRoot, homeDir: this.homeDir, fs: this.fs })
  }

  private layoutFor(mode: StorageMode): RepoLayout {
    return resolveLayout(this.repoRoot, { mode, homeDir: this.homeDir })
  }

  /**
   * A `cli` session is its grant's role, or `reader` when it presented none — never the `role` it
   * was constructed with, which for a local process is simply what it chose to say about itself.
   */
  get role(): SessionRole {
    if (this.options.transport === 'cli') {
      return this.granted?.role ?? 'reader'
    }
    return this.options.role
  }

  /**
   * What this session may do. A `cli` session is told by its grant, because the flags it was
   * started with are its own; every other transport is configured by the person who launched it.
   */
  roleCapabilities(): Capability[] {
    if (this.options.transport === 'cli') {
      return this.granted === null ? [...UNGRANTED_CLI_CAPABILITIES] : [...this.granted.capabilities]
    }
    return capabilitiesForRole(this.options.role, { allowSave: this.options.allowSave === true })
  }

  isInitialized(): boolean {
    try {
      this.openIfReady()
    } catch {
      // A folder whose project cannot be opened reads as not initialized, as it always has.
    }
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

  /**
   * Re-resolves how the folder is set up, for a session with no store open. A session can outlive
   * the folder being set up — an agent connected over MCP before the person initializes in the
   * desktop app — and in that window it only guessed the mode, so a project created since in the
   * *other* mode would stay invisible to it forever. A session that was told which mode to use
   * keeps that one.
   */
  private refreshLayout(): void {
    if (this.store !== null || this.options.mode !== undefined) {
      return
    }
    const mode = this.resolvedMode()
    if (mode !== this.layout.mode) {
      this.layout = this.layoutFor(mode)
    }
  }

  /** Opens the store when the folder has since been set up (in either mode). */
  private openIfReady(): void {
    if (this.store !== null) {
      return
    }
    this.refreshLayout()
    if (this.fs.exists(this.layout.projectFile)) {
      // Another session (e.g. an agent over MCP, or the desktop app) set the folder up after this
      // one opened.
      this.openStore()
    }
  }

  private requireStore(): Store {
    this.openIfReady()
    if (!this.store) {
      fail('not_initialized', `${this.repoRoot} is not initialized for Dark Mechanicus. Run initialize_repository first.`)
    }
    return this.store
  }

  private openStore(): void {
    const project = readProject(this.layout, this.fs)
    if (!project) {
      fail('not_initialized', `${this.repoRoot} has no valid project record at ${this.layout.projectFile}.`)
    }
    this.fs.mkdirp(this.layout.localDir)
    const db = openDatabase(this.layout.dbFile)
    try {
      this.store = this.createStore(db, project)
    } catch (error: unknown) {
      db.close()
      throw error
    }
    // A branch that moved while closed is never acknowledged silently: reconcile stays explicit.
    // A db project has nothing tracked to reconcile at all.
    if (this.layout.mode === 'repo' && this.options.autoReconcile !== false && !this.branchChanged()) {
      this.reconcile()
    }
    this.safeFlush()
  }

  /**
   * Redeems the grant token, once the database is open and migrated. A `cli` session without one
   * stays a reader; a token that is not usable fails the open rather than quietly downgrading, so
   * a stale token is never mistaken for a deliberate read-only session.
   */
  private redeem(db: Db, machineId: string): void {
    const token = this.options.grantToken
    if (this.options.transport !== 'cli' || token === undefined) {
      return
    }
    this.granted = redeemGrant({ db, clock: this.clock, machineId }, token)
  }

  private createStore(db: Db, project: ProjectRecord): Store {
    migrate(db)
    bindProject(db, this.layout, project)
    const machineId = ensureMachineId({ layout: this.layout, fs: this.fs, ids: this.ids, clock: this.clock })
    db.tx(() => setMeta(db, META_KEYS.machineId, machineId))
    this.redeem(db, machineId)
    const session = registerSession(
      { db, clock: this.clock, ids: this.ids },
      {
        role: this.role,
        label: this.options.label,
        transport: this.options.transport,
        pid: this.options.pid ?? null,
        capabilities: this.roleCapabilities(),
        grantId: this.granted?.grantId ?? null
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
      checkout: () => this.checkout(),
      definitionOfDone: () => this.definitionOfDone()
    }
    return { db, project, ctx }
  }

  /** The checks `project.json` holds now: read from the file each time, never from the copy read at open. */
  definitionOfDone(): DefinitionOfDoneCheck[] {
    return readProject(this.layout, this.fs)?.definitionOfDone ?? []
  }

  checkout(): { branch: string | null; commit: string | null } {
    const head = this.git.head()
    return { branch: head?.branch ?? null, commit: head?.commit ?? null }
  }

  /** Only asked once the store is open (open, heartbeat, and the branch guard). */
  branchChanged(): boolean {
    const recorded = getMeta(this.requireStore().db, META_KEYS.checkoutBranch)
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

  /**
   * Sets the folder up, in `input.mode` when it asks for one. A folder already set up the other way
   * is refused rather than given a second project (`initializeRepository`).
   *
   * The session only moves to the other mode once that has succeeded: a refusal must leave a
   * session that was working on the project it already had still working on it, rather than closed
   * and pointing at a project that was never created.
   */
  initialize(input: { name?: string; keyPrefix?: string; mode?: StorageMode }): InitializeResultView {
    const target = input.mode === undefined ? this.layout : this.layoutFor(input.mode)
    const result = initializeRepository(
      {
        layout: target,
        fs: this.fs,
        ids: this.ids,
        clock: this.clock,
        otherProjectFile: this.layoutFor(target.mode === 'repo' ? 'db' : 'repo').projectFile
      },
      input
    )
    if (target.mode !== this.layout.mode) {
      // The session's database is the other mode's: close it and open the project just created.
      this.close()
      this.layout = target
    }
    if (!this.store) {
      this.openStore()
    }
    return {
      projectId: result.projectId,
      name: result.name,
      keyPrefix: result.keyPrefix,
      createdFiles: result.createdFiles,
      alreadyInitialized: result.alreadyInitialized,
      storage: { mode: this.layout.mode, projectDir: this.layout.dmDir }
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
      sessionId: store.ctx.session.id,
      fileHashes: this.fileHashes
    })
    return result
  }

  flush(): FlushResultView {
    const store = this.requireStore()
    // Pending exports belong to the recorded branch; never write them into another checkout.
    this.assertBranch()
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
      this.openIfReady()
      return
    }
    touchSession({ db: this.store.db, clock: this.clock }, this.store.ctx.session.id)
    if (this.layout.mode === 'repo' && this.options.autoReconcile !== false && !this.branchChanged()) {
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

  /**
   * A grant is checked again before each command, not only when the session opened. Revoking one
   * has to stop the session it is running: `dm` is one command per process today, so the window is
   * small, but anything that holds a workspace open would otherwise keep its authority until it
   * exited.
   */
  private assertStillGranted(): void {
    const store = this.store
    if (this.granted === null || store === null) {
      return
    }
    assertGrantUsable({ db: store.db, clock: this.clock, machineId: store.ctx.machineId }, this.granted.grantId)
  }

  async execute(name: CommandName, rawInput: unknown): Promise<unknown> {
    const spec = COMMANDS[name]
    // Untrusted input is validated before anything else, whatever state the repository is in.
    const input = spec.schema ? parseInput(spec.schema, rawInput ?? {}, `${name} input`) : undefined
    if (!spec.beforeInit) {
      this.requireStore()
    }
    this.assertStillGranted()
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
    execute: (name: CommandName, input: unknown) => core.execute(name, input),
    close: () => core.close()
  }
  return Object.assign(commands, lifecycle) as unknown as Workspace
}
