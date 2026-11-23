/**
 * Reads attachment image files back into the database on reconcile. Records name their images by metadata only, so a
 * row can arrive without bytes (`data` NULL); this fills it from `attachments/<sha256>.<ext>` in the folder that owns it.
 * Every file is untrusted: the folder and each file must be contained (no links), the folder is bounded in files and
 * bytes, and a file counts only when its hash matches its name and its bytes are a PNG or JPEG of the declared type.
 * An image whose file is missing, corrupt or refused is flagged missing instead of failing the import.
 */
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { AttachmentMime, AttachmentOwnerKind, AttachmentRef, SessionRole } from '../../shared/domain/views'
import { contentHash } from '../canonical'
import { inspectImageBytes, MAX_IMAGE_BYTES } from '../attachments/intake'
import type { Db } from '../db/database'
import { attachmentRef } from '../schemas'
import type { FileHashCache } from './fileHashes'
import { ATTACHMENT_SIDECAR_NAME } from './attachmentFiles'
import { attachmentSidecar } from './portable'
import { resolveAttachmentPlacement } from '../services/attachmentOwners'
import { type AttachmentFolder, assertContained, displayPath, ownedPaths } from './paths'
import type { FsAdapter, RepoLayout } from './types'

/** At most this many entries in one `attachments/` folder. */
const MAX_ATTACHMENT_FILES_PER_FOLDER = 2_000
/** At most this many bytes of image files in one `attachments/` folder. */
const MAX_ATTACHMENT_BYTES_PER_FOLDER = 512 * 1024 * 1024

const FILE_NAME = /^([0-9a-f]{64})\.(png|jpg)$/
const EXTENSION_MIME = { png: 'image/png', jpg: 'image/jpeg' } as const

interface FileEnv {
  layout: RepoLayout
  fs: FsAdapter
}

interface Env extends FileEnv {
  db: Db
  fileHashes?: FileHashCache
}

interface AttachmentRejection {
  path: string
  message: string
}

interface AttachmentImportOutcome {
  changed: boolean
  rejected: AttachmentRejection[]
}

interface VerifiedFile {
  path: string
  stamp: string | null
  bytes: Uint8Array
  mime: string
  width: number
  height: number
}

/** Who staged an image, as its sidecar says; a sidecar that is missing or invalid is simply absent. */
interface SidecarCreator {
  sha256: string
  role: SessionRole
  label: string
}

/** A sidecar is a few hundred bytes; anything larger is not read. */
const MAX_SIDECAR_BYTES = 16 * 1024

interface FolderScan {
  files: Map<string, VerifiedFile>
  /** Valid sidecars by attachment id. */
  creators: Map<string, SidecarCreator>
  rejected: AttachmentRejection[]
}

