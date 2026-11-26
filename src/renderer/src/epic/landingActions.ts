/** What the epic workspace does when another screen asks it to open something (a link in a chat, a Metrics dashboard row, a clicked notification). */
import type { EpicLanding, TicketScorecardLanding } from '../app/landing'
import { planFor, type PlanViewKind, type WorkspaceAction, type WorkspaceData } from './workspaceState'

/** A request that names a ticket. */
type TicketRequest = Extract<EpicLanding, { ticketId: string }>

/**
 * A ticket Scorecard request for a ticket the saved plan no longer holds (removed after the revision its run was pinned
 * to): its panel cannot open, so the epic's Scorecard opens with a message saying why.
 */
function missingTicket(landing: TicketScorecardLanding): WorkspaceAction[] {
  const name = landing.ticketKey ?? landing.ticketId
  return [
    { type: 'open_scorecard' },
    { type: 'banner', text: `${name} is not in this epic's saved plan any more, so its Scorecard tab cannot open; the epic's Scorecard is shown instead.` }
  ]
}

/** What opens a ticket the plan holds: its Scorecard tab, its Activity tab for the attempt, or just its panel. */
function openTicket(landing: TicketRequest): WorkspaceAction {
  const { ticketId } = landing
  if (landing.kind === 'ticketScorecard') return { type: 'open_ticket_scorecard', ticketId, runId: landing.runId }
  return landing.attemptId === null ? { type: 'select_ticket', ticketId } : { type: 'open_activity', ticketId, attemptId: landing.attemptId }
}

/**
 * The actions that open what a landing names, as the workspace stands. An epic Scorecard request opens the epic's
 * Scorecard; an Agent request opens the Agent tab with the chat (and thread) selected; a checkpoint request opens the
 * checkpoint panel. A ticket request opens the ticket's panel, on its Activity tab for the attempt when one is named, or on
 * its Scorecard tab. The Activity and Scorecard tabs belong to the saved plan's panel (a draft with changes shows the
 * editor instead), so those are shown on the saved plan, without that being remembered as the person's choice of
 * view. A ticket the plan does not have opens nothing, except that a Scorecard request explains why (`missingTicket`).
 */
export function landingActions(landing: EpicLanding, data: WorkspaceData, view: PlanViewKind): WorkspaceAction[] {
  switch (landing.kind) {
    case 'epicScorecard':
      return [{ type: 'open_scorecard' }]
    case 'epicAgent':
      return [{ type: 'open_agent', chatId: landing.chatId, threadId: null }]
    case 'epicCheckpoint':
      return [{ type: 'open_checkpoint' }]
    default:
      return ticketActions(landing, data, view)
  }
}

function ticketActions(landing: TicketRequest, data: WorkspaceData, view: PlanViewKind): WorkspaceAction[] {
  const needsSaved = landing.kind === 'ticketScorecard' || landing.attemptId !== null
  const toSaved = needsSaved && view !== 'saved'
  const shown = planFor(data, toSaved ? 'saved' : view)
  if (shown === null || !shown.bundle.tickets.some((ticket) => ticket.id === landing.ticketId)) {
    return landing.kind === 'ticketScorecard' ? missingTicket(landing) : []
  }
  const open = openTicket(landing)
  return toSaved ? [{ type: 'show_view', view: 'saved', remember: false }, open] : [open]
}
