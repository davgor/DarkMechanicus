/**
 * Reads attachment image files back into the database on reconcile. Records name their images by metadata only, so a
 * row can arrive without bytes (`data` NULL); this fills it from `attachments/<sha256>.<ext>` in the folder that owns it.
 * Every file is untrusted: the folder and each file must be contained (no links), the folder is bounded in files and
 * bytes, and a file counts only when its hash matches its name and its bytes are a PNG or JPEG of the declared type.
 * An image whose file is missing, corrupt or refused is flagged missing instead of failing the import.
 */
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { AttachmentOwnerKind, AttachmentRef, SessionRole } from '../../shared/domain/views'
import { inspectImageBytes, MAX_IMAGE_BYTES } from '../attachments/intake'
import type { Db } from '../db/database'
import { attachmentRef } from '../schemas'
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
}

interface AttachmentRejection {
  path: string
  message: string
}

interface AttachmentImportOutcome {
  restored: number
  missing: number
  rejected: AttachmentRejection[]
}

interface VerifiedFile {
  bytes: Uint8Array
  mime: string
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

interface PendingRow {
  id: string
  sha256: string
  mime: string
  bytes: number
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
    const bytes = env.fs.readFileBytes(path)
    if (createHash('sha256').update(bytes).digest('hex') !== match[1]) {
      return `does not hold the bytes its name (${name}) says: the hash differs`
    }
    const inspected = inspectImageBytes(bytes)
    const declared = EXTENSION_MIME[match[2] as 'png' | 'jpg']
    return inspected.mime === declared ? { bytes, mime: inspected.mime } : `is a ${inspected.mime} image named as ${declared}`
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
export function registerEvidenceAttachments(db: Db, now: string): void {
  const sources: { owner: AttachmentOwnerKind; rows: EvidenceRow[] }[] = [
    {
      owner: 'attempt',
      rows: db.all<EvidenceRow>(
        "SELECT id AS owner_id, evidence_json, submitted_at FROM attempts WHERE kind = 'work' AND evidence_json LIKE '%\"attachments\"%'"
      )
    },
    {
      owner: 'kanban_attempt',
      rows: db.all<EvidenceRow>(
        "SELECT id AS owner_id, evidence_json, submitted_at FROM kanban_attempts WHERE evidence_json LIKE '%\"attachments\"%'"
      )
    }
  ]
  for (const source of sources) {
    for (const row of source.rows) {
      registerRowImages(db, { owner: source.owner, ownerId: row.owner_id, createdAt: row.submitted_at ?? now }, row.evidence_json)
    }
  }
}

/**
 * Records each image a saved plan revision names on a ticket as an owned row with no bytes, so `restoreAttachmentFiles`
 * fills it from the epic's folder. Only a ticket the database tracks owns an image; a row that exists is left as it is.
 * Runs after the records are applied, before the restore.
 */
export function registerTicketAttachments(db: Db, now: string): void {
  const revisions = db.all<{ bundle_json: string; saved_at: string | null }>(
    "SELECT bundle_json, saved_at FROM plan_revisions WHERE state = 'saved' AND bundle_json LIKE '%\"attachments\"%' ORDER BY number"
  )
  for (const revision of revisions) {
    for (const ticket of namedTickets(revision.bundle_json)) {
      registerTicketImages(db, ticket, revision.saved_at ?? now)
    }
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

/**
 * Fills the bytes of every owned attachment that has none, from its owner's `attachments/` folder, and flags the ones
 * with no usable file as missing (a later reconcile that finds the file clears the flag). Runs after the records are
 * applied, inside the reconcile transaction, so each owner can be found.
 */
export function restoreAttachmentFiles(env: Env): AttachmentImportOutcome {
  const outcome: AttachmentImportOutcome = { restored: 0, missing: 0, rejected: [] }
  const rows = env.db.all<PendingRow>(
    'SELECT id, sha256, mime, bytes, owner_kind, owner_id FROM attachments WHERE data IS NULL AND owner_kind IS NOT NULL ORDER BY rowid'
  )
  const scans = new Map<string, FolderScan>()
  for (const row of rows) {
    const placement = resolveAttachmentPlacement(env.db, { kind: row.owner_kind, id: row.owner_id })
    let file: VerifiedFile | undefined
    if (placement !== null) {
      const key = `${placement.folder.kind}:${placement.folder.id}`
      let scan = scans.get(key)
      if (scan === undefined) {
        scan = scanAttachmentFolder(env, placement.folder)
        scans.set(key, scan)
        outcome.rejected.push(...scan.rejected)
      }
      file = scan.files.get(row.sha256)
      // The placeholder creator stays unless the sidecar of this very image (same id and hash) names a valid one.
      const creator = scan.creators.get(row.id)
      if (creator !== undefined && creator.sha256 === row.sha256) {
        env.db.run('UPDATE attachments SET created_by_role = ?, created_by_label = ? WHERE id = ?', creator.role, creator.label, row.id)
      }
    }
    if (file !== undefined && file.mime === row.mime && file.bytes.byteLength === row.bytes) {
      env.db.run('UPDATE attachments SET data = ?, missing = 0 WHERE id = ?', Buffer.from(file.bytes), row.id)
      outcome.restored += 1
    } else {
      env.db.run('UPDATE attachments SET missing = 1 WHERE id = ?', row.id)
      outcome.missing += 1
    }
  }
  return outcome
}
