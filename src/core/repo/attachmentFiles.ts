/**
 * Attachment image files in `repo` mode: `attachments/<sha256>.<ext>` inside the run, card or epic folder that owns the
 * image. This module finds the folder, writes a file once (temp, fsync, rename, read back and compare the hash) and
 * looks up the images an owning record still has to export. The finalizer calls it before it writes the record that
 * points at an image, and records the export.
 */
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import type { AttachmentMime, AttachmentOwner, AttachmentOwnerKind } from '../../shared/domain/views'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { type AttachmentPlacement, resolveAttachmentPlacement } from '../services/attachmentOwners'
import { assertContained, displayPath, ownedPaths } from './paths'
import type { FsAdapter, RepoLayout } from './types'

interface Env {
  layout: RepoLayout
  fs: FsAdapter
}

/** The name of an image file in an `attachments/` folder: its sha256 and extension. */
export const ATTACHMENT_FILE_NAME = /^([0-9a-f]{64})\.(png|jpg)$/

/** An attachment row with its bytes, as the export needs it. */
export interface StoredAttachment {
  id: string
  sha256: string
  mime: AttachmentMime
  owner: AttachmentOwner | null
  data: Uint8Array | null
}

interface StoredRow {
  id: string
  sha256: string
  mime: AttachmentMime
  owner_kind: AttachmentOwnerKind | null
  owner_id: string | null
  data: Uint8Array | null
}

const STORED_COLUMNS = 'a.id, a.sha256, a.mime, a.owner_kind, a.owner_id, a.data'

function toStored(row: StoredRow): StoredAttachment {
  return {
    id: row.id,
    sha256: row.sha256,
    mime: row.mime,
    owner: row.owner_kind === null || row.owner_id === null ? null : { kind: row.owner_kind, id: row.owner_id },
    data: row.data
  }
}

/** One attachment with its bytes; fails with `not_found` for an unknown id. */
export function loadStoredAttachment(db: Db, id: string): StoredAttachment {
  const row = db.get<StoredRow>(`SELECT ${STORED_COLUMNS} FROM attachments a WHERE a.id = ?`, id)
  if (row === undefined) {
    fail('not_found', `Attachment ${id} does not exist.`, { id })
  }
  return toStored(row)
}

/**
 * Where an attachment's file goes. Fails with a plain reason, and writes nothing, for an image no record has claimed
 * and for an owner this database does not hold.
 */
export function placementOfAttachment(db: Db, attachment: StoredAttachment): AttachmentPlacement {
  if (attachment.owner === null) {
    return fail('internal', `Attachment ${attachment.id} has no owner, so there is no folder to export it to.`)
  }
  const placement = resolveAttachmentPlacement(db, attachment.owner)
  if (placement === null) {
    return fail(
      'not_found',
      `Attachment ${attachment.id} is not exported: its ${attachment.owner.kind} ${attachment.owner.id} is not in this database, so its folder cannot be found.`,
      { id: attachment.id }
    )
  }
  return placement
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function discard(fs: FsAdapter, path: string): void {
  try {
    fs.remove(path)
  } catch {
    // Best effort: the original failure is what matters.
  }
}

/** Whether a file holding exactly these bytes is already in place. A missing or different file is not an error. */
function alreadyWritten(env: Env, target: string, sha256: string): boolean {
  assertContained(env.layout, env.fs, target)
  if (!env.fs.exists(target)) {
    return false
  }
  try {
    return sha256Of(env.fs.readFileBytes(target)) === sha256
  } catch {
    return false
  }
}

/**
 * Writes the attachment's file once: nothing is touched when the file is already there with the right hash. Otherwise
 * the bytes go to a temp file, are fsynced, renamed into place and read back; a mismatch removes the file and fails.
 */
export function writeAttachmentFile(env: Env, attachment: StoredAttachment, placement: AttachmentPlacement): void {
  if (attachment.data === null) {
    fail('not_found', `The bytes of attachment ${attachment.id} are not stored, so its file cannot be written.`, { id: attachment.id })
  }
  if (sha256Of(attachment.data) !== attachment.sha256) {
    fail('internal', `The stored bytes of attachment ${attachment.id} do not match its sha256, so its file is not written.`, {
      id: attachment.id
    })
  }
  const target = ownedPaths(env.layout).attachmentFile(placement.folder, attachment.sha256, attachment.mime)
  if (alreadyWritten(env, target, attachment.sha256)) {
    return
  }
  const temp = `${target}.tmp-${process.pid}`
  assertContained(env.layout, env.fs, target)
  env.fs.mkdirp(dirname(target))
  try {
    assertContained(env.layout, env.fs, temp)
    env.fs.writeFileBytes(temp, attachment.data)
    env.fs.fsyncFile(temp)
    assertContained(env.layout, env.fs, target)
    env.fs.rename(temp, target)
  } catch (error: unknown) {
    discard(env.fs, temp)
    throw error
  }
  if (sha256Of(env.fs.readFileBytes(target)) !== attachment.sha256) {
    discard(env.fs, target)
    fail('internal', `Read-back of ${displayPath(env.layout, target)} does not match what was written.`)
  }
}

/** The records whose attachments an export of a record has to write first. */
export interface OwningRecord {
  kind: 'comment' | 'run' | 'kanban_card' | 'epic'
  id: string
}

const OWNED_BY: Record<OwningRecord['kind'], string> = {
  comment: "a.owner_kind = 'comment' AND a.owner_id = ?",
  run: "a.owner_kind = 'attempt' AND a.owner_id IN (SELECT id FROM attempts WHERE run_id = ?)",
  kanban_card: `((a.owner_kind = 'kanban_card' AND a.owner_id = ?)
    OR (a.owner_kind = 'kanban_attempt' AND a.owner_id IN (SELECT id FROM kanban_attempts WHERE card_id = ?)))`,
  epic: "a.owner_kind = 'ticket' AND a.owner_id IN (SELECT ticket_id FROM ticket_status WHERE epic_id = ?)"
}

/** The attachments of a record (and of what it holds) with bytes whose file this machine has not exported yet. */
export function unexportedAttachments(db: Db, record: OwningRecord): StoredAttachment[] {
  const params = record.kind === 'kanban_card' ? [record.id, record.id] : [record.id]
  return db
    .all<StoredRow>(
      `SELECT ${STORED_COLUMNS} FROM attachments a
       LEFT JOIN sync_state s ON s.kind = 'attachment' AND s.entity_id = a.id
       WHERE a.data IS NOT NULL AND ${OWNED_BY[record.kind]} AND s.exported_hash IS NOT a.sha256
       ORDER BY a.rowid`,
      ...params
    )
    .map(toStored)
}
