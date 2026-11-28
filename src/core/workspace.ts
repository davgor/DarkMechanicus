import { AsyncLocalStorage } from 'node:async_hooks'
import { createBrowserClient, type BrowserClient } from './desktop/browserClient'
import { createDesktopClient, type DesktopClient } from './desktop/desktopClient'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CommandApi, CommandName } from '../shared/domain/api'
import type {
  DefinitionOfDoneCheck,
  FlushResultView,
  InitializeResultView,
  ReconcileResultView,
  SessionRole
} from '../shared/domain/views'
import { capabilitiesForRole, type Capability, type SessionContext } from './authz'
import { createSystemClock, type Clock } from './clock'
import { COMMANDS } from './commands/index'
import type { WorkspaceCore } from './commands/types'
import type { Ctx } from './context'
import { guardTransactions, openDatabase, tagTransactions, type Db, type TransactionObserver } from './db/database'
import { migrate, readSchemaVersion, SCHEMA_VERSION } from './db/migrations'
import { DomainError, fail } from './errors'
import { policyForStore, portablePolicy, recoverSqlitePolicy } from './repo/deliveryPolicy'
import { createIdGenerator, type IdGenerator } from './ids'
import { getMeta, META_KEYS, setMeta } from './meta'
import { assertForgeStorage, assertForgeTransferIdle, boundForgeRoot, forgeBindingEpoch, isForgeMember } from './repo/forgeBinding'
import { forgeCodeCheckout, isForgeCodeMember } from './repo/forgeCheckout'
import { findRepositoryRoot } from './repo/discovery'
import { createFileHashCache } from './repo/fileHashes'
import { type FlushMode, flushOutbox, type FlushScope } from './repo/finalizer'
import { createGitAdapter } from './repo/git'
import { reconcileRepository } from './repo/importer'
import { reconcileGate } from './repo/reconcileFingerprint'
import { ensureMachineId, initializeRepository, type ProjectLayout, readProject } from './repo/initialize'
import { resolveLayout } from './repo/layout'
import { nodeFs } from './repo/nodeFs'
import type { ProjectRecord } from './repo/portable'
import { resolveHomeDir, resolveStorageMode, type StorageMode } from './repo/storageMode'
import { createRecordStatusCache } from './repo/storage'
import { assertStorageMigrationIdle, recoverStorageMigration, exportForgeDestination, switchStorage, type ForgeExportOptions } from './repo/storageMigration'
import { pruneStagedAttachments } from './services/attachments'
import { listAgentPeers, MAIL_POLL_COMMANDS, openMailPollSession, touchMailPollSession } from './services/agentMail'
import { assertGrantUsable, authenticateGrant, redeemGrant, type RedeemedGrant } from './services/grants'
import { refreshSavePermission } from './services/savePermissions'
import { auditYoloCommand, authorizeYoloCommand, type YoloCommandAdmission } from './services/yoloCommands'
import type { FsAdapter, GitAdapter, RepoLayout } from './repo/types'
import { parseInput } from './schemas'
import { completeSavedRevision, previewSavedRevision } from './services/plans'
import { endSession, registerSession, touchSession } from './services/sessions'
import { COMMAND_SCHEMAS } from './commandSchemas'

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
  /** Pure Node authenticated naming transport; defaults to the hosted terminal environment. */
  desktopClient?: DesktopClient
  /** Pure Node authenticated browser transport (`DM_BROWSER_PIPE`); defaults to the hosted terminal environment. */
  browserClient?: BrowserClient
  pid?: number | null
  clock?: Clock
  ids?: IdGenerator
  fs?: FsAdapter
  /** The local database's synchronous setting (default 'full'); see `OpenDatabaseOptions.synchronous`. Tests only. */
  databaseSynchronous?: 'full' | 'off'
  /** One-shot CLI process progress while waiting for the project writer. */
  onWriterBusy?: () => void
  /** Measurement only: reports each depth-0 write transaction's lock hold; see `OpenDatabaseOptions.onTransaction`. */
  onTransaction?: TransactionObserver
  git?: GitAdapter
  /**
   * Builds the adapter for a child repository of a folder of repositories, given its checked real path
   * (default `createGitAdapter` with this session's filesystem). For tests, as `git` is for the root.
   */
  gitAt?: (root: string) => GitAdapter
  /** Reconcile tracked records on open and on heartbeat (default true). */
  autoReconcile?: boolean
  /** The desktop owner reconciles on its sync lane after opening: open neither reconciles nor flushes first. */
  deferOpenReconcile?: boolean
  /** Who serves this session. `packaged` is true only for the installed app; missing means false. */
  serverInfo?: { name: string; version: string; packaged?: boolean }
  /**
   * Internal: the restricted mailbox-poll mode the `dm` CLI selects for own identity and mailbox status reads.
   * It needs the `cli` transport and a grant bound to an open mailbox here; it reuses
   * the binding's one dedicated poll session instead of registering a session per call, skips record reconcile,
   * portable flush and staged-image pruning, and refuses every other command before dispatching it. Migration and
   * the current grant and binding are still checked on every call.
   */
  mailPoll?: boolean
  /** Internal CLI peer discovery only: ephemeral authenticated authority, no session/audit or record maintenance writes. */
  mailRead?: boolean
}

