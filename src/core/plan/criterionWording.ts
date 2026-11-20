/**
 * Flags work-ticket criteria that ask for a person. The person verifies only at the sprint checkpoint, so a
 * work ticket's criteria must be checkable by an agent alone; a criterion that needs a person belongs in the
 * sprint's acceptance node. The result is only ever a warning, never an error, so saved plans stay valid.
 */
import type { PlanBundle } from '../../shared/domain/bundle'
import type { ValidationIssue } from '../../shared/domain/views'
import { isAcceptanceTicket } from './acceptance'

export const CRITERION_NEEDS_PERSON = 'criterion_needs_person'

/** Wording that removes or replaces a manual step rather than asking for one ("no manual check", "automates human verification"). */
const NEGATED = String.raw`(?<!\b(?:no|without|remove[sd]?|removing|replace[sd]?|replacing|automate[sd]?|automating|skip[sp]?|skipped|skipping)\s+(?:(?:the|a|any)\s+)?)`

/**
 * Wording that asks a person to check something, matched on word boundaries and case-insensitively. The broad
 * phrases are narrowed so wording about the product's own behaviour ("the dialog asks the user", "the wizard will
 * ask the user", "after the user confirms", "lists the files to edit by hand") does not count.
 */
const NEEDS_PERSON: readonly RegExp[] = [
  new RegExp(String.raw`${NEGATED}\bmanually\s+(?:verif|check|test|confirm|inspect)\w*`, 'i'),
  new RegExp(String.raw`${NEGATED}\bmanual\s+(?:checks?|verifications?)\b`, 'i'),
  /\bperson\s+verifies\b/i,
  new RegExp(String.raw`${NEGATED}\bhuman[\s-]+verif`, 'i'),
  /(?<!\b(?:will|would|must|should|can|could|may|to|does|did)\s+)\bask\s+the\s+(?:user|person)\b/i,
  /(?<!\b(?:after|once|when|whenever|until|unless|if|before)\s+(?:(?:the|a|an)\s+)?(?:[\w-]+\s+)?)\buser\s+confirms\b/i,
  /\b(?:verif|check|test|confirm|inspect|validat|review)\w*\b(?:\s+[\w'-]+){0,3}?\s+(?<!\b(?:edit|edits|edited|editing|fix|fixes|fixed|write|writes|written|change|changes|changed|update|updates|updated|create|created|build|built|make|made|generate|generated|craft|crafted)\s+)by\s+hand\b/i
]

/** Quoted or code spans name wording rather than ask for it ('shows a "manually verify" hint'). */
const QUOTED = /"[^"]*"|“[^”]*”|`[^`]*`/g

/** True when the criterion's text asks a person to verify it. */
export function criterionNeedsPerson(text: string): boolean {
  const unquoted = text.replace(QUOTED, ' ')
  return NEEDS_PERSON.some((pattern) => pattern.test(unquoted))
}

/** One `criterion_needs_person` warning per work ticket with such a criterion; acceptance nodes are exempt. */
export function criterionNeedsPersonWarnings(bundle: PlanBundle): ValidationIssue[] {
  return bundle.tickets
    .filter((ticket) => !isAcceptanceTicket(ticket) && ticket.acceptanceCriteria.some((criterion) => criterionNeedsPerson(criterion.text)))
    .map((ticket) => ({
      code: CRITERION_NEEDS_PERSON,
      message: `Ticket ${ticket.key} criterion needs a person; tickets must be agent-verifiable, so move it to the sprint acceptance node or make it checkable by an agent.`,
      ticketIds: [ticket.id]
    }))
}
