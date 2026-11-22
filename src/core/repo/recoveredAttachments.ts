/** Portable preservation of images whose original owning record no longer exists. Never invents or reassigns owners. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { inspectImageBytes, MAX_IMAGE_BYTES } from '../attachments/intake'
import { canonicalJson, prettyJson } from '../canonical'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { isStableId } from '../ids'
import { attachmentRef } from '../schemas'
import { insertOwnedRow } from './attachmentImport'
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
interface Env { db: Db; fs: FsAdapter; layout: RepoLayout }

function directory(layout: RepoLayout): string { return join(layout.dmDir, 'recovered-attachments') }
function imagePath(layout: RepoLayout, record: Archive): string {
  return join(directory(layout), `${record.attachment.sha256}.${record.attachment.mime === 'image/png' ? 'png' : 'jpg'}`)
}

function recordOf(db: Db, id: string): Archive {
  const attachment = loadStoredAttachment(db, id)
  const metadata = db.get<{ bytes: number; width: number; height: number; label: string; purpose: string }>(
    'SELECT bytes, width, height, label, purpose FROM attachments WHERE id = ?', id
  )!
  return archiveSchema.parse({
    format: 'darkmechanicus.recovered-attachment', formatVersion: 1,
    attachment: { id, sha256: attachment.sha256, mime: attachment.mime, ...metadata }, owner: attachment.owner,
    createdBy: attachment.createdBy, createdAt: attachment.createdAt
  })
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

function importOne(env: Env, path: string, id: string): void {
  const record = readRecord(env, path, id)
  const bytes = readBytes(env, record)
  const exists = env.db.get<{ missing: number }>('SELECT missing FROM attachments WHERE id = ?', id)
  if (!exists) {
    insertOwnedRow(env.db, record.attachment, { owner: record.owner.kind, ownerId: record.owner.id, createdAt: record.createdAt })
  } else {
    const current = loadStoredAttachment(env.db, id)
    const metadata = recordOf(env.db, id)
    // Canonical references register a placeholder before their image files restore its original creator.
    const placeholder = current.data === null && current.createdBy.role === 'worker' && current.createdBy.label === 'imported'
    const comparable = placeholder ? { ...metadata, createdBy: record.createdBy, createdAt: record.createdAt } : metadata
    if (canonicalJson(comparable) !== canonicalJson(record)) fail('conflict', `Recovered attachment ${id} conflicts with existing attachment metadata or ownership.`)
    if (current.data !== null) {
      verifyBytes(record, current.data)
      if (exists.missing === 0) return // Reconciliation must not rewrite every historical image on each heartbeat.
    }
  }
  env.db.run('UPDATE attachments SET data = ?, missing = 0, created_by_role = ?, created_by_label = ?, created_at = ? WHERE id = ?',
    Buffer.from(bytes), record.createdBy.role, record.createdBy.label, record.createdAt, id)
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

/** Archives are immutable metadata, checked against any existing row. An owner restored later can use the same image. */
export function importRecoveredAttachments(env: Env): { path: string; message: string }[] {
  const rejected: { path: string; message: string }[] = []
  const dir = directory(env.layout)
  const reject = (path: string, error: unknown): void => { rejected.push({ path: displayPath(env.layout, path), message: error instanceof Error ? error.message : String(error) }) }
  try {
    const names = assertRecoveredArchiveBounds(env)
    for (const name of names) {
      const match = ATTACHMENT_SIDECAR_NAME.exec(name)
      if (match === null) continue
      const path = join(dir, name)
      try { env.db.tx(() => importOne(env, path, match[1]!)) } catch (error) { reject(path, error) }
    }
  } catch (error) { reject(dir, error) }
  return rejected
}