/** One repository opened by one session. Implements the full command contract. */
export interface Workspace extends CommandApi {
  exportForge?(member: string, mode?: StorageMode, options?: ForgeExportOptions): void
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
  /** The open store's core context, for a read the desktop serves outside the command table (`dm-attachment:`). Throws when no store is open. */
  ctx(): Ctx
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
 * How to recover from a database that belongs to another project. In either mode the database holds data nothing else
 * can rebuild: in `db` mode the whole project, in `repo` mode the local agent mail (and unsaved local state) that the
 * tracked records never carry. So the advice is never to delete it: back it up or move it aside first.
 */
function mismatchAdvice(layout: RepoLayout): string {
  if (layout.mode === 'repo') {
    return `The local database in ${layout.localDir} belongs to a different project than ${layout.projectFile}. It holds local-only data, such as agent mail, that tracked records cannot rebuild, so do not delete it: move ${layout.localDir} aside (or copy it somewhere safe) before reopening the project to rebuild it from tracked records, or restore the project.json that belongs to it.`
  }
  return `The database in ${layout.localDir} belongs to a different project than ${layout.projectFile}. It is the only copy of that project's work, so do not delete it: move the whole project directory aside, or restore the project.json that belongs to it.`
}

/** A CLI session that presented no grant: it observes, and changes nothing. */
const UNGRANTED_CLI_CAPABILITIES: readonly Capability[] = ['read']

/** Ordinary CLI opens, commands and audit closure share one lock-wait deadline below the native client's 60 s cap. */
const CLI_SQLITE_CONTENTION_TIMEOUT_MS = 10_000

function bindProject(db: Db, layout: RepoLayout, project: ProjectRecord): void {
  const known = getMeta(db, META_KEYS.projectId)
  if (known !== null && known !== project.projectId) {
    fail('project_mismatch', mismatchAdvice(layout), { databaseProjectId: known, projectId: project.projectId, localDir: layout.localDir })
  }
  if (known === project.projectId && getMeta(db, META_KEYS.projectName) === project.name && getMeta(db, META_KEYS.keyPrefix) === project.keyPrefix) {
    // Already bound and current: no write transaction on every open.
    return
  }
  db.tx(() => {
    setMeta(db, META_KEYS.projectId, project.projectId)
    setMeta(db, META_KEYS.projectName, project.name)
    setMeta(db, META_KEYS.keyPrefix, project.keyPrefix)
  })
}

/** The hosted terminal environment, with this CLI session's grant as the pipes' credential. */
function controlEnv(options: OpenWorkspaceOptions): Readonly<Record<string, string | undefined>> {
  return options.grantToken === undefined ? process.env : { ...process.env, DM_SESSION_TOKEN: options.grantToken }
}

/** Exported for tests that need the core itself (e.g. `gitFor`); everything else opens a `Workspace`. */
function workspaceDesktopClient(options: OpenWorkspaceOptions): DesktopClient {
  return options.desktopClient ?? createDesktopClient({ env: controlEnv(options) })
}

/**
 * The desktop client a workspace starts with. A mailbox poll needs the `dm` CLI and a grant, and never names a chat,
 * so it starts with none (built on first use, which a poll never makes).
 */
function initialDesktopClient(options: OpenWorkspaceOptions): DesktopClient | null {
  if (options.mailPoll !== true && options.mailRead !== true) {
    return workspaceDesktopClient(options)
  }
  if (options.transport !== 'cli' || options.grantToken === undefined) {
    fail('unauthorized', 'Restricted mailbox access needs the dm CLI and a grant bound to this chat’s mailbox.')
  }
  return null
}

function workspaceRoots(options: OpenWorkspaceOptions, fs: FsAdapter, home: string) {
  const source = options.transport === 'stdio'
    ? findRepositoryRoot(options.repoRoot, fs, home)
    : canonicalRoot(options.repoRoot, fs)
  assertForgeTransferIdle(fs, home, source)
  const repoRoot = boundForgeRoot(fs, home, source)
  const boundCodeRoot = source === repoRoot ? undefined : source
  return { repoRoot, boundCodeRoot, forgeCodeMember: boundCodeRoot !== undefined || isForgeCodeMember(fs, repoRoot) }
}

export class RepositoryWorkspace implements WorkspaceCore {
  /** Built at construction, except for a mailbox poll, which never names a chat and so never needs one. */
  private builtDesktopClient: DesktopClient | null

