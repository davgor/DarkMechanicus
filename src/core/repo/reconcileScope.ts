/**
 * Which records a reconcile reads, and the marker it leaves for the next one.
 *
 * A reconcile asks git what changed since the commit the last one recorded (`trackedChanges`), and re-reads besides:
 * - records this database exported since the last reconcile (an export written and reverted in between leaves git
 *   nothing to report, while the recorded hash no longer matches the file);
 * - records holding a stored conflict;
 * - the paths the last reconcile left unsettled: rejected, in conflict, or waiting on another record (a run whose epic
 *   was refused, a comment whose epic is not here yet). These are stored with the paths `git status` reported in
 *   `reconcile_dirty_paths`, so they are re-read until they settle, like an uncommitted change.
 *
 * Anything else falls back to reading every record (`full`), exactly as before this marker existed.
 */
import type { Db } from '../db/database'
import { getMeta, META_KEYS, RECONCILE_DIRTY_PATHS_LIMIT, readReconcileMarker, setMeta } from '../meta'
import { IMPORTER_VERSION, type RecheckRecords, type TrackedChanges, trackedChanges } from './gitChanges'
import type { GitAdapter, GitStatusPaths } from './types'

/** Why every record is read although git could have said what changed. */
type ScopeFullReason =
  /** The caller asked for a full reconcile (the desktop's explicit Reconcile, Forge validation, tests). */
  | 'requested'
  /** An epic or Kanban card was deleted here since the last reconcile: a restored folder must come back as a full read brings it. */
  | 'record_deleted'

type ScopeChanges = TrackedChanges | { kind: 'full'; reason: ScopeFullReason }

/** What one reconcile reads, and what the status it started from said (null when git could not say). */
export interface ReconcileScope {
  changes: ScopeChanges
  /** The commit HEAD named when the status was taken; null when unborn or unknown. */
  head: string | null
  /** The paths the status reported (relative to `.darkmechanicus/`), without ignored and machine-local ones. */
  statusPaths: string[] | null
}

/** Paths the next reconcile never needs: ignored by git, or below folders no reconcile reads. */
function worthRecording(change: { status: string; path: string }): boolean {
  return change.status !== '!' && !change.path.startsWith('local/') && !change.path.startsWith('knowledge/')
}

type RecheckKey = 'epics' | 'runs' | 'kanbanCards' | 'profiles'

interface RecheckRow {
  kind: string
  epic_id: string | null
  run_id: string | null
  entity_id: string | null
  card_id: string | null
}

/** Which record a stored conflict or an export of each kind names (`sync_state` and `outbox` kinds). */
const RECHECK_TARGETS: Record<string, (row: RecheckRow) => { key: RecheckKey; id: string | null } | 'projectObservations'> = {
  epic: (row) => ({ key: 'epics', id: row.epic_id }),
  snapshot: (row) => ({ key: 'epics', id: row.epic_id }),
  epic_state: (row) => ({ key: 'epics', id: row.epic_id }),
  comment: (row) => ({ key: 'epics', id: row.epic_id }),
  run: (row) => ({ key: 'runs', id: row.run_id }),
  run_history: (row) => ({ key: 'runs', id: row.run_id }),
  profile: (row) => ({ key: 'profiles', id: row.entity_id }),
  kanban_card: (row) => ({ key: 'kanbanCards', id: row.card_id }),
  kanban_event: (row) => ({ key: 'kanbanCards', id: row.card_id }),
  metric_observation: (row) => (row.epic_id === null ? 'projectObservations' : { key: 'epics', id: row.epic_id })
}

/**
 * Records to re-read whatever git says: every record holding a stored conflict (epic, run, comment, profile, Kanban
 * card or event), and every record exported since the last reconcile (`outbox.done_at`, written by the same clock as
 * `last_reconcile_at`; equal times count, so an export in the same millisecond is re-read).
 */
export function recheckRecords(db: Db): RecheckRecords {
  const since = getMeta(db, META_KEYS.lastReconcileAt) ?? ''
  const rows = db.all<RecheckRow>(
    `SELECT s.kind,
       CASE s.kind WHEN 'epic' THEN s.entity_id WHEN 'comment' THEN c.epic_id END AS epic_id,
       CASE s.kind WHEN 'run' THEN s.entity_id END AS run_id,
       s.entity_id,
       CASE s.kind WHEN 'kanban_card' THEN s.entity_id WHEN 'kanban_event' THEN e.card_id END AS card_id
     FROM sync_state s
     LEFT JOIN comments c ON s.kind = 'comment' AND c.id = s.entity_id
     LEFT JOIN kanban_events e ON s.kind = 'kanban_event' AND e.id = s.entity_id
     WHERE s.conflict IS NOT NULL
     UNION ALL
     SELECT o.kind, o.epic_id, o.run_id, o.entity_id,
       CASE o.kind WHEN 'kanban_card' THEN o.entity_id WHEN 'kanban_event' THEN e.card_id END AS card_id
     FROM outbox o
     LEFT JOIN kanban_events e ON o.kind = 'kanban_event' AND e.id = o.entity_id
     WHERE o.state = 'done' AND o.done_at >= ?`,
    since
  )
  const recheck = { epics: new Set<string>(), runs: new Set<string>(), kanbanCards: new Set<string>(), profiles: new Set<string>(), projectObservations: false }
  for (const row of rows) {
    const target = Object.hasOwn(RECHECK_TARGETS, row.kind) ? RECHECK_TARGETS[row.kind]?.(row) ?? null : null
    if (target === 'projectObservations') {
      recheck.projectObservations = true
    } else if (target !== null && target.id !== null) {
      recheck[target.key].add(target.id)
    }
  }
  return recheck
}

