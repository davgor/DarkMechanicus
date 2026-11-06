/**
 * Image attachments: PNG and JPEG images stored in SQLite with their metadata and bytes. An image is staged (no owner)
 * until a record claims it; a staged image nobody claims is pruned after seven days. Bytes read back exactly as stored.
 * This module holds the storage, staging and claiming rules; the commands adapt it and nothing here touches the UI.
 */
import { createHash } from 'node:crypto'
import { readImageFile } from '../attachments/intake'
import { requireCapability } from '../authz'
import type {
  AttachmentMime,
  AttachmentOwner,
  AttachmentOwnerKind,
  AttachmentPurpose,
  AttachmentRef,
  AttachmentView,
  SessionRole
} from '../../shared/domain/views'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { isStableId } from '../ids'
import { isBefore } from '../clock'
import { enqueueOutbox } from './outbox'
import { resolveAttachmentPlacement } from './attachmentOwners'
import { attachmentMime, attachmentPurpose, LIMITS, parseInput } from '../schemas'

/** A staged image older than this many days is pruned when a workspace opens. */
const STAGED_ATTACHMENT_MAX_AGE_DAYS = 7

const OWNER_KINDS: readonly AttachmentOwnerKind[] = ['attempt', 'kanban_attempt', 'comment', 'kanban_card', 'ticket']

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

export interface StagedAttachmentInput {
  bytes: Uint8Array
  /** Lowercase hex SHA-256 of `bytes`; checked against them. */
  sha256: string
  mime: AttachmentMime
  width: number
  height: number
  label: string
  purpose: AttachmentPurpose
}

interface AttachmentRow {
  id: string
  sha256: string
  mime: AttachmentMime
  bytes: number
  width: number
  height: number
  label: string
  purpose: AttachmentPurpose
  owner_kind: AttachmentOwnerKind | null
  owner_id: string | null
  missing: number
  created_by_role: SessionRole
  created_by_label: string
  created_at: string
}

const COLUMNS = `id, sha256, mime, bytes, width, height, label, purpose, owner_kind, owner_id, missing,
  created_by_role, created_by_label, created_at`

function toAttachmentView(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    sha256: row.sha256,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    label: row.label,
    purpose: row.purpose,
    owner: row.owner_kind === null || row.owner_id === null ? null : { kind: row.owner_kind, id: row.owner_id },
    missing: row.missing === 1,
    createdBy: { role: row.created_by_role, label: row.created_by_label },
    createdAt: row.created_at
  }
}

/** The image type the first bytes declare, or null when they are neither PNG nor JPEG. */
function detectMime(bytes: Uint8Array): AttachmentMime | null {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, PNG_SIGNATURE.length))
  if (head.equals(PNG_SIGNATURE)) {
    return 'image/png'
  }
  if (head.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return 'image/jpeg'
  }
  return null
}

function checkBytes(input: StagedAttachmentInput): void {
  const size = input.bytes.byteLength
  if (size < 1 || size > LIMITS.attachmentBytes) {
    fail('invalid_input', `An attachment is between 1 and ${LIMITS.attachmentBytes} bytes; this one is ${size}.`, { bytes: size })
  }
  const detected = detectMime(input.bytes)
  if (detected === null || detected !== input.mime) {
    fail('invalid_input', 'Only PNG and JPEG images are accepted, and the file must be the type its first bytes declare.', {
      declared: input.mime,
      detected
    })
  }
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    fail('invalid_input', 'An attachment sha256 is a lowercase hex SHA-256 digest.')
  }
  if (createHash('sha256').update(input.bytes).digest('hex') !== input.sha256) {
    fail('invalid_input', 'The attachment sha256 does not match its bytes.')
  }
}

