/** Portable preservation of images whose original owning record no longer exists. Never invents or reassigns owners. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { inspectImageBytes, MAX_IMAGE_BYTES } from '../attachments/intake'
import { canonicalJson, contentHash, prettyJson } from '../canonical'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { isStableId } from '../ids'
import { attachmentRef } from '../schemas'
import { insertOwnedRow } from './attachmentImport'
import type { FileHashCache } from './fileHashes'
import { ATTACHMENT_SIDECAR_NAME, loadStoredAttachment, writeAttachmentBytes } from './attachmentFiles'
import { writeFileSafely } from './finalizer'
import { assertContained, displayPath } from './paths'
import { attachmentSidecar, readOwnedRecord } from './portable'
import type { FsAdapter, RepoLayout } from './types'

const ownerKinds = { attempt: 'attempt', kanban_attempt: 'kanbanAttempt', kanban_message: 'kanbanEvent', kanban_card: 'kanbanCard', comment: 'comment', ticket: 'ticket' } as const
const owner = z.strictObject({
  kind: z.enum(['attempt', 'kanban_attempt', 'kanban_message', 'kanban_card', 'comment', 'ticket']),
  id: z.string()
}).refine(value => isStableId(value.id, ownerKinds[value.kind]), 'Invalid original attachment owner')
const archiveSchema = z.strictObject({
  format: z.literal('darkmechanicus.recovered-attachment'), formatVersion: z.literal(1),
  attachment: attachmentRef, owner,
  createdBy: attachmentSidecar.shape.createdBy, createdAt: attachmentSidecar.shape.createdAt
})
type Archive = z.infer<typeof archiveSchema>
interface Env { db: Db; fs: FsAdapter; layout: RepoLayout; fileHashes?: FileHashCache }

function directory(layout: RepoLayout): string { return join(layout.dmDir, 'recovered-attachments') }
function imagePath(layout: RepoLayout, record: Archive): string {
  return join(directory(layout), `${record.attachment.sha256}.${record.attachment.mime === 'image/png' ? 'png' : 'jpg'}`)
}

interface StoredArchive {
  archive: Archive
  missing: boolean
  length: number | null
}

function storedArchive(db: Db, id: string): StoredArchive | null {
  const row = db.get<{
    sha256: string; mime: string; bytes: number; width: number; height: number; label: string; purpose: string
    owner_kind: string | null; owner_id: string | null; created_by_role: string; created_by_label: string; created_at: string
    missing: number; length: number | null
  }>(
    `SELECT sha256, mime, bytes, width, height, label, purpose, owner_kind, owner_id, created_by_role, created_by_label,
       created_at, missing, length(data) AS length FROM attachments WHERE id = ?`, id
  )
  if (row === undefined) return null
  const { sha256, mime, bytes, width, height, label, purpose } = row
  const archive = archiveSchema.parse({
    format: 'darkmechanicus.recovered-attachment', formatVersion: 1,
    attachment: { id, sha256, mime, bytes, width, height, label, purpose },
    owner: { kind: row.owner_kind, id: row.owner_id },
    createdBy: { role: row.created_by_role, label: row.created_by_label }, createdAt: row.created_at
  })
  return { archive, length: row.length, missing: row.missing !== 0 }
}

function recordOf(db: Db, id: string): Archive {
  return storedArchive(db, id)?.archive ?? fail('not_found', `Attachment ${id} does not exist.`, { id })
}

function verifyBytes(record: Archive, bytes: Uint8Array): void {
  const ref = record.attachment
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) fail('conflict', `Recovered attachment ${ref.id} bytes do not match its sha256.`)
  const inspected = inspectImageBytes(bytes)
  if (bytes.byteLength !== ref.bytes || inspected.mime !== ref.mime || inspected.width !== ref.width || inspected.height !== ref.height) {
    fail('conflict', `Recovered attachment ${ref.id} image does not match its metadata.`)
  }
}

/** Missing bytes remain an error; recovery preserves evidence rather than turning absence into success. */
export function exportRecoveredAttachment(env: Env, id: string): void {
  const record = recordOf(env.db, id)
  const stored = loadStoredAttachment(env.db, id)
  if (stored.data === null) fail('not_found', `The bytes of recovered attachment ${id} are missing.`)
  verifyBytes(record, stored.data)
  writeAttachmentBytes(env, stored, imagePath(env.layout, record))
  writeFileSafely(env, join(directory(env.layout), `${id}.json`), prettyJson(record))
}