/**
 * Whether an epic or a Kanban card was deleted here since the last reconcile. The deletion removes the rows, the sync
 * records and the folder together; a folder restored before the next reconcile leaves git nothing to report, while a
 * full read imports it again.
 */
function deletedSinceLastReconcile(db: Db): boolean {
  const since = getMeta(db, META_KEYS.lastReconcileAt) ?? ''
  return db.get("SELECT 1 FROM events WHERE kind IN ('epic.deleted', 'kanban.deleted') AND at >= ? LIMIT 1", since) !== undefined
}

function scopedChanges(deps: { db: Db; git: GitAdapter }, status: GitStatusPaths): ScopeChanges {
  if (deletedSinceLastReconcile(deps.db)) return { kind: 'full', reason: 'record_deleted' }
  const marker = readReconcileMarker(deps.db)
  const base = marker.baseCommit
  const head = status.ok ? status.head : null
  // Only asked when the marker names another commit than HEAD; `trackedChanges` decides on everything else.
  const moved = base !== null && head !== null && base !== head
  const isAncestor = moved ? deps.git.isAncestorSync(base, head) : null
  const diff = moved && isAncestor === true ? deps.git.diffPaths(base, head) : null
  return trackedChanges({
    marker,
    status,
    recordedBranch: getMeta(deps.db, META_KEYS.checkoutBranch),
    isAncestor,
    diff,
    recheck: recheckRecords(deps.db)
  })
}

/** Asks git once for the working tree, then decides which records this reconcile reads. */
export function reconcileScope(deps: { db: Db; git: GitAdapter }, full: boolean): ReconcileScope {
  const status = deps.git.statusPaths()
  const head = status.ok ? status.head : null
  const statusPaths = status.ok ? status.paths.filter(worthRecording).map((change) => change.path) : null
  const changes: ScopeChanges = full ? { kind: 'full', reason: 'requested' } : scopedChanges(deps, status)
  return { changes, head, statusPaths }
}

/** What the reconcile left unsettled, by record, plus the paths it rejected (as results show them). */
interface Unsettled {
  epics: Iterable<string>
  runs: Iterable<string>
  kanbanCards: Iterable<string>
  profiles: Iterable<string>
  rejectedPaths: Iterable<string>
  /** How results show `.darkmechanicus/` (`displayPath` of it), which rejected paths start with. */
  shownDmDir: string
}

/**
 * Paths (relative to `.darkmechanicus/`) the next reconcile re-reads until they settle. A rejected path outside
 * `.darkmechanicus/`, or one naming no record (a whole record folder), is kept as shown: the next reconcile then
 * reads everything, as it must to report that rejection again.
 */
export function unsettledPaths(unsettled: Unsettled): string[] {
  const prefix = `${unsettled.shownDmDir}/`
  return [
    ...[...unsettled.epics].map((id) => `epics/${id}`),
    ...[...unsettled.runs].map((id) => `history/${id}`),
    ...[...unsettled.kanbanCards].map((id) => `kanban/${id}`),
    ...[...unsettled.profiles].map((name) => `profiles/${name}.json`),
    ...[...unsettled.rejectedPaths].map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
  ]
}

const MARKER_KEYS = [META_KEYS.reconcileBaseCommit, META_KEYS.reconcileImporterVersion, META_KEYS.reconcileDirtyPaths]

/**
 * Records where the next reconcile starts: the commit the status saw, this importer's version, and the paths to re-read
 * (the status's and the unsettled ones). Called inside the apply's transaction, so a reconcile that throws leaves the
 * previous marker. Without a status (git failed, unborn HEAD) the marker is removed; over the path limit the list is,
 * and either way the next reconcile reads everything.
 */
export function writeReconcileMarker(db: Db, scope: ReconcileScope, unsettled: string[]): void {
  if (scope.head === null || scope.statusPaths === null) {
    db.run(`DELETE FROM meta WHERE key IN (${MARKER_KEYS.map(() => '?').join(', ')})`, ...MARKER_KEYS)
    return
  }
  const dirty = [...new Set([...scope.statusPaths, ...unsettled])].sort()
  setMeta(db, META_KEYS.reconcileBaseCommit, scope.head)
  setMeta(db, META_KEYS.reconcileImporterVersion, String(IMPORTER_VERSION))
  if (dirty.length > RECONCILE_DIRTY_PATHS_LIMIT) {
    db.run('DELETE FROM meta WHERE key = ?', META_KEYS.reconcileDirtyPaths)
  } else {
    setMeta(db, META_KEYS.reconcileDirtyPaths, JSON.stringify(dirty))
  }
}
