/**
 * The desktop's prospective budget control. A ticket's planned budget is a draft field (`update_ticket` with `budget`),
 * so setting it follows draft and save ownership: it needs `draft.edit`, writes only the draft, and is refused as a
 * `conflict` when the draft moved since the revision the person edited. Only `savePlan` (`plan.save`) freezes it as a
 * new budget version, and a run keeps the version its first claim pinned (`plannedBaselines.ts`), so an edit never
 * changes a grade already read: it is prospective.
 */
import type { SetTicketBudgetInput, SetTicketBudgetResultView } from '../../shared/domain/scoreReads'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { updatePlanDraft } from './drafts'
import { getPlannedBaselines } from './plannedBaselines'

/**
 * Sets or clears a ticket's budget in the epic's draft and answers with the ticket's budget versions as they now stand
 * relative to the run (or the epic's current saved revision). A ticket only the draft holds, or any ticket of an epic
 * never saved, has no versions yet (`ticket` null): its budget becomes its first version when the plan is saved.
 */
export function setTicketBudget(ctx: Ctx, input: SetTicketBudgetInput): SetTicketBudgetResultView {
  requireCapability(ctx.session, 'draft.edit')
  return ctx.db.tx(() => {
    const update = updatePlanDraft(ctx, {
      epicId: input.epicId,
      ops: [{ op: 'update_ticket', ticket: input.ticketId, patch: { budget: input.budget } }],
      expectedDraftRevision: input.expectedDraftRevision
    })
    // A never-saved epic has no budget versions yet: the edit becomes the first version when the plan is first saved.
    const saved = ctx.db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', input.epicId)?.current_revision_id ?? null
    const baselines = saved === null ? null : getPlannedBaselines(ctx, { epicId: input.epicId, ...(input.runId === undefined ? {} : { runId: input.runId }) })
    const ticket = baselines?.tickets.find((entry) => entry.ticketId === input.ticketId) ?? null
    return {
      epicId: input.epicId,
      draftRevision: update.draftRevision,
      ticket,
      appliesTo: ticket === null || ticket.dispatchedAt === null ? 'next_dispatch' : 'later_dispatches'
    }
  })
}
