/** What the epic workspace does when another screen asks it to open a ticket (a link in a chat). */
import type { TicketLanding } from '../app/landing'
import { planFor, type PlanViewKind, type WorkspaceAction, type WorkspaceData } from './workspaceState'

/**
 * The actions that open the ticket a landing names, as the workspace stands: the ticket's panel, and its
 * Activity tab for the attempt when one is named. The Activity tab belongs to the saved plan's panel (a draft
 * with changes shows the editor instead), so an attempt is shown on the saved plan, without that being
 * remembered as the person's choice of view. Nothing opens for a ticket the plan being shown does not have.
 */
export function landingActions(landing: TicketLanding, data: WorkspaceData, view: PlanViewKind): WorkspaceAction[] {
  const { ticketId, attemptId } = landing
  const toSaved = attemptId !== null && view !== 'saved'
  const shown = planFor(data, toSaved ? 'saved' : view)
  if (shown === null || !shown.bundle.tickets.some((ticket) => ticket.id === ticketId)) {
    return []
  }
  const open: WorkspaceAction = attemptId === null ? { type: 'select_ticket', ticketId } : { type: 'open_activity', ticketId, attemptId }
  return toSaved ? [{ type: 'show_view', view: 'saved', remember: false }, open] : [open]
}