function readBytes(env: Env, record: Archive): Uint8Array {
  const path = imagePath(env.layout, record)
  assertContained(env.layout, env.fs, path)
  const size = env.fs.fileSize(path)
  if (size < 1 || size > MAX_IMAGE_BYTES || size !== record.attachment.bytes) fail('import_rejected', `Recovered attachment ${record.attachment.id} has missing or invalid image bytes.`)
  const bytes = env.fs.readFileBytes(path)
  verifyBytes(record, bytes)
  return bytes
}

function readRecord(env: Env, path: string, id: string): Archive {
  assertContained(env.layout, env.fs, path)
  if (env.fs.fileSize(path) > 16 * 1024) fail('import_rejected', 'Recovered attachment metadata exceeds 16 KiB.')
  const record = readOwnedRecord(env, archiveSchema, path) ?? fail('import_rejected', 'Recovered attachment record disappeared.')
  if (record.attachment.id !== id) fail('import_rejected', 'Recovered attachment id does not match its filename.')
  return record
}

/** Hydrates an orphan from a prior recovery archive, without trusting its placement or metadata. */
export function readRecoveredAttachmentBytes(env: Env, id: string): Uint8Array {
  const record = readRecord(env, join(directory(env.layout), `${id}.json`), id)
  if (canonicalJson(recordOf(env.db, id)) !== canonicalJson(record)) fail('conflict', `Recovered attachment ${id} conflicts with existing attachment metadata or ownership.`)
  return readBytes(env, record)
}

function archiveStamp(env: Env, sidecar: string, archive: Archive): string | null {
  const image = imagePath(env.layout, archive)
  assertContained(env.layout, env.fs, sidecar)
  assertContained(env.layout, env.fs, image)
  const recordStamp = env.fs.fileStamp(sidecar)
  const imageStamp = env.fs.fileStamp(image)
  return recordStamp === null || imageStamp === null ? null : contentHash([recordStamp, imageStamp])
}

/** What a verified archive is remembered against: the stored row, complete, with its metadata (its sha256 binds the bytes). */
function savedIdentity(row: StoredArchive | null): string | null {
  if (row === null || row.missing || row.length !== row.archive.attachment.bytes) return null
  return contentHash([row.archive])
}

/** Whether restoring `record` would write: its row is absent, without bytes or missing. Refuses conflicting metadata. */
function wouldRestore(db: Db, record: Archive): boolean {
  const { id } = record.attachment
  const current = storedArchive(db, id)
  if (current === null) return true
  // Canonical references register a placeholder before their image files restore its original creator.
  const { archive } = current
  const placeholder = current.length === null && archive.createdBy.role === 'worker' && archive.createdBy.label === 'imported'
  const comparable = placeholder ? { ...archive, createdBy: record.createdBy, createdAt: record.createdAt } : archive
  if (canonicalJson(comparable) !== canonicalJson(record)) fail('conflict', `Recovered attachment ${id} conflicts with existing attachment metadata or ownership.`)
  const data = loadStoredAttachment(db, id).data
  if (data !== null) verifyBytes(record, data)
  return data === null || current.missing
}

function restoreArchive(env: Env, record: Archive, bytes: Uint8Array): boolean {
  if (!wouldRestore(env.db, record)) return false
  const { id } = record.attachment
  if (storedArchive(env.db, id) === null) {
    insertOwnedRow(env.db, record.attachment, { owner: record.owner.kind, ownerId: record.owner.id, createdAt: record.createdAt })
  }
  env.db.run('UPDATE attachments SET data = ?, missing = 0, created_by_role = ?, created_by_label = ?, created_at = ? WHERE id = ?',
    Buffer.from(bytes), record.createdBy.role, record.createdBy.label, record.createdAt, id)
  return true
}

/** An archive read and verified before the writer lock, whose row still needs it. */
interface PreparedArchive {
  path: string
  record: Archive
  bytes: Uint8Array
  /** The sidecar and image stamps, when they held still while read; the verification is remembered against them. */
  stamp: string | null
}

/** Whether the verification remembered for the stored row still holds for the archive's current stamps. */
function rememberedValid(env: Env, path: string, id: string): boolean {
  const saved = storedArchive(env.db, id)
  const identity = savedIdentity(saved)
  if (saved === null || identity === null || env.fileHashes === undefined) return false
  const stamp = archiveStamp(env, path, saved.archive)
  return stamp !== null && env.fileHashes.get(`recovered:v1:${id}`, stamp) === identity
}

