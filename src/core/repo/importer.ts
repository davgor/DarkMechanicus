/**
 * Reconcile / import: rebuilds and refreshes the local database from Git-tracked records.
 *
 * Every tracked file is untrusted: owned paths come from validated ids with containment checks,
 * records pass size / merge-marker / schema checks, snapshots are hash-verified and graph-validated,
 * and cross-file references are checked before anything is applied. All staged changes are applied
 * in one transaction (per-item savepoints), so a rejected epic or run never changes what the
 * database already holds, and drafts are never touched.
 */
import { join } from 'node:path'
import type { PlanBundle } from '../../shared/domain/bundle'
import { LEASED_ATTEMPT_STATES, OPEN_ATTEMPT_STATES } from '../../shared/domain/status'
import type { ReconcileResultView } from '../../shared/domain/views'
import { contentHash } from '../canonical'
import type { Clock } from '../clock'
import { type Db, parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { getMeta, META_KEYS, setMeta } from '../meta'
import { validatePlan } from '../plan/graph'
import { LIMITS } from '../schemas'
import { indexComment, indexDocument } from '../services/searchIndex'
import { readProject } from './initialize'
import { assertContained, displayPath, ownedPaths } from './paths'
import {
  type CommentRecord,
  commentRecord,
  type EpicPointerRecord,
  epicPointerRecord,
  type EpicStateRecord,
  epicStateRecord,
  MAX_COMMENT_RECORD_BYTES,
  parseRecord,
  type ProjectRecord,
  readCommentRecord,
  readOwnedText,
  type RunHistoryRecord,
  runHistoryRecord,
  type SnapshotRecord,
  snapshotRecord,
  trackedCommentHash,
  trackedEpicHash,
  trackedRunHash
} from './portable'
import type { FsAdapter, GitAdapter, RepoLayout } from './types'

export interface ImporterDeps {
  db: Db
  layout: RepoLayout
  fs: FsAdapter
  clock: Clock
  machineId: string
  git: GitAdapter
  sessionId?: string | null
}

type AttemptRecord = RunHistoryRecord['attempts'][number]

interface Rejection {
  path: string
  message: string
}

interface EpicFiles {
  epicId: string
  path: string
  pointer: EpicPointerRecord
  state: EpicStateRecord
  snapshots: SnapshotRecord[]
  trackedHash: string
}

interface RunFiles {
  runId: string
  path: string
  record: RunHistoryRecord
  trackedHash: string
}

interface CommentFiles {
  commentId: string
  epicId: string
  path: string
  record: CommentRecord
  trackedHash: string
}

/** Changed entities (parsed and validated) plus ids whose tracked files match the last sync. */
interface Scan {
  epics: EpicFiles[]
  runs: RunFiles[]
  /** Comment files not yet synced with this exact text (unchanged ones are not listed). */
  comments: CommentFiles[]
  unchanged: string[]
  rejected: Rejection[]
  /** Directory names under `epics/` whose records were rejected. */
  rejectedEpics: Set<string>
}

interface Conflict {
  kind: 'epic' | 'run' | 'comment'
  entityId: string
  epicId: string
  message: string
}

interface Plan {
  epics: EpicFiles[]
  runs: RunFiles[]
  /** New comments to insert. */
  comments: CommentFiles[]
  /** Files identical to comments already here: only their sync record is written. */
  syncedComments: CommentFiles[]
  unchanged: string[]
  conflicts: Conflict[]
  rejected: Rejection[]
}

const JSON_SUFFIX = '.json'
const MAX_SNAPSHOTS_PER_EPIC = 1_000
const MAX_SNAPSHOT_BYTES_PER_EPIC = 256 * 1024 * 1024

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reject(path: string, reason: string): never {
  return fail('import_rejected', `${path} ${reason}.`, { path })
}

/**
 * The checkout branch recorded at the last reconcile (stored as '' for "no branch") and whether
 * the current branch differs from it. Nothing recorded yet means nothing changed.
 */
export function branchState(db: Db, current: string | null): { recorded: string | null; changed: boolean } {
  const raw = getMeta(db, META_KEYS.checkoutBranch)
  const recorded = raw === '' ? null : raw
  return { recorded, changed: raw !== null && recorded !== current }
}

function requireProject(deps: ImporterDeps): ProjectRecord {
  const project = readProject(deps.layout, deps.fs)
  if (project === null) {
    fail('not_initialized', 'This repository has no .darkmechanicus/project.json. Initialize it first.')
  }
  const known = getMeta(deps.db, META_KEYS.projectId)
  if (known !== null && known !== project.projectId) {
    fail('project_mismatch', `Tracked project ${project.projectId} does not match this database's project ${known}.`, {
      expected: known,
      found: project.projectId
    })
  }
  return project
}

/** Entries of an owned directory (dotfiles ignored). A linked directory fails the whole reconcile. */
function listEntries(deps: ImporterDeps, dir: string): string[] {
  if (!deps.fs.exists(dir) && !deps.fs.isSymlink(dir)) {
    return []
  }
  assertContained(deps.layout, deps.fs, dir)
  return deps.fs
    .readdir(dir)
    .filter((name) => !name.startsWith('.'))
    .sort()
}

function requireText(deps: ImporterDeps, path: string): string {
  return readOwnedText(deps, path) ?? reject(displayPath(deps.layout, path), 'is missing')
}

function readSnapshot(deps: ImporterDeps, epicId: string, name: string): SnapshotRecord {
  const revisionId = name.slice(0, -JSON_SUFFIX.length)
  const file = ownedPaths(deps.layout).snapshotFile(epicId, revisionId)
  const shown = displayPath(deps.layout, file)
  const record = parseRecord(snapshotRecord, requireText(deps, file), shown)
  if (record.epicId !== epicId || record.revisionId !== revisionId) {
    reject(shown, 'names a different epic or revision than its path')
  }
  const report = validatePlan(record.bundle)
  if (!report.valid) {
    reject(shown, `holds an invalid plan: ${report.errors[0]?.message ?? 'unknown error'}`)
  }
  return record
}

/** Bounds the memory one epic's snapshots can take, checked from file sizes before any is read. */
function checkSnapshotBudget(deps: ImporterDeps, epicId: string, names: string[]): void {
  const paths = ownedPaths(deps.layout)
  let bytes = 0
  for (const name of names) {
    const file = paths.snapshotFile(epicId, name.slice(0, -JSON_SUFFIX.length))
    assertContained(deps.layout, deps.fs, file)
    bytes += Math.max(0, deps.fs.fileSize(file))
  }
  if (bytes > MAX_SNAPSHOT_BYTES_PER_EPIC) {
    reject(displayPath(deps.layout, paths.snapshotsDir(epicId)), 'holds more than 256 MiB of snapshots')
  }
}

function readSnapshots(deps: ImporterDeps, epicId: string): SnapshotRecord[] {
  const dir = ownedPaths(deps.layout).snapshotsDir(epicId)
  assertContained(deps.layout, deps.fs, dir)
  if (!deps.fs.isDirectory(dir)) {
    reject(displayPath(deps.layout, dir), 'is missing')
  }
  const names = deps.fs
    .readdir(dir)
    .filter((name) => name.endsWith(JSON_SUFFIX))
    .sort()
  if (names.length > MAX_SNAPSHOTS_PER_EPIC) {
    reject(displayPath(deps.layout, dir), `holds more than ${MAX_SNAPSHOTS_PER_EPIC} snapshots`)
  }
  checkSnapshotBudget(deps, epicId, names)
  return names.map((name) => readSnapshot(deps, epicId, name))
}

function checkEpicFiles(files: Omit<EpicFiles, 'path' | 'trackedHash'>, shown: { pointer: string; state: string }): void {
  const { epicId, pointer, state, snapshots } = files
  if (pointer.epicId !== epicId) {
    reject(shown.pointer, 'belongs to a different epic')
  }
  if (state.epicId !== epicId) {
    reject(shown.state, 'belongs to a different epic')
  }
  const current = snapshots.find((snapshot) => snapshot.revisionId === pointer.revisionId)
  if (current === undefined) {
    reject(shown.pointer, `points to missing snapshot ${pointer.revisionId}`)
  }
  if (current.contentHash !== pointer.contentHash || current.number !== pointer.revisionNumber) {
    reject(shown.pointer, 'does not match the snapshot it points to')
  }
  const known = new Set(snapshots.flatMap((snapshot) => snapshot.bundle.tickets.map((ticket) => ticket.id)))
  const unknown = Object.keys(state.ticketStatuses).find((ticketId) => !known.has(ticketId))
  if (unknown !== undefined) {
    reject(shown.state, `names ticket ${unknown}, which no snapshot contains`)
  }
}

interface EpicTexts {
  epicId: string
  dir: string
  pointerText: string
  stateText: string
  trackedHash: string
}

function parseEpicFiles(deps: ImporterDeps, texts: EpicTexts): EpicFiles {
  const paths = ownedPaths(deps.layout)
  const shown = {
    pointer: displayPath(deps.layout, paths.epicPointerFile(texts.epicId)),
    state: displayPath(deps.layout, paths.epicStateFile(texts.epicId))
  }
  const pointer = parseRecord(epicPointerRecord, texts.pointerText, shown.pointer)
  const state = parseRecord(epicStateRecord, texts.stateText, shown.state)
  const snapshots = readSnapshots(deps, texts.epicId)
  checkEpicFiles({ epicId: texts.epicId, pointer, state, snapshots }, shown)
  return { epicId: texts.epicId, path: displayPath(deps.layout, texts.dir), pointer, state, snapshots, trackedHash: texts.trackedHash }
}

/**
 * Reads an epic's pointer and state; null when they match the last sync (nothing to import, so the
 * snapshots are not re-read on every heartbeat). Otherwise every file is parsed and validated.
 */
function readEpicFiles(deps: ImporterDeps, epicId: string): EpicFiles | null {
  const paths = ownedPaths(deps.layout)
  const dir = paths.epicDir(epicId)
  assertContained(deps.layout, deps.fs, dir)
  if (!deps.fs.isDirectory(dir)) {
    reject(displayPath(deps.layout, dir), 'is not a directory')
  }
  const pointerText = requireText(deps, paths.epicPointerFile(epicId))
  const stateText = requireText(deps, paths.epicStateFile(epicId))
  const trackedHash = trackedEpicHash(pointerText, stateText)
  if (matchesSync(deps.db, 'epic', epicId, trackedHash)) {
    return null
  }
  return parseEpicFiles(deps, { epicId, dir, pointerText, stateText, trackedHash })
}

function readRunFiles(deps: ImporterDeps, runId: string): RunFiles | null {
  const file = ownedPaths(deps.layout).runHistoryFile(runId)
  const text = requireText(deps, file)
  const trackedHash = trackedRunHash(text)
  if (matchesSync(deps.db, 'run', runId, trackedHash)) {
    return null
  }
  const shown = displayPath(deps.layout, file)
  const record = parseRecord(runHistoryRecord, text, shown)
  if (record.runId !== runId) {
    reject(shown, 'belongs to a different run')
  }
  return { runId, path: shown, record, trackedHash }
}

interface ScanSink<T> {
  found: T[]
  unchanged: string[]
  onReject: (name: string, message: string) => void
}

function scanEntries<T>(names: string[], read: (name: string) => T | null, sink: ScanSink<T>): void {
  for (const name of names) {
    try {
      const found = read(name)
      if (found === null) {
        sink.unchanged.push(name)
      } else {
        sink.found.push(found)
      }
    } catch (error: unknown) {
      sink.onReject(name, messageOf(error))
    }
  }
}

/** A comment file already imported or exported with exactly this text and not in conflict. */
function commentSynced(db: Db, commentId: string, hash: string): boolean {
  const row = db.get<{ exported_hash: string | null; imported_hash: string | null; conflict: string | null }>(
    "SELECT exported_hash, imported_hash, conflict FROM sync_state WHERE kind = 'comment' AND entity_id = ?",
    commentId
  )
  return row !== undefined && row.conflict === null && (row.exported_hash === hash || row.imported_hash === hash)
}

/** `.json` names in an epic's comments directory; dot entries and other names (such as temp files) are ignored. */
function listCommentNames(deps: ImporterDeps, dir: string): string[] {
  if (!deps.fs.exists(dir) && !deps.fs.isSymlink(dir)) {
    return []
  }
  assertContained(deps.layout, deps.fs, dir)
  if (!deps.fs.isDirectory(dir)) {
    reject(displayPath(deps.layout, dir), 'is not a directory')
  }
  const names = deps.fs
    .readdir(dir)
    .filter((name) => !name.startsWith('.') && name.endsWith(JSON_SUFFIX))
    .sort()
  if (names.length > LIMITS.commentsPerEpic) {
    reject(displayPath(deps.layout, dir), `holds more than ${LIMITS.commentsPerEpic} comments`)
  }
  return names
}

/** Reads one comment file's text: contained, a regular file, and within the comment size limit. */
function readCommentText(deps: ImporterDeps, file: string, shown: string): string {
  assertContained(deps.layout, deps.fs, file)
  if (deps.fs.isDirectory(file)) {
    reject(shown, 'is not a regular file')
  }
  if (deps.fs.fileSize(file) > MAX_COMMENT_RECORD_BYTES) {
    reject(shown, 'is larger than the 256 KiB comment limit')
  }
  return requireText(deps, file)
}

/** A comment file named `<commentId>.json`; null when its text matches the last sync. */
function readCommentFile(deps: ImporterDeps, epicId: string, name: string): CommentFiles | null {
  const commentId = name.slice(0, -JSON_SUFFIX.length)
  const file = ownedPaths(deps.layout).commentFile(epicId, commentId)
  const shown = displayPath(deps.layout, file)
  const text = readCommentText(deps, file, shown)
  const trackedHash = trackedCommentHash(text)
  if (commentSynced(deps.db, commentId, trackedHash)) {
    return null
  }
  const record = parseRecord(commentRecord, text, shown)
  if (record.id !== commentId) {
    reject(shown, 'names a different comment than its file name')
  }
  if (record.epicId !== epicId) {
    reject(shown, 'belongs to a different epic')
  }
  return { commentId, epicId, path: shown, record, trackedHash }
}

/** Every comment file of one epic; each bad file is rejected on its own. */
function scanComments(deps: ImporterDeps, epicId: string, scan: Scan): void {
  const dir = ownedPaths(deps.layout).commentsDir(epicId)
  const shownDir = displayPath(deps.layout, dir)
  let names: string[]
  try {
    names = listCommentNames(deps, dir)
  } catch (error: unknown) {
    scan.rejected.push({ path: shownDir, message: messageOf(error) })
    return
  }
  scanEntries(names, (name) => readCommentFile(deps, epicId, name), {
    found: scan.comments,
    unchanged: [],
    onReject: (name, message) => {
      scan.rejected.push({ path: `${shownDir}/${name}`, message })
    }
  })
}

function scanRepository(deps: ImporterDeps): Scan {
  const scan: Scan = { epics: [], runs: [], comments: [], unchanged: [], rejected: [], rejectedEpics: new Set() }
  const epicNames = listEntries(deps, deps.layout.epicsDir)
  const runNames = listEntries(deps, deps.layout.historyDir)
  scanEntries(epicNames, (name) => readEpicFiles(deps, name), {
    found: scan.epics,
    unchanged: scan.unchanged,
    onReject: (name, message) => {
      scan.rejectedEpics.add(name)
      scan.rejected.push({ path: displayPath(deps.layout, join(deps.layout.epicsDir, name)), message })
    }
  })
  scanEntries(runNames, (name) => readRunFiles(deps, name), {
    found: scan.runs,
    unchanged: scan.unchanged,
    onReject: (name, message) => {
      scan.rejected.push({ path: displayPath(deps.layout, join(deps.layout.historyDir, name)), message })
    }
  })
  // Comments of an epic whose own records were rejected stay unread until those records are fixed.
  for (const epicId of epicNames.filter((name) => !scan.rejectedEpics.has(name))) {
    scanComments(deps, epicId, scan)
  }
  return scan
}

function matchesSync(db: Db, kind: 'epic' | 'run', entityId: string, hash: string): boolean {
  const row = db.get<{ exported_hash: string | null; imported_hash: string | null }>(
    'SELECT exported_hash, imported_hash FROM sync_state WHERE kind = ? AND entity_id = ?',
    kind,
    entityId
  )
  return row !== undefined && (row.exported_hash === hash || row.imported_hash === hash)
}

/** Unexported plan or state changes; a comment waiting for export never touches those files. */
function hasPendingEpicChanges(db: Db, epicId: string): boolean {
  const row = db.get<{ pending: number }>(
    `SELECT EXISTS (SELECT 1 FROM outbox WHERE epic_id = ? AND kind <> 'comment' AND state IN ('pending', 'failed'))
         OR EXISTS (SELECT 1 FROM plan_revisions WHERE epic_id = ? AND state = 'pending') AS pending`,
    epicId,
    epicId
  )
  return row?.pending === 1
}

function hasPendingRunChanges(db: Db, runId: string): boolean {
  const row = db.get<{ pending: number }>(
    "SELECT EXISTS (SELECT 1 FROM outbox WHERE run_id = ? AND state IN ('pending', 'failed')) AS pending",
    runId
  )
  return row?.pending === 1
}

/** Revision or ticket ids that already belong to another epic (or differ in content) are refused. */
function epicClash(db: Db, files: EpicFiles): string | null {
  for (const snapshot of files.snapshots) {
    const row = db.get<{ epic_id: string; content_hash: string }>('SELECT epic_id, content_hash FROM plan_revisions WHERE id = ?', snapshot.revisionId)
    if (row !== undefined && (row.epic_id !== files.epicId || row.content_hash !== snapshot.contentHash)) {
      return `Revision ${snapshot.revisionId} already exists locally with different content or another epic.`
    }
  }
  const ticketIds = new Set(files.snapshots.flatMap((snapshot) => snapshot.bundle.tickets.map((ticket) => ticket.id)))
  for (const ticketId of ticketIds) {
    const row = db.get<{ epic_id: string }>('SELECT epic_id FROM ticket_status WHERE ticket_id = ?', ticketId)
    if (row !== undefined && row.epic_id !== files.epicId) {
      return `Ticket ${ticketId} already belongs to another epic.`
    }
  }
  return null
}

const RUN_CHILD_TABLES = [
  { table: 'attempts', what: 'Attempt', ids: (record: RunHistoryRecord) => record.attempts.map((item) => item.id) },
  { table: 'sprint_reports', what: 'Report', ids: (record: RunHistoryRecord) => record.reports.map((item) => item.id) },
  { table: 'checkpoints', what: 'Checkpoint', ids: (record: RunHistoryRecord) => record.checkpoints.map((item) => item.id) }
] as const

function foreignChild(db: Db, record: RunHistoryRecord): string | null {
  for (const child of RUN_CHILD_TABLES) {
    const id = child.ids(record).find((childId) => {
      const row = db.get<{ run_id: string }>(`SELECT run_id FROM ${child.table} WHERE id = ?`, childId)
      return row !== undefined && row.run_id !== record.runId
    })
    if (id !== undefined) {
      return `${child.what} ${id} already belongs to another run.`
    }
  }
  return null
}

/** A run must reference a known epic and a revision of that epic, and must not claim others' rows. */
function runClash(db: Db, record: RunHistoryRecord, staged: Map<string, EpicFiles>): string | null {
  const stagedEpic = staged.get(record.epicId)
  const epicKnown = stagedEpic !== undefined || db.get('SELECT id FROM epics WHERE id = ?', record.epicId) !== undefined
  if (!epicKnown) {
    return `Run ${record.runId} belongs to unknown epic ${record.epicId}.`
  }
  const stagedRevision = stagedEpic?.snapshots.some((snapshot) => snapshot.revisionId === record.revisionId) === true
  const localRevision = db.get<{ epic_id: string }>('SELECT epic_id FROM plan_revisions WHERE id = ?', record.revisionId)
  if (!stagedRevision && localRevision?.epic_id !== record.epicId) {
    return `Run ${record.runId} is pinned to unknown revision ${record.revisionId}.`
  }
  const existing = db.get<{ epic_id: string }>('SELECT epic_id FROM runs WHERE id = ?', record.runId)
  if (existing !== undefined && existing.epic_id !== record.epicId) {
    return `Run ${record.runId} already exists locally for another epic.`
  }
  return foreignChild(db, record)
}

function epicConflictMessage(epicId: string): string {
  return `Tracked records for epic ${epicId} changed while local changes are waiting to be exported. Flush or resolve the local changes before importing.`
}

function planEpics(db: Db, scan: Scan, plan: Plan): Set<string> {
  const skipped = new Set(scan.rejectedEpics)
  for (const files of scan.epics) {
    if (hasPendingEpicChanges(db, files.epicId)) {
      skipped.add(files.epicId)
      plan.conflicts.push({ kind: 'epic', entityId: files.epicId, epicId: files.epicId, message: epicConflictMessage(files.epicId) })
      continue
    }
    const clash = epicClash(db, files)
    if (clash === null) {
      plan.epics.push(files)
    } else {
      skipped.add(files.epicId)
      plan.rejected.push({ path: files.path, message: clash })
    }
  }
  return skipped
}

function planRuns(db: Db, scan: Scan, plan: Plan, skippedEpics: Set<string>): void {
  const staged = new Map(plan.epics.map((files) => [files.epicId, files]))
  for (const run of scan.runs.filter((item) => !skippedEpics.has(item.record.epicId))) {
    if (hasPendingRunChanges(db, run.runId)) {
      const message = `Tracked history for run ${run.runId} changed while local run changes are waiting to be exported.`
      plan.conflicts.push({ kind: 'run', entityId: run.runId, epicId: run.record.epicId, message })
      continue
    }
    const clash = runClash(db, run.record, staged)
    if (clash === null) {
      plan.runs.push(run)
    } else {
      plan.rejected.push({ path: run.path, message: clash })
    }
  }
}

function planKnownComment(plan: Plan, file: CommentFiles, known: Record<string, unknown>): void {
  if (contentHash(known) === contentHash(file.record)) {
    plan.syncedComments.push(file)
    return
  }
  const message = `Comment ${file.commentId} already exists with different content; ${file.path} was not imported.`
  plan.conflicts.push({ kind: 'comment', entityId: file.commentId, epicId: file.epicId, message })
}

/**
 * Comments are immutable: an id already present (here, or earlier in this import) with other
 * content is a conflict, never an overwrite. A new comment is imported once its epic exists here
 * or is imported now; otherwise its epic's own rejection or conflict explains the wait.
 */
function planComments(db: Db, scan: Scan, plan: Plan): void {
  const stagedEpics = new Set(plan.epics.map((files) => files.epicId))
  const seen = new Map<string, CommentRecord>()
  for (const file of scan.comments) {
    const known = readCommentRecord(db, file.commentId) ?? seen.get(file.commentId)
    if (known !== undefined) {
      planKnownComment(plan, file, known)
    } else if (stagedEpics.has(file.epicId) || db.get('SELECT id FROM epics WHERE id = ?', file.epicId) !== undefined) {
      seen.set(file.commentId, file.record)
      plan.comments.push(file)
    }
  }
}

function planImport(db: Db, scan: Scan): Plan {
  const plan: Plan = {
    epics: [],
    runs: [],
    comments: [],
    syncedComments: [],
    unchanged: [...scan.unchanged],
    conflicts: [],
    rejected: [...scan.rejected]
  }
  planRuns(db, scan, plan, planEpics(db, scan, plan))
  planComments(db, scan, plan)
  return plan
}

function markSynced(db: Db, entry: { kind: Conflict['kind']; entityId: string; hash: string; generation: number | null; now: string }): void {
  db.run(
    `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
     VALUES (?, ?, ?, COALESCE(?, 0), ?, NULL, ?)
     ON CONFLICT(kind, entity_id) DO UPDATE SET exported_hash = excluded.exported_hash,
       generation = COALESCE(?, sync_state.generation), imported_hash = excluded.imported_hash,
       conflict = NULL, updated_at = excluded.updated_at`,
    entry.kind,
    entry.entityId,
    entry.hash,
    entry.generation,
    entry.hash,
    entry.now,
    entry.generation
  )
}

function upsertEpic(db: Db, files: EpicFiles): void {
  const { state, pointer } = files
  db.run(
    `INSERT INTO epics (id, title, status, current_revision_id, branch_json, provenance_json, outcome_json, revision,
       created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status,
       current_revision_id = excluded.current_revision_id, branch_json = excluded.branch_json,
       provenance_json = excluded.provenance_json, outcome_json = excluded.outcome_json, revision = epics.revision + 1,
       updated_at = excluded.updated_at, completed_at = excluded.completed_at`,
    files.epicId,
    state.title,
    state.status,
    pointer.revisionId,
    state.branch === null ? null : toJson(state.branch),
    state.provenance === null ? null : toJson(state.provenance),
    state.outcome === null ? null : toJson(state.outcome),
    state.createdAt,
    state.updatedAt,
    state.completedAt
  )
}

function upsertRevision(db: Db, snapshot: SnapshotRecord): void {
  db.run(
    `INSERT INTO plan_revisions (id, epic_id, number, base_revision_id, content_hash, bundle_json, state, created_at,
       saved_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'saved', ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET state = 'saved', saved_at = COALESCE(plan_revisions.saved_at, excluded.saved_at)`,
    snapshot.revisionId,
    snapshot.epicId,
    snapshot.number,
    snapshot.baseRevisionId,
    snapshot.contentHash,
    toJson(snapshot.bundle),
    snapshot.createdAt,
    snapshot.savedAt
  )
}

function upsertTicketStatuses(db: Db, files: EpicFiles): void {
  for (const [ticketId, status] of Object.entries(files.state.ticketStatuses)) {
    db.run(
      `INSERT INTO ticket_status (ticket_id, epic_id, status, revision, updated_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(ticket_id) DO UPDATE SET status = excluded.status, revision = ticket_status.revision + 1,
         updated_at = excluded.updated_at
       WHERE ticket_status.status <> excluded.status`,
      ticketId,
      files.epicId,
      status,
      files.state.updatedAt
    )
  }
}

function currentBundle(files: EpicFiles): PlanBundle | undefined {
  return files.snapshots.find((snapshot) => snapshot.revisionId === files.pointer.revisionId)?.bundle
}

function indexEpic(db: Db, files: EpicFiles): void {
  const bundle = currentBundle(files)
  const intent = bundle === undefined ? [] : [bundle.epic.intent, ...bundle.epic.successCriteria.map((item) => item.text)]
  const body = [...intent, files.state.outcome?.summary ?? ''].filter((part) => part !== '').join('\n')
  indexDocument(db, { docType: 'epic', docId: files.epicId, epicId: files.epicId, title: files.state.title, body })
  db.run("DELETE FROM search_index WHERE doc_type = 'ticket' AND epic_id = ?", files.epicId)
  for (const ticket of bundle?.tickets ?? []) {
    indexDocument(db, {
      docType: 'ticket',
      docId: ticket.id,
      epicId: files.epicId,
      ticketId: ticket.id,
      title: `${ticket.key} ${ticket.title}`,
      body: [ticket.body, ...ticket.acceptanceCriteria.map((item) => item.text)].join('\n')
    })
  }
}

function applyEpic(db: Db, files: EpicFiles, now: string): void {
  upsertEpic(db, files)
  for (const snapshot of files.snapshots) {
    upsertRevision(db, snapshot)
  }
  upsertTicketStatuses(db, files)
  markSynced(db, { kind: 'epic', entityId: files.epicId, hash: files.trackedHash, generation: files.pointer.generation, now })
  indexEpic(db, files)
}

function upsertRun(db: Db, record: RunHistoryRecord): void {
  db.run(
    `INSERT INTO runs (id, epic_id, number, revision_id, state, active_sprint_id, orchestrator_session_id, host_json,
       host_catalog_id, skill_version, owner_machine_id, pause_reason, auto_continue, revision, created_at, started_at,
       updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET number = excluded.number, revision_id = excluded.revision_id, state = excluded.state,
       active_sprint_id = excluded.active_sprint_id, orchestrator_session_id = NULL, host_json = excluded.host_json,
       host_catalog_id = excluded.host_catalog_id, skill_version = excluded.skill_version,
       owner_machine_id = excluded.owner_machine_id, pause_reason = excluded.pause_reason, auto_continue = 0,
       revision = runs.revision + 1, started_at = excluded.started_at, updated_at = excluded.updated_at,
       ended_at = excluded.ended_at`,
    record.runId,
    record.epicId,
    record.number,
    record.revisionId,
    record.state,
    record.activeSprintId,
    record.host === null ? null : toJson(record.host),
    record.hostCatalogId,
    record.skillVersion,
    record.ownerMachineId,
    record.pauseReason,
    record.createdAt,
    record.startedAt,
    record.updatedAt,
    record.endedAt
  )
}

/** A lease never travels: an imported claimed/running attempt is uncertain until reconciled. */
function importedAttemptState(attempt: AttemptRecord): AttemptRecord['state'] {
  return LEASED_ATTEMPT_STATES.includes(attempt.state) ? 'lease_expired' : attempt.state
}

function nullableJson(value: unknown): string | null {
  return value === null ? null : toJson(value)
}

function upsertAttempt(db: Db, runId: string, attempt: AttemptRecord): void {
  db.run(
    `INSERT INTO attempts (id, run_id, ticket_id, number, kind, state, fencing_token, claim_secret, worker_json,
       revision_id, ticket_content_hash, lease_expires_at, heartbeat_at, outputs_json, evidence_json, failure_json,
       decision_json, created_at, updated_at, submitted_at, decided_at, reconciled_at, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ticket_id = excluded.ticket_id, number = excluded.number, kind = excluded.kind,
       state = excluded.state, fencing_token = excluded.fencing_token, claim_secret = NULL,
       worker_json = excluded.worker_json, revision_id = excluded.revision_id,
       ticket_content_hash = excluded.ticket_content_hash, lease_expires_at = NULL, heartbeat_at = NULL,
       outputs_json = excluded.outputs_json, evidence_json = excluded.evidence_json,
       failure_json = excluded.failure_json, decision_json = excluded.decision_json, updated_at = excluded.updated_at,
       submitted_at = excluded.submitted_at, decided_at = excluded.decided_at, reconciled_at = excluded.reconciled_at,
       superseded_at = excluded.superseded_at`,
    attempt.id,
    runId,
    attempt.ticketId,
    attempt.number,
    attempt.kind,
    importedAttemptState(attempt),
    attempt.fencingToken,
    toJson(attempt.worker),
    attempt.revisionId,
    attempt.ticketContentHash,
    nullableJson(attempt.outputs),
    nullableJson(attempt.evidence),
    nullableJson(attempt.failure),
    nullableJson(attempt.decision),
    attempt.createdAt,
    attempt.updatedAt,
    attempt.submittedAt,
    attempt.decidedAt,
    attempt.reconciledAt,
    attempt.supersededAt
  )
}

function upsertReportsAndCheckpoints(db: Db, record: RunHistoryRecord): void {
  for (const report of record.reports) {
    db.run(
      `INSERT INTO sprint_reports (id, run_id, sprint_id, report_revision, content_json, content_hash, submitted_by,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET sprint_id = excluded.sprint_id, report_revision = excluded.report_revision,
         content_json = excluded.content_json, content_hash = excluded.content_hash,
         submitted_by = excluded.submitted_by`,
      report.id,
      record.runId,
      report.sprintId,
      report.reportRevision,
      toJson(report.content),
      report.contentHash,
      report.submittedBy,
      report.createdAt
    )
  }
  for (const checkpoint of record.checkpoints) {
    db.run(
      `INSERT INTO checkpoints (id, run_id, sprint_id, report_id, outcome, policy, approval_id, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET outcome = excluded.outcome, policy = excluded.policy,
         decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
      checkpoint.id,
      record.runId,
      checkpoint.sprintId,
      checkpoint.reportId,
      checkpoint.outcome,
      checkpoint.policy,
      checkpoint.decidedBy,
      checkpoint.decidedAt
    )
  }
}

function ticketKeys(db: Db, revisionId: string): Map<string, string> {
  const row = db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', revisionId)
  const bundle = parseJson<{ tickets: { id: string; key: string }[] }>(row?.bundle_json, { tickets: [] })
  return new Map(bundle.tickets.map((ticket) => [ticket.id, ticket.key]))
}

function attemptBody(attempt: AttemptRecord): string {
  const parts = [
    attempt.outputs?.summary,
    attempt.failure?.reason,
    attempt.failure?.details,
    attempt.decision?.notes,
    ...(attempt.decision?.reasons ?? [])
  ]
  return parts.filter((part): part is string => part !== undefined && part !== '').join('\n')
}

function indexRun(db: Db, record: RunHistoryRecord): void {
  const keys = ticketKeys(db, record.revisionId)
  for (const attempt of record.attempts) {
    indexDocument(db, {
      docType: 'attempt',
      docId: attempt.id,
      epicId: record.epicId,
      runId: record.runId,
      ticketId: attempt.ticketId,
      title: `${keys.get(attempt.ticketId) ?? attempt.ticketId} attempt ${attempt.number}`,
      body: attemptBody(attempt)
    })
  }
  for (const report of record.reports) {
    const { content } = report
    const followUps = content.followUps.map((item) => `${item.title}\n${item.body}`)
    indexDocument(db, {
      docType: 'report',
      docId: report.id,
      epicId: record.epicId,
      runId: record.runId,
      title: `Sprint report ${report.reportRevision}`,
      body: [content.summary, ...content.risks, ...followUps].join('\n')
    })
  }
}

function applyRun(db: Db, run: RunFiles, now: string): void {
  const { record } = run
  upsertRun(db, record)
  // Closed attempts first, so an attempt that closes never collides with the one-open-attempt index.
  const isOpen = (attempt: AttemptRecord): boolean => OPEN_ATTEMPT_STATES.includes(importedAttemptState(attempt))
  for (const attempt of [...record.attempts.filter((item) => !isOpen(item)), ...record.attempts.filter(isOpen)]) {
    upsertAttempt(db, record.runId, attempt)
  }
  upsertReportsAndCheckpoints(db, record)
  markSynced(db, { kind: 'run', entityId: run.runId, hash: run.trackedHash, generation: null, now })
  indexRun(db, record)
}

function applyComment(db: Db, file: CommentFiles, now: string): void {
  const { record } = file
  db.run(
    `INSERT INTO comments (id, epic_id, ticket_id, body, author_role, author_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.epicId,
    record.ticketId,
    record.body,
    record.author.role,
    record.author.label,
    record.createdAt
  )
  markSynced(db, { kind: 'comment', entityId: file.commentId, hash: file.trackedHash, generation: null, now })
  indexComment(db, record)
}

/** Applies one staged item under a savepoint; a constraint failure rejects only that item. */
function applyItem(db: Db, path: string, apply: () => void, rejected: Rejection[]): boolean {
  try {
    db.tx(apply)
    return true
  } catch (error: unknown) {
    rejected.push({ path, message: `Could not be applied: ${messageOf(error)}` })
    return false
  }
}

function insertEvent(deps: ImporterDeps, event: { kind: string; epicId?: string; runId?: string; payload: Record<string, unknown> }): void {
  deps.db.run(
    `INSERT INTO events (at, kind, epic_id, run_id, ticket_id, session_id, payload_json)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    deps.clock.nowIso(),
    event.kind,
    event.epicId ?? null,
    event.runId ?? null,
    deps.sessionId ?? null,
    toJson(event.payload)
  )
}

/** A moved checkout pauses every run that could still dispatch work until someone resumes it. */
function pauseActiveRuns(deps: ImporterDeps, now: string): string[] {
  const runs = deps.db.all<{ id: string; epic_id: string }>(
    "SELECT id, epic_id FROM runs WHERE state IN ('queued', 'running', 'awaiting_checkpoint') ORDER BY id"
  )
  for (const run of runs) {
    deps.db.run(
      "UPDATE runs SET state = 'paused', pause_reason = 'branch_changed', revision = revision + 1, updated_at = ? WHERE id = ?",
      now,
      run.id
    )
    insertEvent(deps, { kind: 'run.paused', epicId: run.epic_id, runId: run.id, payload: { reason: 'branch_changed' } })
  }
  return runs.map((run) => run.id)
}

function storeConflicts(db: Db, conflicts: Conflict[], now: string): void {
  for (const conflict of conflicts) {
    db.run(
      `INSERT INTO sync_state (kind, entity_id, generation, conflict, updated_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(kind, entity_id) DO UPDATE SET conflict = excluded.conflict, updated_at = excluded.updated_at`,
      conflict.kind,
      conflict.entityId,
      conflict.message,
      now
    )
  }
}

function applyStaged(deps: ImporterDeps, plan: Plan, now: string): { imported: string[]; rejected: Rejection[] } {
  const rejected = [...plan.rejected]
  const imported: string[] = []
  const failedEpics = new Set<string>()
  for (const files of plan.epics) {
    const applied = applyItem(deps.db, files.path, () => applyEpic(deps.db, files, now), rejected)
    if (applied) {
      imported.push(files.epicId)
    } else {
      failedEpics.add(files.epicId)
    }
  }
  for (const run of plan.runs.filter((item) => !failedEpics.has(item.record.epicId))) {
    if (applyItem(deps.db, run.path, () => applyRun(deps.db, run, now), rejected)) {
      imported.push(run.runId)
    }
  }
  applyComments(deps.db, plan, { now, failedEpics, imported, rejected })
  return { imported, rejected }
}

interface CommentApply {
  now: string
  failedEpics: Set<string>
  imported: string[]
  rejected: Rejection[]
}

function applyComments(db: Db, plan: Plan, apply: CommentApply): void {
  for (const file of plan.comments.filter((item) => !apply.failedEpics.has(item.epicId))) {
    if (applyItem(db, file.path, () => applyComment(db, file, apply.now), apply.rejected)) {
      apply.imported.push(file.commentId)
    }
  }
  for (const file of plan.syncedComments) {
    markSynced(db, { kind: 'comment', entityId: file.commentId, hash: file.trackedHash, generation: null, now: apply.now })
  }
}

function rememberProject(db: Db, project: ProjectRecord): void {
  if (getMeta(db, META_KEYS.projectId) === null) {
    setMeta(db, META_KEYS.projectId, project.projectId)
    setMeta(db, META_KEYS.projectName, project.name)
    setMeta(db, META_KEYS.keyPrefix, project.keyPrefix)
  }
}

interface ApplyContext {
  project: ProjectRecord
  plan: Plan
  current: string | null
  branchChanged: boolean
}

function applyPlan(deps: ImporterDeps, context: ApplyContext): ReconcileResultView {
  const { plan, branchChanged } = context
  const now = deps.clock.nowIso()
  rememberProject(deps.db, context.project)
  const { imported, rejected } = applyStaged(deps, plan, now)
  storeConflicts(deps.db, plan.conflicts, now)
  const pausedRuns = branchChanged ? pauseActiveRuns(deps, now) : []
  const conflicts = plan.conflicts.map((conflict) => ({ epicId: conflict.epicId, message: conflict.message }))
  const result = { imported, unchanged: plan.unchanged, conflicts, rejected, branchChanged, pausedRuns }
  if (imported.length > 0 || conflicts.length > 0 || rejected.length > 0 || branchChanged) {
    const payload = { imported, unchanged: plan.unchanged.length, conflicts: conflicts.length, rejected: rejected.length, branchChanged, pausedRuns }
    insertEvent(deps, { kind: 'repository.reconciled', payload })
  }
  setMeta(deps.db, META_KEYS.checkoutBranch, context.current ?? '')
  setMeta(deps.db, META_KEYS.lastReconcileAt, now)
  return result
}

/**
 * Reconciles tracked records into the local database under the write lock (so no finalizer can be
 * mid-write while files are read). Throws `not_initialized`, `project_mismatch`, or `unsafe_path`
 * (a linked `epics/` or `history/`) without changing anything; per-epic and per-run problems are
 * reported in `rejected`/`conflicts` and leave those entities as they were.
 */
export function reconcileRepository(deps: ImporterDeps): ReconcileResultView {
  return deps.db.tx(() => {
    const current = deps.git.head()?.branch ?? null
    const branchChanged = branchState(deps.db, current).changed
    const project = requireProject(deps)
    const plan = planImport(deps.db, scanRepository(deps))
    return applyPlan(deps, { project, plan, current, branchChanged })
  })
}