  get desktopClient(): DesktopClient {
    this.builtDesktopClient ??= workspaceDesktopClient(this.options)
    return this.builtDesktopClient
  }

  /** Built on first use: only the `browser_*` commands reach the browser pipe. */
  private builtBrowserClient: BrowserClient | null = null

  get browserClient(): BrowserClient {
    this.builtBrowserClient ??= this.options.browserClient ?? createBrowserClient({ env: controlEnv(this.options) })
    return this.builtBrowserClient
  }

  readonly repoRoot: string
  readonly homeDir: string
  /** Re-resolved when `initialize` sets the folder up in a mode other than the one it resolved to. */
  layout: RepoLayout
  readonly fs: FsAdapter
  readonly git: GitAdapter
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly options: OpenWorkspaceOptions

  get transport(): OpenWorkspaceOptions['transport'] {
    return this.options.transport
  }
  private store: Store | null = null
  private readonly forgeEpoch: string | null
  private readonly boundCodeRoot: string | undefined
  private readonly forgeCodeMember: boolean
  private readonly commandContext = new AsyncLocalStorage<Ctx>()
  /** What the presented grant conferred, or null for a session that presented none. */
  private granted: RedeemedGrant | null = null
  /** Validation metadata retained across reconciles of this workspace. */
  private readonly fileHashes = createFileHashCache()
  readonly recordStatus = createRecordStatusCache()
  /** Adapters `gitFor` opened, by child repository name. */
  private readonly childGits = new Map<string, GitAdapter>()

  constructor(options: OpenWorkspaceOptions) {
    this.options = options
    this.builtDesktopClient = initialDesktopClient(options)
    this.fs = options.fs ?? nodeFs
    this.homeDir = options.homeDir ?? resolveHomeDir(process.env, homedir())
    // Always canonical: a database-only project is keyed by this path, so two spellings of one
    // folder must never resolve to two projects (or to none, which would set the checkout up).
    const roots = workspaceRoots(options, this.fs, this.homeDir)
    this.repoRoot = roots.repoRoot
    this.boundCodeRoot = roots.boundCodeRoot
    this.forgeCodeMember = roots.forgeCodeMember
    this.forgeEpoch = forgeBindingEpoch(this.fs, this.homeDir, this.repoRoot)
    if (options.mailRead === true) assertStorageMigrationIdle({ repoRoot: this.repoRoot, homeDir: this.homeDir, fs: this.fs })
    else recoverStorageMigration({ repoRoot: this.repoRoot, homeDir: this.homeDir, fs: this.fs })
    this.layout = this.layoutFor(options.mode ?? this.resolvedMode())
    this.git = options.git ?? createGitAdapter(this.repoRoot, { fs: this.fs })
    this.clock = options.clock ?? createSystemClock()
    this.ids = options.ids ?? createIdGenerator(() => this.clock.nowMs())
    if (this.fs.exists(this.layout.projectFile)) {
      this.openStore()
    } else if (this.canRestoreSqliteSettings()) {
      // The checked-out settings carry the previous setup decision. The clone needs only its local ticket database.
      this.initialize({ mode: 'db' })
    }
  }

