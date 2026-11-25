/**
 * Crash-safe flush of the `outbox` table into repository-owned records (`repo` mode), or straight
 * through without a file in hand (`db` mode, where the database is the record).
 *
 * A `repo` entry is exported in two steps (`exportEntry`). Staging runs outside the write lock: the export runs in a
 * read transaction and collects its file changes (a save's state is built as its hook will leave it, from
 * `previewSavedRevision`), and each new file is written to a temp file under `local/staging/`, fsynced and read back;
 * images are loaded and hashed there too. The commit runs in one short `db.tx` (BEGIN IMMEDIATE), so finalizers in
 * different processes never interleave: it runs the save hook once, collects the changes again from the rows as they
 * are now (reusing the snapshot staging built and checked, and re-checking that the entry still waits and that the
 * tracked records may be written over), and only when every change is staged are the temps renamed into place, in
 * order, the pointer last, before the export is recorded and committed. When the commit finds other changes (a write
 * landed meanwhile), it stages those and commits again, a bounded number of times. Any failure puts back the tracked
 * files already replaced before the transaction rolls back, leaving the last good pointer (and every earlier snapshot)
 * untouched and the entry pending for an idempotent retry. A failed entry is retried by a scheduled flush only after
 * a backoff.
 */
import { dirname, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { FlushResultView } from '../../shared/domain/views'
import { canonicalJson, contentHash, prettyJson } from '../canonical'
import { addSeconds, type Clock, isBefore } from '../clock'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { getMeta, META_KEYS, setMeta } from '../meta'
import { KANBAN_OUTBOX_KINDS, type OutboxKind } from '../services/outbox'
import { hasTransferHold } from '../services/transferGuard'
import { observationPayloadHash } from '../space/ledger'
import {
  ATTACHMENT_FILE_NAME,
  ATTACHMENT_SIDECAR_NAME,
  attachmentBytesToWrite,
  loadStoredAttachment,
  type OwningRecord,
  placementOfAttachment,
  sha256Of,
  type StoredAttachment,
  unexportedAttachments
} from './attachmentFiles'
import { type AttachmentFolder, assertContained, displayPath, ownedPaths } from './paths'
import {
  buildCommentRecord,
  buildEpicPointerRecord,
  buildEpicStateRecord,
  buildKanbanCardRecord,
  buildKanbanEventRecord,
  buildObservationRecord,
  buildProfileRecord,
  buildRunHistoryRecord,
  buildSnapshotRecord,
  commentRecord,
  kanbanEventRecord,
  MAX_RECORD_BYTES,
  metricObservationRecord,
  parseRecord,
  readOwnedText,
  type SavedRevisionPreview,
  type SnapshotRecord,
  snapshotRecord,
  trackedCommentHash,
  trackedEpicHash,
  trackedKanbanCardHash,
  trackedKanbanEventHash,
  trackedObservationHash,
  trackedProfileHash,
  trackedRunHash,
  scorecardRecord,
  scorecardRecordTexts
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
   * Called inside the commit's transaction, once, before the epic's state and pointer are collected. Applies the DB
   * side of the completed save (revision saved, epic current revision, ticket statuses, draft removal). The state and
   * pointer files are built after it, from the updated rows, and these effects commit only after the pointer is in place.
   */
  onSnapshotSaved(revisionId: string): void
  /**
   * Outside the write lock, reading only: what `onSnapshotSaved` will change in the epic's state record (null when the
   * revision is saved already), so staging writes the state the commit will find. Without it, or when it misses, the
   * commit finds another state and the entry is staged again.
   */
  previewSavedRevision?(revisionId: string): SavedRevisionPreview | null
}

export interface FlushOutcome extends FlushResultView {
  savedRevisionIds: string[]
  failedRevisionIds: string[]
}

/** An entry becomes `failed` after this many attempts. Failed entries are still retried, and their count stays at this maximum. */
const MAX_FLUSH_ATTEMPTS = 5
const MAX_ERROR_LENGTH = 2_000
/** Entries queued while flushing (a first save queues its epic's earlier comments) get further passes. */
const MAX_FLUSH_PASSES = 3
/** A scheduled flush retries a failed entry after 15 s, then 30 s, 1 min, 2 min, 4 min, and then every 5 min. */
const RETRY_DELAY_SECONDS = 15
const MAX_RETRY_DELAY_SECONDS = 300
/** A commit that finds other changes than were staged stages those and commits again, at most this many more times. */
const MAX_RESTAGES = 2

interface OutboxRow {
  id: number
  kind: OutboxKind
  epic_id: string | null
  run_id: string | null
  revision_id: string | null
  entity_id: string | null
  /** The Kanban card a `kanban_card` or `kanban_event` entry belongs to; null for every other kind. */
  card_id: string | null
  /** Before this time a scheduled flush leaves the entry (it failed); null: at once. */
  next_attempt_at: string | null
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

/**
 * One file change of an entry's export, collected while the export runs and made only at its commit: a text record or
 * an image, whose temp file is staged (written, fsynced and read back) before the write lock is taken, or a removal.
 */
type FileChange =
  | {
      kind: 'write'
      target: string
      text: string
      /** What staging and the commit must agree on: the text itself. */
      identity: string
      /** Reads the staged temp file back and fails when it does not hold what was written. */
      check: (fs: FsAdapter, temp: string) => void
      /** The text to put back (null: remove the file) when a later step fails; undefined: nothing is put back. */
      restore?: string | null
    }
  | {
      kind: 'image'
      target: string
      /** Listed without its bytes: staging loads and hashes them, outside the write lock. */
      attachment: StoredAttachment
      identity: string
    }
  | { kind: 'remove'; target: string }

type StagedChange = Exclude<FileChange, { kind: 'remove' }>

interface SnapshotText {
  record: SnapshotRecord
  text: string
}

/** What staging built or checked that the commit reuses: a revision's row never changes, so neither does its snapshot. */
interface ExportMemo {
  snapshots: Map<string, SnapshotText>
  /** Snapshot files found holding their revision, by path, with the stamp they had then. */
  checked: Map<string, string>
}

/** The dependencies of one run of an entry's export: the file changes it collects, and whether it stages or commits. */
interface ExportDeps extends FinalizerDeps {
  changes: FileChange[]
  memo: ExportMemo
  /** A staging run, outside the write lock: it never writes the database and records no export, which the commit does. */
  planning: boolean
}

function collect(deps: ExportDeps, change: FileChange): void {
  // Staging checks containment; the commit checks it again right before each rename (`putInPlace`).
  if (deps.planning) {
    assertContained(deps.layout, deps.fs, change.target)
  }
  const repeated = deps.changes.some(
    (known) => known.kind !== 'remove' && change.kind !== 'remove' && known.target === change.target && known.identity === change.identity
  )
  if (!repeated) {
    deps.changes.push(change)
  }
}

/** Puts `text` at `target` at the entry's commit; `verify` checks the staged copy (default: exact text). */
function putText(deps: ExportDeps, target: string, text: string, options: { verify?: (written: string) => void; restore?: string | null } = {}): void {
  const verify = options.verify ?? exactly(text, displayPath(deps.layout, target))
  collect(deps, { kind: 'write', target, text, identity: text, check: (fs, temp) => verify(fs.readFile(temp)), restore: options.restore })
}

/** The text an earlier change of this export puts at `target`: later steps of the export read it as on disk. */
function collectedText(deps: ExportDeps, target: string): string | null {
  for (let index = deps.changes.length - 1; index >= 0; index -= 1) {
    const change = deps.changes[index]
    if (change?.target === target) {
      return change.kind === 'write' ? change.text : null
    }
  }
  return null
}

/** A staged write: its temp file, or null for an image its target already holds (whose stamp must hold until the commit). */
interface StagedFile {
  identity: string
  temp: string | null
  stamp: string | null
}

/** An entry's staged writes by target, kept across its commit rounds; `count` keeps temp names unique. */
interface Staging {
  files: Map<string, StagedFile>
  count: number
}

function verifyStaged(deps: FinalizerDeps, change: StagedChange, temp: string): void {
  if (change.kind === 'write') {
    change.check(deps.fs, temp)
  } else if (sha256Of(deps.fs.readFileBytes(temp)) !== change.attachment.sha256) {
    fail('internal', `Read-back of ${displayPath(deps.layout, change.target)} does not match what was written.`)
  }
}

/**
 * Outside the write lock: writes one change's temp file, fsyncs it and reads it back. An image's stored bytes are
 * loaded and checked against its sha256 here, and an image its target already holds is not written again. Temps sit
 * under `local/` (never tracked, never read by a reconcile), named after the entry, the round and the target.
 */
function stageWrite(deps: FinalizerDeps, entryId: number, staging: Staging, change: StagedChange): StagedFile {
  let data: string | Uint8Array = change.kind === 'write' ? change.text : new Uint8Array()
  if (change.kind === 'image') {
    const stored = { ...change.attachment, data: loadStoredAttachment(deps.db, change.attachment.id).data }
    const bytes = attachmentBytesToWrite(deps, stored, change.target)
    if (bytes === null) {
      return { identity: change.identity, temp: null, stamp: deps.fs.fileStamp(change.target) }
    }
    data = bytes
  }
  staging.count += 1
  const name = relative(deps.layout.dmDir, change.target).split(sep).join('~')
  const temp = join(deps.layout.localDir, 'staging', `${entryId}-${staging.count}-${name}.tmp-${process.pid}`)
  try {
    assertContained(deps.layout, deps.fs, temp)
    deps.fs.mkdirp(dirname(temp))
    assertContained(deps.layout, deps.fs, temp)
    if (typeof data === 'string') {
      deps.fs.writeFile(temp, data)
    } else {
      deps.fs.writeFileBytes(temp, data)
    }
    deps.fs.fsyncFile(temp)
    verifyStaged(deps, change, temp)
  } catch (error: unknown) {
    discard(deps.fs, temp)
    throw error
  }
  return { identity: change.identity, temp, stamp: null }
}

/** Stages every write not staged yet with the same content; a temp staged for older content of a target is dropped. */
function stageChanges(deps: FinalizerDeps, entryId: number, changes: FileChange[], staging: Staging): void {
  for (const change of changes) {
    if (change.kind === 'remove' || staging.files.get(change.target)?.identity === change.identity) {
      continue
    }
    const older = staging.files.get(change.target)?.temp ?? null
    staging.files.delete(change.target)
    if (older !== null) {
      discard(deps.fs, older)
    }
    staging.files.set(change.target, stageWrite(deps, entryId, staging, change))
  }
}

/** Whether every write the commit collected is staged with the same content (an image left in place: unchanged since). */
function allStaged(fs: FsAdapter, changes: FileChange[], staging: Staging): boolean {
  return changes.every((change) => {
    if (change.kind === 'remove') {
      return true
    }
    const staged = staging.files.get(change.target)
    return staged?.identity === change.identity && (staged.temp !== null || (staged.stamp !== null && fs.fileStamp(change.target) === staged.stamp))
  })
}

/** One entry's commit: its frozen clock, what staging built and staged, and the temps already renamed into place. */
interface CommitRun {
  clock: Clock
  memo: ExportMemo
  staging: Staging
  renamed: Set<string>
}

/**
 * Inside the commit's transaction: renames each staged temp over its target, or removes the file, in the order the
 * export collected them; an image its target already holds is left. Containment is re-checked right before each, so a
 * directory swapped for a link meanwhile is caught.
 */
function putInPlace(deps: FinalizerDeps, changes: FileChange[], run: CommitRun, placed: Set<number>): void {
  changes.forEach((change, index) => {
    const temp = change.kind === 'remove' ? null : (run.staging.files.get(change.target)?.temp ?? null)
    if (change.kind !== 'remove' && temp === null) {
      return
    }
    assertContained(deps.layout, deps.fs, change.target)
    if (temp === null) {
      deps.fs.remove(change.target)
    } else {
      deps.fs.mkdirp(dirname(change.target))
      assertContained(deps.layout, deps.fs, change.target)
      deps.fs.rename(temp, change.target)
      run.renamed.add(temp)
    }
    placed.add(index)
  })
}

/** The revision's snapshot record and text, built once per entry: staging builds it, the commit reuses it. */
function snapshotOf(deps: ExportDeps, revisionId: string): SnapshotText {
  const known = deps.memo.snapshots.get(revisionId)
  if (known !== undefined) {
    return known
  }
  const record = buildSnapshotRecord(deps.db, revisionId)
  const snapshot = { record, text: prettyJson(record) }
  deps.memo.snapshots.set(revisionId, snapshot)
  return snapshot
}

/**
 * Writes a snapshot once; an existing file must hold the same bundle and is never rewritten. A file staging found
 * holding it, unchanged since (same stamp), is not read again at the commit.
 */
function writeSnapshot(deps: ExportDeps, snapshot: SnapshotText): void {
  const { record } = snapshot
  const target = ownedPaths(deps.layout).snapshotFile(record.epicId, record.revisionId)
  const shown = displayPath(deps.layout, target)
  if (collectedText(deps, target) === snapshot.text) {
    return
  }
  const stamp = deps.fs.fileStamp(target)
  if (stamp !== null && deps.memo.checked.get(target) === stamp) {
    return
  }
  const existing = readOwnedText(deps, target)
  if (existing !== null) {
    if (existing !== snapshot.text && parseRecord(snapshotRecord, existing, shown).contentHash !== record.contentHash) {
      fail('conflict', `${shown} already exists with different content; snapshots are never rewritten.`)
    }
    if (stamp !== null) {
      deps.memo.checked.set(target, stamp)
    }
    return
  }
  putText(deps, target, snapshot.text, {
    verify: (written) => {
      if (parseRecord(snapshotRecord, written, shown).contentHash !== record.contentHash) {
        fail('internal', `Read-back of ${shown} does not match the revision's content hash.`)
      }
    }
  })
}

/** Kinds of `sync_state` rows the finalizer records exports for. */
type ExportKind = 'epic' | 'run' | 'comment' | 'profile' | 'kanban_card' | 'kanban_event' | 'attachment' | 'metric_observation'

function nextGeneration(db: Db, kind: ExportKind, entityId: string): number {
  const row = db.get<{ generation: number }>('SELECT generation FROM sync_state WHERE kind = ? AND entity_id = ?', kind, entityId)
  return (row?.generation ?? 0) + 1
}

function recordExport(deps: ExportDeps, entry: { kind: ExportKind; entityId: string; hash: string; generation: number }): void {
  if (deps.planning) {
    return
  }
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

/**
 * Writes `attachments/<id>.json` beside the image: who staged it and when, so an import can restore `createdBy`. Named by
 * id (two ids can share bytes); nothing but the id, the hash, the creator and the time goes in. A file already holding
 * exactly this text is left alone.
 */
function writeAttachmentSidecar(deps: ExportDeps, attachment: StoredAttachment, folder: AttachmentFolder): void {
  const target = ownedPaths(deps.layout).attachmentSidecarFile(folder, attachment.id)
  const text = prettyJson({ id: attachment.id, sha256: attachment.sha256, createdBy: attachment.createdBy, createdAt: attachment.createdAt })
  assertContained(deps.layout, deps.fs, target)
  if (deps.fs.exists(target) && readOwnedText(deps, target) === text) {
    return
  }
  putText(deps, target, text)
}

/**
 * Puts one image's file beside its owner's records and records the export (its hash is the image's sha256). Its bytes
 * are loaded, checked and written by staging, which leaves a file already holding them alone.
 */
function exportAttachmentFile(deps: ExportDeps, attachment: StoredAttachment): void {
  const placement = placementOfAttachment(deps.db, attachment)
  const target = ownedPaths(deps.layout).attachmentFile(placement.folder, attachment.sha256, attachment.mime)
  collect(deps, { kind: 'image', target, attachment, identity: `sha256:${attachment.sha256}` })
  writeAttachmentSidecar(deps, attachment, placement.folder)
  recordExport(deps, {
    kind: 'attachment',
    entityId: attachment.id,
    hash: attachment.sha256,
    generation: nextGeneration(deps.db, 'attachment', attachment.id)
  })
}

/**
 * Writes the image files a record points at, before the record itself is written, whatever order the outbox queued
 * them in: an owner's claim can come after its record's own entry, and a record must never point at a file that is
 * not there yet. Images already exported are not touched.
 */
function exportAttachmentsOf(deps: ExportDeps, record: OwningRecord): void {
  for (const attachment of unexportedAttachments(deps.db, record)) {
    exportAttachmentFile(deps, attachment)
  }
}

function attachmentExists(db: Db, id: string): boolean {
  return db.get('SELECT 1 AS present FROM attachments WHERE id = ?', id) !== undefined
}

/**
 * The `attachment` entry of one claimed image. An image in an epic's folder waits for the epic's records to be in this
 * checkout, as a comment does, so a checkout of another branch never gets an epic folder holding images alone.
 */
function exportAttachment(deps: ExportDeps, attachmentId: string): void {
  if (!attachmentExists(deps.db, attachmentId)) {
    // Detached or deleted after it was queued: there is nothing left to export.
    return
  }
  const attachment = loadStoredAttachment(deps.db, attachmentId, false)
  const placement = placementOfAttachment(deps.db, attachment)
  if (placement.folder.kind === 'epic') {
    const pointer = ownedPaths(deps.layout).epicPointerFile(placement.folder.id)
    assertContained(deps.layout, deps.fs, pointer)
    if (!deps.fs.exists(pointer)) {
      fail(
        'not_found',
        `Attachment ${attachmentId} is not exported: the records of epic ${placement.folder.id} are not in this checkout. It is exported once they are, for example after checking out the epic's branch.`
      )
    }
  }
  exportAttachmentFile(deps, attachment)
}

/**
 * Deletes the image files of a card's folder that no remaining row of the card holds (files are named by sha256, so a
 * file stays while any row of the card, or of one of its attempts, has that hash). Runs before the card record is
 * written, so a record never lists an image whose file was just removed, and a dropped image's file does not linger.
 */
function pruneCardAttachmentFiles(deps: ExportDeps, cardId: string): void {
  const dir = ownedPaths(deps.layout).attachmentsDir({ kind: 'kanban_card', id: cardId })
  assertContained(deps.layout, deps.fs, dir)
  if (!deps.fs.exists(dir) || !deps.fs.isDirectory(dir)) {
    return
  }
  const rows = deps.db
      .all<{ id: string; sha256: string }>(
        `SELECT id, sha256 FROM attachments
         WHERE (owner_kind = 'kanban_card' AND owner_id = ?)
            OR (owner_kind = 'kanban_attempt' AND owner_id IN (SELECT id FROM kanban_attempts WHERE card_id = ?))
            OR (owner_kind = 'kanban_message' AND owner_id IN (
              SELECT id FROM kanban_events WHERE card_id = ? AND kind = 'message'
            ))`,
        cardId,
        cardId,
        cardId
      )
  const keptHashes = new Set(rows.map((row) => row.sha256))
  const keptIds = new Set(rows.map((row) => row.id))
  for (const name of deps.fs.readdir(dir)) {
    const match = ATTACHMENT_FILE_NAME.exec(name)
    const sidecar = ATTACHMENT_SIDECAR_NAME.exec(name)
    // A sidecar is named by id, so it goes with its own image row, even when another id keeps the same bytes.
    if ((match !== null && !keptHashes.has(match[1] ?? '')) || (sidecar !== null && !keptIds.has(sidecar[1] ?? ''))) {
      collect(deps, { kind: 'remove', target: join(dir, name) })
    }
  }
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

/** A save's revision, exported before its hook ran: staging builds the state the hook will leave (`preview`). */
interface SavingRevision {
  revisionId: string
  preview: SavedRevisionPreview | null
}

/**
 * Rewrites state.json, then current.json (last), for an epic's current saved revision (or the revision a save is
 * staging), unless the tracked records are held for a Linear transfer or hold records this machine has not imported
 * (`requireWritableRecords`).
 *
 * Before anything is replaced, the hashes the files may pass through are noted (`readExportIntent`), so a process
 * that dies before the row commits does not lock itself out. When a rename or the commit fails, the files already
 * replaced are put back as they were (`restore`), so the checkout again holds the records this machine last synced.
 */
function exportEpic(deps: ExportDeps, epicId: string, entryId: number, saving?: SavingRevision): void {
  const epic = deps.db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', epicId)
  if (epic === undefined) {
    fail('not_found', `Epic ${epicId} does not exist.`)
  }
  const revisionId = saving?.revisionId ?? epic.current_revision_id
  if (revisionId === null) {
    return
  }
  const before = requireWritableRecords(deps, epicId)
  exportAttachmentsOf(deps, { kind: 'epic', id: epicId })
  const snapshot = snapshotOf(deps, revisionId)
  writeSnapshot(deps, snapshot)
  const meta = { generation: nextGeneration(deps.db, 'epic', epicId), updatedAt: deps.clock.nowIso() }
  const stateText = prettyJson(buildEpicStateRecord(deps.db, epicId, meta, saving?.preview ?? undefined))
  const pointerText = prettyJson(buildEpicPointerRecord(snapshot.record, meta))
  const paths = ownedPaths(deps.layout)
  const hashes = [
    trackedEpicHash(before.pointer ?? '', stateText),
    trackedEpicHash(pointerText, stateText),
    trackedEpicHash(pointerText, before.state ?? '')
  ]
  const intent = { entryId, row: epicSyncedRow(deps.db, epicId), hashes }
  putText(deps, paths.exportIntentFile(epicId), JSON.stringify(intent))
  putText(deps, paths.epicStateFile(epicId), stateText, { restore: before.state })
  putText(deps, paths.epicPointerFile(epicId), pointerText, { restore: before.pointer })
  recordExport(deps, { kind: 'epic', entityId: epicId, hash: trackedEpicHash(pointerText, stateText), generation: meta.generation })
}

/** An immutable record: written once, and an existing file must hold the very same record. */
interface OnceRecord<T> {
  schema: z.ZodType<T>
  value: T
  /** What the conflict calls these records, as in "comments are never rewritten". */
  plural: string
  /** Whether the record on disk is the same record (default: identical content). */
  same?: (onDisk: T, value: T) => boolean
}

/** Writes an immutable record file once and returns its text; an existing file must hold the same record. */
function writeOnce<T>(deps: ExportDeps, target: string, record: OnceRecord<T>): string {
  const shown = displayPath(deps.layout, target)
  const existing = readOwnedText(deps, target)
  if (existing !== null) {
    const same = record.same ?? ((onDisk: T, value: T) => contentHash(onDisk) === contentHash(value))
    if (!same(parseRecord(record.schema, existing, shown), record.value)) {
      fail('conflict', `${shown} already exists with different content; ${record.plural} are never rewritten.`)
    }
    return existing
  }
  const text = prettyJson(record.value)
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) {
    fail('internal', `${shown} would be larger than the 8 MiB record limit, so it is not written.`)
  }
  putText(deps, target, text)
  return text
}

/**
 * A checkout of another branch may not hold the epic's records at all: a comment or observation written there would
 * leave an epic folder with only `comments/` or `observations/`, which every reconcile rejects. The entry waits instead.
 */
function requireEpicRecords(deps: FinalizerDeps, epicId: string, what: string): void {
  const pointer = ownedPaths(deps.layout).epicPointerFile(epicId)
  assertContained(deps.layout, deps.fs, pointer)
  if (!deps.fs.exists(pointer)) {
    fail(
      'not_found',
      `${what} is not exported: the records of epic ${epicId} are not in this checkout. It is exported once they are, for example after checking out the epic's branch.`
    )
  }
}

/** Comments are exported beside their epic's records, so only once the epic has a saved plan in this checkout. */
function exportComment(deps: ExportDeps, commentId: string): void {
  const record = buildCommentRecord(deps.db, commentId)
  const epic = deps.db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', record.epicId)
  if ((epic?.current_revision_id ?? null) === null) {
    fail('internal', `Comment ${commentId} belongs to epic ${record.epicId}, which has no saved plan to export it with yet.`)
  }
  requireEpicRecords(deps, record.epicId, `Comment ${commentId}`)
  exportAttachmentsOf(deps, { kind: 'comment', id: commentId })
  const text = writeOnce(deps, ownedPaths(deps.layout).commentFile(record.epicId, commentId), { schema: commentRecord, value: record, plural: 'comments' })
  recordExport(deps, { kind: 'comment', entityId: commentId, hash: trackedCommentHash(text), generation: nextGeneration(deps.db, 'comment', commentId) })
}

/**
 * Writes an observation once: beside its epic's records (waiting, as a comment does, while they are not in this
 * checkout), or in the project-level `observations/` folder when it names no epic. A file already there must hold the
 * same observation, so an export interrupted after its write is completed by the retry and never rewritten. Another
 * machine's file of the same delivery (same payload, its own `recordedAt`) is that observation too, and is kept.
 */
function exportObservation(deps: ExportDeps, observationId: string): void {
  const record = buildObservationRecord(deps.db, observationId)
  const epicId = record.observation.scope.epicId
  if (epicId !== null) {
    requireEpicRecords(deps, epicId, `Metric observation ${observationId}`)
  }
  const target = ownedPaths(deps.layout).observationFile(epicId, observationId)
  const text = writeOnce(deps, target, {
    schema: metricObservationRecord,
    value: record,
    plural: 'metric observations',
    same: (onDisk, value) => observationPayloadHash(onDisk.observation) === observationPayloadHash(value.observation)
  })
  recordExport(deps, {
    kind: 'metric_observation',
    entityId: observationId,
    hash: trackedObservationHash(text),
    generation: nextGeneration(deps.db, 'metric_observation', observationId)
  })
}

/**
 * Writes each report revision's frozen scorecard beside its run history, once and before the run history that names
 * it, so a checkout never holds a run history whose scorecard is missing. A scorecard is immutable and every other
 * machine refuses the whole run over a bad one, so both sides are checked here, as `writeOnce` checks other immutable
 * records: a file already there must hold this scorecard (a truncated or edited copy is a `conflict`, never rewritten),
 * and one written now must pass the import's own check (schema, seal, regrade under its policy), else `conflict`.
 */
function exportScorecards(deps: ExportDeps, runId: string): void {
  const paths = ownedPaths(deps.layout)
  for (const { reportId, text } of scorecardRecordTexts(deps.db, runId)) {
    const target = paths.scorecardFile(runId, reportId)
    const shown = displayPath(deps.layout, target)
    assertContained(deps.layout, deps.fs, target)
    if (deps.fs.exists(target)) {
      const size = deps.fs.fileSize(target)
      if (size <= 0 || size > MAX_RECORD_BYTES || !sameScorecard(deps.fs.readFile(target), text)) {
        fail('conflict', `${shown} already exists with different content; scorecards are never rewritten, so run ${runId} is not exported until it is restored.`)
      }
      continue
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) {
      fail('internal', `${shown} would be larger than the 8 MiB record limit, so it is not written.`)
    }
    try {
      parseRecord(scorecardRecord, text, shown)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      fail('conflict', `The stored scorecard of report ${reportId} is not exported: every other machine would refuse run ${runId} over it. ${reason}`)
    }
    putText(deps, target, text)
  }
}

/** Whether a scorecard file holds the same snapshot as `text` (any formatting or line endings); unreadable is not. */
function sameScorecard(onDisk: string, text: string): boolean {
  try {
    return canonicalJson(JSON.parse(onDisk)) === canonicalJson(JSON.parse(text))
  } catch {
    return false
  }
}

/**
 * Rewrites a card's `card.json` at the next generation, past every generation this machine has exported, imported or
 * seen. It writes only over the record it last exported or imported, or one a reconcile has reported as a conflict
 * with a local edit (and noted as seen): another machine's edit is never dropped before the person was told. Until a
 * reconcile has seen it, the entry fails with `conflict` and waits; the next export after that reconcile wins, as a
 * profile's does.
 */
function exportKanbanCard(deps: ExportDeps, cardId: string): void {
  exportAttachmentsOf(deps, { kind: 'kanban_card', id: cardId })
  pruneCardAttachmentFiles(deps, cardId)
  const target = ownedPaths(deps.layout).kanbanCardFile(cardId)
  const generation = nextGeneration(deps.db, 'kanban_card', cardId)
  const text = prettyJson(buildKanbanCardRecord(deps.db, cardId, { generation }))
  const existing = readOwnedText(deps, target)
  if (existing !== null && existing !== text && !matchesSync(deps.db, 'kanban_card', cardId, trackedKanbanCardHash(existing))) {
    const shown = displayPath(deps.layout, target)
    fail(
      'conflict',
      `${shown} holds a card record this machine has not imported, so the local edit was not written over it. The next reconcile reports the conflict, and the export after it writes the local card.`
    )
  }
  if (existing !== text) {
    putText(deps, target, text)
  }
  recordExport(deps, { kind: 'kanban_card', entityId: cardId, hash: trackedKanbanCardHash(text), generation })
}

/**
 * Writes a card's event once, beside its `card.json`. A checkout without the card's record (another branch) would get
 * a card folder with events alone, which every reconcile rejects; the entry waits instead, as a comment's does.
 */
function exportKanbanEvent(deps: ExportDeps, eventId: string): void {
  const record = buildKanbanEventRecord(deps.db, eventId)
  const paths = ownedPaths(deps.layout)
  const cardFile = paths.kanbanCardFile(record.cardId)
  assertContained(deps.layout, deps.fs, cardFile)
  if (!deps.fs.exists(cardFile)) {
    fail('not_found', `Kanban event ${eventId} is not exported: the record of card ${record.cardId} is not in this checkout.`)
  }
  exportAttachmentsOf(deps, { kind: 'kanban_card', id: record.cardId })
  const text = writeOnce(deps, paths.kanbanEventFile(record.cardId, eventId), { schema: kanbanEventRecord, value: record, plural: 'Kanban events' })
  recordExport(deps, { kind: 'kanban_event', entityId: eventId, hash: trackedKanbanEventHash(text), generation: nextGeneration(deps.db, 'kanban_event', eventId) })
}

/** The ids of the experiment events a tracked run history holds; none when it does not parse. */
function trackedEventIds(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { experimentEvents?: unknown }
    const events = Array.isArray(parsed.experimentEvents) ? (parsed.experimentEvents as ({ id?: unknown } | null)[]) : []
    return events.flatMap((event) => (typeof event?.id === 'string' ? [event.id] : []))
  } catch {
    return []
  }
}

/**
 * Refuses, with `conflict`, to write a run's history over a tracked one holding records this machine has not imported:
 * any such file for a run another machine owns (this machine only appends experiment events there, from a stale copy of
 * the rest), and for a run it owns, one holding experiment events it does not store (another machine's results). Writing
 * would drop them. The entry waits; the reconcile adds them, numbering this machine's unexported events after them
 * (`insertExperimentEvents`), and the export after it writes both. A database that never learned this machine's id
 * (no workspace opened it) is held to the event rule only.
 */
function requireWritableRunHistory(deps: FinalizerDeps, runId: string): void {
  const path = ownedPaths(deps.layout).runHistoryFile(runId)
  const existing = readOwnedText(deps, path)
  if (existing === null || matchesSync(deps.db, 'run', runId, trackedRunHash(existing))) return
  const shown = displayPath(deps.layout, path)
  const machineId = getMeta(deps.db, META_KEYS.machineId)
  const owner = deps.db.get<{ owner_machine_id: string }>('SELECT owner_machine_id FROM runs WHERE id = ?', runId)?.owner_machine_id
  if (machineId !== null && owner !== machineId) {
    fail(
      'conflict',
      `${shown} holds records of run ${runId} this machine has not imported, and machine ${owner ?? 'unknown'} owns the run, so this machine's experiment events were not written over them. Reconcile: it takes the tracked history and numbers this machine's unexported events after its own, and the next export writes both.`
    )
  }
  const unknown = trackedEventIds(existing).filter((id) => deps.db.get('SELECT id FROM experiment_events WHERE id = ?', id) === undefined)
  if (unknown.length > 0) {
    fail(
      'conflict',
      `${shown} holds experiment events this machine has not imported (${unknown.join(', ')}), so the run history was not written over them. Reconcile: it adds them and numbers this machine's unexported events after them, and the next export writes both.`
    )
  }
}

function required(value: string | null, what: string): string {
  if (value === null) {
    fail('internal', `Outbox entry has no ${what}.`)
  }
  return value
}

type EntryHandler = (deps: ExportDeps, hooks: FinalizerHooks, entry: OutboxRow) => void

const FILE_HANDLERS: Record<OutboxKind, EntryHandler> = {
  snapshot: (deps, hooks, entry) => {
    const revisionId = required(entry.revision_id, 'revision id')
    const snapshot = snapshotOf(deps, revisionId)
    // Checked before the snapshot is written too, so a save refused for held or unimported records leaves no file behind.
    requireWritableRecords(deps, snapshot.record.epicId)
    writeSnapshot(deps, snapshot)
    if (deps.planning) {
      // Staging never writes the database: the hook runs once, at the commit.
      exportEpic(deps, snapshot.record.epicId, entry.id, { revisionId, preview: hooks.previewSavedRevision?.(revisionId) ?? null })
      return
    }
    hooks.onSnapshotSaved(revisionId)
    exportEpic(deps, snapshot.record.epicId, entry.id)
  },
  epic_state: (deps, _hooks, entry) => exportEpic(deps, required(entry.epic_id, 'epic id'), entry.id),
  run_history: (deps, _hooks, entry) => {
    const runId = required(entry.run_id, 'run id')
    requireWritableRunHistory(deps, runId)
    exportAttachmentsOf(deps, { kind: 'run', id: runId })
    exportScorecards(deps, runId)
    const text = prettyJson(buildRunHistoryRecord(deps.db, runId))
    putText(deps, ownedPaths(deps.layout).runHistoryFile(runId), text)
    recordExport(deps, { kind: 'run', entityId: runId, hash: trackedRunHash(text), generation: nextGeneration(deps.db, 'run', runId) })
  },
  comment: (deps, _hooks, entry) => exportComment(deps, required(entry.entity_id, 'comment id')),
  profile: (deps, _hooks, entry) => {
    const name = required(entry.entity_id, 'entity id')
    const text = prettyJson(buildProfileRecord(deps.db, name))
    putText(deps, ownedPaths(deps.layout).profileFile(name), text)
    recordExport(deps, { kind: 'profile', entityId: name, hash: trackedProfileHash(text), generation: nextGeneration(deps.db, 'profile', name) })
  },
  kanban_card: (deps, _hooks, entry) => exportKanbanCard(deps, required(entry.entity_id, 'card id')),
  kanban_event: (deps, _hooks, entry) => exportKanbanEvent(deps, required(entry.entity_id, 'event id')),
  attachment: (deps, _hooks, entry) => exportAttachment(deps, required(entry.entity_id, 'attachment id')),
  metric_observation: (deps, _hooks, entry) => exportObservation(deps, required(entry.entity_id, 'observation id'))
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
  profile: () => undefined,
  kanban_card: () => undefined,
  kanban_event: () => undefined,
  attachment: () => undefined,
  metric_observation: () => undefined
}

type EntryResult = 'flushed' | 'skipped' | 'stale'

/** Whether the entry still waits: another process may have completed it meanwhile. */
function waiting(db: Db, entryId: number): boolean {
  const current = db.get<{ state: string }>('SELECT state FROM outbox WHERE id = ?', entryId)
  return current !== undefined && current.state !== 'done'
}

function completeEntry(db: Db, entryId: number, now: string): void {
  db.run("UPDATE outbox SET state = 'done', done_at = ?, last_error = NULL, next_attempt_at = NULL WHERE id = ?", now, entryId)
  setMeta(db, META_KEYS.lastFlushAt, now)
}

function newMemo(): ExportMemo {
  return { snapshots: new Map(), checked: new Map() }
}

function exportDeps(deps: FinalizerDeps, clock: Clock, memo: ExportMemo, planning: boolean): ExportDeps {
  return { db: deps.db, layout: deps.layout, fs: deps.fs, clock, changes: [], memo, planning }
}

/** `db` mode, in one transaction: no file is written. Skips an entry another process completed meanwhile. */
function processEntry(deps: FinalizerDeps, hooks: FinalizerHooks, entry: OutboxRow): EntryResult {
  if (!waiting(deps.db, entry.id)) {
    return 'skipped'
  }
  DB_HANDLERS[entry.kind](exportDeps(deps, deps.clock, newMemo(), false), hooks, entry)
  completeEntry(deps.db, entry.id, deps.clock.nowIso())
  return 'flushed'
}

/** Runs the entry's file export and returns the changes it collected, or null when the entry no longer waits. */
function collectChanges(deps: ExportDeps, hooks: FinalizerHooks, entry: OutboxRow): FileChange[] | null {
  if (!waiting(deps.db, entry.id)) {
    return null
  }
  FILE_HANDLERS[entry.kind](deps, hooks, entry)
  return deps.changes
}

function discardAll(fs: FsAdapter, temps: string[]): void {
  for (const temp of temps) {
    discard(fs, temp)
  }
}

/** Puts back the tracked files the commit already replaced, in reverse order, as they were before the export. */
function putBack(deps: FinalizerDeps, changes: FileChange[], placed: Set<number>): void {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index]
    if (placed.has(index) && change?.kind === 'write' && change.restore !== undefined) {
      restoreFile(deps, change.target, change.restore)
    }
  }
  placed.clear()
}