function checkDetails(input: StagedAttachmentInput): void {
  for (const [name, value] of [
    ['width', input.width],
    ['height', input.height]
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > LIMITS.attachmentSide) {
      fail('invalid_input', `An attachment's ${name} is a whole number from 1 to ${LIMITS.attachmentSide} pixels.`, { [name]: value })
    }
  }
  if (input.label.length > LIMITS.label) {
    fail('invalid_input', `An attachment's label is at most ${LIMITS.label} characters.`)
  }
  parseInput(attachmentPurpose, input.purpose, 'attachment purpose')
  parseInput(attachmentMime, input.mime, 'attachment type')
}

function checkStagedInput(input: StagedAttachmentInput): void {
  checkDetails(input)
  checkBytes(input)
}

/** Stores one image with no owner (staged) and returns its metadata. Refuses anything that is not a valid PNG or JPEG. */
export function createStagedAttachment(ctx: Ctx, input: StagedAttachmentInput): AttachmentView {
  checkStagedInput(input)
  const id = ctx.ids.next('attachment')
  ctx.db.run(
    `INSERT INTO attachments (id, sha256, mime, bytes, width, height, label, purpose, owner_kind, owner_id, missing, data,
       created_by_role, created_by_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?)`,
    id,
    input.sha256,
    input.mime,
    input.bytes.byteLength,
    input.width,
    input.height,
    input.label,
    input.purpose,
    Buffer.from(input.bytes),
    ctx.session.role,
    ctx.session.label,
    ctx.clock.nowIso()
  )
  return getAttachment(ctx, id)
}

interface StageFileInput {
  /** The path as the agent gave it. */
  path: string
  /** The folders the path may lie in (see `resolveAllowedRoots`). */
  roots: readonly string[]
  label: string
  purpose: AttachmentPurpose
}

/**
 * Stages the image at `path`. Its type, size, dimensions and hash come from the file's own bytes (`readImageFile`),
 * never from the caller. Refuses a session without `attachment.write`.
 */
export function stageAttachmentFile(ctx: Ctx, input: StageFileInput): AttachmentView {
  requireCapability(ctx.session, 'attachment.write')
  const image = readImageFile(input.path, input.roots)
  return createStagedAttachment(ctx, {
    bytes: image.bytes,
    sha256: image.sha256,
    mime: image.mime,
    width: image.width,
    height: image.height,
    label: input.label,
    purpose: input.purpose
  })
}

