/**
 * Sprint acceptance nodes. Every sprint ends in one ticket of kind `acceptance` that verifies the
 * sprint's work. It implicitly requires every other required ticket of its sprint, so no edges are
 * stored for that and tickets can move between sprints without rewiring. These helpers are the
 * single definition of "the acceptance node of a sprint" for validation, readiness and views.
 */
import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'

/** True for a sprint acceptance node. A ticket with no kind, or kind `work`, is a work ticket. */
export function isAcceptanceTicket(ticket: Pick<TicketContent, 'kind'>): boolean {
  return ticket.kind === 'acceptance'
}

/** The title an automatically created node gets, which a renumbered sprint keeps current. */
export function acceptanceTitle(ordinal: number): string {
  return `Sprint ${ordinal} acceptance`
}

/** The tickets a sprint lists, in sprint order; entries that name no ticket are skipped. */
function sprintTickets(bundle: PlanBundle, sprintId: string): TicketContent[] {
  const sprint = bundle.sprints.find((item) => item.id === sprintId)
  if (!sprint) {
    return []
  }
  const byId = new Map(bundle.tickets.map((ticket) => [ticket.id, ticket]))
  return sprint.ticketIds.flatMap((id) => byId.get(id) ?? [])
}

/** Every acceptance node a sprint lists, in sprint order. A valid plan has at most one per sprint. */
export function acceptanceNodesOf(bundle: PlanBundle, sprintId: string): TicketContent[] {
  return sprintTickets(bundle, sprintId).filter(isAcceptanceTicket)
}

/** The acceptance node of a sprint (the first one listed), or undefined when it has none. */
export function acceptanceNodeOf(bundle: PlanBundle, sprintId: string): TicketContent | undefined {
  return acceptanceNodesOf(bundle, sprintId)[0]
}

/** The tickets of a sprint that are not acceptance nodes, in sprint order. */
export function workTicketsOf(bundle: PlanBundle, sprintId: string): TicketContent[] {
  return sprintTickets(bundle, sprintId).filter((ticket) => !isAcceptanceTicket(ticket))
}

/**
 * The tickets an acceptance node requires without any stored edge: every required (not optional)
 * work ticket of its sprint, in sprint order. Empty for any other ticket.
 */
export function implicitPrerequisitesOf(bundle: PlanBundle, ticketId: string): string[] {
  const sprint = bundle.sprints.find((item) => item.ticketIds.includes(ticketId))
  const node = bundle.tickets.find((ticket) => ticket.id === ticketId)
  if (!sprint || !node || !isAcceptanceTicket(node)) {
    return []
  }
  return workTicketsOf(bundle, sprint.id)
    .filter((ticket) => !ticket.optional)
    .map((ticket) => ticket.id)
}
