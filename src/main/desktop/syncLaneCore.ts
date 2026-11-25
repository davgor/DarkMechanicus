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
import { guardTransactions, openDatabase, type Db } from '../../core/db/database'
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
}

/** The lane's open connection; kept between reconciles and released before the owner moves or replaces the store. */
export interface LaneState { store?: LaneStore }

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
  const db = guardTransactions(openDatabase(layout.dbFile), () => assertForgeStorage(nodeFs, home, path, epoch))
  const store: LaneStore = { path, layout, db, git: createGitAdapter(path, { fs: nodeFs }), fileHashes: createFileHashCache() }
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
    const { db, layout, git, fileHashes } = store
    const hasLocalCache = hasValidatedRepositoryCache(db)
    if (mode === 'heartbeat' && (layout.mode !== 'repo' || branchState(db, git.head()?.branch ?? null).changed)) {
      return { result: null, hasLocalCache }
    }
    const result = reconcileRepository({
      db, layout, fs: nodeFs, clock: createSystemClock(), machineId: request.machineId, git, sessionId: request.sessionId, fileHashes
    }, reconcileGate({ db, layout, fs: nodeFs, git }, mode !== 'explicit'))
    return { result, hasLocalCache }
  })
}