interface AttachmentRow {
  id: string
  sha256: string
  mime: AttachmentMime
  bytes: number
  width: number
  height: number
  missing: number
  stored_bytes: number | null
  owner_kind: AttachmentOwnerKind
  owner_id: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sizeProblem(env: FileEnv, dir: string, names: string[]): string | null {
  if (names.length > MAX_ATTACHMENT_FILES_PER_FOLDER) {
    return `holds more than ${MAX_ATTACHMENT_FILES_PER_FOLDER} files, so none is read`
  }
  let total = 0
  for (const name of names) {
    total += Math.max(0, env.fs.fileSize(join(dir, name)))
  }
  return total > MAX_ATTACHMENT_BYTES_PER_FOLDER
    ? `holds more than ${MAX_ATTACHMENT_BYTES_PER_FOLDER / (1024 * 1024)} MiB, so none is read`
    : null
}

/** Reads and checks one file; returns why it is refused, or the verified bytes. */
function verifyFile(env: FileEnv, path: string, name: string, match: RegExpExecArray): VerifiedFile | string {
  try {
    assertContained(env.layout, env.fs, path)
    if (!env.fs.exists(path) || env.fs.isDirectory(path)) {
      return 'is not a regular file'
    }
    if (env.fs.fileSize(path) > MAX_IMAGE_BYTES) {
      return `is larger than ${MAX_IMAGE_BYTES} bytes`
    }
    const before = env.fs.fileStamp(path)
    const bytes = env.fs.readFileBytes(path)
    if (createHash('sha256').update(bytes).digest('hex') !== match[1]) {
      return `does not hold the bytes its name (${name}) says: the hash differs`
    }
    const inspected = inspectImageBytes(bytes)
    const declared = EXTENSION_MIME[match[2] as 'png' | 'jpg']
    if (inspected.mime !== declared) return `is a ${inspected.mime} image named as ${declared}`
    const stamp = env.fs.fileStamp(path)
    return { path, stamp: before === stamp ? stamp : null, bytes, ...inspected }
  } catch (error: unknown) {
    return messageOf(error).replace(/\.$/, '')
  }
}

/** The creator a sidecar names, or null when it is unreadable, too large, not a valid sidecar, or not for this id. */
function readSidecar(env: FileEnv, path: string, id: string): SidecarCreator | null {
  try {
    assertContained(env.layout, env.fs, path)
    if (env.fs.isDirectory(path) || env.fs.fileSize(path) > MAX_SIDECAR_BYTES) {
      return null
    }
    const parsed = attachmentSidecar.safeParse(JSON.parse(env.fs.readFile(path)))
    return parsed.success && parsed.data.id === id
      ? { sha256: parsed.data.sha256, role: parsed.data.createdBy.role, label: parsed.data.createdBy.label }
      : null
  } catch {
    return null
  }
}

/** Sorts one entry of an `attachments/` folder: a sidecar, an image, or a name this importer ignores. */
function scanEntry(env: FileEnv, scan: FolderScan, path: string, reject: (path: string, why: string) => void): void {
  const name = basename(path)
  const sidecar = ATTACHMENT_SIDECAR_NAME.exec(name)
  if (sidecar !== null) {
    const creator = readSidecar(env, path, sidecar[1] ?? '')
    if (creator !== null) {
      scan.creators.set(sidecar[1] ?? '', creator)
    }
    return
  }
  const match = FILE_NAME.exec(name)
  if (match === null) {
    return
  }
  const verified = verifyFile(env, path, name, match)
  if (typeof verified === 'string') {
    reject(path, verified)
  } else {
    scan.files.set(match[1] ?? '', verified)
  }
}

/** Every verifiable image in the folder's `attachments/` directory, keyed by sha256; the rest is reported as rejected. */
function scanAttachmentFolder(env: FileEnv, folder: AttachmentFolder): FolderScan {
  const dir = ownedPaths(env.layout).attachmentsDir(folder)
  const scan: FolderScan = { files: new Map(), creators: new Map(), rejected: [] }
  const reject = (path: string, why: string): void => {
    const shown = displayPath(env.layout, path)
    scan.rejected.push({ path: shown, message: `${shown} ${why}.` })
  }
  try {
    assertContained(env.layout, env.fs, dir)
    if (!env.fs.exists(dir)) {
      return scan
    }
    if (!env.fs.isDirectory(dir)) {
      reject(dir, 'is not a directory')
      return scan
    }
    const names = env.fs.readdir(dir).filter((name) => basename(name) === name && !name.includes('.tmp-'))
    const tooMuch = sizeProblem(env, dir, names)
    if (tooMuch !== null) {
      reject(dir, tooMuch)
      return scan
    }
    for (const name of names) {
      scanEntry(env, scan, join(dir, name), reject)
    }
  } catch (error: unknown) {
    scan.files.clear()
    scan.creators.clear()
    reject(dir, `was not read: ${messageOf(error).replace(/\.$/, '')}`)
  }
  return scan
}

interface EvidenceRow {
  rowid: number
  owner_id: string
  evidence_json: string
  submitted_at: string | null
}

/**
 * Records each image an imported submission names as evidence (an epic attempt's run record, a Kanban card attempt's
 * submitted event) as an owned row with no bytes, so `restoreAttachmentFiles` fills it from the owner's folder. An image
 * whose row exists is left as it is. A carry-forward attempt copies an earlier acceptance's evidence; the image belongs to
 * the attempt that submitted it, so the copy registers nothing. Runs after the records are applied, before the restore.
 */
export function registerEvidenceAttachments(db: Db, now: string, scope?: { runs: string[]; cards: string[] }): void {
  registerEvidence(db, now, 'attempt', scope?.runs)
  registerEvidence(db, now, 'kanban_attempt', scope?.cards)
}

function registerEvidence(db: Db, now: string, owner: 'attempt' | 'kanban_attempt', scope: string[] | undefined): void {
  if (scope?.length === 0) return
  const ids = scope === undefined ? null : JSON.stringify(scope)
  const from = owner === 'attempt'
    ? { table: 'attempts', parent: 'run_id', filter: "AND kind = 'work'" }
    : { table: 'kanban_attempts', parent: 'card_id', filter: '' }
  let after = 0
  for (;;) {
    const rows = db.all<EvidenceRow>(
      `SELECT rowid, id AS owner_id, evidence_json, submitted_at FROM ${from.table}
       WHERE rowid > ? AND evidence_json LIKE '%"attachments"%' ${from.filter}
         AND (? IS NULL OR ${from.parent} IN (SELECT value FROM json_each(?)))
       ORDER BY rowid LIMIT 16`, after, ids, ids
    )
    for (const row of rows) {
      registerRowImages(db, { owner, ownerId: row.owner_id, createdAt: row.submitted_at ?? now }, row.evidence_json)
      after = row.rowid
    }
    if (rows.length < 16) break
  }
}

/**
 * Records each image a saved plan revision names on a ticket as an owned row with no bytes, so `restoreAttachmentFiles`
 * fills it from the epic's folder. Only a ticket the database tracks owns an image; a row that exists is left as it is.
 * Runs after the records are applied, before the restore.
 */
export function registerTicketAttachments(db: Db, now: string, epics?: string[]): void {
  if (epics?.length === 0) return
  const ids = epics === undefined ? null : JSON.stringify(epics)
  let cursor = { number: 0, rowid: 0 }
  for (;;) {
    const revisions = db.all<{ rowid: number; number: number; bundle_json: string; saved_at: string | null }>(
      `SELECT rowid, number, bundle_json, saved_at FROM plan_revisions
       WHERE state = 'saved' AND bundle_json LIKE '%"attachments"%'
         AND (number, rowid) > (?, ?) AND (? IS NULL OR epic_id IN (SELECT value FROM json_each(?)))
       ORDER BY number, rowid LIMIT 16`, cursor.number, cursor.rowid, ids, ids
    )
    for (const revision of revisions) {
      for (const ticket of namedTickets(revision.bundle_json)) {
        registerTicketImages(db, ticket, revision.saved_at ?? now)
      }
      cursor = revision
    }
    if (revisions.length < 16) break
  }
}

function registerTicketImages(db: Db, ticket: { id: string; refs: AttachmentRef[] }, createdAt: string): void {
  if (db.get('SELECT ticket_id FROM ticket_status WHERE ticket_id = ?', ticket.id) === undefined) {
    return
  }
  for (const ref of ticket.refs) {
    if (db.get('SELECT id FROM attachments WHERE id = ?', ref.id) === undefined) {
      insertOwnedRow(db, ref, { owner: 'ticket', ownerId: ticket.id, createdAt })
    }
  }
}

/** The tickets of a stored bundle that name images, with their valid references; anything malformed is skipped. */
function namedTickets(bundleJson: string): { id: string; refs: AttachmentRef[] }[] {
  const bundle = JSON.parse(bundleJson) as { tickets?: unknown }
  if (!Array.isArray(bundle.tickets)) {
    return []
  }
  return bundle.tickets.flatMap((item: unknown) => {
    const ticket = item as { id?: unknown; attachments?: unknown } | null
    if (typeof ticket?.id !== 'string' || !Array.isArray(ticket.attachments)) {
      return []
    }
    const refs = ticket.attachments.flatMap((entry: unknown) => {
      const parsed = attachmentRef.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
    return refs.length === 0 ? [] : [{ id: ticket.id, refs }]
  })
}

function registerRowImages(db: Db, owner: { owner: AttachmentOwnerKind; ownerId: string; createdAt: string }, evidenceJson: string): void {
  for (const ref of namedImages(evidenceJson)) {
    if (db.get('SELECT id FROM attachments WHERE id = ?', ref.id) === undefined) {
      insertOwnedRow(db, ref, owner)
    }
  }
}

/** The valid references an evidence record names; anything that is not a valid reference is skipped. */
function namedImages(evidenceJson: string): AttachmentRef[] {
  const evidence = JSON.parse(evidenceJson) as { attachments?: unknown }
  if (!Array.isArray(evidence.attachments)) {
    return []
  }
  return evidence.attachments.flatMap((item: unknown) => {
    const parsed = attachmentRef.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

/** Inserts an owned row with no bytes for `ref`; `restoreAttachmentFiles` fills the bytes from the owner's folder. */
export function insertOwnedRow(db: Db, ref: AttachmentRef, owner: { owner: AttachmentOwnerKind; ownerId: string; createdAt: string }): void {
  db.run(
    `INSERT INTO attachments (id, sha256, mime, bytes, width, height, label, purpose, owner_kind, owner_id, missing, data,
       created_by_role, created_by_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'worker', 'imported', ?)`,
    ref.id,
    ref.sha256,
    ref.mime,
    ref.bytes,
    ref.width,
    ref.height,
    ref.label,
    ref.purpose,
    owner.owner,
    owner.ownerId,
    owner.createdAt
  )
}

function rowIdentity(row: AttachmentRow, path: string): string {
  return contentHash([path, row.sha256, row.mime, row.bytes, row.width, row.height, row.owner_kind, row.owner_id])
}

function matchesImage(row: AttachmentRow, file: VerifiedFile): boolean {
  return file.mime === row.mime && file.bytes.byteLength === row.bytes && file.width === row.width && file.height === row.height
}

function rememberImage(env: Env, row: AttachmentRow, file: VerifiedFile): void {
  if (file.stamp !== null) env.fileHashes?.remember(`attachment:${row.id}`, file.stamp, rowIdentity(row, file.path))
}

/** Recheck a changed portable copy without replacing good evidence in SQLite. */
function checkRestoredImage(env: Env, row: AttachmentRow, folder: AttachmentFolder, outcome: AttachmentImportOutcome): void {
  const path = ownedPaths(env.layout).attachmentFile(folder, row.sha256, row.mime)
  const shown = displayPath(env.layout, path)
  try {
    assertContained(env.layout, env.fs, path)
    // A removed portable copy cannot invalidate the evidence already held in SQLite.
    if (!env.fs.exists(path)) return
    const stamp = env.fs.fileStamp(path)
    if (stamp !== null && env.fileHashes?.get(`attachment:${row.id}`, stamp) === rowIdentity(row, path)) return
    const name = basename(path)
    const file = verifyFile(env, path, name, FILE_NAME.exec(name)!)
    if (typeof file === 'string' || !matchesImage(row, file)) {
      outcome.rejected.push({ path: shown, message: `${shown} ${typeof file === 'string' ? file : 'does not match its attachment metadata'}.` })
      return
    }
    rememberImage(env, row, file)
  } catch (error: unknown) {
    outcome.rejected.push({ path: shown, message: messageOf(error) })
  }
}

/**
 * Fills the bytes of owned attachments from their portable copies and checks changed copies of already stored
 * images. A missing or rejected copy never erases the locally stored evidence.
 */
export function restoreAttachmentFiles(env: Env): AttachmentImportOutcome {
  const outcome: AttachmentImportOutcome = { changed: false, rejected: [] }
  const rows = env.db.all<AttachmentRow>(
    `SELECT id, sha256, mime, bytes, width, height, missing, length(data) AS stored_bytes, owner_kind, owner_id
     FROM attachments WHERE owner_kind IS NOT NULL ORDER BY rowid`
  )
  const scans = new Map<string, FolderScan>()
  for (const row of rows) {
    const placement = resolveAttachmentPlacement(env.db, { kind: row.owner_kind, id: row.owner_id })
    if (row.stored_bytes !== null) {
      if (placement !== null) checkRestoredImage(env, row, placement.folder, outcome)
      continue
    }

    const file = placement === null ? undefined : imageForPlaceholder(env, row, placement.folder, { scans, outcome })
    if (file !== undefined && matchesImage(row, file)) {
      env.db.run('UPDATE attachments SET data = ?, missing = 0 WHERE id = ?', Buffer.from(file.bytes), row.id)
      rememberImage(env, row, file)
      outcome.changed = true
    } else if (row.missing !== 1) {
      env.db.run('UPDATE attachments SET missing = 1 WHERE id = ?', row.id)
      outcome.changed = true
    }
  }
  return outcome
}

function imageForPlaceholder(
  env: Env, row: AttachmentRow, folder: AttachmentFolder, state: { scans: Map<string, FolderScan>; outcome: AttachmentImportOutcome }
): VerifiedFile | undefined {
  const { scans, outcome } = state
  const key = `${folder.kind}:${folder.id}`
  let scan = scans.get(key)
  if (scan === undefined) {
    scan = scanAttachmentFolder(env, folder)
    scans.set(key, scan)
    outcome.rejected.push(...scan.rejected)
  }
  const creator = scan.creators.get(row.id)
  if (creator !== undefined && creator.sha256 === row.sha256) {
    const updated = env.db.run(`UPDATE attachments SET created_by_role = ?, created_by_label = ? WHERE id = ?
      AND (created_by_role <> ? OR created_by_label <> ?)`, creator.role, creator.label, row.id, creator.role, creator.label)
    if (updated.changes > 0) outcome.changed = true
  }
  return scan.files.get(row.sha256)
}
