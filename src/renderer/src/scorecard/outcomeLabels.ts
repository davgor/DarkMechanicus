/**
 * Words the epic and sprint-report Scorecards share for required outcomes and the tickets they name, so the two tabs
 * never drift apart in how they describe the same core read model.
 */
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { VerificationReason } from '../../../shared/domain/performance'
import type { VerificationState } from '../../../shared/domain/space'
import type { RequiredOutcome } from '../../../shared/domain/spaceGrades'

/** A ticket as the person knows it: its key and title from the plans read, else its id. */
interface TicketName {
  key: string
  title: string
}

export type TicketNames = ReadonlyMap<string, TicketName>

/** Every ticket the given plans name; a later plan's name of the same ticket wins. */
export function planTicketNames(bundles: readonly PlanBundle[]): TicketNames {
  return new Map(bundles.flatMap((bundle) => bundle.tickets.map((ticket) => [ticket.id, { key: ticket.key, title: ticket.title }] as const)))
}

export function ticketLabel(names: TicketNames, ticketId: string): string {
  const name = names.get(ticketId)
  return name === undefined ? ticketId : `${name.key} ${name.title}`
}

export const STATE_LABELS: Readonly<Record<VerificationState, string>> = { verified: 'verified', failed: 'failed', pending: 'pending', missing: 'not verified' }

export const REASON_LABELS: Readonly<Record<VerificationReason, string>> = {
  reviewed: 'accepted after review',
  confirmed_failure: 'confirmed failure (a criterion or check failed, or every try was used)',
  awaiting_review: 'awaiting review',
  in_progress: 'in progress',
  awaiting_retry: 'awaiting a retry',
  legacy_review_basis_unknown: 'accepted before reviews were recorded',
  worker_claims_only: 'only the worker claims it',
  required_evidence_missing: 'required evidence missing',
  retry_grants_unknown: 'every try used, as far as these records show (retry grants are kept on the machine that ran it)',
  run_ended: 'the run ended without an outcome',
  carried_forward: 'carried forward, not delivered here',
  no_attempt: 'never dispatched'
}

const ROLE_LABELS: Readonly<Record<RequiredOutcome['role'], string>> = {
  integrated: 'integrated (acceptance or administrative)',
  work: 'feature ticket',
  optional: 'optional'
}

/**
 * An outcome's role, state and reason in words. `markUncounted` adds ` · not counted` to an outcome that does not
 * count (a list that shows those beside the counted ones); a list of counted outcomes only leaves it out.
 */
export function outcomeText(outcome: RequiredOutcome, markUncounted: boolean): string {
  const moved = outcome.movedOut ? ' · since moved out of this sprint' : ''
  const counted = markUncounted && !outcome.counted ? ' · not counted' : ''
  return `${ROLE_LABELS[outcome.role]} · ${STATE_LABELS[outcome.state]}: ${REASON_LABELS[outcome.reason]}${moved}${counted}`
}
