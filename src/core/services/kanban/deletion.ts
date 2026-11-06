/**
 * Deleting a Kanban card: a person's act from the desktop. The card's rows, its pending exports and its tracked
 * folder go together, so neither a restart nor a reconcile of the portable files brings it back.
 */
import { KANBAN_OPEN_ATTEMPT_STATES, type DeleteKanbanCardResultView } from '../../../shared/domain/kanban'
import { requireCapability } from '../../authz'
import type { Ctx } from '../../context'
import { fail } from '../../errors'
import { appendEvent } from '../events'
import { expireKanbanLeases } from './attempts'
import { loadSummaryRow } from './cards'

/** Deletes the card's tracked folder and returns the folders it removed; it runs inside the deletion transaction. */
type CardFilesRemover = (cardId: string) => string[]

const CARD_EVENTS = 'SELECT id FROM kanban_events WHERE card_id = ?'

/** Children before parents, since foreign keys are enforced. Every `?` binds the card id. */
const DELETE_STATEMENTS = [
  `DELETE FROM outbox WHERE (kind = 'kanban_card' AND entity_id = ?) OR (kind = 'kanban_event' AND entity_id IN (${CARD_EVENTS}))`,
  `DELETE FROM sync_state WHERE (kind = 'kanban_card' AND entity_id = ?) OR (kind = 'kanban_event' AND entity_id IN (${CARD_EVENTS}))`,
  // Cached replies that name the card (createKanbanCard, updateKanbanCard) would otherwise replay a deleted card.
  'DELETE FROM idempotency WHERE instr(response_json, ?) > 0',
  'DELETE FROM kanban_events WHERE card_id = ?',
  'DELETE FROM kanban_attempts WHERE card_id = ?',
  'DELETE FROM kanban_cards WHERE id = ?'
]

/**
 * Hard-deletes a card. Refused while it has an attempt in flight (claimed, running or submitted), since an agent may
 * still be working on it or its result still awaits review; an attempt whose lease lapsed no longer blocks.
 */
export function deleteKanbanCard(ctx: Ctx, input: { cardId: string }, removeFiles: CardFilesRemover): DeleteKanbanCardResultView {
  requireCapability(ctx.session, 'kanban.delete')
  ctx.assertBranch()
  expireKanbanLeases(ctx, input.cardId)
  return ctx.db.tx(() => {
    const card = loadSummaryRow(ctx, input.cardId)
    if (card.open_state !== null && KANBAN_OPEN_ATTEMPT_STATES.includes(card.open_state)) {
      fail(
        'invalid_state',
        `${card.key} has attempt #${card.open_number} in state ${card.open_state}, so it cannot be deleted. Wait for the attempt to finish or its lease to lapse, then delete the card.`,
        { cardId: card.id, attemptState: card.open_state }
      )
    }
    for (const sql of DELETE_STATEMENTS) {
      ctx.db.run(sql, ...Array.from({ length: sql.split('?').length - 1 }, () => card.id))
    }
    const removedPaths = removeFiles(card.id)
    appendEvent(ctx, { kind: 'kanban.deleted', payload: { key: card.key, title: card.title } })
    return { cardId: card.id, key: card.key, title: card.title, removedPaths }
  })
}
