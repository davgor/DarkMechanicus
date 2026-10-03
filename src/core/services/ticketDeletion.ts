import type { TicketContent } from '../../shared/domain/bundle'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { openDraft, updatePlanDraft } from './drafts'
import { assertEpicOpen, getEpic, loadEpicRow } from './epics'
import { appendEvent } from './events'
import { readPlanBundle, requestSave } from './plans'

function assertNoOpenAttempt(ctx: Ctx, epicId: string, ticket: TicketContent): void {
  const open = ctx.db.get<{ id: string }>(
    `SELECT a.id FROM attempts a JOIN runs r ON r.id = a.run_id
     WHERE r.epic_id = ? AND a.ticket_id = ? AND a.state IN ('claimed', 'running', 'submitted')`,
    epicId,
    ticket.id
  )
  if (open) {
    fail('conflict', `${ticket.key} has an open attempt. Finish or reconcile it before deleting the ticket.`, {
      attemptId: open.id
    })
  }
}

/**
 * Removes a ticket from the saved plan in one step: the draft edit and save a person would make
 * (open the draft, remove_ticket, save), in one transaction so a refusal at any step changes nothing.
 * Refused while the draft holds other changes, so those are never saved by surprise.
 */
export function deleteTicket(ctx: Ctx, input: { epicId: string; ticketId: string }): ReturnType<typeof requestSave> {
  requireCapability(ctx.session, 'ticket.delete')
  return ctx.db.tx(() => {
    const epic = loadEpicRow(ctx, input.epicId)
    assertEpicOpen(epic)
    const ticket =
      readPlanBundle(ctx, epic, 'saved').bundle.tickets.find((item) => item.id === input.ticketId) ??
      fail('not_found', `Ticket ${input.ticketId} is not in the saved plan.`, { ticketId: input.ticketId })
    const summary = getEpic(ctx, { epicId: epic.id })
    if (summary.pendingSave) {
      fail('save_pending', 'A save is still being written. Flush portable state, then try again.')
    }
    if (summary.draftChanged) {
      fail(
        'conflict',
        'The draft has unsaved changes. Save or discard them before deleting a ticket here, or remove it in the draft.'
      )
    }
    assertNoOpenAttempt(ctx, epic.id, ticket)
    openDraft(ctx, { epicId: epic.id })
    const update = updatePlanDraft(ctx, { epicId: epic.id, ops: [{ op: 'remove_ticket', ticket: ticket.id }] })
    appendEvent(ctx, {
      kind: 'ticket.deleted',
      epicId: epic.id,
      ticketId: ticket.id,
      payload: { key: ticket.key, title: ticket.title }
    })
    return requestSave(ctx, { epicId: epic.id, expectedDraftRevision: update.draftRevision })
  })
}
