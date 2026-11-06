/**
 * Reference images on plan tickets. A ticket's images live in the plan bundle as refs, and a ticket owner resolves only
 * once its `ticket_status` row exists, which a save writes. So a draft only names staged images; they stay staged until
 * the revision naming them is saved, when `claimSavedTicketAttachments` gives them to their tickets.
 */
import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'
import type { AttachmentPurpose, AttachmentRef } from '../../shared/domain/views'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { LIMITS } from '../schemas'

/** One image a ticket names in a draft or in a revision still waiting to be saved. */
interface PlannedRef {
  epicId: string
  ticketId: string
  ticketKey: string
  attachmentId: string
}

const PLANNED_REFS = `
  SELECT d.epic_id AS epicId, json_extract(t.value, '$.id') AS ticketId, json_extract(t.value, '$.key') AS ticketKey,
    json_extract(a.value, '$.id') AS attachmentId
  FROM drafts d, json_each(d.bundle_json, '$.tickets') t, json_each(t.value, '$.attachments') a
  UNION ALL
  SELECT p.epic_id, json_extract(t.value, '$.id'), json_extract(t.value, '$.key'), json_extract(a.value, '$.id')
  FROM plan_revisions p, json_each(p.bundle_json, '$.tickets') t, json_each(t.value, '$.attachments') a
  WHERE p.state = 'pending'`

/** Every image a draft or a pending revision names on a ticket. */
function plannedRefs(db: Db): PlannedRef[] {
  return db.all<PlannedRef>(PLANNED_REFS)
}

/** The ids of every image a draft or a pending revision names: staged images the prune keeps. */
export function plannedAttachmentIds(db: Db): Set<string> {
  return new Set(plannedRefs(db).map((ref) => ref.attachmentId))
}

interface RefRow {
  id: string
  sha256: string
  mime: AttachmentRef['mime']
  bytes: number
  width: number
  height: number
  label: string
  purpose: AttachmentPurpose
  owner_kind: string | null
  owner_id: string | null
}

function loadRefRow(db: Db, id: string): RefRow | undefined {
  return db.get<RefRow>(
    'SELECT id, sha256, mime, bytes, width, height, label, purpose, owner_kind, owner_id FROM attachments WHERE id = ?',
    id
  )
}

/** Staged, or already owned by this ticket. */
function heldByTicketOrStaged(row: RefRow, ticketId: string): boolean {
  return row.owner_kind === null || (row.owner_kind === 'ticket' && row.owner_id === ticketId)
}

function toRef(row: RefRow): AttachmentRef {
  const { id, sha256, mime, bytes, width, height, label, purpose } = row
  return { id, sha256, mime, bytes, width, height, label, purpose }
}

function checkIdList(ids: readonly string[], ticketLabel: string): void {
  if (ids.length > LIMITS.attachmentsPerRecord) {
    fail('capacity_exceeded', `${ticketLabel} holds at most ${LIMITS.attachmentsPerRecord} images; ${ids.length} were given.`, {
      limit: LIMITS.attachmentsPerRecord,
      requested: ids.length
    })
  }
  if (new Set(ids).size !== ids.length) {
    fail('invalid_input', `${ticketLabel} lists the same image more than once.`)
  }
}

/** The row of an image a draft may name on `ticketId`; refuses one that is unknown, evidence, or held elsewhere. */
function draftableRow(db: Db, id: string, ticketId: string): RefRow {
  const row = loadRefRow(db, id) ?? fail('not_found', `Attachment ${id} does not exist.`, { id })
  if (row.purpose === 'evidence') {
    fail('invalid_input', `Attachment ${id} is evidence; a ticket shows reference images only.`, { id })
  }
  if (!heldByTicketOrStaged(row, ticketId)) {
    fail('conflict', `Attachment ${id} already belongs to a ${row.owner_kind ?? 'record'} and cannot be shown on this ticket.`, { id })
  }
  return row
}

/**
 * The refs of the images `ids` names for ticket `ticketId` of a draft. Each must be a reference image that is staged or
 * already owned by this ticket, named by no other ticket in another epic's draft or in a pending revision (the caller
 * checks the draft it edits), listed once, and at most `LIMITS.attachmentsPerRecord` of them.
 */
export function ticketAttachmentRefs(db: Db, request: { ids: readonly string[]; ticketId: string; epicId?: string }): AttachmentRef[] {
  const { ids, ticketId } = request
  checkIdList(ids, 'A ticket')
  const rows = ids.map((id) => draftableRow(db, id, ticketId))
  const wanted = new Set(ids)
  const elsewhere = plannedRefs(db).find(
    (ref) => wanted.has(ref.attachmentId) && ref.ticketId !== ticketId && ref.epicId !== request.epicId
  )
  if (elsewhere !== undefined) {
    fail('conflict', `Attachment ${elsewhere.attachmentId} is already shown on ${elsewhere.ticketKey}.`, {
      id: elsewhere.attachmentId,
      ticketId: elsewhere.ticketId
    })
  }
  return rows.map(toRef)
}

function ticketsWithImages(bundle: PlanBundle): (TicketContent & { attachments: AttachmentRef[] })[] {
  return bundle.tickets.filter((ticket): ticket is TicketContent & { attachments: AttachmentRef[] } => (ticket.attachments ?? []).length > 0)
}

/**
 * Refuses a save whose tickets name images that cannot be theirs: more than `LIMITS.attachmentsPerRecord` on one ticket
 * in this revision, one image on two tickets, an image that no longer exists, or one owned by another record. Images an
 * earlier revision dropped are not counted. Runs before the revision becomes pending.
 */
export function checkSavedTicketAttachments(db: Db, bundle: PlanBundle): void {
  const seen = new Map<string, string>()
  for (const ticket of ticketsWithImages(bundle)) {
    const ids = ticket.attachments.map((ref) => ref.id)
    checkIdList(ids, ticket.key)
    for (const id of ids) {
      const other = seen.get(id)
      if (other !== undefined) {
        fail('conflict', `Attachment ${id} is shown on both ${other} and ${ticket.key}; an image belongs to one ticket.`, { id })
      }
      seen.set(id, ticket.key)
      const row = loadRefRow(db, id) ?? fail('not_found', `Attachment ${id} on ${ticket.key} no longer exists. Remove it from the ticket, then save.`, { id, ticketId: ticket.id })
      if (!heldByTicketOrStaged(row, ticket.id)) {
        fail('conflict', `Attachment ${id} on ${ticket.key} now belongs to a ${row.owner_kind ?? 'record'}. Remove it from the ticket, then save.`, { id, ticketId: ticket.id })
      }
    }
  }
}

/**
 * Gives each ticket of a saved revision the images it names that are still staged. Runs inside the snapshot entry once
 * `ticket_status` holds the tickets, and never throws: an image already owned (by this ticket or another record) or gone
 * since the save was requested is skipped, so the entry still completes. No per-owner count is applied: the save checked
 * this revision's own list. The finalizer writes the files with the epic's records.
 */
export function claimSavedTicketAttachments(db: Db, bundle: PlanBundle): void {
  for (const ticket of ticketsWithImages(bundle)) {
    for (const ref of ticket.attachments) {
      db.run("UPDATE attachments SET owner_kind = 'ticket', owner_id = ? WHERE id = ? AND owner_kind IS NULL", ticket.id, ref.id)
    }
  }
}