  private isDesktopSession(): boolean {
    return this.options.transport === 'desktop' && this.options.role === 'desktop'
  }

  private canRestoreSqliteSettings(): boolean {
    return this.isDesktopSession() &&
      this.layout.mode === 'db' && Boolean(portablePolicy(this))
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
    return capabilitiesForRole(this.options.role, { allowSave: this.options.allowSave ?? this.options.role === 'orchestrator' })
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
    return this.options.mailRead === true ? null : this.store?.ctx.session.id ?? null
  }

  project(): ProjectRecord {
    return this.requireStore().project
  }

  db(): Db | null {
    return this.store?.db ?? null
  }

  ctx(): Ctx {
    this.assertCurrentStorage()
    return this.commandContext.getStore() ?? this.requireStore().ctx
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

  private assertForgeStorage(): void {
    assertForgeStorage(this.fs, this.homeDir, this.repoRoot, this.forgeEpoch)
  }

  private assertCurrentStorage(): void {
    this.assertForgeStorage()
    assertStorageMigrationIdle({ repoRoot: this.repoRoot, homeDir: this.homeDir, fs: this.fs })
    if (this.store !== null && this.resolvedMode() !== this.layout.mode) {
      fail('conflict', 'This folder’s storage mode changed in another session. Close and reconnect this session before continuing.')
    }
  }

  private requireStore(): Store {
    this.openIfReady()
    this.assertCurrentStorage()
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
    // A poll only ever opens the existing database its grant was bound in, so it never creates the local directory.
    const restricted = this.options.mailPoll === true || this.options.mailRead === true
    if (!restricted) {
      this.fs.mkdirp(this.layout.localDir)
    }
    const db = this.openProjectDatabase(restricted)
    try {
      this.store = this.createStore(db, project)

      // Staged images nobody claimed within the retention window are dropped each time a workspace opens; a mailbox
      // poll, which runs every few seconds and touches nothing else, leaves that to ordinary sessions.
      if (!restricted) {
        pruneStagedAttachments(this.store.ctx)
      }
      this.finishOpen()
    } catch (error: unknown) {
      this.store = null
      db.close()
      throw error
    }
  }

  private openProjectDatabase(restricted: boolean): Db {
    return openDatabase(this.layout.dbFile, {
      synchronous: this.options.databaseSynchronous ?? 'full', readOnly: this.options.mailRead === true,
      ...(this.options.onTransaction ? { onTransaction: this.options.onTransaction } : {}),
      ...(this.transport === 'cli' && this.options.onWriterBusy
        ? { onWriterBusy: this.options.onWriterBusy, busyTimeoutMs: 500 }
        : this.transport === 'cli' && !restricted ? { contentionTimeoutMs: CLI_SQLITE_CONTENTION_TIMEOUT_MS } : {})
    })
  }

  private finishOpen(): void {
    if (this.options.mailPoll === true || this.options.mailRead === true || (this.isDesktopSession() && this.options.deferOpenReconcile === true)) return
    // A branch that moved while closed is never acknowledged silently: reconcile stays explicit.
    // A db project has nothing tracked to reconcile at all.
    if (this.layout.mode === 'repo' && this.options.autoReconcile !== false && !this.branchChanged()) {
      this.reconcile(true)
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
    db = guardTransactions(db, () => this.assertForgeStorage())
    if (this.options.mailRead === true) {
      if (readSchemaVersion(db) !== SCHEMA_VERSION) fail('incompatible_schema', 'Open the project in the desktop app to update its database before listing peers.')
      if (getMeta(db, META_KEYS.projectId) !== project.projectId) fail('project_mismatch', mismatchAdvice(this.layout))
    } else {
      migrate(db)
      bindProject(db, this.layout, project)
    }
    if (this.isDesktopSession()) recoverSqlitePolicy(this, db)
    const machineId = this.machineIdFor(db)
    if (getMeta(db, META_KEYS.machineId) !== machineId) {
      db.tx(() => setMeta(db, META_KEYS.machineId, machineId))
    }
    // Grant use and its session audit commit together under the ordinary session writer lock.
    const grantSession = this.options.mailPoll === true || (this.options.transport === 'cli' && this.options.grantToken !== undefined)
    // A peer reader authenticates inside the same snapshot as its command, never by creating an audit session.
    const session: SessionContext = this.options.mailRead === true
      ? { id: this.ids.next('session'), role: 'reader', label: this.options.label, capabilities: new Set() }
      : grantSession ? db.tx(() => this.openSession(db, machineId)) : this.openSession(db, machineId)
    const ctx: Ctx = {
      db,
      clock: this.clock,
      ids: this.ids,
      session,
      machineId,
      projectId: project.projectId,
      projectRoot: this.repoRoot,
      assertBranch: () => this.assertBranch(),
      checkout: () => this.checkout(),
      gitFor: (repo) => this.gitFor(repo),
      deliveryStandards: () => {
        const current = readProject(this.layout, this.fs) ?? fail('not_initialized', 'Project configuration is unavailable.')
        return policyForStore(this.layout, db, current, this.fs)
      },
      definitionOfDone: () => this.definitionOfDone(),
      repositories: () => readProject(this.layout, this.fs)?.repositories?.map((entry) => entry.name) ?? null,
      repositoryEntries: () => readProject(this.layout, this.fs)?.repositories ?? null
    }
    return { db, project, ctx }
  }

  private openPeerReader(db: Db, machineId: string): SessionContext {
    const token = this.options.grantToken
    if (token === undefined) fail('unauthorized', 'Peer discovery needs an authenticated CLI grant.')
    this.granted = authenticateGrant({ db, clock: this.clock, machineId }, token)
    return {
      id: this.ids.next('session'), role: this.granted.role, label: this.options.label,
      capabilities: new Set(this.granted.capabilities.filter((capability) => capability === 'mail.use')),
      mailRead: { grantId: this.granted.grantId }
    }
  }

  /**
   * This machine's id. An ordinary open reads (and on first use creates) `local/machine.json`; a mailbox poll takes
   * the copy every ordinary open records in the database beside it, and reads the file only when there is none.
   */
  private machineIdFor(db: Db): string {
    if (this.options.mailRead === true) {
      return getMeta(db, META_KEYS.machineId) ?? fail('unauthorized', 'Peer discovery requires an existing local mailbox database.')
    }
    const recorded = this.options.mailPoll === true ? getMeta(db, META_KEYS.machineId) : null
    return recorded ?? ensureMachineId({ layout: this.layout, fs: this.fs, ids: this.ids, clock: this.clock })
  }

  /**
   * Redeems the grant, then registers a fresh session row for an ordinary open; for a mailbox poll, maps the binding's
   * one dedicated poll session, re-checked under the write lock so concurrent polls never create a second one.
   */
  private openSession(db: Db, machineId: string): SessionContext {
    this.redeem(db, machineId)
    if (this.options.mailPoll === true) {
      if (this.granted === null) {
        fail('unauthorized', 'Mailbox polling needs a grant bound to this chat’s mailbox.')
      }
      return openMailPollSession({ db, clock: this.clock, ids: this.ids, machineId, projectRoot: this.repoRoot }, this.granted)
    }
    return registerSession(
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
  }

  /** The checks `project.json` holds now: read from the file each time, never from the copy read at open. */
  definitionOfDone(): DefinitionOfDoneCheck[] {
    return readProject(this.layout, this.fs)?.definitionOfDone ?? []
  }

  checkout(): { branch: string | null; commit: string | null } {
    const head = this.git.head()
    return { branch: head?.branch ?? null, commit: head?.commit ?? null }
  }

  /**
   * The code adapter for a named child repository, this Forge project's code checkout, or an ordinary repository.
   * Revalidate the mapping on every request, including when reusing a previously opened adapter. Ticket checkout
   * state and portable files continue to use `this.git`.
   */
  gitFor(repo: string | null): GitAdapter {
    if (repo === null) {
      return this.forgeCodeMember || isForgeCodeMember(this.fs, this.repoRoot) ? this.forgeVerificationGit() : this.git
    }
    const path = this.childRepositoryPath(repo)
    let git = this.childGits.get(repo)
    if (git === undefined) {
      git = this.options.gitAt?.(path) ?? createGitAdapter(path, { fs: this.fs })
      this.childGits.set(repo, git)
    }
    return git
  }

  private forgeVerificationGit(): GitAdapter {
    try {
      const checked = forgeCodeCheckout(this.repoRoot, this.homeDir, this.boundCodeRoot)
      const git = this.options.gitAt?.(checked.root) ?? createGitAdapter(checked.root, { fs: this.fs })
      return {
        ...git,
        assertCurrent: () => {
          try {
            checked.assertCurrent()
          } catch {
            fail('conflict', 'The Forge World code checkout or its mapping changed during verification. Reconnect and verify the delivery again.')
          }
        }
      }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      return fail('invalid_input', `Cannot verify code delivery for this Forge World project. ${reason} Reconnect its local code checkout in Dark Mechanicus.`)
    }
  }

  /** Refuses `repo` unless `project.json`, as it is now (so a rescan behind this session applies), lists it present. */
  private assertListedRepository(repo: string): void {
    const entry = readProject(this.layout, this.fs)?.repositories?.find((candidate) => candidate.name === repo)
    if (entry === undefined) {
      fail('invalid_input', `${JSON.stringify(repo)} is not a repository of this project.`, { repository: repo })
    }
    if (entry.missing === true) {
      fail('invalid_input', `Repository ${JSON.stringify(repo)} is missing from ${this.repoRoot}.`, { repository: repo })
    }
  }

  /**
   * The real path of child repository `repo`: listed and present, and `<root>/<repo>` a directory that is not a
   * link and whose real parent is the real project root, so nothing reaches outside the folder through `..`,
   * separators or links.
   */
  private childRepositoryPath(repo: string): string {
    this.assertListedRepository(repo)
    const shown = JSON.stringify(repo)
    const path = join(this.repoRoot, repo)
    if (this.fs.isSymlink(path)) {
      fail('unsafe_path', `Repository ${shown} is a link, not a folder inside ${this.repoRoot}.`, { repository: repo })
    }
    if (!this.fs.exists(path)) {
      fail('invalid_input', `Repository ${shown} is missing from ${this.repoRoot}.`, { repository: repo })
    }
    const real = this.realPathOf(path)
    if (real === null || dirname(real) !== this.realPathOf(this.repoRoot)) {
      fail('unsafe_path', `Repository ${shown} does not resolve to a folder directly inside ${this.repoRoot}.`, {
        repository: repo
      })
    }
    // Without its own `.git`, Git would search upward from the child and could open a repository around the folder.
    if (!this.fs.isDirectory(real) || !this.fs.exists(join(real, '.git'))) {
      fail('invalid_input', `Repository ${shown} is not a Git repository folder.`, { repository: repo })
    }
    return real
  }

  private realPathOf(path: string): string | null {
    try {
      return this.fs.realpath(path)
    } catch {
      return null
    }
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
  initialize(input: { name?: string; keyPrefix?: string; mode?: StorageMode; layout?: ProjectLayout }): InitializeResultView {
    // A folder of repositories is stored in the database only, so that is its default mode.
    const mode = input.mode ?? (input.layout === 'multi_repo' ? 'db' : undefined)
    const target = mode === undefined ? this.layout : this.layoutFor(mode)
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

  async switchStorageMode(mode: StorageMode): Promise<{ mode: StorageMode; projectDir: string; cleanupPending: boolean }> {
    const store = this.requireStore()
    if (isForgeMember(this.fs, this.repoRoot)) fail('conflict', 'Use Ticket source control to move a Forge World project.')
    return switchStorage(this.migrationDeps(store), mode)
  }

  exportForge(member: string, mode: StorageMode = 'repo', options?: ForgeExportOptions): void {
    if (this.transport !== 'desktop') fail('unauthorized', 'Forge conversion requires the desktop app.')
    exportForgeDestination(this.migrationDeps(this.requireStore()), member, mode, options)
  }

  private migrationDeps(store: Store) {
    return {
      repoRoot: this.repoRoot, homeDir: this.homeDir, fs: this.fs,
      ctx: store.ctx,
      db: store.db, layout: this.layout, git: this.git, clock: this.clock, sessionId: store.ctx.session.id,
      detach: () => { store.db.close() },
      attach: (layout: RepoLayout, db: Db) => {
        this.layout = layout
        store.db = guardTransactions(db, () => this.assertForgeStorage())
        store.ctx.db = store.db
      }
    }
  }

  /**
   * Reconciles the tracked records. An automatic reconcile (open, heartbeat) is skipped while the
   * inputs are those of the last clean reconcile (`reconcileFingerprint.ts`), and otherwise reads
   * only the records git reports as changed (`reconcileScope.ts`); an explicit one (the
   * `reconcile_repository` command, the desktop's Reconcile, Forge validation) always reads
   * everything. Either records the fingerprint and the git marker for the next session.
   */
  reconcile(automatic = false): ReconcileResultView {
    const store = this.requireStore()
    return tagTransactions('reconcile', () => reconcileRepository({
      db: store.db,
      layout: this.layout,
      fs: this.fs,
      clock: this.clock,
      machineId: store.ctx.machineId,
      git: this.git,
      sessionId: store.ctx.session.id,
      fileHashes: this.fileHashes
    }, reconcileGate({ db: store.db, layout: this.layout, fs: this.fs, git: this.git }, automatic), { full: !automatic }))
  }

  /** An explicit flush (the default) retries every waiting entry at once; `scheduled` leaves failed ones in backoff. */
  flush(scope?: FlushScope, mode: FlushMode = 'explicit'): FlushResultView {
    const store = this.requireStore()
    // Pending exports belong to the recorded branch; never write them into another checkout.
    this.assertBranch()
    const outcome = tagTransactions('flush', () => flushOutbox(
      { db: store.db, layout: this.layout, fs: this.fs, clock: this.clock },
      {
        onSnapshotSaved: (revisionId) => completeSavedRevision(store.ctx, revisionId),
        previewSavedRevision: (revisionId) => previewSavedRevision(store.ctx, revisionId)
      },
      scope,
      mode
    ))
    return { flushed: outcome.flushed, failed: outcome.failed, errors: outcome.errors }
  }

  /** Flush after a committed mutation; failures stay recorded in the outbox and are retried after their backoff. */
  safeFlush(): void {
    try {
      this.flush(undefined, 'scheduled')
    } catch {
      // The outbox keeps the entry pending with its error; storage status surfaces it.
    }
  }

  heartbeat(): void {
    if (this.options.mailPoll === true || this.options.mailRead === true) {
      fail('unauthorized', 'A restricted mailbox session has no heartbeat.')
    }
    this.assertCurrentStorage()
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
      this.reconcile(true)
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

  private async runElevated(ctx: Ctx, admission: YoloCommandAdmission, run: () => unknown): Promise<unknown> {
    auditYoloCommand(ctx, admission, 'admitted')
    const capabilities = new Set(ctx.session.capabilities)
    for (const capability of admission.capabilities) capabilities.add(capability)
    const scoped = { ...ctx, session: { ...ctx.session, capabilities } }
    try {
      const result = await this.commandContext.run(scoped, run)
      auditYoloCommand(ctx, admission, 'succeeded')
      return result
    } catch (error) {
      auditYoloCommand(ctx, admission, 'failed')
      throw error
    }
  }

  private async runCommand(name: CommandName, input: unknown, run: () => unknown): Promise<unknown> {
    const ctx = this.store?.ctx
    const grantId = this.granted?.grantId
    if (ctx === undefined || grantId === undefined) return run()
    const admission = await authorizeYoloCommand(ctx, grantId, name, input)
    return admission === null ? run() : this.runElevated(ctx, admission, run)
  }

  async execute(name: CommandName, rawInput: unknown): Promise<unknown> {
    if (this.options.mailRead === true) return this.executePeerRead(name, rawInput)
    if (this.options.mailPoll === true) {
      return this.executePoll(name, rawInput)
    }
    return this.executeOrdinary(name, rawInput)
  }

  private async executeOrdinary(name: CommandName, rawInput: unknown): Promise<unknown> {
    const spec = COMMANDS[name]
    // Untrusted input is validated before anything else, whatever state the repository is in.
    const input = spec.schema ? parseInput(spec.schema, rawInput ?? {}, `${name} input`) : undefined
    this.assertCurrentStorage()
    if (!spec.beforeInit) {
      this.requireStore()
    }
    this.assertStillGranted()
    if (this.store !== null) refreshSavePermission(this.store.ctx)
    const run = spec.run as (core: WorkspaceCore, input: unknown) => unknown
    const result = await tagTransactions('command', () => this.runCommand(name, input, () => run(this, input)))
    if (spec.mutates && this.store) {
      this.safeFlush()
    }
    return result
  }

  private executePeerRead(name: CommandName, rawInput: unknown): unknown {
    if (name !== 'listAgentPeers') fail('unauthorized', 'A peer reader may only list agent peers.', { command: name })
    const input = parseInput(COMMAND_SCHEMAS.listAgentPeers, rawInput ?? {}, `${name} input`)
    const store = this.requireStore()
    return store.db.tx(() => {
      store.ctx.session = this.openPeerReader(store.db, store.ctx.machineId)
      return listAgentPeers(this.ctx(), input)
    }, 'read')
  }

  /**
   * A poll session runs only its own identity and status queries, refused before any other command's input is read.
   * The synchronous service query and the session's last-seen mark commit together; nothing is flushed.
   */
  private executePoll(name: CommandName, rawInput: unknown): unknown {
    if (!MAIL_POLL_COMMANDS.includes(name)) {
      fail('unauthorized', 'A mailbox poll session may only read its own identity or mailbox status.', { command: name })
    }
    const spec = COMMANDS[name]
    const input = spec.schema ? parseInput(spec.schema, rawInput ?? {}, `${name} input`) : undefined
    const store = this.requireStore()
    this.assertStillGranted()
    const run = spec.run as (core: WorkspaceCore, input: unknown) => unknown
    // The store was required (and its storage checked) above, so the command's `ctx()` is served it without requiring it again.
    return store.db.tx(() => {
      const result = this.commandContext.run(store.ctx, () => run(this, input))
      touchMailPollSession({ db: store.db, clock: this.clock }, store.ctx.session.id)
      return result
    })
  }

  close(): void {
    const store = this.store
    if (!store) {
      return
    }
    this.store = null
    try {
      // A poll session is shared by every poll of its binding: closing one poll never ends it.
      if (this.options.mailPoll !== true && this.options.mailRead !== true && this.resolvedMode() === this.layout.mode) {
        this.endCurrentSession(store)
      }
    } finally {
      store.db.close()
    }
  }

  private endCurrentSession(store: Store): void {
    try { endSession({ db: store.db, clock: this.clock }, store.ctx.session.id) }
    catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error }
  }
}

export function openWorkspace(options: OpenWorkspaceOptions): Workspace {
  const core = new RepositoryWorkspace(options)
  const commands: Record<string, (input?: unknown) => Promise<unknown>> = {}
  for (const name of Object.keys(COMMANDS) as CommandName[]) {
    commands[name] = (input?: unknown) => core.execute(name, input)
  }
  const lifecycle = {
    exportForge: (member: string, mode?: StorageMode, options?: ForgeExportOptions) => core.exportForge(member, mode, options),
    repoRoot: core.repoRoot,
    sessionId: () => core.sessionId(),
    isInitialized: () => core.isInitialized(),
    heartbeat: () => core.heartbeat(),
    execute: (name: CommandName, input: unknown) => core.execute(name, input),
    ctx: () => core.ctx(),
    close: () => core.close()
  }
  return Object.assign(commands, lifecycle) as unknown as Workspace
}
