/**
 * Where an attachment's file lives, from the record that owns it: an attempt's evidence in its run's history folder, a
 * card or a card attempt's in the card's folder, a comment's or a ticket's in the epic's folder. Read from the database
 * alone; an owner this database does not hold has no folder.
 */
import type { Db } from '../db/database'
import type { AttachmentOwner } from '../../shared/domain/views'
import type { AttachmentFolder } from '../repo/paths'

export interface AttachmentPlacement {
  folder: AttachmentFolder
  /** The epic the folder belongs to, when it has one (a Kanban card has none). */
  epicId: string | null
  /** The run whose history folder it is, for an attempt's evidence. */
  runId: string | null
}

function runPlacement(db: Db, attemptId: string): AttachmentPlacement | null {
  const row = db.get<{ run_id: string; epic_id: string }>(
    'SELECT a.run_id, r.epic_id FROM attempts a JOIN runs r ON r.id = a.run_id WHERE a.id = ?',
    attemptId
  )
  return row === undefined ? null : { folder: { kind: 'run', id: row.run_id }, epicId: row.epic_id, runId: row.run_id }
}

function cardPlacement(cardId: string | undefined): AttachmentPlacement | null {
  return cardId === undefined ? null : { folder: { kind: 'kanban_card', id: cardId }, epicId: null, runId: null }
}

function epicPlacement(epicId: string | undefined): AttachmentPlacement | null {
  return epicId === undefined ? null : { folder: { kind: 'epic', id: epicId }, epicId, runId: null }
}

/** The folder an owner's attachments are exported to, or null when this database does not hold the owner. */
export function resolveAttachmentPlacement(db: Db, owner: AttachmentOwner): AttachmentPlacement | null {
  switch (owner.kind) {
    case 'attempt':
      return runPlacement(db, owner.id)
    case 'kanban_attempt':
      return cardPlacement(db.get<{ card_id: string }>('SELECT card_id FROM kanban_attempts WHERE id = ?', owner.id)?.card_id)
    case 'kanban_card':
      return cardPlacement(db.get<{ id: string }>('SELECT id FROM kanban_cards WHERE id = ?', owner.id)?.id)
    case 'comment':
      return epicPlacement(db.get<{ epic_id: string }>('SELECT epic_id FROM comments WHERE id = ?', owner.id)?.epic_id)
    case 'ticket':
      return epicPlacement(db.get<{ epic_id: string }>('SELECT epic_id FROM ticket_status WHERE ticket_id = ?', owner.id)?.epic_id)
  }
}