/** An image's metadata. Throws `not_found` for an unknown id. */
export function getAttachment(ctx: Ctx, id: string): AttachmentView {
  const row = ctx.db.get<AttachmentRow>(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`, id)
  if (row === undefined) {
    fail('not_found', `Attachment ${id} does not exist.`, { id })
  }
  return toAttachmentView(row)
}

/** An image's bytes, exactly as stored. Throws `not_found` for an unknown id or one whose bytes are missing. */
export function readAttachmentBytes(ctx: Ctx, id: string): Buffer {
  const row = ctx.db.get<{ data: Uint8Array | null }>('SELECT data FROM attachments WHERE id = ?', id)
  if (row === undefined) {
    fail('not_found', `Attachment ${id} does not exist.`, { id })
  }
  if (row.data === null) {
    fail('not_found', `The bytes of attachment ${id} are not stored.`, { id })
  }
  return Buffer.from(row.data)
}

/**
 * Queues the file export of claimed images with the claim, so it sits before the owning record's own export in the
 * outbox. An owner this database does not hold yet queues with no epic or run: the export then fails with its reason
 * until it does.
 */
function queueAttachmentExports(ctx: Ctx, ids: readonly string[], owner: AttachmentOwner): void {
  const placement = resolveAttachmentPlacement(ctx.db, owner)
  for (const id of ids) {
    enqueueOutbox(ctx, { kind: 'attachment', entityId: id, epicId: placement?.epicId ?? null, runId: placement?.runId ?? null })
  }
}

/**
 * Gives staged images to `owner`, all or none. Refuses an unknown id, an id already owned (by this owner or another),
 * a repeated id, and any claim that would take the owner past `LIMITS.attachmentsPerRecord`. Each claimed image queues an
 * `attachment` outbox entry that writes its file beside the owner's records (`repo` mode).
 */
export function claimAttachments(ctx: Ctx, ids: readonly string[], owner: AttachmentOwner): AttachmentView[] {
  if (!OWNER_KINDS.includes(owner.kind) || !isStableId(owner.id)) {
    fail('invalid_input', 'An attachment owner is a known record kind with its stable id.', { owner })
  }
  for (const id of ids) {
    if (!isStableId(id, 'attachment')) {
      fail('invalid_input', `${id} is not an attachment id.`, { id })
    }
  }
  if (new Set(ids).size !== ids.length) {
    fail('invalid_input', 'The same attachment is listed more than once.')
  }
  if (ids.length === 0) {
    return []
  }
  return ctx.db.tx(() => {
    const owned = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attachments WHERE owner_kind = ? AND owner_id = ?', owner.kind, owner.id)?.n ?? 0
    if (owned + ids.length > LIMITS.attachmentsPerRecord) {
      fail(
        'capacity_exceeded',
        `A record holds at most ${LIMITS.attachmentsPerRecord} attachments; ${owner.id} holds ${owned} and this claim adds ${ids.length}.`,
        { ownerId: owner.id, limit: LIMITS.attachmentsPerRecord, owned, requested: ids.length }
      )
    }
    for (const id of ids) {
      const row = ctx.db.get<{ owner_kind: string | null }>('SELECT owner_kind FROM attachments WHERE id = ?', id)
      if (row === undefined) {
        fail('not_found', `Attachment ${id} does not exist.`, { id })
      }
      if (row.owner_kind !== null) {
        fail('conflict', `Attachment ${id} is already claimed by a ${row.owner_kind} and cannot be claimed again.`, { id })
      }
      ctx.db.run('UPDATE attachments SET owner_kind = ?, owner_id = ? WHERE id = ? AND owner_kind IS NULL', owner.kind, owner.id, id)
    }
    queueAttachmentExports(ctx, ids, owner)
    return ids.map((id) => getAttachment(ctx, id))
  })
}

/** The metadata a record keeps about an image: its reference, without the owner, the bytes or the audit fields. */
function attachmentRefOf(view: AttachmentView): AttachmentRef {
  return {
    id: view.id,
    sha256: view.sha256,
    mime: view.mime,
    bytes: view.bytes,
    width: view.width,
    height: view.height,
    label: view.label,
    purpose: view.purpose
  }
}

/**
 * Claims the images a submission's evidence names, for `owner`, inside the caller's transaction, and returns the evidence
 * with their references in place of the ids. Evidence that names no images keeps its shape: no `attachments` key.
 */
export function claimEvidenceAttachments<E extends { attachments?: readonly string[] }>(
  ctx: Ctx,
  evidence: E | undefined,
  owner: AttachmentOwner
): Omit<E, 'attachments'> & { attachments?: AttachmentRef[] } {
  const { attachments: ids, ...rest } = evidence ?? ({} as E)
  if (ids === undefined) {
    return rest
  }
  return { ...rest, attachments: claimAttachments(ctx, ids, owner).map(attachmentRefOf) }
}

/** The oldest creation time a staged image may keep, given the current time. */
export function stagedAttachmentCutoff(nowIso: string): string {
  return new Date(Date.parse(nowIso) - STAGED_ATTACHMENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Deletes staged images created before `olderThan` (an ISO time; default seven days before now) and returns how many.
 * Owned images are never touched.
 */
export function pruneStagedAttachments(ctx: Ctx, olderThan: string = stagedAttachmentCutoff(ctx.clock.nowIso())): number {
  return ctx.db.tx(() => {
    const stale = ctx.db
      .all<{ id: string; created_at: string }>('SELECT id, created_at FROM attachments WHERE owner_kind IS NULL')
      .filter((row) => isBefore(row.created_at, olderThan))
    for (const row of stale) {
      ctx.db.run('DELETE FROM attachments WHERE id = ? AND owner_kind IS NULL', row.id)
    }
    return stale.length
  })
}
