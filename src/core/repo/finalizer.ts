/**
 * Crash-safe flush of the `outbox` table into repository-owned records.
 *
 * Each entry is handled inside one `db.tx` (BEGIN IMMEDIATE), so the cross-process write lock is
 * held while files are written and finalizers in different processes never interleave. Files are
 * written to a temp file, fsynced, renamed over the target, and read back. A snapshot is complete and
 * verified before anything points at it, and the pointer is replaced last; any failure rolls the
 * transaction back, leaving the last good pointer (and every earlier snapshot) untouched and the
 * entry pending for an idempotent retry.
 */
import { dirname } from 'node:path'
import type { FlushResultView } from '../../shared/domain/views'
import { contentHash, prettyJson } from '../canonical'
import type { Clock } from '../clock'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { META_KEYS, setMeta } from '../meta'
import type { OutboxKind } from '../services/outbox'
import { assertContained, displayPath, ownedPaths } from './paths'
import {
  buildCommentRecord,
  buildEpicPointerRecord,
  buildEpicStateRecord,
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
  trackedRunHash
} from './portable'
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

type ExportKind = 'epic' | 'run' | 'comment'

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

/** Rewrites state.json, then current.json (last), for an epic's current saved revision. */
function exportEpic(deps: FinalizerDeps, epicId: string): void {
  const epic = deps.db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', epicId)
  if (epic === undefined) {
    fail('not_found', `Epic ${epicId} does not exist.`)
  }
  if (epic.current_revision_id === null) {
    return
  }
  const snapshot = buildSnapshotRecord(deps.db, epic.current_revision_id)
  writeSnapshot(deps, snapshot)
  const meta = { generation: nextGeneration(deps.db, 'epic', epicId), updatedAt: deps.clock.nowIso() }
  const stateText = prettyJson(buildEpicStateRecord(deps.db, epicId, meta))
  const pointerText = prettyJson(buildEpicPointerRecord(snapshot, meta))
  const paths = ownedPaths(deps.layout)
  writeFileSafely(deps, paths.epicStateFile(epicId), stateText)
  writeFileSafely(deps, paths.epicPointerFile(epicId), pointerText)
  recordExport(deps, { kind: 'epic', entityId: epicId, hash: trackedEpicHash(pointerText, stateText), generation: meta.generation })
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

/** Comments are exported beside their epic's records, so only once the epic has a saved plan. */
function exportComment(deps: FinalizerDeps, commentId: string): void {
  const record = buildCommentRecord(deps.db, commentId)
  const epic = deps.db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', record.epicId)
  if ((epic?.current_revision_id ?? null) === null) {
    fail('internal', `Comment ${commentId} belongs to epic ${record.epicId}, which has no saved plan to export it with yet.`)
  }
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

const HANDLERS: Record<OutboxKind, EntryHandler> = {
  snapshot: (deps, hooks, entry) => {
    const revisionId = required(entry.revision_id, 'revision id')
    const record = buildSnapshotRecord(deps.db, revisionId)
    writeSnapshot(deps, record)
    hooks.onSnapshotSaved(revisionId)
    exportEpic(deps, record.epicId)
  },
  epic_state: (deps, _hooks, entry) => exportEpic(deps, required(entry.epic_id, 'epic id')),
  run_history: (deps, _hooks, entry) => {
    const runId = required(entry.run_id, 'run id')
    const text = prettyJson(buildRunHistoryRecord(deps.db, runId))
    writeFileSafely(deps, ownedPaths(deps.layout).runHistoryFile(runId), text)
    recordExport(deps, { kind: 'run', entityId: runId, hash: trackedRunHash(text), generation: nextGeneration(deps.db, 'run', runId) })
  },
  comment: (deps, _hooks, entry) => exportComment(deps, required(entry.entity_id, 'comment id'))
}

type EntryResult = 'flushed' | 'skipped'

/** Runs inside the entry's transaction; skips an entry another process completed meanwhile. */
function processEntry(deps: FinalizerDeps, hooks: FinalizerHooks, entry: OutboxRow): EntryResult {
  const current = deps.db.get<{ state: string }>('SELECT state FROM outbox WHERE id = ?', entry.id)
  if (current === undefined || current.state === 'done') {
    return 'skipped'
  }
  HANDLERS[entry.kind](deps, hooks, entry)
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    recordFailure(deps, entry, message)
    keys.forEach((key) => state.blocked.add(key))
    noteFailure(state.outcome, entry, message)
  }
}

function queuedAfter(db: Db, afterId: number): OutboxRow[] {
  return db.all<OutboxRow>(
    "SELECT id, kind, epic_id, run_id, revision_id, entity_id FROM outbox WHERE state IN ('pending', 'failed') AND id > ? ORDER BY id",
    afterId
  )
}

/**
 * Flushes pending (and previously failed) outbox entries in id order. A failed entry blocks later
 * entries of the same epic/run so their records are never written out of order; other entities
 * continue. Entries queued by the flush itself are picked up by a further pass (bounded). Flush
 * failures never throw: they are counted, and the entry keeps its last error.
 */
export function flushOutbox(deps: FinalizerDeps, hooks: FinalizerHooks): FlushOutcome {
  const state: FlushState = {
    outcome: { flushed: 0, failed: 0, errors: [], savedRevisionIds: [], failedRevisionIds: [] },
    blocked: new Set<string>()
  }
  let afterId = 0
  for (let pass = 0; pass < MAX_FLUSH_PASSES; pass += 1) {
    const entries = queuedAfter(deps.db, afterId)
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
