/**
 * Whether the inputs of an automatic reconcile are those of the last clean one, so opening a session or a heartbeat can
 * skip a full scan of the tracked records. A full reconcile reads every tracked file under the writer lock; on a large
 * project that took seconds per one-shot CLI process even when nothing had changed.
 *
 * The fingerprint has two parts:
 * - tracked: the fingerprint format and schema version, the storage mode, the real checkout root and Git HEAD (branch,
 *   commit, detached), and every entry under `.darkmechanicus/` except machine-local `local/`: its path and kind, and a
 *   regular file's stamp (size, mtime and ctime in nanoseconds, device and inode). An added, removed, renamed or
 *   rewritten file, or one replaced by a link or a folder, changes it.
 * - local: the machine-local state an apply reads besides the files: open outbox entries, sync state (recorded hashes
 *   and conflicts), pending plan revisions, open Linear transfers, the epics held here, attachment rows (owned, still
 *   without bytes or missing), the attachment registration backfill and the recorded checkout branch. Exports change
 *   files and sync state together; anything an older build writes to these tables or files changes the fingerprint too,
 *   and an older build never writes the fingerprint itself, so it cannot leave one that vouches for state it changed.
 *
 * The tracked part is read once, before the scan. Only a clean reconcile (no conflict, no rejection) records a
 * fingerprint; anything else clears it, so the next session reconciles in full. Storing the part read before the scan is
 * safe: the scan saw these files or newer ones, and a file that changed after the walk carries a new stamp, so the
 * next session's walk differs and it reconciles in full.
 */
import { createHash, type Hash } from 'node:crypto'
import { join, relative } from 'node:path'
import type { ReconcileResultView } from '../../shared/domain/views'
import { sha256Hex } from '../canonical'
import type { Db } from '../db/database'
import { SCHEMA_VERSION } from '../db/migrations'
import { getMeta, META_KEYS, setMeta } from '../meta'
import type { FsAdapter, GitAdapter, RepoLayout } from './types'

const FORMAT = 'darkmechanicus.reconcile-fingerprint/1'

interface FingerprintDeps {
  db: Db
  layout: RepoLayout
  fs: FsAdapter
  git: GitAdapter
  /** The database schema the fingerprint belongs to (default `SCHEMA_VERSION`); tests vary it. */
  schemaVersion?: number
}

/** How `reconcileRepository` consults the fingerprint; both run under the writer lock. */
export interface ReconcileGate {
  /** True when a session already reconciled these exact inputs cleanly: nothing is applied. */
  current(): boolean
  /** Records (or clears) the fingerprint for the result just applied. */
  applied(result: ReconcileResultView): void
}

function addTree(deps: FingerprintDeps, dir: string, hash: Hash): void {
  const { fs, layout } = deps
  for (const name of [...fs.readdir(dir)].sort()) {
    const path = join(dir, name)
    if (path === layout.localDir) continue
    const shown = relative(layout.dmDir, path)
    const stamp = fs.fileStamp(path)
    if (stamp !== null) {
      hash.update(`f\0${shown}\0${stamp}\n`)
    } else if (fs.isSymlink(path)) {
      hash.update(`l\0${shown}\n`)
    } else if (fs.isDirectory(path)) {
      hash.update(`d\0${shown}\n`)
      addTree(deps, path, hash)
    } else {
      hash.update(`o\0${shown}\n`)
    }
  }
}

/** The tracked part, or null when it cannot be read (the caller then reconciles in full). */
function trackedInputs(deps: FingerprintDeps): string | null {
  try {
    const { fs, layout } = deps
    if (fs.isSymlink(layout.dmDir) || !fs.isDirectory(layout.dmDir)) return null
    const hash = createHash('sha256')
    hash.update(JSON.stringify([FORMAT, deps.schemaVersion ?? SCHEMA_VERSION, layout.mode, fs.realpath(layout.root), deps.git.head()]))
    addTree(deps, layout.dmDir, hash)
    return hash.digest('hex')
  } catch {
    return null
  }
}

/** The tracked part joined with the machine-local state read in the same snapshot. */
function fingerprint(db: Db, tracked: string): string {
  const outbox = db.all<{ id: number; state: string }>("SELECT id, state FROM outbox WHERE state IN ('pending', 'failed') ORDER BY id")
  const counts = db.get<Record<string, number | string | null>>(`SELECT
    (SELECT count(*) FROM sync_state) AS synced,
    (SELECT max(updated_at) FROM sync_state) AS syncedAt,
    (SELECT count(*) FROM sync_state WHERE conflict IS NOT NULL) AS conflicts,
    (SELECT count(*) FROM plan_revisions WHERE state = 'pending') AS pendingPlans,
    (SELECT count(*) FROM transfers WHERE status IN ('queued', 'in_progress')) AS openTransfers,
    (SELECT count(*) FROM epics) AS epics,
    (SELECT count(*) FROM attachments WHERE owner_kind IS NOT NULL) AS owned,
    (SELECT count(*) FROM attachments WHERE data IS NULL OR missing = 1) AS unfilled,
    (SELECT coalesce(max(rowid), 0) FROM attachments) AS lastAttachment`)
  const meta = [getMeta(db, META_KEYS.checkoutBranch), getMeta(db, META_KEYS.attachmentRegistration)]
  const local = JSON.stringify([outbox.map((row) => `${row.id}:${row.state}`), counts, meta])
  return `${tracked}:${sha256Hex(local)}`
}

/**
 * Reads the tracked inputs now, before any scan. `current` compares them and the local state with the fingerprint the
 * last clean reconcile recorded, touching no table when the tracked part already differs; `applied` records the
 * fingerprint after a clean reconcile and clears it after any other.
 */
export function observeReconcileInputs(deps: FingerprintDeps): ReconcileGate {
  const tracked = trackedInputs(deps)
  return {
    current: () => {
      const stored = getMeta(deps.db, META_KEYS.reconcileFingerprint)
      return tracked !== null && stored !== null && stored.startsWith(`${tracked}:`) && stored === fingerprint(deps.db, tracked)
    },
    applied: (result) => {
      const clean = [result.conflicts, result.profileConflicts, result.kanbanConflicts, result.rejected].every((list) => list.length === 0)
      setMeta(deps.db, META_KEYS.reconcileFingerprint, tracked !== null && clean ? fingerprint(deps.db, tracked) : '')
    }
  }
}
