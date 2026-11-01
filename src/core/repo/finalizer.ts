/**
 * Crash-safe flush of the `outbox` table into repository-owned records (`repo` mode), or straight
 * through without a file in hand (`db` mode, where the database is the record).
 *
 * Each entry is handled inside one `db.tx` (BEGIN IMMEDIATE), so the cross-process write lock is
 * held while files are written and finalizers in different processes never interleave. Files are
 * written to a temp file, fsynced, renamed over the target, and read back. A snapshot is complete and
 * verified before anything points at it, and the pointer is replaced last; any failure rolls the
 * transaction back, leaving the last good pointer (and every earlier snapshot) untouched and the
 * entry pending for an idempotent retry.
 */
import { dirname } from 'node:path'
import { z } from 'zod'
import type { FlushResultView } from '../../shared/domain/views'
import { contentHash, prettyJson } from '../canonical'
import type { Clock } from '../clock'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { META_KEYS, setMeta } from '../meta'
import type { OutboxKind } from '../services/outbox'
import { hasTransferHold } from '../services/transferGuard'
import type { StorageMode } from './storageMode'
import { assertContained, displayPath, ownedPaths } from './paths'
import {
  buildCommentRecord,
  buildEpicPointerRecord,
  buildEpicStateRecord,
  buildProfileRecord,
  buildRunHistoryRecord,
  buildSnapshotRecord,
  type CommentRecord,
  commentRecord,
  parseRecord,
  readOwnedText,
  type SnapshotRecord,
  snapshotRecord,
  trackedCommentHash,
  trackedEpicHash,
  trackedProfileHash,
  trackedRunHash
} from './portable'
import { matchesSync } from './syncState'
import type { FsAdapter, RepoLayout } from './types'

export interface FinalizerDeps {
  db: Db
  layout: RepoLayout
  fs: FsAdapter
  clock: Clock
}

export interface FinalizerHooks {
  /**
   * Called inside the finalizer's transaction once the revision's snapshot is durable and verified.
   * Applies the DB side of the completed save (revision saved, epic current revision, ticket
   * statuses, draft removal). The state and pointer files are written after it, from the updated
   * rows, and these effects commit only after the pointer is durable.
   */
  onSnapshotSaved(revisionId: string): void
}

export interface FlushOutcome extends FlushResultView {
  savedRevisionIds: string[]
  failedRevisionIds: string[]
}

/** An entry becomes `failed` after this many attempts (flush still retries it when called). */
const MAX_FLUSH_ATTEMPTS = 5
const MAX_ERROR_LENGTH = 2_000
/** Entries queued while flushing (a first save queues its epic's earlier comments) get further passes. */
const MAX_FLUSH_PASSES = 3

interface OutboxRow {
  id: number
  kind: OutboxKind
  epic_id: string | null
  run_id: string | null
  revision_id: string | null
  entity_id: string | null
}

type WriteEnv = Pick<FinalizerDeps, 'layout' | 'fs'>

function exactly(expected: string, shown: string): (written: string) => void {
  return (written) => {
    if (written !== expected) {
      fail('internal', `Read-back of ${shown} does not match what was written.`)
    }
  }
}

function discard(fs: FsAdapter, path: string): void {
  try {
    fs.remove(path)
  } catch {
    // Best effort: the original failure is what matters.
  }
}

/**
 * Atomically replaces an owned file: containment check, temp write, fsync, rename over the target,
 * then read back through `verify` (default: exact text). Containment is re-checked right before
 * the rename so a directory swapped for a link meanwhile is caught.
 */
export function writeFileSafely(
  env: WriteEnv,
  target: string,
  text: string,
  verify: (written: string) => void = exactly(text, displayPath(env.layout, target))
): void {
  const temp = `${target}.tmp-${process.pid}`
  assertContained(env.layout, env.fs, target)
  env.fs.mkdirp(dirname(target))
  try {
    assertContained(env.layout, env.fs, temp)
    env.fs.writeFile(temp, text)
    env.fs.fsyncFile(temp)
    assertContained(env.layout, env.fs, target)
    env.fs.rename(temp, target)
  } catch (error: unknown) {
    discard(env.fs, temp)
    throw error
  }
  verify(env.fs.readFile(target))
}