/** Thrown to roll back a commit that found changes staging did not stage: they are staged next. */
class Restage {
  constructor(readonly changes: FileChange[]) {}
}

/**
 * The commit, in one short write transaction: collects the entry's changes again from the rows as they are now (the
 * save hook runs here, once), and only when every one is staged renames the temps into place and completes the entry.
 *
 * A rename or the completion failing puts the replaced files back before the transaction rolls back, while the lock is
 * still held, so no other process's export of the entry can land in between and be overwritten. Only a failing COMMIT
 * itself puts them back after the lock is released.
 */
function commitChanges(deps: FinalizerDeps, hooks: FinalizerHooks, entry: OutboxRow, run: CommitRun): EntryResult | Restage {
  const placed = new Set<number>()
  let changes: FileChange[] = []
  try {
    return deps.db.tx((): EntryResult => {
      const found = collectChanges(exportDeps(deps, run.clock, run.memo, false), hooks, entry)
      if (found === null) {
        return 'skipped'
      }
      if (!allStaged(deps.fs, found, run.staging)) {
        throw new Restage(found)
      }
      changes = found
      try {
        putInPlace(deps, changes, run, placed)
        completeEntry(deps.db, entry.id, run.clock.nowIso())
      } catch (error: unknown) {
        putBack(deps, changes, placed)
        throw error
      }
      return 'flushed'
    })
  } catch (error: unknown) {
    if (error instanceof Restage) {
      return error
    }
    // Only a failing COMMIT leaves files placed: the lock is gone, but the rows they describe never committed.
    putBack(deps, changes, placed)
    throw error
  }
}

