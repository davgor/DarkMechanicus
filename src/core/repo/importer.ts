/**
 * Reconcile / import: rebuilds and refreshes the local database from Git-tracked records.
 *
 * Every tracked file is untrusted: owned paths come from validated ids with containment checks,
 * records pass size / merge-marker / schema checks, snapshots are hash-verified and graph-validated,
 * and cross-file references are checked before anything is applied. Parse and plan before taking the
 * writer lock, then recheck the observed files and database revision before a single atomic apply.
 * Per-item savepoints preserve the local state of a rejected epic or run. Drafts are never touched.
 * Verified hashes avoid opening unchanged bodies again when their stamps and database identities agree.
 * An epic whose local Linear transfer is open takes no other saved revision and no run from the files (`planTransferHolds`).
 */
import { join } from 'node:path'
import type { EpicProvenance, PlanBundle } from '../../shared/domain/bundle'
import type { ExperimentEvent, RetroExperiment } from '../../shared/domain/experiments'
import type { ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import { LEASED_ATTEMPT_STATES, OPEN_ATTEMPT_STATES } from '../../shared/domain/status'
import type { ReconcileResultView } from '../../shared/domain/views'
import { canonicalJson, contentHash } from '../canonical'
import type { Clock } from '../clock'
import { type Db, parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { getMeta, META_KEYS, readReconcileMarker, setMeta } from '../meta'
import { hasValidatedRepositoryCache, rememberValidatedRepositoryCache } from './validatedCache'
import { correctionHolderProblem, type CorrectionHolder, crossRepoEvidenceProblem } from '../plan/corrections'
import { resultProblem, type ScorecardLookup, sourceProblem } from '../plan/experiments'
import { validatePlan } from '../plan/graph'
import { retroSearchParts } from '../plan/retro'
import { LIMITS } from '../schemas'
import { enqueueOutbox } from '../services/outbox'
import { indexComment, indexDocument } from '../services/searchIndex'
import { findOpenTransfer, type OpenTransfer, TRANSFER_HOLD_PREFIX } from '../services/transferGuard'
import { type FileHashCache, readUnlessSynced } from './fileHashes'
import { readProject } from './initialize'
import { releaseBackoff } from './finalizer'
import { assertContained, displayPath, ownedPaths } from './paths'
import { applyAttachmentFiles, insertOwnedRow, prepareAttachmentFiles, registerEvidenceAttachments, registerTicketAttachments } from './attachmentImport'
import { applyCard, type KanbanScan, kanbanConflictsStored, scanKanban, storeKanbanConflicts } from './kanbanImport'
import { applyObservations, type ObservationScope, observationsSettled, scanObservations } from './observationImport'
import { databaseRevision, observeRepository } from './reconcilePreparation'
import type { ReconcileGate } from './reconcileFingerprint'
import { reconcileScope, type ReconcileScope, unsettledPaths, writeReconcileMarker } from './reconcileScope'
import { applyRecoveredAttachments, prepareRecoveredAttachments } from './recoveredAttachments'
import { applyProfile, type ProfileScan, profileConflictsStored, scanProfiles, storeProfileConflicts } from './profileImport'
import {
  buildRunHistoryRecord,
  type CommentRecord,
  commentRecord,
  eventProblem,
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
  scorecardRecord,
  type SnapshotRecord,
  snapshotRecord,
  trackedCommentHash,
  trackedEpicHash,
  trackedRunHash
} from './portable'
import { hasPendingEpicChanges, matchesSync } from './syncState'
import { IMPORTER_VERSION, type TrackedRecords } from './gitChanges'
import type { FsAdapter, GitAdapter, RepoLayout } from './types'

export interface ImporterDeps {
  db: Db
  layout: RepoLayout
  fs: FsAdapter
  clock: Clock
  machineId: string
  git: GitAdapter
  sessionId?: string | null
  /** Bounded validation metadata kept by the workspace across reconciles. */
  fileHashes: FileHashCache
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
  /** The snapshot the pointer names; `checkEpicFiles` refused the epic when it is not among `snapshots`. */
  current: SnapshotRecord
  trackedHash: string
}

interface RunFiles {
  runId: string
  path: string
  record: RunHistoryRecord
  /** Each report's frozen scorecard, by report id, read from the record the report names. */
  scorecards: Map<string, ScorecardSnapshot>
  /** Each report's content exactly as written in the file (what its contentHash binds), by report id: what is stored. */
  written: Map<string, unknown>
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
  /** Runs this machine owns whose changes wait to be exported: only the experiment events other machines appended are added. */
  eventMerges: RunFiles[]
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

/** Entries of an owned directory (dotfiles ignored); throws when it is a link or not a directory. */
function listEntries(deps: ImporterDeps, dir: string): string[] {
  if (!deps.fs.exists(dir) && !deps.fs.isSymlink(dir)) {
    return []
  }
  assertContained(deps.layout, deps.fs, dir)
  if (!deps.fs.isDirectory(dir)) {
    reject(displayPath(deps.layout, dir), 'is not a directory')
  }
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

interface SavedSnapshot {
  id: string
  number: number
  base_revision_id: string | null
  content_hash: string
  created_at: string
  saved_at: string
}

type SnapshotInput = { record: SnapshotRecord; stored: boolean } | { saved: SavedSnapshot; stored: true }

function snapshotIdentity(record: SnapshotRecord): string {
  return contentHash([record.number, record.baseRevisionId, record.contentHash, record.createdAt, record.savedAt])
}

function savedIdentity(row: SavedSnapshot): string {
  return contentHash([row.number, row.base_revision_id, row.content_hash, row.created_at, row.saved_at])
}

function readSnapshots(deps: ImporterDeps, epicId: string): SnapshotInput[] {
  const paths = ownedPaths(deps.layout)
  const dir = paths.snapshotsDir(epicId)
  assertContained(deps.layout, deps.fs, dir)
  if (!deps.fs.isDirectory(dir)) reject(displayPath(deps.layout, dir), 'is missing')
  const names = deps.fs.readdir(dir).filter((name) => name.endsWith(JSON_SUFFIX)).sort()
  if (names.length > MAX_SNAPSHOTS_PER_EPIC) {
    reject(displayPath(deps.layout, dir), `holds more than ${MAX_SNAPSHOTS_PER_EPIC} snapshots`)
  }
  let bytes = 0
  const files = names.map((name) => {
    const id = name.slice(0, -JSON_SUFFIX.length)
    const path = paths.snapshotFile(epicId, id)
    assertContained(deps.layout, deps.fs, path)
    bytes += Math.max(0, deps.fs.fileSize(path))
    if (bytes > MAX_SNAPSHOT_BYTES_PER_EPIC) reject(displayPath(deps.layout, dir), 'holds more than 256 MiB of snapshots')
    return { id, name, path, stamp: deps.fs.fileStamp(path) }
  })
  const saved = new Map(deps.db.all<SavedSnapshot>(
    "SELECT id, number, base_revision_id, content_hash, created_at, saved_at FROM plan_revisions WHERE epic_id = ? AND state = 'saved'", epicId
  ).map((row) => [row.id, row]))
  return files.map(({ id, name, path, stamp }) => {
    const row = saved.get(id)
    if (row !== undefined && stamp !== null && deps.fileHashes.get(path, stamp) === savedIdentity(row)) {
      return { saved: row, stored: true }
    }
    const record = readSnapshot(deps, epicId, name)
    if (stamp !== null && stamp === deps.fs.fileStamp(path)) deps.fileHashes.remember(path, stamp, snapshotIdentity(record))
    return { record, stored: row !== undefined && row.content_hash === record.contentHash && row.number === record.number }
  })
}

function storedSnapshot(deps: ImporterDeps, epicId: string, row: SavedSnapshot): SnapshotRecord {
  const body = deps.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', row.id)!
  return {
    format: 'darkmechanicus.plan-snapshot', formatVersion: 1, epicId, revisionId: row.id, number: row.number,
    baseRevisionId: row.base_revision_id, contentHash: row.content_hash, createdAt: row.created_at, savedAt: row.saved_at,
    bundle: JSON.parse(body.bundle_json) as PlanBundle
  }
}

function checkEpicFiles(files: Omit<EpicFiles, 'path' | 'trackedHash' | 'current'>, shown: { pointer: string; state: string }): SnapshotRecord {
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
  return current
}

/** Validates the pointer and the snapshot set even when only a snapshot changed. */
function snapshotSeal(input: SnapshotInput): { id: string; hash: string; number: number } {
  return 'saved' in input
    ? { id: input.saved.id, hash: input.saved.content_hash, number: input.saved.number }
    : { id: input.record.revisionId, hash: input.record.contentHash, number: input.record.number }
}

function checkedSeals(pointer: EpicPointerRecord, shown: string, inputs: SnapshotInput[]): ReturnType<typeof snapshotSeal>[] {
  const seals = inputs.map(snapshotSeal)
  const pointed = seals.find((seal) => seal.id === pointer.revisionId)
  if (pointed === undefined) reject(shown, `points to missing snapshot ${pointer.revisionId}`)
  if (pointed.hash !== pointer.contentHash || pointed.number !== pointer.revisionNumber) reject(shown, 'does not match the snapshot it points to')
  return seals
}

function readEpicFiles(deps: ImporterDeps, epicId: string): EpicFiles | null {
  const paths = ownedPaths(deps.layout)
  const dir = paths.epicDir(epicId)
  assertContained(deps.layout, deps.fs, dir)
  if (!deps.fs.isDirectory(dir)) reject(displayPath(deps.layout, dir), 'is not a directory')
  const pointerPath = paths.epicPointerFile(epicId)
  const statePath = paths.epicStateFile(epicId)
  const pointerText = requireText(deps, pointerPath)
  const stateText = requireText(deps, statePath)
  const trackedHash = trackedEpicHash(pointerText, stateText)
  const shown = { pointer: displayPath(deps.layout, pointerPath), state: displayPath(deps.layout, statePath) }
  const pointer = parseRecord(epicPointerRecord, pointerText, shown.pointer)
  const inputs = readSnapshots(deps, epicId)
  const seals = checkedSeals(pointer, shown.pointer, inputs)
  const synced = matchesSync(deps.db, 'epic', epicId, trackedHash)
  const snapshotSet = contentHash(seals)
  if (synced && inputs.every((input) => input.stored) && deps.fileHashes.get(statePath, snapshotSet) === trackedHash) return null
  const state = parseRecord(epicStateRecord, stateText, shown.state)
  const snapshots = inputs.map((input) => 'saved' in input ? storedSnapshot(deps, epicId, input.saved) : input.record)
  const current = checkEpicFiles({ epicId, pointer, state, snapshots }, shown)
  const files = { epicId, path: displayPath(deps.layout, dir), pointer, state, snapshots, current, trackedHash }
  if (synced) {
    // A user who chose the local revision may have left other validated snapshots in the checkout.
    // Validate those files but keep the existing selection and history when the pointer is unchanged.
    const clash = epicClash(deps.db, files)
    if (clash !== null) fail('import_rejected', clash, { path: files.path })
  }
  deps.fileHashes.remember(statePath, snapshotSet, trackedHash)
  return synced ? null : files
}

/**
 * What a scorecard must agree on with the run history that names it: its seal, its run and epic, its sprint and
 * report revision (id, number, content hash), and the subjects it grades. A re-sealed snapshot of another report,
 * run or epic is refused. Its plan revision is checked against the epic's revisions with the rest of the run.
 */
function scorecardMismatch(snapshot: ScorecardSnapshot, record: RunHistoryRecord, report: RunHistoryRecord['reports'][number]): string | null {
  const checks: [boolean, string][] = [
    [snapshot.snapshotId === report.scorecard?.snapshotId && snapshot.snapshotHash === report.scorecard.snapshotHash, 'is not the scorecard the run history names'],
    [snapshot.runId === record.runId && snapshot.sprint.subject.id === report.sprintId, 'belongs to another run or sprint'],
    [snapshot.epicId === record.epicId, 'belongs to another epic'],
    [
      snapshot.report.reportId === report.id && snapshot.report.reportRevision === report.reportRevision && snapshot.report.contentHash === report.contentHash,
      'belongs to another report revision'
    ],
    [snapshot.run.subject.id === record.runId && (snapshot.epic === null || snapshot.epic.subject.id === record.epicId), 'grades another run or epic'],
    [snapshot.sources.runIds.includes(record.runId), 'does not name its own run among its sources']
  ]
  return checks.find(([ok]) => !ok)?.[1] ?? null
}

function readScorecards(deps: ImporterDeps, record: RunHistoryRecord): Map<string, ScorecardSnapshot> {
  const scorecards = new Map<string, ScorecardSnapshot>()
  for (const report of record.reports) {
    if (report.scorecard === undefined) continue
    const file = ownedPaths(deps.layout).scorecardFile(record.runId, report.id)
    const shown = displayPath(deps.layout, file)
    const text = readOwnedText(deps, file) ?? reject(shown, 'is missing: the run history names it')
    const snapshot = parseRecord(scorecardRecord, text, shown)
    const mismatch = scorecardMismatch(snapshot, record, report)
    if (mismatch !== null) reject(shown, mismatch)
    scorecards.set(report.id, snapshot)
  }
  return scorecards
}

/** A report as written in a run history file, before the schema fills any default. */
interface WrittenReport {
  id?: unknown
  contentHash?: unknown
  content?: unknown
}

/**
 * A report revision is immutable and approvals bind its content hash, so each report's content, as written in the file
 * (before the schema fills any default), must hash to the contentHash it carries: a hand-edited retro, a swapped
 * baseline or an injected experiment does not. That written content is what is stored and exported again
 * (`upsertReportsAndCheckpoints`, `buildRunHistoryRecord`); readers fill the defaults (`filledReportContent`).
 */
function editedReport(reports: WrittenReport[]): string | null {
  const edited = reports.find((report) => contentHash(report.content) !== report.contentHash)
  return edited === undefined ? null : `holds report ${String(edited.id)}, whose content does not hash to its contentHash; a report's content is never edited`
}

/** Stamp the report sidecars too: a retained run hash cannot hide an edited or deleted scorecard. */
function runStamp(deps: ImporterDeps, file: string, runId: string, reportIds: string[]): string | null {
  assertContained(deps.layout, deps.fs, file)
  const stamp = deps.fs.fileStamp(file)
  if (stamp === null) return null
  const stamps = [stamp]
  for (const reportId of reportIds) {
    const sidecar = ownedPaths(deps.layout).scorecardFile(runId, reportId)
    assertContained(deps.layout, deps.fs, sidecar)
    const sidecarStamp = deps.fs.fileStamp(sidecar)
    if (sidecarStamp === null) return null
    stamps.push(reportId, sidecarStamp)
  }
  return contentHash(stamps)
}

function validateRunScorecards(deps: ImporterDeps, input: { record: RunHistoryRecord; file: string; bodyStamp: string | null; hash: string }) {
  const { record, file, bodyStamp, hash } = input
  const reportIds = record.reports.filter((report) => report.scorecard !== undefined).map((report) => report.id).sort()
  const before = runStamp(deps, file, record.runId, reportIds)
  const scorecards = readScorecards(deps, record)
  if (before !== null && bodyStamp !== null && bodyStamp === deps.fs.fileStamp(file) && before === runStamp(deps, file, record.runId, reportIds)) {
    deps.fileHashes.remember(file, before, hash)
  }
  return scorecards
}

function readRunFiles(deps: ImporterDeps, runId: string): RunFiles | null {
  const file = ownedPaths(deps.layout).runHistoryFile(runId)
  const savedReports = deps.db.all<{ id: string }>(
    'SELECT id FROM sprint_reports WHERE run_id = ? AND scorecard_json IS NOT NULL ORDER BY id', runId
  ).map((row) => row.id)
  const stamp = runStamp(deps, file, runId, savedReports)
  const known = stamp === null ? null : deps.fileHashes.get(file, stamp)
  if (known !== null && matchesSync(deps.db, 'run', runId, known)) return null
  const bodyStamp = deps.fs.fileStamp(file)
  const text = requireText(deps, file)
  const trackedHash = trackedRunHash(text)
  const shown = displayPath(deps.layout, file)
  const record = parseRecord(runHistoryRecord, text, shown)
  if (record.runId !== runId) {
    reject(shown, 'belongs to a different run')
  }
  // `parseRecord` just validated this text, so it holds the reports; read raw, they are as written (no default filled).
  const raw: { reports: WrittenReport[] } = JSON.parse(text)
  const edited = editedReport(raw.reports)
  if (edited !== null) {
    reject(shown, edited)
  }
  const written = new Map(raw.reports.map((report) => [String(report.id), report.content]))
  const scorecards = validateRunScorecards(deps, { record, file, bodyStamp, hash: trackedHash })
  if (matchesSync(deps.db, 'run', runId, trackedHash)) return null
  return { runId, path: shown, record, scorecards, written, trackedHash }
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
  const changed = readUnlessSynced(deps, file, {
    hashOf: trackedCommentHash,
    synced: (hash) => commentSynced(deps.db, commentId, hash),
    read: () => readCommentText(deps, file, displayPath(deps.layout, file))
  })
  if (changed === null) {
    return null
  }
  const shown = displayPath(deps.layout, file)
  const record = parseRecord(commentRecord, changed.text, shown)
  if (record.id !== commentId) {
    reject(shown, 'names a different comment than its file name')
  }
  if (record.epicId !== epicId) {
    reject(shown, 'belongs to a different epic')
  }
  return { commentId, epicId, path: shown, record, trackedHash: changed.hash }
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

/**
 * `epics/` or `history/` as a link, redirected outside, or not a directory is reported and read as
 * empty: nothing is read through it, and the rest of the reconcile (and opening the repository) goes on.
 */
function listTopLevel(deps: ImporterDeps, dir: string, scan: Scan): string[] {
  try {
    return listEntries(deps, dir)
  } catch (error: unknown) {
    scan.rejected.push({ path: displayPath(deps.layout, dir), message: messageOf(error) })
    return []
  }
}

/**
 * The entries of `epics/` or `history/` to read: every one, or only the records `only` names (none listed when it names
 * none). A targeted read still lists the folder, so a missing record is skipped and a bad folder rejected as in a full one.
 */
function topLevelNames(deps: ImporterDeps, dir: string, scan: Scan, only: Set<string> | undefined): string[] {
  if (only === undefined) return listTopLevel(deps, dir, scan)
  return only.size === 0 ? [] : listTopLevel(deps, dir, scan).filter((name) => only.has(name))
}

function scanRepository(deps: ImporterDeps, records: TrackedRecords | null): Scan {
  const scan: Scan = { epics: [], runs: [], comments: [], unchanged: [], rejected: [], rejectedEpics: new Set() }
  const epicNames = topLevelNames(deps, deps.layout.epicsDir, scan, records?.epics)
  const runNames = topLevelNames(deps, deps.layout.historyDir, scan, records?.runs)
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
  { table: 'checkpoints', what: 'Checkpoint', ids: (record: RunHistoryRecord) => record.checkpoints.map((item) => item.id) },
  { table: 'row_checks', what: 'Row check', ids: (record: RunHistoryRecord) => (record.rowChecks ?? []).map((item) => item.id) },
  {
    table: 'experiment_events',
    what: 'Experiment event',
    ids: (record: RunHistoryRecord) => (record.experimentEvents ?? []).map((item) => item.id)
  }
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

/**
 * A report id already stored here must arrive with the content hash stored for it (its content was checked against
 * that hash when the file was read, `editedReport`): changed content for an existing report is refused, and this
 * machine's copy is kept. So is a report naming another scorecard than the one frozen here for it: a scorecard is
 * never replaced. A record that names none (written before scorecards) leaves the stored one as it is.
 */
function changedReport(db: Db, record: RunHistoryRecord): string | null {
  for (const report of record.reports) {
    const stored = db.get<{ content_hash: string; scorecard_hash: string | null }>(
      "SELECT content_hash, json_extract(scorecard_json, '$.snapshotHash') AS scorecard_hash FROM sprint_reports WHERE id = ?",
      report.id
    )
    if (stored !== undefined && stored.content_hash !== report.contentHash) {
      return `Report ${report.id} differs from the revision stored here (content hash ${stored.content_hash}); a report revision is never replaced, so the local one is kept.`
    }
    if (stored?.scorecard_hash != null && report.scorecard !== undefined && report.scorecard.snapshotHash !== stored.scorecard_hash) {
      return `Report ${report.id} names scorecard ${report.scorecard.snapshotHash}, not the one frozen here for it (${stored.scorecard_hash}); a scorecard is never replaced, so the local one is kept.`
    }
  }
  return null
}

/**
 * Experiment events are append-only: an event already stored must arrive exactly as stored, apart from its number, and
 * no other event may take its place in its experiment's order. Two machines may append to one run's history (the owner
 * of a follow-up run records results on the source run): an incoming event taking the number of an event stored here
 * that the incoming history does not hold is a fork, resolved by numbering this machine's event after the incoming ones
 * (`insertExperimentEvents`), unless both sides recorded statuses of one experiment (`forkedStatuses`). The machine
 * that resolved a fork exports that event under its new number, so a stored event arriving with nothing but another
 * number (in a sequence numbered 1 to n, `runHistoryRecord`) takes that number here too, and every machine that
 * imported the old number follows; the stored statuses keep their order (`reorderedEvents`), while a result may move
 * past a status, since another machine's fork resolution numbers it after statuses this machine already holds.
 */
function rewrittenEvent(db: Db, record: RunHistoryRecord): string | null {
  const incoming = new Map((record.experimentEvents ?? []).map((event) => [event.id, event]))
  for (const event of incoming.values()) {
    const stored = storedEvent(db, event.id)
    if (stored !== undefined && !renumberedOnly(stored, event)) {
      return `Experiment event ${event.id} differs from the one stored here; experiment events are never rewritten.`
    }
    const byNumber = db.get<{ id: string }>('SELECT id FROM experiment_events WHERE experiment_id = ? AND number = ?', event.experimentId, event.number)
    const holder = byNumber === undefined || byNumber.id === event.id ? undefined : incoming.get(byNumber.id)
    if (holder !== undefined && !renumberedOnly(storedEvent(db, holder.id), holder)) {
      return `Experiment event ${event.id} takes number ${event.number} of experiment ${event.experimentId}, which event ${holder.id} already holds here.`
    }
  }
  return reorderedEvents(db, record) ?? forkedStatuses(db, record)
}

/**
 * A resolved fork only numbers events after the ones both sides already hold, so the statuses of an experiment stored
 * here must arrive in the order they are stored: a renumbering that moves one status past another changes what the
 * experiment's status is, and is refused. Results are left out of the check: only a run's owner records statuses (a
 * status fork is refused, `forkedStatuses`), so a result recorded elsewhere legitimately moves past a status when
 * forks resolve on several machines in turn (a third machine that numbered a result after two statuses follows the
 * history that numbered it between them).
 */
function reorderedEvents(db: Db, record: RunHistoryRecord): string | null {
  const incoming = record.experimentEvents ?? []
  for (const experimentId of new Set(incoming.map((event) => event.experimentId))) {
    const stored = db.all<{ id: string }>('SELECT id FROM experiment_events WHERE experiment_id = ? ORDER BY number', experimentId).map((row) => row.id)
    const arriving = incoming
      .filter((event) => event.kind === 'status' && event.experimentId === experimentId && stored.includes(event.id))
      .sort((a, b) => a.number - b.number)
    const kept = stored.filter((id) => arriving.some((event) => event.id === id))
    if (arriving.some((event, index) => event.id !== kept[index])) {
      return `Experiment ${experimentId}'s statuses arrive in another order than stored here; a stored status never moves past another stored status, since that changes what the experiment's status is.`
    }
  }
  return null
}

function storedEvent(db: Db, eventId: string): ExperimentEvent | undefined {
  const row = db.get<{ event_json: string }>('SELECT event_json FROM experiment_events WHERE id = ?', eventId)
  return row === undefined ? undefined : (JSON.parse(row.event_json) as ExperimentEvent)
}

/** Whether `incoming` is the stored event exactly, or with another number only. */
function renumberedOnly(stored: ExperimentEvent | undefined, incoming: ExperimentEvent): boolean {
  return stored !== undefined && canonicalJson({ ...stored, number: 0 }) === canonicalJson({ ...incoming, number: 0 })
}

/** Events of the incoming run history this machine does not store yet. */
function arrivingEvents(db: Db, record: RunHistoryRecord): ExperimentEvent[] {
  return (record.experimentEvents ?? []).filter((event) => db.get('SELECT id FROM experiment_events WHERE id = ?', event.id) === undefined)
}

/** Events of the run stored here that the incoming run history does not hold (this machine's, not in the tracked file), in order. */
function localOnlyEvents(db: Db, record: RunHistoryRecord): ExperimentEvent[] {
  const incoming = new Set((record.experimentEvents ?? []).map((event) => event.id))
  return db
    .all<{ id: string; event_json: string }>('SELECT id, event_json FROM experiment_events WHERE run_id = ? ORDER BY experiment_id, number', record.runId)
    .filter((row) => !incoming.has(row.id))
    .map((row) => JSON.parse(row.event_json) as ExperimentEvent)
}

/**
 * A fork renumbers only when one side recorded results alone (only a run's owner records statuses): statuses of one
 * experiment recorded on two machines cannot be put in order, so the run history is refused.
 */
function forkedStatuses(db: Db, record: RunHistoryRecord): string | null {
  const arriving = arrivingEvents(db, record).filter((event) => event.kind === 'status')
  const local = localOnlyEvents(db, record).find((event) => event.kind === 'status' && arriving.some((item) => item.experimentId === event.experimentId))
  const other = arriving.find((event) => event.experimentId === local?.experimentId)
  return local === undefined || other === undefined
    ? null
    : `Experiment ${local.experimentId}'s statuses were recorded on two machines (event ${local.id} here, event ${other.id} in the tracked history), so they cannot be put in order; record statuses only on the machine that owns run ${record.runId}.`
}

/**
 * An event stored here but missing from the record is kept (it waits to be exported), so it must still fit the incoming
 * reports: the definition it cites must be there, by content hash. A run history that redefines an experiment under
 * stored events is refused rather than left unexportable.
 */
function redefinedUnderEvents(db: Db, record: RunHistoryRecord): string | null {
  const incoming = new Set((record.experimentEvents ?? []).map((event) => event.id))
  const reports = new Map(record.reports.map((report) => [report.id, report]))
  const stored = db.all<{ id: string; event_json: string }>('SELECT id, event_json FROM experiment_events WHERE run_id = ? ORDER BY experiment_id, number', record.runId)
  for (const row of stored.filter((item) => !incoming.has(item.id))) {
    const problem = eventProblem(JSON.parse(row.event_json) as ExperimentEvent, record.runId, reports)
    if (problem !== null) {
      return `Experiment event ${row.id} stored here ${problem} in the incoming run history; an experiment that has events is never redefined.`
    }
  }
  return null
}

/**
 * Every experiment's provenance is checked against the frozen scorecard it cites (arriving now or stored here): its
 * source must be exactly the reference the cited grade gives and its baseline exactly the value read from that grade.
 * A hand-edited baseline, seal, report or epic is refused.
 */
function forgedSource(record: RunHistoryRecord, scorecardFor: ScorecardLookup): string | null {
  for (const report of record.reports) {
    for (const experiment of report.content.retro?.experiments ?? []) {
      const problem = experiment.source.epicId === record.epicId ? sourceProblem(experiment, report, scorecardFor) : `cites epic ${experiment.source.epicId}`
      if (problem !== null) return `Experiment ${experiment.id} of report ${report.id} ${problem}.`
    }
  }
  return null
}

/**
 * An epic as a cross-epic result check reads it: arriving now (its snapshots), else stored here (its saved
 * revisions); undefined when this machine has neither.
 */
type HolderLookup = (epicId: string) => CorrectionHolder | undefined

function holderLookup(db: Db, staged: Map<string, EpicFiles>): HolderLookup {
  return (epicId) => {
    const arriving = staged.get(epicId)
    if (arriving !== undefined) return { epicId, provenance: arriving.state.provenance, bundles: arriving.snapshots.map((snapshot) => snapshot.bundle) }
    const epic = db.get<{ provenance_json: string | null }>('SELECT provenance_json FROM epics WHERE id = ?', epicId)
    if (epic === undefined) return undefined
    const bundles = db.all<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE epic_id = ? ORDER BY number', epicId).map((row) => JSON.parse(row.bundle_json) as PlanBundle)
    return { epicId, provenance: parseJson<EpicProvenance | null>(epic.provenance_json, null), bundles }
  }
}

/**
 * A result read from another epic's grade must cite an epic of this project holding the experiment's corrective work:
 * a follow-up whose provenance names the experiment's epic, or this project's own cross-repository correction epic for
 * it (the active repository chosen as its own target), whose saved revision carries the experiment's correction
 * markers under its key with one payload hash (`correctionHolderProblem`). An epic that is not here (deleted, or never
 * shared) cannot be checked: the event is imported and reads as citing a scorecard that is not here, and once that
 * epic's records arrive the outcome checks the result against its grade (`experimentOutcome`).
 */
function foreignResultProblem(
  event: Extract<ExperimentEvent, { kind: 'result' }>,
  experiment: RetroExperiment,
  record: RunHistoryRecord,
  checks: { holderFor: HolderLookup; projectId: string }
): string | null {
  const cited = event.result.assessment
  if (cited === null || cited.epicId === record.epicId) return null
  const holder = checks.holderFor(cited.epicId)
  if (holder === undefined) return null
  const problem = correctionHolderProblem(holder, experiment, checks.projectId)
  return problem === null ? null : `cites a grade of epic ${cited.epicId}, which holds no corrective work of experiment ${experiment.id} (${problem})`
}

/**
 * Where a result's cited scorecard is read, and what is wrong with where it comes from. A result carrying the grade of
 * another project's correction epic (the Dark Mechanicus source, `crossRepo`) is checked first and whole
 * (`crossRepoEvidenceProblem`: bound to this project's request, sealed, regraded), and only then read from what it
 * carries; it never stands in for a grade of this project. Any other result reads this project's scorecards.
 */
function citedSource(
  event: Extract<ExperimentEvent, { kind: 'result' }>,
  experiment: RetroExperiment,
  record: RunHistoryRecord,
  checks: { scorecardFor: ScorecardLookup; holderFor: HolderLookup; projectId: string }
): { problem: string | null; lookup: ScorecardLookup } {
  const carried = event.result.crossRepo
  if (carried === undefined) return { problem: foreignResultProblem(event, experiment, record, checks), lookup: checks.scorecardFor }
  const cited = event.result.assessment
  const own = [record.epicId, ...(cited !== null && checks.holderFor(cited.epicId) !== undefined ? [cited.epicId] : [])]
  const problem = crossRepoEvidenceProblem(carried, experiment, { projectId: checks.projectId, own, regrade: true }, cited)
  return { problem, lookup: (reportId) => (reportId === carried.scorecard.report.reportId ? carried.scorecard : undefined) }
}

/**
 * Every result read from an assessment must cite the experiment's epic or a follow-up epic holding its corrective
 * work (`foreignResultProblem`), or carry a checked grade of another project's correction epic (`citedSource`), and
 * be exactly what that frozen assessment holds for the baseline's measure. A cited scorecard that is not here (arriving
 * or stored) does not hold the run history back forever: the event is imported, its outcome reads the scorecard as not
 * here, and the outcome checks the result against it once it arrives.
 */
function forgedResult(record: RunHistoryRecord, scorecardFor: ScorecardLookup, holderFor: HolderLookup, projectId: string): string | null {
  const definitions = new Map<string, RetroExperiment>(record.reports.flatMap((report) => (report.content.retro?.experiments ?? []).map((item) => [item.id, item] as const)))
  for (const event of record.experimentEvents ?? []) {
    const experiment = definitions.get(event.experimentId)
    if (event.kind !== 'result' || experiment === undefined) continue
    const { problem, lookup } = citedSource(event, experiment, record, { scorecardFor, holderFor, projectId })
    const absent = event.result.assessment !== null && lookup(event.result.assessment.reportId) === undefined
    const found = problem ?? (absent ? null : resultProblem(event.result, experiment.baseline.measure, lookup))
    if (found !== null) return `Experiment event ${event.id} ${found}.`
  }
  return null
}

/** What an incoming run history is checked against: the epics arriving now, the scorecards here, and this project. */
interface RunChecks {
  staged: Map<string, EpicFiles>
  scorecardFor: ScorecardLookup
  projectId: string
}

/** The experiment checks of an incoming run history, in order: append-only events, no redefinition, provenance. */
function experimentClash(db: Db, record: RunHistoryRecord, against: RunChecks): string | null {
  return (
    rewrittenEvent(db, record) ??
    redefinedUnderEvents(db, record) ??
    forgedSource(record, against.scorecardFor) ??
    forgedResult(record, against.scorecardFor, holderLookup(db, against.staged), against.projectId)
  )
}

/**
 * A run must reference a known epic and a revision of that epic, its scorecards must have been graded under revisions
 * of that epic, it must not claim others' rows or rewrite (or redefine under) an experiment event stored here, and its
 * experiments must follow from the scorecards they cite.
 */
function runClash(db: Db, run: Pick<RunFiles, 'record' | 'scorecards'>, against: RunChecks): string | null {
  const { record } = run
  const stagedEpic = against.staged.get(record.epicId)
  const epicKnown = stagedEpic !== undefined || db.get('SELECT id FROM epics WHERE id = ?', record.epicId) !== undefined
  if (!epicKnown) {
    return `Run ${record.runId} belongs to unknown epic ${record.epicId}.`
  }
  const knownRevision = (revisionId: string): boolean =>
    stagedEpic?.snapshots.some((snapshot) => snapshot.revisionId === revisionId) === true ||
    db.get<{ epic_id: string }>('SELECT epic_id FROM plan_revisions WHERE id = ?', revisionId)?.epic_id === record.epicId
  if (!knownRevision(record.revisionId)) {
    return `Run ${record.runId} is pinned to unknown revision ${record.revisionId}.`
  }
  // A scorecard is graded under the plan the run held at its report: it must be a revision of the same epic.
  const graded = [...run.scorecards.values()].find((snapshot) => !knownRevision(snapshot.planRevisionId))
  if (graded !== undefined) {
    return `The scorecard of report ${graded.report.reportId} names plan revision ${graded.planRevisionId}, which is not a revision of epic ${record.epicId}.`
  }
  const existing = db.get<{ epic_id: string }>('SELECT epic_id FROM runs WHERE id = ?', record.runId)
  if (existing !== undefined && existing.epic_id !== record.epicId) {
    return `Run ${record.runId} already exists locally for another epic.`
  }
  return foreignChild(db, record) ?? changedReport(db, record) ?? experimentClash(db, record, against)
}

/**
 * The sealed scorecard of a report as an import sees it: one arriving now (checked against its seal and regraded when
 * read), else the one stored here (checked when it was written or imported).
 */
function scorecardLookup(db: Db, scan: Scan): ScorecardLookup {
  const arriving = new Map(scan.runs.flatMap((run) => [...run.scorecards]))
  return (reportId) => {
    const stored = arriving.has(reportId) ? null : db.get<{ scorecard_json: string | null }>('SELECT scorecard_json FROM sprint_reports WHERE id = ?', reportId)?.scorecard_json
    return arriving.get(reportId) ?? (stored == null ? undefined : (JSON.parse(stored) as ScorecardSnapshot))
  }
}

/** Starts the conflict of an epic whose tracked records changed while its local changes wait to be exported. */
export const EPIC_RECORDS_CONFLICT_PREFIX = 'Tracked records for epic '

/**
 * Neither side is applied, and the finalizer will not write over the tracked records either (`exportEpic`), so only
 * the person's choice (`resolveEpicConflict`) settles it.
 */
function epicConflictMessage(epicId: string): string {
  return (
    `${EPIC_RECORDS_CONFLICT_PREFIX}${epicId} changed while local changes are waiting to be exported, so neither was ` +
    "applied. Choose which to keep in the desktop app's Storage card: keep the tracked records (the epic's local " +
    "changes are dropped) or write local (this machine's records of the epic replace them)."
  )
}

interface TransferHold {
  transfer: OpenTransfer
  revisionIds: string[]
  runIds: string[]
}

function transferHoldMessage(epicId: string, hold: TransferHold): string {
  const held = [
    hold.revisionIds.length > 0 ? `saved revision ${hold.revisionIds.join(', ')}` : null,
    hold.runIds.length > 0 ? `run ${hold.runIds.join(', ')}` : null
  ].filter((part) => part !== null)
  const status = hold.transfer.status === 'in_progress' ? 'in progress' : 'queued'
  return (
    `${TRANSFER_HOLD_PREFIX}${epicId}: tracked records bring ${held.join(' and ')} while its Linear transfer of revision ` +
    `${hold.transfer.revisionId} is ${status}, so the epic's tracked plan, state and run changes were not imported. ` +
    'Cancel the transfer, then reconcile again.'
  )
}

/**
 * `transfers` is local only, so another machine can save a plan or start a run while this one transfers the
 * epic to Linear. For an epic whose transfer is queued or in progress, any incoming saved revision this
 * database lacks, a pointer off the transferred revision, or any incoming run holds back every tracked change
 * of that epic (one conflict each); the first reconcile after the transfer is canceled imports them. While the
 * hold stands, the epic state export and the transfer's completion are refused (`hasTransferHold`).
 * Saving is refused here while the transfer is open, so the transferred revision is the newest saved one: an
 * unknown revision is a newer save from elsewhere, including one numbered like the transferred revision
 * because two machines saved from the same base.
 */
function planTransferHolds(db: Db, scan: Scan, plan: Plan): Set<string> {
  const holds = new Map<string, TransferHold>()
  const holdFor = (epicId: string): TransferHold | null => {
    const known = holds.get(epicId)
    if (known !== undefined) {
      return known
    }
    const transfer = findOpenTransfer(db, epicId)
    if (transfer === null) {
      return null
    }
    const hold: TransferHold = { transfer, revisionIds: [], runIds: [] }
    holds.set(epicId, hold)
    return hold
  }
  for (const files of scan.epics) {
    const hold = holdFor(files.epicId)
    if (hold === null) {
      continue
    }
    const added = files.snapshots
      .filter((snapshot) => db.get("SELECT id FROM plan_revisions WHERE id = ? AND state = 'saved'", snapshot.revisionId) === undefined)
      .map((snapshot) => snapshot.revisionId)
    const moved = files.pointer.revisionId !== hold.transfer.revisionId && !added.includes(files.pointer.revisionId)
    hold.revisionIds.push(...added, ...(moved ? [files.pointer.revisionId] : []))
  }
  for (const run of scan.runs) {
    holdFor(run.record.epicId)?.runIds.push(run.runId)
  }
  const held = new Set<string>()
  for (const [epicId, hold] of holds) {
    if (hold.revisionIds.length > 0 || hold.runIds.length > 0) {
      held.add(epicId)
      plan.conflicts.push({ kind: 'epic', entityId: epicId, epicId, message: transferHoldMessage(epicId, hold) })
    }
  }
  return held
}

function planEpics(db: Db, scan: Scan, plan: Plan, held: Set<string>): Set<string> {
  const skipped = new Set([...scan.rejectedEpics, ...held])
  for (const files of scan.epics.filter((item) => !held.has(item.epicId))) {
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

/**
 * A run whose changes wait to be exported here is not applied from the tracked history over them: that is a
 * conflict that waits, unless the changes on either side are experiment events another machine may append (results
 * read from a follow-up run it owns). On a run this machine owns, the events other machines appended are merged in
 * (`planOwnMerge`), and the waiting export writes both. On a run it does not own, holding events the tracked history
 * lacks (its own results), the tracked history applies as usual and those events are numbered after its own
 * (`insertExperimentEvents`).
 */
function planRuns(db: Db, scan: Scan, plan: Plan, from: { skippedEpics: Set<string>; projectId: string; machineId: string }): void {
  const staged = new Map(plan.epics.map((files) => [files.epicId, files]))
  const checks: RunChecks = { staged, scorecardFor: scorecardLookup(db, scan), projectId: from.projectId }
  for (const run of scan.runs.filter((item) => !from.skippedEpics.has(item.record.epicId))) {
    if (hasPendingRunChanges(db, run.runId)) {
      const owned = db.get<{ owner_machine_id: string }>('SELECT owner_machine_id FROM runs WHERE id = ?', run.runId)?.owner_machine_id === from.machineId
      const appended = owned ? arrivingEvents(db, run.record) : localOnlyEvents(db, run.record)
      if (appended.length === 0) {
        const message = `Tracked history for run ${run.runId} changed while local run changes are waiting to be exported.`
        plan.conflicts.push({ kind: 'run', entityId: run.runId, epicId: run.record.epicId, message })
        continue
      }
      if (owned) {
        planOwnMerge(db, run, plan, checks)
        continue
      }
    }
    const clash = runClash(db, run, checks)
    if (clash === null) {
      plan.runs.push(run)
    } else {
      plan.rejected.push({ path: run.path, message: clash })
    }
  }
}

/**
 * Experiment events another machine appended to a run this machine owns while its own changes wait to be exported:
 * merged in when they fit the reports stored here and pass every event check of an import (`mergeClash`).
 */
function planOwnMerge(db: Db, run: RunFiles, plan: Plan, checks: RunChecks): void {
  const clash = mergeClash(db, run.record, checks)
  if (clash === null) {
    plan.eventMerges.push(run)
  } else {
    plan.rejected.push({ path: run.path, message: clash })
  }
}

/**
 * Arriving events must cite definitions the reports stored here hold, and pass the event checks of any import, judged
 * against the reports stored here: they are the owner's, and the tracked ones may predate a revision it has not
 * exported yet (a restatement whose events wait to be exported with it).
 */
function mergeClash(db: Db, record: RunHistoryRecord, against: RunChecks): string | null {
  const { reports } = buildRunHistoryRecord(db, record.runId)
  const byId = new Map(reports.map((report) => [report.id, report]))
  for (const event of arrivingEvents(db, record)) {
    const problem = eventProblem(event, record.runId, byId)
    if (problem !== null) return `Experiment event ${event.id} ${problem} here, so it is not merged into run ${record.runId}.`
  }
  return changedReport(db, record) ?? experimentClash(db, { ...record, reports }, against)
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

function planImport(db: Db, scan: Scan, from: { projectId: string; machineId: string }): Plan {
  const plan: Plan = {
    epics: [],
    runs: [],
    eventMerges: [],
    comments: [],
    syncedComments: [],
    unchanged: [...scan.unchanged],
    conflicts: [],
    rejected: [...scan.rejected]
  }
  planRuns(db, scan, plan, { skippedEpics: planEpics(db, scan, plan, planTransferHolds(db, scan, plan)), ...from })
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
    `INSERT INTO epics (id, title, status, current_revision_id, branch_json, repository_branches_json, provenance_json,
       outcome_json, revision, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status,
       current_revision_id = excluded.current_revision_id, branch_json = excluded.branch_json,
       repository_branches_json = excluded.repository_branches_json,
       provenance_json = excluded.provenance_json, outcome_json = excluded.outcome_json, revision = epics.revision + 1,
       updated_at = excluded.updated_at, completed_at = excluded.completed_at`,
    files.epicId,
    state.title,
    state.status,
    pointer.revisionId,
    state.branch === null ? null : toJson(state.branch),
    state.repositoryBranches === undefined ? null : toJson(state.repositoryBranches),
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
     ON CONFLICT(id) DO UPDATE SET state = 'saved', saved_at = COALESCE(plan_revisions.saved_at, excluded.saved_at)
       WHERE plan_revisions.state <> 'saved' OR plan_revisions.saved_at IS NULL`,
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
  db.run('UPDATE epics SET standards_json = ? WHERE id = ?', files.state.standards ? toJson(files.state.standards) : null, files.epicId)
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

function indexEpic(db: Db, files: EpicFiles, reindexTickets: boolean): void {
  const { bundle } = files.current
  const intent = [bundle.epic.intent, ...bundle.epic.successCriteria.map((item) => item.text)]
  const body = [...intent, files.state.outcome?.summary ?? ''].filter((part) => part !== '').join('\n')
  indexDocument(db, { docType: 'epic', docId: files.epicId, epicId: files.epicId, title: files.state.title, body })
  if (!reindexTickets) return
  db.run("DELETE FROM search_index WHERE doc_type = 'ticket' AND epic_id = ?", files.epicId)
  for (const ticket of bundle.tickets) {
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
  const previous = db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', files.epicId)
  upsertEpic(db, files)
  for (const snapshot of files.snapshots) {
    upsertRevision(db, snapshot)
  }
  upsertTicketStatuses(db, files)
  markSynced(db, { kind: 'epic', entityId: files.epicId, hash: files.trackedHash, generation: files.pointer.generation, now })
  indexEpic(db, files, previous?.current_revision_id !== files.pointer.revisionId)
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

/** What `increment_json` holds: a folder of repositories' array of verdicts, the single verdict, or NULL for neither. */
function incrementJson(attempt: AttemptRecord): string | null {
  const stored = attempt.increments ?? attempt.increment
  return stored === undefined ? null : toJson(stored)
}

function upsertAttempt(db: Db, runId: string, attempt: AttemptRecord): void {
  db.run(
    `INSERT INTO attempts (id, run_id, ticket_id, number, kind, state, fencing_token, claim_secret, worker_json,
       revision_id, ticket_content_hash, lease_expires_at, heartbeat_at, outputs_json, evidence_json, failure_json,
       decision_json, increment_json, created_at, updated_at, submitted_at, decided_at, reconciled_at, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ticket_id = excluded.ticket_id, number = excluded.number, kind = excluded.kind,
       state = excluded.state, fencing_token = excluded.fencing_token, claim_secret = NULL,
       worker_json = excluded.worker_json, revision_id = excluded.revision_id,
       ticket_content_hash = excluded.ticket_content_hash, lease_expires_at = NULL, heartbeat_at = NULL,
       outputs_json = excluded.outputs_json, evidence_json = excluded.evidence_json,
       failure_json = excluded.failure_json, decision_json = excluded.decision_json,
       increment_json = excluded.increment_json, updated_at = excluded.updated_at,
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
    incrementJson(attempt),
    attempt.createdAt,
    attempt.updatedAt,
    attempt.submittedAt,
    attempt.decidedAt,
    attempt.reconciledAt,
    attempt.supersededAt
  )
}

/**
 * Reports are upserted from the record, each with its content as written in the file (`RunFiles.written`, which
 * hashes to its contentHash), so the export writes back exactly what was hashed. A report's scorecard is stored as
 * canonical JSON (the bytes it was exported with) and, once stored, is never replaced or cleared: a record written by an
 * app that predates scorecards leaves the frozen one as it is (one naming another snapshot for the same revision was
 * refused, `changedReport`).
 */
function upsertReportsAndCheckpoints(db: Db, record: RunHistoryRecord, scorecards: ReadonlyMap<string, ScorecardSnapshot>, written: ReadonlyMap<string, unknown>): void {
  for (const report of record.reports) {
    const scorecard = scorecards.get(report.id)
    db.run(
      `INSERT INTO sprint_reports (id, run_id, sprint_id, report_revision, content_json, content_hash, submitted_by,
         created_at, scorecard_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET sprint_id = excluded.sprint_id, report_revision = excluded.report_revision,
         content_json = excluded.content_json, content_hash = excluded.content_hash,
         submitted_by = excluded.submitted_by, scorecard_json = COALESCE(sprint_reports.scorecard_json, excluded.scorecard_json)`,
      report.id,
      record.runId,
      report.sprintId,
      report.reportRevision,
      toJson(written.get(report.id) ?? report.content),
      report.contentHash,
      report.submittedBy,
      report.createdAt,
      scorecard === undefined ? null : canonicalJson(scorecard)
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

function upsertRowChecks(db: Db, record: RunHistoryRecord): void {
  for (const check of record.rowChecks ?? []) {
    db.run(
      `INSERT INTO row_checks (id, run_id, number, sprint_id, row_no, commit_ref, checks_json, recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET number = excluded.number, sprint_id = excluded.sprint_id, row_no = excluded.row_no,
         commit_ref = excluded.commit_ref, checks_json = excluded.checks_json, recorded_by = excluded.recorded_by`,
      check.id,
      record.runId,
      check.number,
      check.sprintId,
      check.row,
      check.commit,
      toJson(check.checks),
      check.recordedBy,
      check.createdAt
    )
  }
}

/** Added to an event's number while it moves, so no move lands on a number another moving event has not left yet. */
const MOVING = 1_000_000

/**
 * New experiment events are added; a stored one is never replaced (`rewrittenEvent` refused any that differ but in
 * number), and one arriving under another number (a fork another machine resolved) takes it. This machine's events
 * of the run that the incoming history does not hold (not exported yet, or written over by another machine's export)
 * are numbered after the incoming events of their experiment, in their order, and the run history is queued for
 * export so they reach the tracked file.
 */
function insertExperimentEvents(db: Db, record: RunHistoryRecord, clock: Clock): void {
  const incoming = record.experimentEvents ?? []
  const local = localOnlyEvents(db, record)
  const last = new Map<string, number>()
  for (const event of incoming) last.set(event.experimentId, Math.max(last.get(event.experimentId) ?? 0, event.number))
  const renumbered = local.map((event) => {
    const number = (last.get(event.experimentId) ?? 0) + 1
    last.set(event.experimentId, number)
    return { before: event.number, event: { ...event, number } }
  })
  const adopted = incoming.flatMap((event) => {
    const stored = storedEvent(db, event.id)
    return stored === undefined ? [] : [{ before: stored.number, event }]
  })
  const moves = [...renumbered, ...adopted].filter((item) => item.before !== item.event.number)
  for (const { event } of moves) db.run('UPDATE experiment_events SET number = number + ? WHERE id = ?', MOVING, event.id)
  for (const { event } of moves) {
    db.run('UPDATE experiment_events SET number = ?, event_json = ? WHERE id = ?', event.number, toJson(event), event.id)
  }
  for (const event of incoming) {
    db.run(
      `INSERT INTO experiment_events (id, run_id, number, experiment_id, recorded_at, event_json)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      event.id,
      record.runId,
      event.number,
      event.experimentId,
      event.recordedAt,
      toJson(event)
    )
  }
  if (local.length > 0) enqueueOutbox({ db, clock }, { kind: 'run_history', epicId: record.epicId, runId: record.runId })
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
    const retro = content.retro == null ? [] : retroSearchParts(content.retro, (ticketId) => keys.get(ticketId) ?? ticketId)
    indexDocument(db, {
      docType: 'report',
      docId: report.id,
      epicId: record.epicId,
      runId: record.runId,
      title: `Sprint report ${report.reportRevision}`,
      body: [content.summary, ...content.risks, ...followUps, ...retro].join('\n')
    })
  }
}

function applyRun(db: Db, run: RunFiles, at: { now: string; clock: Clock }): void {
  const { record } = run
  upsertRun(db, record)
  // Closed attempts first, so an attempt that closes never collides with the one-open-attempt index.
  const isOpen = (attempt: AttemptRecord): boolean => OPEN_ATTEMPT_STATES.includes(importedAttemptState(attempt))
  for (const attempt of [...record.attempts.filter((item) => !isOpen(item)), ...record.attempts.filter(isOpen)]) {
    upsertAttempt(db, record.runId, attempt)
  }
  upsertReportsAndCheckpoints(db, record, run.scorecards, run.written)
  upsertRowChecks(db, record)
  insertExperimentEvents(db, record, at.clock)
  markSynced(db, { kind: 'run', entityId: run.runId, hash: run.trackedHash, generation: null, now: at.now })
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
  for (const ref of record.attachments ?? []) {
    if (db.get('SELECT id FROM attachments WHERE id = ?', ref.id) === undefined) {
      insertOwnedRow(db, ref, { owner: 'comment', ownerId: record.id, createdAt: record.createdAt })
    }
  }
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

/**
 * A record validated as synced no longer has a tracked/local divergence. Transfer holds also need
 * recomputation when their held files disappear. Conflicts on unread or rejected records are kept.
 */
function storeConflicts(db: Db, conflicts: Conflict[], unchanged: string[], now: string): void {
  db.run(
    `UPDATE sync_state SET conflict = NULL, updated_at = ? WHERE conflict IS NOT NULL AND (
       (kind = 'epic' AND substr(conflict, 1, ?) = ?)
       OR (kind IN ('epic', 'run', 'comment') AND entity_id IN (SELECT value FROM json_each(?)))
       OR (kind = 'profile' AND 'profile:' || entity_id IN (SELECT value FROM json_each(?)))
     )`,
    now,
    TRANSFER_HOLD_PREFIX.length,
    TRANSFER_HOLD_PREFIX,
    JSON.stringify(unchanged),
    JSON.stringify(unchanged)
  )
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

interface StagedOutcome {
  imported: string[]
  savedEpics: string[]
  importedRuns: string[]
  changedEpics: Set<string>
  rejected: Rejection[]
}

function applyStaged(deps: ImporterDeps, plan: Plan, now: string): StagedOutcome {
  const rejected = [...plan.rejected]
  const imported: string[] = []
  const failedEpics = new Set<string>()
  const changedEpics = new Set<string>()
  const savedEpics: string[] = []
  const importedRuns: string[] = []
  for (const files of plan.epics) {
    const applied = applyItem(deps.db, files.path, () => applyEpic(deps.db, files, now), rejected)
    if (applied) {
      imported.push(files.epicId)
      savedEpics.push(files.epicId)
      changedEpics.add(files.epicId)
    } else {
      failedEpics.add(files.epicId)
    }
  }
  for (const run of plan.runs.filter((item) => !failedEpics.has(item.record.epicId))) {
    if (applyItem(deps.db, run.path, () => applyRun(deps.db, run, { now, clock: deps.clock }), rejected)) {
      imported.push(run.runId)
      importedRuns.push(run.runId)
      changedEpics.add(run.record.epicId)
    }
  }
  for (const run of plan.eventMerges) {
    if (applyItem(deps.db, run.path, () => insertExperimentEvents(deps.db, run.record, deps.clock), rejected)) {
      imported.push(run.runId)
      changedEpics.add(run.record.epicId)
    }
  }
  applyComments(deps.db, plan, { now, failedEpics, imported, rejected, changedEpics })
  return { imported, rejected, changedEpics, savedEpics, importedRuns }
}

interface CommentApply {
  now: string
  failedEpics: Set<string>
  changedEpics: Set<string>
  imported: string[]
  rejected: Rejection[]
}

function applyComments(db: Db, plan: Plan, apply: CommentApply): void {
  for (const file of plan.comments.filter((item) => !apply.failedEpics.has(item.epicId))) {
    if (applyItem(db, file.path, () => applyComment(db, file, apply.now), apply.rejected)) {
      apply.imported.push(file.commentId)
      apply.changedEpics.add(file.epicId)
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
  scan: Scan
  plan: Plan
  profiles: ProfileScan
  kanban: KanbanScan
  current: string | null
  branchChanged: boolean
  /** Which records this reconcile read, and the status it started from (the marker it leaves). */
  scope: ReconcileScope
}

/** The record's file holds what this database last exported or imported, and no conflict is stored for it. */
function settled(db: Db, kind: string, entityId: string, hash: string): boolean {
  return db.get(
    'SELECT 1 FROM sync_state WHERE kind = ? AND entity_id = ? AND conflict IS NULL AND (exported_hash = ? OR imported_hash = ?)',
    kind, entityId, hash, hash
  ) !== undefined
}

function cardSettled(db: Db, card: KanbanScan['cards'][number]): boolean {
  return (card.definition === null || settled(db, 'kanban_card', card.cardId, card.definition.trackedHash)) &&
    [...card.events, ...card.syncedEvents].every((event) => settled(db, 'kanban_event', event.eventId, event.trackedHash))
}

/**
 * Paths of what this reconcile read as changed but did not settle (refused, in conflict, or waiting on another record),
 * and of every rejection: the next reconcile reads them again, as a full one would.
 */
function unsettledRecords(deps: ImporterDeps, context: ApplyContext, rejectedPaths: string[]): string[] {
  const { db } = deps
  const { scan, kanban, profiles } = context
  return unsettledPaths({
    epics: [
      ...scan.epics.filter((files) => !settled(db, 'epic', files.epicId, files.trackedHash)).map((files) => files.epicId),
      ...scan.comments.filter((file) => !settled(db, 'comment', file.commentId, file.trackedHash)).map((file) => file.epicId)
    ],
    runs: scan.runs.filter((run) => !settled(db, 'run', run.runId, run.trackedHash)).map((run) => run.runId),
    kanbanCards: [...kanban.cards.filter((card) => !cardSettled(db, card)).map((card) => card.cardId), ...kanban.conflicts.map((conflict) => conflict.cardId)],
    profiles: [
      ...profiles.staged.filter((profile) => !settled(db, 'profile', profile.name, profile.trackedHash)).map((profile) => profile.name),
      ...profiles.conflicts.map((conflict) => conflict.name)
    ],
    rejectedPaths,
    shownDmDir: displayPath(deps.layout, deps.layout.dmDir)
  })
}

/**
 * Whether the conflicts and rejections differ from those the previous reconcile reported (stored
 * as a digest in meta), so a file that stays rejected is not recorded again on every heartbeat.
 */
function problemsDigest(result: ReconcileResultView): string {
  const { conflicts, profileConflicts, kanbanConflicts, rejected } = result
  return contentHash({ conflicts, profileConflicts, kanbanConflicts, rejected })
}

function problemsChanged(db: Db, result: ReconcileResultView): boolean {
  const { conflicts, profileConflicts, kanbanConflicts, rejected } = result
  const digest = problemsDigest(result)
  const previous = getMeta(db, META_KEYS.reconcileProblems)
  if (previous === digest) return false
  setMeta(db, META_KEYS.reconcileProblems, digest)
  return previous !== null || conflicts.length + profileConflicts.length + kanbanConflicts.length + rejected.length > 0
}

/**
 * Records a `repository.reconciled` event when the reconcile imported something, saw the branch
 * change, repairs stored attachments, or adds or clears a conflict or rejection.
 */
function recordReconciled(deps: ImporterDeps, result: ReconcileResultView,
  changes: { changedEpics: string[]; kanbanChanged: boolean; attachmentsChanged: boolean }): void {
  const { imported, rejected, branchChanged, pausedRuns } = result
  const conflicts = result.conflicts.length + result.profileConflicts.length + result.kanbanConflicts.length
  const { changedEpics, kanbanChanged, attachmentsChanged } = changes
  rememberValidatedRepositoryCache(deps.db, conflicts === 0 && rejected.length === 0)
  const refreshAll = problemsChanged(deps.db, result) || attachmentsChanged
  if (imported.length > 0 || branchChanged || refreshAll) {
    const payload = { imported, unchanged: result.unchanged.length, conflicts, rejected: rejected.length, branchChanged, pausedRuns,
      changedEpics, kanbanChanged, ...(refreshAll ? { refreshAll: true } : {}) }
    insertEvent(deps, { kind: 'repository.reconciled', payload })
  }
}

/** Registers the attachments the records imported now name (all of them, once per database). */
function registerAttachments(deps: ImporterDeps, now: string, imported: { runs: string[]; cards: string[]; epics: string[] }): void {
  if (getMeta(deps.db, META_KEYS.attachmentRegistration) !== '1') {
    registerEvidenceAttachments(deps.db, now)
    registerTicketAttachments(deps.db, now)
    setMeta(deps.db, META_KEYS.attachmentRegistration, '1')
  } else {
    registerEvidenceAttachments(deps.db, now, { runs: imported.runs, cards: imported.cards })
    registerTicketAttachments(deps.db, now, imported.epics)
  }
}

/** An archive only fills a row without bytes, so a targeted reconcile reads `recovered-attachments/` only when git reports it or such a row waits. */
function readsRecoveredAttachments(deps: ImporterDeps, targeted: TrackedRecords | null): boolean {
  return targeted === null || targeted.recoveredAttachments ||
    deps.db.get('SELECT 1 FROM attachments WHERE data IS NULL OR missing = 1 LIMIT 1') !== undefined
}

/** Imports `recovered-attachments/` when `readsRecoveredAttachments`. */
function recoverAttachments(deps: ImporterDeps, targeted: TrackedRecords | null): { rejected: { path: string; message: string }[]; changed: boolean } {
  return readsRecoveredAttachments(deps, targeted) ? applyRecoveredAttachments(deps, prepareRecoveredAttachments(deps)) : { rejected: [], changed: false }
}

function observationScope(targeted: TrackedRecords | null): ObservationScope | undefined {
  return targeted === null ? undefined : { projectLevel: targeted.projectObservations, epics: targeted.epics }
}

function heldEpics(db: Db): string[] {
  return db.all<{ id: string }>('SELECT id FROM epics ORDER BY id').map((row) => row.id)
}

/** Applies staged profiles, each under its own transaction so one the database refuses is reported without undoing the others. */
function applyProfiles(db: Db, profiles: ProfileScan, now: string): { imported: string[]; rejected: Rejection[] } {
  const imported: string[] = []
  const rejected = [...profiles.rejected]
  for (const profile of profiles.staged) {
    if (applyItem(db, profile.path, () => applyProfile(db, profile, now), rejected)) imported.push(`profile:${profile.name}`)
  }
  storeProfileConflicts(db, profiles, now)
  return { imported, rejected }
}

/** Applies staged cards, each under its own transaction; returns the `kanban:<cardId>` keys whose definition or events changed. */
function applyKanban(db: Db, kanban: KanbanScan, now: string): { imported: string[]; rejected: Rejection[] } {
  const imported: string[] = []
  const rejected = [...kanban.rejected]
  for (const card of kanban.cards) {
    if (applyItem(db, card.path, () => applyCard(db, card, now), rejected) && (card.definition !== null || card.events.length > 0)) {
      imported.push(`kanban:${card.cardId}`)
    }
  }
  storeKanbanConflicts(db, kanban.conflicts, now)
  return { imported, rejected }
}

function applyPlan(deps: ImporterDeps, context: ApplyContext): ReconcileResultView {
  const { plan, profiles, kanban, branchChanged, scope } = context
  const now = deps.clock.nowIso()
  rememberProject(deps.db, context.project)
  const staged = applyStaged(deps, plan, now)
  const profileOutcome = applyProfiles(deps.db, profiles, now)
  const kanbanOutcome = applyKanban(deps.db, kanban, now)
  // After epics and runs, so an observation of a run imported now resolves.
  const targeted = scope.changes.kind === 'targeted' ? scope.changes : null
  const observationOutcome = applyObservations(deps, scanObservations(deps, heldEpics(deps.db), observationScope(targeted)), now)
  registerAttachments(deps, now, { runs: staged.importedRuns, cards: kanbanOutcome.imported.map((key: string) => key.slice('kanban:'.length)), epics: staged.savedEpics })
  const recovered = recoverAttachments(deps, targeted)
  const attachmentOutcome = applyAttachmentFiles(deps, prepareAttachmentFiles(deps))
  storeConflicts(deps.db, plan.conflicts, [...plan.unchanged, ...profiles.unchanged], now)
  const pausedRuns = branchChanged ? pauseActiveRuns(deps, now) : []
  const result: ReconcileResultView = {
    imported: [...staged.imported, ...profileOutcome.imported, ...kanbanOutcome.imported, ...observationOutcome.imported],
    unchanged: [...plan.unchanged, ...profiles.unchanged, ...kanban.unchanged],
    conflicts: plan.conflicts.map((conflict) => ({ epicId: conflict.epicId, message: conflict.message })),
    profileConflicts: profiles.conflicts,
    kanbanConflicts: kanban.conflicts.map((conflict) => ({ cardId: conflict.cardId, message: conflict.message })),
    rejected: [
      ...staged.rejected,
      ...profileOutcome.rejected,
      ...kanbanOutcome.rejected,
      ...observationOutcome.rejected,
      ...attachmentOutcome.rejected,
      ...recovered.rejected
    ],
    branchChanged,
    pausedRuns
  }
  recordReconciled(deps, result, {
    changedEpics: [...staged.changedEpics],
    kanbanChanged: kanbanOutcome.imported.length > 0,
    attachmentsChanged: attachmentOutcome.changed || recovered.changed
  })
  if (branchChanged || getMeta(deps.db, META_KEYS.checkoutBranch) === null) setMeta(deps.db, META_KEYS.checkoutBranch, context.current ?? '')
  setMeta(deps.db, META_KEYS.lastReconcileAt, now)
  writeReconcileMarker(deps.db, scope, unsettledRecords(deps, context, result.rejected.map((rejection) => rejection.path)))
  return result
}

/**
 * A database-only project tracks no record file, so there is never anything to import. Built fresh
 * each time: the result goes out to callers, and a shared one would let any of them change what
 * every later reconcile returns.
 */
function nothingToReconcile(): ReconcileResultView {
  return {
    imported: [],
    unchanged: [],
    conflicts: [],
    profileConflicts: [],
    kanbanConflicts: [],
    rejected: [],
    branchChanged: false,
    pausedRuns: []
  }
}

/**
 * Whether `storeConflicts` would leave `sync_state` as it is: every conflict is stored with its message, and each stored
 * conflict it clears first is one it sets again with the same message.
 */
function conflictsStored(db: Db, conflicts: Conflict[], unchanged: string[]): boolean {
  const kept = new Set(conflicts.map((conflict) => JSON.stringify([conflict.kind, conflict.entityId, conflict.message])))
  const cleared = db.all<{ kind: string; entity_id: string; conflict: string }>(
    `SELECT kind, entity_id, conflict FROM sync_state WHERE conflict IS NOT NULL AND (
       (kind = 'epic' AND substr(conflict, 1, ?) = ?)
       OR (kind IN ('epic', 'run', 'comment') AND entity_id IN (SELECT value FROM json_each(?)))
       OR (kind = 'profile' AND 'profile:' || entity_id IN (SELECT value FROM json_each(?)))
     )`,
    TRANSFER_HOLD_PREFIX.length, TRANSFER_HOLD_PREFIX, JSON.stringify(unchanged), JSON.stringify(unchanged)
  )
  return cleared.every((row) => kept.has(JSON.stringify([row.kind, row.entity_id, row.conflict]))) && conflicts.every((conflict) =>
    db.get('SELECT 1 FROM sync_state WHERE kind = ? AND entity_id = ? AND conflict = ?', conflict.kind, conflict.entityId, conflict.message) !== undefined)
}

/**
 * Whether the meta an apply keeps is already what it would write: the project, the checkout branch, the attachment
 * registration, and the marker's commit and importer version. The marker advances only when HEAD moved or inside a write
 * that happens anyway; the dirty paths it keeps are re-read by the next reconcile, which is safe while nothing changed.
 */
function bookkeepingCurrent(db: Db, scope: ReconcileScope): boolean {
  if (getMeta(db, META_KEYS.projectId) === null || getMeta(db, META_KEYS.checkoutBranch) === null) return false
  if (getMeta(db, META_KEYS.attachmentRegistration) !== '1') return false
  const marker = readReconcileMarker(db)
  if (scope.head === null || scope.statusPaths === null) return marker.baseCommit === null && marker.importerVersion === null && marker.dirtyPaths === null
  return marker.baseCommit === scope.head && marker.importerVersion === IMPORTER_VERSION
}

/**
 * The result of a prepared reconcile that would write nothing, or null when applying it would write: it imports nothing,
 * stores or clears no conflict, finds the problems the last reconcile recorded, and has no observation, recovered archive
 * or attachment image to apply. Such a reconcile takes no write transaction: `last_reconcile_at`, the marker and the
 * fingerprint stay as the last write left them (`recheckRecords` then re-reads a longer export window, which is safe).
 * Reads only; run in a read snapshot.
 */
/** Whether the plan applies no record and stores or clears no conflict. */
function recordsSettled(db: Db, context: ApplyContext): boolean {
  const { plan, profiles, kanban } = context
  const staged = plan.epics.length + plan.runs.length + plan.eventMerges.length + plan.comments.length + plan.syncedComments.length +
    profiles.staged.length + kanban.cards.length
  return staged === 0 && conflictsStored(db, plan.conflicts, [...plan.unchanged, ...profiles.unchanged]) &&
    profileConflictsStored(db, profiles) && kanbanConflictsStored(db, kanban.conflicts)
}

function unchangedResult(deps: ImporterDeps, context: ApplyContext): ReconcileResultView | null {
  const { db } = deps
  const { plan, profiles, kanban, scope } = context
  if (context.branchChanged || !bookkeepingCurrent(db, scope) || !recordsSettled(db, context)) return null
  const sideRejected = sideInputsSettled(deps, scope.changes.kind === 'targeted' ? scope.changes : null)
  if (sideRejected === null) return null
  const result: ReconcileResultView = {
    imported: [],
    unchanged: [...plan.unchanged, ...profiles.unchanged, ...kanban.unchanged],
    conflicts: plan.conflicts.map((conflict) => ({ epicId: conflict.epicId, message: conflict.message })),
    profileConflicts: profiles.conflicts,
    kanbanConflicts: kanban.conflicts.map((conflict) => ({ cardId: conflict.cardId, message: conflict.message })),
    rejected: [...plan.rejected, ...profiles.rejected, ...kanban.rejected, ...sideRejected],
    branchChanged: false,
    pausedRuns: []
  }
  if (problemsDigest(result) !== getMeta(db, META_KEYS.reconcileProblems)) return null
  const clean = result.conflicts.length + result.profileConflicts.length + result.kanbanConflicts.length + result.rejected.length === 0
  if (getMeta(db, META_KEYS.validatedRepositoryCache) !== '1' && (clean || hasValidatedRepositoryCache(db))) return null
  return result
}

/**
 * The rejections the observation, recovered-archive and attachment-image passes would report when none of them has
 * anything to apply, else null; in the order `applyPlan` reports them.
 */
function sideInputsSettled(deps: ImporterDeps, targeted: TrackedRecords | null): Rejection[] | null {
  const observations = observationsSettled(deps.db, scanObservations(deps, heldEpics(deps.db), observationScope(targeted)))
  if (observations === null) return null
  const recovered = readsRecoveredAttachments(deps, targeted) ? prepareRecoveredAttachments(deps) : { pending: [], rejected: [] }
  if (recovered.pending.length > 0) return null
  const attachments = prepareAttachmentFiles(deps)
  return attachments.updates.length > 0 ? null : [...observations, ...attachments.rejected, ...recovered.rejected]
}

function prepare(deps: ImporterDeps, full: boolean): { context: ApplyContext; identity: string } {
  const head = deps.git.head()
  const current = head?.branch ?? null
  const branchChanged = branchState(deps.db, current).changed
  const project = requireProject(deps)
  const checkout = checkoutKey(deps, project)
  const identity = JSON.stringify([checkout, head])
  // File stamps and the persisted sync hash still validate each entry after an ordinary same-branch pull.
  deps.fileHashes.scope(deps.db, JSON.stringify([checkout, current, head?.detached ?? null]))
  // Asked before any file is read: a file changed after the status is reported by the next one.
  const scope = reconcileScope(deps, full)
  const records = scope.changes.kind === 'targeted' ? scope.changes : null
  const scan = scanRepository(deps, records)
  const plan = planImport(deps.db, scan, { projectId: project.projectId, machineId: deps.machineId })
  const profiles = scanProfiles(deps, records?.profiles)
  const kanban = scanKanban(deps, records?.kanbanCards)
  return { context: { project, scan, plan, profiles, kanban, current, branchChanged, scope }, identity }
}

function checkoutKey(deps: ImporterDeps, project: ProjectRecord): [RepoLayout['mode'], string, string] {
  return [deps.layout.mode, deps.fs.realpath(deps.layout.root), project.projectId]
}

/**
 * Most of a reconcile can run before taking SQLite's writer lock. SQLite and filesystem
 * observations are checked again after BEGIN IMMEDIATE. If anything changed, rescan under the
 * lock, as a finalizer or external process may have changed which inputs this database accepts.
 * Database-only stores have no portable records to reconcile.
 *
 * With a `gate` (`reconcileFingerprint.ts`), inputs a session already reconciled cleanly are not
 * scanned at all: the gate is checked in a read snapshot before the scan, without the writer lock
 * (a full reconcile of those inputs would change nothing, so skipping it is what it would have
 * done at that snapshot), and again under the lock, for inputs another session reconciled while
 * this one waited. The result applied records the fingerprint the next session checks.
 *
 * When the gate misses, git says which records changed since the last reconcile (`reconcileScope.ts`), and only those
 * (with every record in conflict or left unsettled) are read; anything git cannot vouch for reads everything. `full`
 * reads everything regardless (the desktop's explicit Reconcile and Forge validation, and tests).
 */
export function reconcileRepository(deps: ImporterDeps, gate?: ReconcileGate, options: { full?: boolean } = {}): ReconcileResultView {
  if (deps.layout.mode === 'db') return nothingToReconcile()
  const full = options.full === true
  const apply = (context: ApplyContext): ReconcileResultView => {
    const result = applyPlan(deps, context)
    // In the same transaction: exports this reconcile may have unblocked are retried by the next flush at once.
    releaseBackoff(deps.db, result)
    gate?.applied(result)
    return result
  }
  if (deps.db.inTransaction()) return deps.db.tx(() => gate?.current() === true ? nothingToReconcile() : apply(prepare(deps, full).context))
  if (gate !== undefined && deps.db.tx(() => gate.current(), 'read')) return nothingToReconcile()

  const revision = databaseRevision(deps.db)
  const observed = observeRepository(deps.fs)
  const prepared = prepare({ ...deps, fs: observed.fs }, full)
  // A reconcile that would write nothing (the fingerprint included) takes no write transaction at all.
  const unchanged = deps.db.tx(() => {
    const result = unchangedResult({ ...deps, fs: observed.fs }, prepared.context)
    return result === null || gate?.stale?.(result) === true ? null : result
  }, 'read')
  if (unchanged !== null) return unchanged
  return deps.db.tx(() => {
    if (gate?.current() === true) return nothingToReconcile()
    const identity = JSON.stringify([checkoutKey(deps, requireProject(deps)), deps.git.head()])
    const fresh = prepared.identity === identity && databaseRevision(deps.db) === revision && observed.unchanged()
    return apply(fresh ? prepared.context : prepare(deps, full).context)
  })
}
