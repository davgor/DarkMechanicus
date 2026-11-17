/**
 * The correction marker a ticket created as corrective work carries (`plan/corrections.ts`): a `doc` reference whose
 * location starts with this prefix and whose hash is the creating request's payload hash. It is the work's identity, so
 * the server owns it: a new ticket never brings one (`buildTicket`; `applyCorrections` attaches them), and an edit of a
 * ticket's references keeps the markers it has and never adds one (`patchTicket`).
 */
import type { TicketReference } from '../../shared/domain/bundle'

export const CORRECTION_MARKER_PREFIX = 'darkmechanicus:correction/'

function isCorrectionMarker(reference: TicketReference): boolean {
  return reference.kind === 'doc' && reference.location.startsWith(CORRECTION_MARKER_PREFIX)
}

/** A references edit: the ticket keeps its correction markers, and the edit's own markers are dropped. */
export function editedReferences(current: TicketReference[], edited: TicketReference[]): TicketReference[] {
  return [...current.filter(isCorrectionMarker), ...edited.filter((reference) => !isCorrectionMarker(reference))]
}