/** Writes a snapshot once; an existing file must hold the same bundle and is never rewritten. */
function writeSnapshot(env: WriteEnv, record: SnapshotRecord): void {
  const target = ownedPaths(env.layout).snapshotFile(record.epicId, record.revisionId)
  const shown = displayPath(env.layout, target)
  const existing = readOwnedText(env, target)
  if (existing !== null) {
    if (parseRecord(snapshotRecord, existing, shown).contentHash !== record.contentHash) {
      fail('conflict', `${shown} already exists with different content; snapshots are never rewritten.`)
    }
    return
  }
  try {
    writeFileSafely(env, target, prettyJson(record), (written) => {
      if (parseRecord(snapshotRecord, written, shown).contentHash !== record.contentHash) {
        fail('internal', `Read-back of ${shown} does not match the revision's content hash.`)
      }
    })
  } catch (error: unknown) {
    // The file did not exist before this write and nothing points at it yet: drop an unverified
    // copy so the retry writes it again instead of refusing to rewrite a snapshot.
    discard(env.fs, target)
    throw error
  }
}

/** Kinds of `sync_state` rows the finalizer records exports for. */
type ExportKind = 'epic' | 'run' | 'comment' | 'profile'

function nextGeneration(db: Db, kind: ExportKind, entityId: string): number {
  const row = db.get<{ generation: number }>('SELECT generation FROM sync_state WHERE kind = ? AND entity_id = ?', kind, entityId)
  return (row?.generation ?? 0) + 1
}

function recordExport(deps: FinalizerDeps, entry: { kind: ExportKind; entityId: string; hash: string; generation: number }): void {
  deps.db.run(
    `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(kind, entity_id) DO UPDATE SET exported_hash = excluded.exported_hash,
       generation = excluded.generation, imported_hash = NULL, conflict = NULL, updated_at = excluded.updated_at`,
    entry.kind,
    entry.entityId,
    entry.hash,
    entry.generation,
    deps.clock.nowIso()
  )
}

/** An epic's tracked pointer and state texts as they are in the checkout; null for a missing file. */
interface TrackedEpicTexts {
  pointer: string | null
  state: string | null
}

type RecordsEnv = Pick<FinalizerDeps, 'db' | 'layout' | 'fs'>

function readTrackedEpic(env: WriteEnv, epicId: string): TrackedEpicTexts {
  const paths = ownedPaths(env.layout)
  return { pointer: readOwnedText(env, paths.epicPointerFile(epicId)), state: readOwnedText(env, paths.epicStateFile(epicId)) }
}

/** The epic's `sync_state` hashes and generation; a missing row reads as the one `storeConflicts` inserts. */
const syncedRow = z.strictObject({ exportedHash: z.string().nullable(), importedHash: z.string().nullable(), generation: z.number() })
type SyncedRow = z.infer<typeof syncedRow>

/**
 * The outbox entry whose export wrote it, the row it was written against, and at most the three tracked states an
 * export can leave behind: the new state over the old pointer, both new, or the new pointer over the old state (a
 * restore that failed half way).
 */
const exportIntent = z.strictObject({ entryId: z.number().int(), row: syncedRow, hashes: z.array(z.string()).max(3) })

function epicSyncedRow(db: Db, epicId: string): SyncedRow {
  const row = db.get<{ exported_hash: string | null; imported_hash: string | null; generation: number }>(
    "SELECT exported_hash, imported_hash, generation FROM sync_state WHERE kind = 'epic' AND entity_id = ?",
    epicId
  )
  return { exportedHash: row?.exported_hash ?? null, importedHash: row?.imported_hash ?? null, generation: row?.generation ?? 0 }
}

