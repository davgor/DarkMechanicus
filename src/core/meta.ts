import type { Db } from './db/database'

/** Keys of the local `meta` table (machine-local, never exported). */
export const META_KEYS = {
  projectId: 'project_id',
  deliveryStandards: 'delivery_standards',
  projectName: 'project_name',
  keyPrefix: 'key_prefix',
  machineId: 'machine_id',
  /** Checkout branch recorded at the last reconcile; a different current branch means `branch_changed`. */
  checkoutBranch: 'checkout_branch',
  lastFlushAt: 'last_flush_at',
  lastReconcileAt: 'last_reconcile_at',
  /** Version of the portable attachment registration backfill completed in this database. */
  attachmentRegistration: 'attachment_registration',
  /** Digest of the conflicts and rejections the last reconcile reported; repeating them records no event. */
  reconcileProblems: 'reconcile_problems',
  /** The portable repository has completed a clean reconciliation into this database. */
  validatedRepositoryCache: 'validated_repository_cache',
  /** Inputs of the last clean reconcile (`reconcileFingerprint.ts`); open and heartbeat skip a reconcile while they hold. */
  reconcileFingerprint: 'reconcile_fingerprint',
  /** The commit HEAD named when the last reconcile read the records; a targeted reconcile diffs from it. */
  reconcileBaseCommit: 'reconcile_base_commit',
  /** `IMPORTER_VERSION` (`repo/gitChanges.ts`) of the reconcile that stored `reconcileBaseCommit`. */
  reconcileImporterVersion: 'reconcile_importer_version',
  /**
   * JSON list of the paths (relative to `.darkmechanicus/`) `git status` reported at that reconcile, and of the records
   * it left unsettled (rejected, in conflict, or waiting on another record; `reconcileScope.ts`): the next one re-reads
   * them even when a revert has made them clean again. At most `RECONCILE_DIRTY_PATHS_LIMIT` entries.
   */
  reconcileDirtyPaths: 'reconcile_dirty_paths'
} as const

/**
 * The most paths `reconcileDirtyPaths` holds. A reconcile that saw more stores no list, and a stored list
 * longer than this reads as missing: either way the next reconcile reads every record.
 */
export const RECONCILE_DIRTY_PATHS_LIMIT = 5_000

const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** What the last reconcile recorded for the next one to start from. Each part is null when missing or malformed. */
export interface ReconcileMarker {
  baseCommit: string | null
  importerVersion: number | null
  dirtyPaths: string[] | null
}

type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS]

export function getMeta(db: Db, key: MetaKey): string | null {
  return db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null
}

/** Upserts a meta value; call inside a transaction when it belongs to a larger mutation. */
export function setMeta(db: Db, key: MetaKey, value: string): void {
  db.run(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  )
}

function parseDirtyPaths(raw: string | null): string[] | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const valid = Array.isArray(value) && value.length <= RECONCILE_DIRTY_PATHS_LIMIT && value.every((path) => typeof path === 'string')
  return valid ? (value as string[]) : null
}

/** Reads the three reconcile marker keys; a malformed or over-limit value reads as null. */
export function readReconcileMarker(db: Db): ReconcileMarker {
  const commit = getMeta(db, META_KEYS.reconcileBaseCommit)
  const version = getMeta(db, META_KEYS.reconcileImporterVersion)
  return {
    baseCommit: commit !== null && COMMIT_PATTERN.test(commit) ? commit : null,
    importerVersion: version !== null && /^[1-9][0-9]{0,8}$/.test(version) ? Number(version) : null,
    dirtyPaths: parseDirtyPaths(getMeta(db, META_KEYS.reconcileDirtyPaths))
  }
}