/**
 * A `repo` mode entry in two steps (see the module comment). Staging collects the changes in a read transaction and
 * writes, fsyncs and reads back their temps, outside the write lock; the commit renames them into place. A commit that
 * finds other changes (a write landed while it staged, or a save hook without a preview) stages exactly those and
 * commits again, so a concurrent write never leaves a save pending; past `MAX_RESTAGES` the entry waits (`stale`) for
 * the next flush. Every temp not renamed into place is removed.
 */
function exportEntry(deps: FinalizerDeps, hooks: FinalizerHooks, entry: OutboxRow): EntryResult {
  const now = { ms: deps.clock.nowMs(), iso: deps.clock.nowIso() }
  const run: CommitRun = {
    clock: { nowMs: () => now.ms, nowIso: () => now.iso },
    memo: newMemo(),
    staging: { files: new Map(), count: 0 },
    renamed: new Set()
  }
  let changes = deps.db.tx(() => collectChanges(exportDeps(deps, run.clock, run.memo, true), hooks, entry), 'read')
  if (changes === null) {
    return 'skipped'
  }
  try {
    for (let round = 0; ; round += 1) {
      stageChanges(deps, entry.id, changes, run.staging)
      const result = commitChanges(deps, hooks, entry, run)
      if (!(result instanceof Restage)) {
        return result
      }
      if (round === MAX_RESTAGES) {
        return 'stale'
      }
      changes = result.changes
    }
  } finally {
    const temps = [...run.staging.files.values()].flatMap((staged) => (staged.temp === null || run.renamed.has(staged.temp) ? [] : [staged.temp]))
    discardAll(deps.fs, temps)
  }
}