/** Reads and verifies one archive (no write); null when its row already holds it. */
function prepareOne(env: Env, path: string, id: string): PreparedArchive | null {
  if (rememberedValid(env, path, id)) return null
  const sidecarStamp = env.fs.fileStamp(path)
  const record = readRecord(env, path, id)
  const before = archiveStamp(env, path, record)
  const bytes = readBytes(env, record)
  const stable = before !== null && sidecarStamp !== null && sidecarStamp === env.fs.fileStamp(path) && before === archiveStamp(env, path, record)
  if (!wouldRestore(env.db, record)) {
    if (stable) env.fileHashes?.remember(`recovered:v1:${id}`, before, contentHash([record]))
    return null
  }
  return { path, record, bytes, stamp: stable ? before : null }
}

/** `prepareOne`, with a failure reported as the archive's rejection. */
function tryPrepare(env: Env, path: string, id: string, plan: RecoveredPlan): void {
  try {
    const prepared = prepareOne(env, path, id)
    if (prepared !== null) plan.pending.push(prepared)
  } catch (error) {
    plan.rejected.push({ path: displayPath(env.layout, path), message: error instanceof Error ? error.message : String(error) })
  }
}

/** Shared by export and import: a successful migration must not publish an archive a clone refuses for its size. */
export function assertRecoveredArchiveBounds(env: Pick<Env, 'fs' | 'layout'>): string[] {
  const dir = directory(env.layout)
  assertContained(env.layout, env.fs, dir)
  if (!env.fs.exists(dir)) return []
  if (!env.fs.isDirectory(dir)) fail('import_rejected', 'Recovered attachments must be a directory.')
  const names = env.fs.readdir(dir)
  if (names.length > 20_000) fail('import_rejected', 'Recovered attachment archive has too many files.')
  let bytes = 0
  for (const name of names) {
    const path = join(dir, name)
    assertContained(env.layout, env.fs, path)
    bytes += Math.max(0, env.fs.fileSize(path))
    if (bytes > 512 * 1024 * 1024) fail('import_rejected', 'Recovered attachment archive exceeds 512 MiB.')
  }
  return names
}

/** The archives `importRecoveredAttachments` would restore, read and verified without the writer lock, and those it refuses. */
export interface RecoveredPlan {
  pending: PreparedArchive[]
  rejected: { path: string; message: string }[]
}

/** Reads and verifies `recovered-attachments/` without writing: file reads and hashing happen here, outside any lock. */
export function prepareRecoveredAttachments(env: Env): RecoveredPlan {
  const plan: RecoveredPlan = { pending: [], rejected: [] }
  const dir = directory(env.layout)
  try {
    for (const name of assertRecoveredArchiveBounds(env)) {
      const match = ATTACHMENT_SIDECAR_NAME.exec(name)
      if (match !== null) tryPrepare(env, join(dir, name), match[1]!, plan)
    }
  } catch (error) {
    plan.rejected.push({ path: displayPath(env.layout, dir), message: error instanceof Error ? error.message : String(error) })
  }
  return plan
}

/** Restores each prepared archive in its own short transaction, rechecking its row under the lock. */
export function applyRecoveredAttachments(env: Env, plan: RecoveredPlan): { changed: boolean; rejected: { path: string; message: string }[] } {
  const rejected = [...plan.rejected]
  let changed = false
  for (const prepared of plan.pending) {
    try {
      changed = env.db.tx(() => restoreArchive(env, prepared.record, prepared.bytes)) || changed
      if (prepared.stamp !== null) env.fileHashes?.remember(`recovered:v1:${prepared.record.attachment.id}`, prepared.stamp, contentHash([prepared.record]))
    } catch (error) {
      rejected.push({ path: displayPath(env.layout, prepared.path), message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { changed, rejected }
}

/** Archives are immutable metadata, checked against any existing row. An owner restored later can use the same image. */
export function importRecoveredAttachments(env: Env, onChange?: () => void): { path: string; message: string }[] {
  const outcome = applyRecoveredAttachments(env, prepareRecoveredAttachments(env))
  if (outcome.changed) onChange?.()
  return outcome.rejected
}
