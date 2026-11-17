/**
 * What the desktop's feedback controls say and check before a person's entry goes to `recordHumanFeedback`: the labels of
 * each choice, the bounds of a typed number of minutes (blank leaves the minutes out, never 0), and how a ticket's or a
 * sprint's satisfaction stands: its own rating, a sprint rating it inherits, one not shared with it, or none. A missing
 * rating is said to be missing; nothing here makes one up.
 */
import type { HumanIntervention, HumanReviewActivity, SpaceGrade, WorkflowCause } from '../../../shared/domain/space'
import { HUMAN_RATING_RANGE, MAX_RESCUE_MINUTES, MIN_FEEDBACK_MINUTES, type SatisfactionSignal } from '../../../shared/domain/spaceSignals'

export const RATING_VALUES: readonly number[] = Array.from({ length: HUMAN_RATING_RANGE.max - HUMAN_RATING_RANGE.min + 1 }, (_, index) => HUMAN_RATING_RANGE.min + index)

export const RATING_LABELS: Readonly<Record<number, string>> = {
  1: 'Not satisfied',
  2: 'Somewhat unsatisfied',
  3: 'Neutral',
  4: 'Satisfied',
  5: 'Very satisfied'
}

export const INTERVENTION_LABELS: Readonly<Record<HumanIntervention, string>> = {
  rescue: 'Took over or repaired the work',
  clarification: 'Answered a question',
  override: 'Overrode a decision',
  retry_grant: 'Granted another attempt',
  redirect: 'Changed its direction'
}

export const CAUSE_LABELS: Readonly<Record<WorkflowCause, string>> = {
  requirement: 'Unclear or changed requirement',
  context: 'Missing context',
  implementation: 'Implementation went wrong',
  integration: 'Integration problem',
  tooling: 'Tooling problem',
  verification: 'Verification problem'
}

export const ACTIVITY_LABELS: Readonly<Record<HumanReviewActivity, string>> = {
  review: 'Planned review',
  playtest: 'Playtesting'
}

type MinutesParse = { ok: true; minutes: number | undefined } | { ok: false; message: string }

/**
 * Minutes a person typed: blank leaves them out (the time was not given); otherwise plain digits (a decimal point
 * allowed), at least one minute and at most a working week. Text such as `1e` or `-` is refused, never read as blank.
 */
export function parseMinutes(text: string): MinutesParse {
  const trimmed = text.trim()
  if (trimmed === '') {
    return { ok: true, minutes: undefined }
  }
  const value = /^(\d+\.?\d*|\.\d+)$/.test(trimmed) ? Number(trimmed) : Number.NaN
  if (!Number.isFinite(value) || value < MIN_FEEDBACK_MINUTES || value > MAX_RESCUE_MINUTES) {
    return {
      ok: false,
      message: `Minutes are a number from ${MIN_FEEDBACK_MINUTES} to ${MAX_RESCUE_MINUTES.toLocaleString('en-US')} (a working week). Leave them blank when you do not know.`
    }
  }
  return { ok: true, minutes: value }
}

/** An entry's minutes, or that none were given (never 0). */
export function minutesText(value: number | null): string {
  return value === null ? 'minutes not given' : `${value.toLocaleString('en-US')} min`
}

/** How a ticket's S stands in this read: its own rating, the sprint's shared rating it inherits, an unshared one, or none. */
export function ticketSatisfactionText(signal: SatisfactionSignal): string {
  const own = signal.input.ticketRating
  const sprint = signal.input.sprintRating
  if (own !== null) {
    // Only a shared sprint rating is inherited, so only a shared one is overridden.
    return sprint?.sharedWithTickets === true
      ? `Own rating: ${own.value} of 5. It overrides the sprint's shared rating (${sprint.value} of 5) for this ticket.`
      : `Own rating: ${own.value} of 5.`
  }
  if (sprint === null) {
    return 'No rating recorded for this ticket or its sprint: S is left out of the grade and nothing is assumed.'
  }
  return sprint.sharedWithTickets
    ? `No rating of its own: S inherits the sprint's rating, ${sprint.value} of 5, which was shared with the sprint's tickets (marked inherited).`
    : `No rating of its own. The sprint was rated ${sprint.value} of 5 but not shared with its tickets, so S is left out here.`
}

/** How a sprint's own rating stands, and whether its tickets inherit it. */
export function sprintSatisfactionText(signal: SatisfactionSignal): string {
  const sprint = signal.input.sprintRating
  if (sprint === null) {
    return 'No rating recorded for this sprint: S is left out of the grade and nothing is assumed.'
  }
  return sprint.sharedWithTickets
    ? `Rated ${sprint.value} of 5, shared with the sprint's tickets: a ticket without its own rating inherits it, marked inherited.`
    : `Rated ${sprint.value} of 5, not shared: the sprint's tickets have no rating unless one is given to them one by one.`
}

/** A graded ticket's S at a glance, from the grade itself: own, inherited, or none (never a made-up rating). */
export function satisfactionLabel(grade: Pick<SpaceGrade, 'components'>): string {
  const S = grade.components.find((component) => component.component === 'S')
  if (S === undefined || S.score === null) {
    return 'S: no rating'
  }
  return S.inherited ? 'S: inherited sprint rating' : 'S: own rating'
}
