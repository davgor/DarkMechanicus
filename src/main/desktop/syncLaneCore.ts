/**
 * The sync lane's reconcile. It runs on its own connection to the project database, on the lane's own thread, so the
 * owner's thread keeps serving reads and writes while it imports: WAL lets one connection read while another writes.
 *
 * The lane reconciles as the owner's session on the owner's machine: it never registers a session of its own, so a
 * storage switch sees no extra session. Every write transaction checks the store's Forge binding under the writer lock,
 * as the owner's own connection does, and the owner re-checks the durable binding before admitting and after the result.
 */
import { createSystemClock } from '../../core/clock'
import { DomainError } from '../../core/errors'
import { guardTransactions, openDatabase, tagTransactions, type Db, type TransactionHold } from '../../core/db/database'
import { createFileHashCache, type FileHashCache } from '../../core/repo/fileHashes'
import { assertForgeStorage, forgeBindingEpoch, withForgeOwnerAuthority, type ForgeTransferAuthority } from '../../core/repo/forgeBinding'
import { createGitAdapter } from '../../core/repo/git'
import { branchState, reconcileRepository } from '../../core/repo/importer'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { reconcileGate } from '../../core/repo/reconcileFingerprint'
import { assertStorageMigrationIdle } from '../../core/repo/storageMigration'
import { resolveStorageMode } from '../../core/repo/storageMode'
import type { GitAdapter, RepoLayout } from '../../core/repo/types'
import { hasValidatedRepositoryCache } from '../../core/repo/validatedCache'
import type { SyncMode, SyncValue } from './workspaceClient'

export interface LaneRequest {
  path: string
  home: string
  ownerPid: number
  mode: SyncMode
  authority: ForgeTransferAuthority | undefined
  /** The owner's open session and machine, which the reconcile is recorded as. */
  sessionId: string
  machineId: string
}

interface LaneStore {
  path: string
  layout: RepoLayout
  db: Db
  git: GitAdapter
  /** Validation metadata kept across this lane's reconciles, as a workspace keeps it across its own. */
  fileHashes: FileHashCache
  /**
   * With an observer: `db` and `nodeFs` counting body reads, made once per connection. The file-hash cache is scoped to
   * the connection it is given, so a wrapper made per reconcile would empty it and read every body again each time.
   */
  counted?: CountedStore
}

interface CountedStore { db: Db; fs: typeof nodeFs; reads: { prepared: number; locked: number } }

/**
 * Measurement only (the revamp harness): the lane's write-lock holds, as DM-959's `onTransaction` reports them, and per
 * reconcile the file bodies it read before and under its writer lock. A body read under the lock means the import's
 * lock-free preparation was not fresh and was run again inside the transaction.
 */
export interface LaneObserver {
  onTransaction(hold: TransactionHold): void
  onReconcile(row: { mode: SyncMode; ms: number; fileReads: { prepared: number; locked: number } }): void
}

/** The lane's open connection; kept between reconciles and released before the owner moves or replaces the store. */
export interface LaneState { store?: LaneStore; observer?: LaneObserver }

export function releaseLane(state: LaneState): void {
  const store = state.store
  delete state.store
  store?.db.close()
}

function openStore(state: LaneState, { path, home }: LaneRequest): LaneStore {
  const mode = resolveStorageMode({ repoRoot: path, homeDir: home, fs: nodeFs })
  const current = state.store
  if (current?.path === path && current.layout.mode === mode) return current
  releaseLane(state)
  const layout = resolveLayout(path, { mode, homeDir: home })
  // The owner opened and migrated this database before admitting the lane; the lane never creates one.
  if (!nodeFs.exists(layout.dbFile)) throw new DomainError('not_initialized', `${path} has no project database to reconcile.`)
  const epoch = forgeBindingEpoch(nodeFs, home, path)
  const observed = state.observer ? { onTransaction: state.observer.onTransaction } : {}
  const db = guardTransactions(openDatabase(layout.dbFile, observed), () => assertForgeStorage(nodeFs, home, path, epoch))
  const store: LaneStore = {
    path, layout, db, git: createGitAdapter(path, { fs: nodeFs }), fileHashes: createFileHashCache(),
    ...(state.observer ? { counted: countingBodyReads(db) } : {})
  }
  state.store = store
  return store
}

/**
 * One reconcile on the lane. A heartbeat is fingerprint-gated and skipped after a branch change, as the automatic
 * reconcile of open and heartbeat is; a member reconcile is gated and runs after a branch change; an explicit one is
 * ungated and full, as `reconcileRepository` is.
 */
export function reconcileOnLane(state: LaneState, request: LaneRequest): SyncValue {
  const { path, home, ownerPid, authority, mode } = request
  return withForgeOwnerAuthority({ home, ownerPid, path, authority }, () => {
    assertStorageMigrationIdle({ repoRoot: path, homeDir: home, fs: nodeFs })
    const store = openStore(state, request)
    const { db, layout, git, fileHashes, counted } = store
    const hasLocalCache = hasValidatedRepositoryCache(db)
    if (mode === 'heartbeat' && (layout.mode !== 'repo' || branchState(db, git.head()?.branch ?? null).changed)) {
      return { result: null, hasLocalCache }
    }
    const started = performance.now()
    if (counted) counted.reads = { prepared: 0, locked: 0 }
    const result = tagTransactions('reconcile', () => reconcileRepository({
      db: counted?.db ?? db, layout, fs: counted?.fs ?? nodeFs, clock: createSystemClock(), machineId: request.machineId, git, sessionId: request.sessionId, fileHashes
    }, reconcileGate({ db, layout, fs: nodeFs, git }, mode !== 'explicit'), { full: mode === 'explicit' }))
    if (counted) state.observer?.onReconcile({ mode, ms: performance.now() - started, fileReads: counted.reads })
    return { result, hasLocalCache }
  })
}

/**
 * `db` and `nodeFs`, counting into `reads` each file body read before or inside a write transaction of `db` (a read
 * snapshot does not hold the writer lock, so a read in one counts as prepared).
 */
function countingBodyReads(db: Db): CountedStore {
  let writing = 0
  const counted: CountedStore = { db, fs: nodeFs, reads: { prepared: 0, locked: 0 } }
  const count = () => { if (writing > 0) counted.reads.locked += 1; else counted.reads.prepared += 1 }
  const tracked: Db = {
    path: db.path,
    get: db.get.bind(db), all: db.all.bind(db), run: db.run.bind(db), exec: db.exec.bind(db),
    inTransaction: db.inTransaction.bind(db), close: db.close.bind(db),
    tx: (fn, mode) => {
      if (mode === 'read') return db.tx(fn, mode)
      writing += 1
      try {
        return db.tx(fn, mode)
      } finally {
        writing -= 1
      }
    }
  }
  counted.db = tracked
  counted.fs = {
    ...nodeFs,
    readFile: (path) => { count(); return nodeFs.readFile(path) },
    readFileBytes: (path) => { count(); return nodeFs.readFileBytes(path) }
  }
  return counted
}