function recordFailure(deps: FinalizerDeps, entry: OutboxRow, message: string): void {
  deps.db.tx(() => {
    const row = deps.db.get<{ attempts: number; state: string }>('SELECT attempts, state FROM outbox WHERE id = ?', entry.id)
    // Another process may have completed the entry since this one failed it: a done entry stays done.
    if (row === undefined || row.state === 'done') {
      return
    }
    // The delay counts a failed entry's failures past the attempt maximum, so it reaches its 5 min cap.
    const attempts = Math.min(row.attempts + 1, MAX_FLUSH_ATTEMPTS)
    const failures = row.state === 'failed' ? MAX_FLUSH_ATTEMPTS + 1 : row.attempts + 1
    const delay = Math.min(RETRY_DELAY_SECONDS * 2 ** (failures - 1), MAX_RETRY_DELAY_SECONDS)
    deps.db.run(
      'UPDATE outbox SET attempts = ?, last_error = ?, state = ?, next_attempt_at = ? WHERE id = ?',
      attempts,
      message.slice(0, MAX_ERROR_LENGTH),
      attempts >= MAX_FLUSH_ATTEMPTS ? 'failed' : 'pending',
      addSeconds(deps.clock.nowIso(), delay),
      entry.id
    )
  })
}

function entityKeys(entry: OutboxRow): string[] {
  // A comment or observation file stands alone: it never waits for, or holds back, its epic's plan records.
  if (entry.kind === 'comment' || entry.kind === 'metric_observation') {
    return [`${entry.kind}:${entry.entity_id ?? entry.id}`]
  }
  // A card's definition and events are written in order: a failed one holds back the card's later records only.
  if (entry.card_id !== null) {
    return [`kanban:${entry.card_id}`]
  }
  // An image file stands alone too: it never holds back, or waits behind, the records of its epic or run.
  if (entry.kind === 'attachment') {
    return [`attachment:${entry.entity_id ?? entry.id}`]
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

/** An explicit flush (`flush_portable_state`, the desktop Flush) retries every waiting entry; a scheduled one honors backoff. */
export type FlushMode = 'explicit' | 'scheduled'

interface FlushState {
  outcome: FlushOutcome
  blocked: Set<string>
  mode: FlushMode
}

/** Whether a scheduled flush leaves the entry: it failed, and its retry time has not come yet. */
function backingOff(deps: FinalizerDeps, entry: OutboxRow, mode: FlushMode): boolean {
  return mode === 'scheduled' && entry.next_attempt_at !== null && isBefore(deps.clock.nowIso(), entry.next_attempt_at)
}

/** What a reconcile applied, as `ReconcileResultView` names it. */
export interface ReconciledRecords {
  imported: readonly string[]
  branchChanged: boolean
}

/** The ids a reconcile result names an entry's records by: epic, run, comment, `profile:<name>`, `kanban:<cardId>`. */
function reconciledIds(entry: OutboxRow): string[] {
  const ids = [entry.epic_id, entry.run_id, entry.entity_id, entry.card_id === null ? null : `kanban:${entry.card_id}`]
  ids.push(entry.kind === 'profile' && entry.entity_id !== null ? `profile:${entry.entity_id}` : null)
  return ids.filter((id) => id !== null)
}

/**
 * Inside a reconcile's transaction, with what it applied: an entry waiting out its backoff whose records the reconcile
 * imported (every waiting entry, once it acknowledged a branch change) is retried by the next scheduled flush at once.
 * A failure the reconcile clears (records not in this checkout, records not imported yet) then neither waits out its
 * delay nor holds back the records queued after it. Records it found unchanged keep their backoff: nothing about
 * them changed, so a failure writing them (a full disk, a locked file) is no likelier to clear.
 */
export function releaseBackoff(db: Db, result: ReconciledRecords): void {
  const imported = new Set(result.imported)
  for (const entry of queuedAfter(db, 0, undefined)) {
    if (entry.next_attempt_at !== null && (result.branchChanged || reconciledIds(entry).some((id) => imported.has(id)))) {
      db.run('UPDATE outbox SET next_attempt_at = NULL WHERE id = ?', entry.id)
    }
  }
}

/** Tidies the export intent of a committed epic export; only a top-level commit is final. */
function afterCommit(deps: FinalizerDeps, entry: OutboxRow): void {
  // Inside an outer transaction the row binding still covers a rollback.
  const exportsEpic = entry.kind === 'snapshot' || entry.kind === 'epic_state'
  if (exportsEpic && entry.epic_id !== null && deps.layout.mode === 'repo' && !deps.db.inTransaction()) {
    spendExportIntent(deps, entry.epic_id, entry.id)
  }
}

function flushEntry(deps: FinalizerDeps, hooks: FinalizerHooks, entry: OutboxRow, state: FlushState): void {
  const keys = entityKeys(entry)
  const holdBack = (): void => keys.forEach((key) => state.blocked.add(key))
  if (keys.some((key) => state.blocked.has(key))) {
    return
  }
  // An entry waiting out its backoff, or one whose rows changed while it was staged, holds back its later records.
  if (backingOff(deps, entry, state.mode)) {
    holdBack()
    return
  }
  try {
    const result = deps.layout.mode === 'repo' ? exportEntry(deps, hooks, entry) : deps.db.tx(() => processEntry(deps, hooks, entry))
    if (result === 'stale') {
      holdBack()
      return
    }
    noteSuccess(state.outcome, entry, result)
    afterCommit(deps, entry)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    recordFailure(deps, entry, message)
    holdBack()
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
    `SELECT o.id, o.kind, o.epic_id, o.run_id, o.revision_id, o.entity_id, o.next_attempt_at,
       CASE o.kind WHEN 'kanban_card' THEN o.entity_id
         WHEN 'kanban_event' THEN (SELECT e.card_id FROM kanban_events e WHERE e.id = o.entity_id)
         WHEN 'attachment' THEN (SELECT CASE a.owner_kind WHEN 'kanban_card' THEN a.owner_id
           WHEN 'kanban_attempt' THEN (SELECT k.card_id FROM kanban_attempts k WHERE k.id = a.owner_id)
           WHEN 'kanban_message' THEN (SELECT e.card_id FROM kanban_events e WHERE e.id = a.owner_id AND e.kind = 'message') END
           FROM attachments a WHERE a.id = o.entity_id) END AS card_id
     FROM outbox o WHERE o.state IN ('pending', 'failed') AND o.id > ? ORDER BY o.id`,
    afterId
  )
  if (scope === undefined) {
    return rows
  }
  // Kanban records belong to no epic, so only an unscoped flush writes them.
  return rows.filter(
    (row) =>
      !KANBAN_OUTBOX_KINDS.includes(row.kind) &&
      row.epic_id === scope.epicId &&
      (scope.kinds === undefined || scope.kinds.includes(row.kind))
  )
}

/** Whether a process with this id is running (EPERM: it is, under another user). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes temps under `local/staging/` that a process left when it died between staging and its commit. A temp is
 * named after the process that staged it, so only those of processes no longer running go; a live process's temps
 * (this one's included) stay. Best effort: they are untracked and never read, so one left behind costs only disk.
 */
function sweepOrphanedStaging(deps: FinalizerDeps): void {
  try {
    const dir = join(deps.layout.localDir, 'staging')
    assertContained(deps.layout, deps.fs, dir)
    if (!deps.fs.exists(dir) || !deps.fs.isDirectory(dir)) {
      return
    }
    for (const name of deps.fs.readdir(dir)) {
      const pid = Number(/\.tmp-(\d+)$/.exec(name)?.[1] ?? Number.NaN)
      if (Number.isSafeInteger(pid) && pid > 0 && !processAlive(pid)) {
        discard(deps.fs, join(dir, name))
      }
    }
  } catch {
    // Leftover temps never change what is exported.
  }
}

/**
 * Flushes pending (and previously failed) outbox entries in id order, through the handlers of the
 * project's storage mode (`db` writes no file), all of them or those in `scope`. A failed entry blocks later
 * entries of the same epic, run, or keyed record (such as a profile) so their records are never
 * written out of order; other entities continue. A `scheduled` flush (after a mutation) leaves a failed entry
 * until its backoff has passed; an `explicit` one retries it at once. Entries queued by the flush itself are picked
 * up by a further pass (bounded). Flush failures never throw: they are counted, and the entry keeps its last error.
 * A `repo` flush first removes the staged temps of processes that died before their commit.
 */
export function flushOutbox(deps: FinalizerDeps, hooks: FinalizerHooks, scope?: FlushScope, mode: FlushMode = 'explicit'): FlushOutcome {
  const state: FlushState = {
    outcome: { flushed: 0, failed: 0, errors: [], savedRevisionIds: [], failedRevisionIds: [] },
    blocked: new Set<string>(),
    mode
  }
  if (deps.layout.mode === 'repo') {
    sweepOrphanedStaging(deps)
  }
  let afterId = 0
  for (let pass = 0; pass < MAX_FLUSH_PASSES; pass += 1) {
    const entries = queuedAfter(deps.db, afterId, scope)
    if (entries.length === 0) {
      break
    }
    for (const entry of entries) {
      flushEntry(deps, hooks, entry, state)
      afterId = entry.id
    }
  }
  return state.outcome
}