function readIntentFile(env: WriteEnv, epicId: string): z.infer<typeof exportIntent> | null {
  try {
    const text = readOwnedText(env, ownedPaths(env.layout).exportIntentFile(epicId))
    const parsed = text === null ? null : exportIntent.safeParse(JSON.parse(text))
    return parsed?.success === true ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * The tracked hashes an export of the epic by this machine was about to leave on disk and never committed, noted
 * (machine-local, never committed) before it replaced anything. A process that dies between replacing the files and
 * committing their `sync_state` row leaves one of them behind; it is this machine's own write, not another machine's.
 *
 * The note covers only that uncommitted export. It counts only while the outbox entry that wrote it still waits: the
 * commit marks the entry done in the same transaction as the export's `sync_state` row, so a note left behind after
 * a commit (its removal failed, the app quit) is inert, however the row moves later. It also counts only while the
 * epic's row is still the one it was written against. An unreadable note counts as none.
 */
function readExportIntent(env: RecordsEnv, epicId: string): string[] {
  const intent = readIntentFile(env, epicId)
  if (intent === null) {
    return []
  }
  const entry = env.db.get<{ state: string }>(
    "SELECT state FROM outbox WHERE id = ? AND epic_id = ? AND kind IN ('snapshot', 'epic_state')",
    intent.entryId,
    epicId
  )
  const waiting = entry !== undefined && (entry.state === 'pending' || entry.state === 'failed')
  return waiting && contentHash(intent.row) === contentHash(epicSyncedRow(env.db, epicId)) ? intent.hashes : []
}

/**
 * Tidying only, after the export's entry committed: a note left behind is inert, since its entry is done. Only the
 * note of this entry is removed, so a note another process just wrote for its own export of the epic stays.
 */
function spendExportIntent(env: WriteEnv, epicId: string, entryId: number): void {
  try {
    const path = ownedPaths(env.layout).exportIntentFile(epicId)
    assertContained(env.layout, env.fs, path)
    if (readIntentFile(env, epicId)?.entryId === entryId) {
      env.fs.remove(path)
    }
  } catch {
    // Inert either way: the entry that wrote it is done.
  }
}

/**
 * The hash of an epic's tracked pointer and state when they hold records this machine neither exported nor imported,
 * or null when they hold exactly what it last exported or imported, or no file at all. A file this machine wrote has
 * the exported hash (`recordExport` stores the hash of the very texts written), or, if the process died before that
 * row committed, a hash its export intent names; so only records written elsewhere and not yet imported here
 * (another machine's save or state change, pulled or checked out) count. A checkout with the files but no
 * `sync_state` row for the epic never read them, so they count too; a checkout without them has nothing to lose.
 */
function unimportedHash(env: RecordsEnv, epicId: string, texts: TrackedEpicTexts): string | null {
  if (texts.pointer === null && texts.state === null) {
    return null
  }
  const hash = trackedEpicHash(texts.pointer ?? '', texts.state ?? '')
  return matchesSync(env.db, 'epic', epicId, hash) || readExportIntent(env, epicId).includes(hash) ? null : hash
}

/** The hash of the epic's tracked records when this machine has not imported them (`unimportedHash`), else null. */
export function unimportedEpicRecords(env: RecordsEnv, epicId: string): string | null {
  return unimportedHash(env, epicId, readTrackedEpic(env, epicId))
}

/**
 * Refuses, with `conflict`, to write an epic's tracked records while the importer holds incoming ones for its open
 * Linear transfer (checked first, as before), or while they hold records this machine has not imported; returns
 * their texts otherwise. The entry waits and is retried until the person cancels the transfer, or chooses which
 * records to keep (`resolveEpicConflict`): writing over them would drop another machine's revision or state change.
 */
function requireWritableRecords(env: RecordsEnv, epicId: string): TrackedEpicTexts {
  if (hasTransferHold(env.db, epicId)) {
    fail('conflict', `Epic ${epicId}'s tracked records hold changes waiting for its Linear transfer. Cancel the transfer and reconcile first.`)
  }
  const texts = readTrackedEpic(env, epicId)
  if (unimportedHash(env, epicId, texts) !== null) {
    fail(
      'conflict',
      `Epic ${epicId}'s tracked state and pointer hold records this machine has not imported, so its local changes ` +
        "were not written over them. Reconcile, then choose which to keep in the desktop app's Storage card: keep " +
        'the tracked records or write local. Tracked files the reconcile rejects must be fixed in Git first.'
    )
  }
  return texts
}

/** Best effort: the write's own failure is what the caller reports. */
function restoreFile(env: WriteEnv, path: string, text: string | null): void {
  if (text === null) {
    discard(env.fs, path)
    return
  }
  try {
    writeFileSafely(env, path, text)
  } catch {
    // The entry stays pending; the next flush reads what the file holds then.
  }
}

/**
 * Rewrites state.json, then current.json (last), for an epic's current saved revision, unless the tracked records
 * are held for a Linear transfer or hold records this machine has not imported (`requireWritableRecords`).
 *
 * Before anything is replaced, the hashes the files may pass through are noted (`readExportIntent`), so a process
 * that dies before the row commits does not lock itself out. When a write or its record fails, both files are put
 * back as they were, so the checkout again holds the records this machine last synced.
 */
function exportEpic(deps: FinalizerDeps, epicId: string, entryId: number): void {
  const epic = deps.db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', epicId)
  if (epic === undefined) {
    fail('not_found', `Epic ${epicId} does not exist.`)
  }
  if (epic.current_revision_id === null) {
    return
  }
  const before = requireWritableRecords(deps, epicId)
  const snapshot = buildSnapshotRecord(deps.db, epic.current_revision_id)
  writeSnapshot(deps, snapshot)
  const meta = { generation: nextGeneration(deps.db, 'epic', epicId), updatedAt: deps.clock.nowIso() }
  const stateText = prettyJson(buildEpicStateRecord(deps.db, epicId, meta))
  const pointerText = prettyJson(buildEpicPointerRecord(snapshot, meta))
  const paths = ownedPaths(deps.layout)
  const hashes = [
    trackedEpicHash(before.pointer ?? '', stateText),
    trackedEpicHash(pointerText, stateText),
    trackedEpicHash(pointerText, before.state ?? '')
  ]
  const intent = { entryId, row: epicSyncedRow(deps.db, epicId), hashes }
  writeFileSafely(deps, paths.exportIntentFile(epicId), JSON.stringify(intent))
  try {
    writeFileSafely(deps, paths.epicStateFile(epicId), stateText)
    writeFileSafely(deps, paths.epicPointerFile(epicId), pointerText)
    recordExport(deps, { kind: 'epic', entityId: epicId, hash: trackedEpicHash(pointerText, stateText), generation: meta.generation })
  } catch (error: unknown) {
    restoreFile(deps, paths.epicStateFile(epicId), before.state)
    restoreFile(deps, paths.epicPointerFile(epicId), before.pointer)
    throw error
  }
}

/** Writes a comment file once and returns the text on disk; an existing file must hold the same comment. */
function writeCommentFile(env: WriteEnv, target: string, record: CommentRecord): string {
  const shown = displayPath(env.layout, target)
  const existing = readOwnedText(env, target)
  if (existing !== null) {
    if (contentHash(parseRecord(commentRecord, existing, shown)) !== contentHash(record)) {
      fail('conflict', `${shown} already exists with different content; comments are never rewritten.`)
    }
    return existing
  }
  const text = prettyJson(record)
  try {
    writeFileSafely(env, target, text)
  } catch (error: unknown) {
    // Nothing existed before this write: drop an unverified copy so the retry writes it again.
    discard(env.fs, target)
    throw error
  }
  return text
}

/**
 * A checkout of another branch may not hold the epic's records at all: a comment written there would
 * leave an epic folder with only `comments/`, which every reconcile rejects. The entry waits instead.
 */
function requireEpicRecords(deps: FinalizerDeps, epicId: string, commentId: string): void {
  const pointer = ownedPaths(deps.layout).epicPointerFile(epicId)
  assertContained(deps.layout, deps.fs, pointer)
  if (!deps.fs.exists(pointer)) {
    fail(
      'not_found',
      `Comment ${commentId} is not exported: the records of epic ${epicId} are not in this checkout. It is exported once they are, for example after checking out the epic's branch.`
    )
  }
}

/** Comments are exported beside their epic's records, so only once the epic has a saved plan in this checkout. */
function exportComment(deps: FinalizerDeps, commentId: string): void {
  const record = buildCommentRecord(deps.db, commentId)
  const epic = deps.db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', record.epicId)
  if ((epic?.current_revision_id ?? null) === null) {
    fail('internal', `Comment ${commentId} belongs to epic ${record.epicId}, which has no saved plan to export it with yet.`)
  }
  requireEpicRecords(deps, record.epicId, commentId)
  const text = writeCommentFile(deps, ownedPaths(deps.layout).commentFile(record.epicId, commentId), record)
  recordExport(deps, { kind: 'comment', entityId: commentId, hash: trackedCommentHash(text), generation: nextGeneration(deps.db, 'comment', commentId) })
}

function required(value: string | null, what: string): string {
  if (value === null) {
    fail('internal', `Outbox entry has no ${what}.`)
  }
  return value
}

type EntryHandler = (deps: FinalizerDeps, hooks: FinalizerHooks, entry: OutboxRow) => void

const FILE_HANDLERS: Record<OutboxKind, EntryHandler> = {
  snapshot: (deps, hooks, entry) => {
    const revisionId = required(entry.revision_id, 'revision id')
    const record = buildSnapshotRecord(deps.db, revisionId)
    // Checked before the snapshot is written too, so a save refused for held or unimported records leaves no file behind.
    requireWritableRecords(deps, record.epicId)
    writeSnapshot(deps, record)
    hooks.onSnapshotSaved(revisionId)
    exportEpic(deps, record.epicId, entry.id)
  },
  epic_state: (deps, _hooks, entry) => exportEpic(deps, required(entry.epic_id, 'epic id'), entry.id),
  run_history: (deps, _hooks, entry) => {
    const runId = required(entry.run_id, 'run id')
    const text = prettyJson(buildRunHistoryRecord(deps.db, runId))
    writeFileSafely(deps, ownedPaths(deps.layout).runHistoryFile(runId), text)
    recordExport(deps, { kind: 'run', entityId: runId, hash: trackedRunHash(text), generation: nextGeneration(deps.db, 'run', runId) })
  },
  comment: (deps, _hooks, entry) => exportComment(deps, required(entry.entity_id, 'comment id')),
  profile: (deps, _hooks, entry) => {
    const name = required(entry.entity_id, 'entity id')
    const text = prettyJson(buildProfileRecord(deps.db, name))
    writeFileSafely(deps, ownedPaths(deps.layout).profileFile(name), text)
    recordExport(deps, { kind: 'profile', entityId: name, hash: trackedProfileHash(text), generation: nextGeneration(deps.db, 'profile', name) })
  }
}

/** A comment with no `sync_state` row is re-queued by every later save (`enqueueUnexportedComments`). */
const SETTLED_IN_DATABASE = 'database-only'

/**
 * A database-only project has no record files, so flushing it only has to finish the database side
 * of a save: `onSnapshotSaved` marks the revision saved, settles the draft and indexes it, exactly
 * as it does once a snapshot file is durable in `repo` mode. Every other kind of entry describes a
 * file that mode never writes, and the database already holds that record, so the entry is simply
 * completed.
 *
 * A comment still gets its `sync_state` row. Nothing was exported, so the hash is a marker rather
 * than a digest, but that row is also what tells `enqueueUnexportedComments` the comment is
 * accounted for: without it every save of the epic would queue every one of its comments again.
 */
const DB_HANDLERS: Record<OutboxKind, EntryHandler> = {
  snapshot: (_deps, hooks, entry) => hooks.onSnapshotSaved(required(entry.revision_id, 'revision id')),
  epic_state: () => undefined,
  run_history: () => undefined,
  comment: (deps, _hooks, entry) => {
    const commentId = required(entry.entity_id, 'comment id')
    recordExport(deps, {
      kind: 'comment',
      entityId: commentId,
      hash: SETTLED_IN_DATABASE,
      generation: nextGeneration(deps.db, 'comment', commentId)
    })
  },
  profile: () => undefined
}

const HANDLERS_BY_MODE: Record<StorageMode, Record<OutboxKind, EntryHandler>> = {
  repo: FILE_HANDLERS,
  db: DB_HANDLERS
}

type EntryResult = 'flushed' | 'skipped'

/** Runs inside the entry's transaction; skips an entry another process completed meanwhile. */
function processEntry(deps: FinalizerDeps, hooks: FinalizerHooks, entry: OutboxRow): EntryResult {
  const current = deps.db.get<{ state: string }>('SELECT state FROM outbox WHERE id = ?', entry.id)
  if (current === undefined || current.state === 'done') {
    return 'skipped'
  }
  HANDLERS_BY_MODE[deps.layout.mode][entry.kind](deps, hooks, entry)
  const now = deps.clock.nowIso()
  deps.db.run("UPDATE outbox SET state = 'done', done_at = ?, last_error = NULL WHERE id = ?", now, entry.id)
  setMeta(deps.db, META_KEYS.lastFlushAt, now)
  return 'flushed'
}

function recordFailure(deps: FinalizerDeps, entry: OutboxRow, message: string): void {
  deps.db.tx(() => {
    deps.db.run(
      `UPDATE outbox SET attempts = attempts + 1, last_error = ?,
         state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
       WHERE id = ?`,
      message.slice(0, MAX_ERROR_LENGTH),
      MAX_FLUSH_ATTEMPTS,
      entry.id
    )
  })
}

function entityKeys(entry: OutboxRow): string[] {
  // A comment file stands alone: it never waits for, or holds back, its epic's plan records.
  if (entry.kind === 'comment') {
    return [`comment:${entry.entity_id ?? entry.id}`]
  }
  const keys: string[] = []
  if (entry.epic_id !== null) {
    keys.push(`epic:${entry.epic_id}`)
  }
  if (entry.run_id !== null) {
    keys.push(`run:${entry.run_id}`)
  }
  if (entry.entity_id !== null) {
    keys.push(`${entry.kind}:${entry.entity_id}`)
  }
  return keys
}

function describeEntry(entry: OutboxRow): string {
  return `${entry.kind} ${entry.revision_id ?? entry.run_id ?? entry.entity_id ?? entry.epic_id ?? entry.id}`
}

function noteSuccess(outcome: FlushOutcome, entry: OutboxRow, result: EntryResult): void {
  outcome.flushed += result === 'flushed' ? 1 : 0
  if (entry.kind === 'snapshot' && entry.revision_id !== null) {
    outcome.savedRevisionIds.push(entry.revision_id)
  }
}

function noteFailure(outcome: FlushOutcome, entry: OutboxRow, message: string): void {
  outcome.failed += 1
  outcome.errors.push(`${describeEntry(entry)}: ${message}`)
  if (entry.revision_id !== null) {
    outcome.failedRevisionIds.push(entry.revision_id)
  }
}

interface FlushState {
  outcome: FlushOutcome
  blocked: Set<string>
}

function flushEntry(deps: FinalizerDeps, hooks: FinalizerHooks, entry: OutboxRow, state: FlushState): void {
  const keys = entityKeys(entry)
  if (keys.some((key) => state.blocked.has(key))) {
    return
  }
  try {
    noteSuccess(state.outcome, entry, deps.db.tx(() => processEntry(deps, hooks, entry)))
    // Only a top-level commit is final: inside an outer transaction the row binding still covers a rollback.
    const exportsEpic = entry.kind === 'snapshot' || entry.kind === 'epic_state'
    if (exportsEpic && entry.epic_id !== null && deps.layout.mode === 'repo' && !deps.db.inTransaction()) {
      spendExportIntent(deps, entry.epic_id, entry.id)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    recordFailure(deps, entry, message)
    keys.forEach((key) => state.blocked.add(key))
    noteFailure(state.outcome, entry, message)
  }
}

/** Limits a flush to one epic's entries, and to some kinds of them when `kinds` is given. */
export interface FlushScope {
  epicId: string
  kinds?: readonly OutboxKind[]
}

function queuedAfter(db: Db, afterId: number, scope: FlushScope | undefined): OutboxRow[] {
  const rows = db.all<OutboxRow>(
    "SELECT id, kind, epic_id, run_id, revision_id, entity_id FROM outbox WHERE state IN ('pending', 'failed') AND id > ? ORDER BY id",
    afterId
  )
  if (scope === undefined) {
    return rows
  }
  return rows.filter((row) => row.epic_id === scope.epicId && (scope.kinds === undefined || scope.kinds.includes(row.kind)))
}

/**
 * Flushes pending (and previously failed) outbox entries in id order, through the handlers of the
 * project's storage mode (`db` writes no file), all of them or those in `scope`. A failed entry blocks later
 * entries of the same epic, run, or keyed record (such as a profile) so their records are never
 * written out of order; other entities continue. Entries queued by the flush itself are picked up
 * by a further pass (bounded). Flush failures never throw: they are counted, and the entry keeps
 * its last error.
 */
export function flushOutbox(deps: FinalizerDeps, hooks: FinalizerHooks, scope?: FlushScope): FlushOutcome {
  const state: FlushState = {
    outcome: { flushed: 0, failed: 0, errors: [], savedRevisionIds: [], failedRevisionIds: [] },
    blocked: new Set<string>()
  }
  let afterId = 0
  for (let pass = 0; pass < MAX_FLUSH_PASSES; pass += 1) {
    const entries = queuedAfter(deps.db, afterId, scope)
    if (entries.length === 0) {
      break
    }
    for (const entry of entries) {
      flushEntry(deps, hooks, entry, state)
    }
    afterId = entries[entries.length - 1]?.id ?? afterId
  }
  return state.outcome
}
