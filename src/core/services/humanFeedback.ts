/**
 * What a person enters in the desktop app: a satisfaction/confidence rating of a ticket or a sprint (SPACE S), minutes
 * spent stepping in (rescue time with how and why, a diagnostic beside E), planned review or playtesting time (never a
 * rescue, never scored), and escaped defect records (P). They are recorded only by the desktop session (capability
 * `feedback.record`, which no agent role holds); the source is always `human`, the actor is the person, the desktop
 * session and machine are stored with each entry, and the server stamps the time and checks that every id of the target
 * belongs to its epic. The MCP metric tools refuse `human` sources and human-only metrics outright, so no agent can speak
 * for a person through a command. Portable record files are not authenticated, so the S read shows where each entry was
 * recorded (`FeedbackProvenance`) rather than trusting it blindly.
 */
import type { MetricAttributes, MetricObservation, MetricScope } from '../../shared/domain/space'
import type { EscapedDefectRecordInput, RecordEscapedDefectsInput, RecordEscapedDefectsResultView } from '../../shared/domain/scoreReads'
import {
  HUMAN_RATING_RANGE,
  type HumanFeedbackTarget,
  type HumanRatingFeedback,
  MAX_RESCUE_MINUTES,
  MIN_FEEDBACK_MINUTES,
  type PlannedReviewFeedback,
  type RecordHumanFeedbackInput,
  type RescueFeedback
} from '../../shared/domain/spaceSignals'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { loadAttempt, loadBundle, requireRun } from './execution'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { type ObservationInput, recordObservations } from './observations'

const PERSON_ONLY =
  'Ratings, rescue time, planned review or playtesting time and escaped defect records are a person’s, entered in the desktop app; no agent session records them.'

/** An attempt target takes its run, ticket and sprint from the attempt; any of them named too must agree. */
function attemptScope(ctx: Ctx, target: HumanFeedbackTarget, attemptId: string): MetricScope {
  const attempt = loadAttempt(ctx, attemptId)
  const run = requireRun(ctx, attempt.run_id)
  const sprint = loadBundle(ctx, attempt.revision_id).sprints.find((item) => item.ticketIds.includes(attempt.ticket_id))
  const named = { epicId: run.epic_id, runId: run.id, ticketId: attempt.ticket_id, sprintId: sprint?.id ?? null }
  for (const [key, value] of Object.entries(named) as [keyof typeof named, string | null][]) {
    const given = target[key]
    if (given !== undefined && given !== value) {
      fail('invalid_input', `Attempt ${attempt.id} belongs to ${key} ${value ?? 'none'}, not ${given}.`, { attemptId: attempt.id, [key]: given })
    }
  }
  return { level: 'attempt', ...named, attemptId: attempt.id }
}

/** A sprint rating that also names the run it was given in (and no ticket or attempt): its sprint and run, else null. */
function sprintRatingIn(input: RecordHumanFeedbackInput): { sprintId: string; runId: string } | null {
  const { feedback, target } = input
  if (feedback.kind !== 'rating' || target.ticketId !== undefined || target.attemptId !== undefined) {
    return null
  }
  return target.sprintId === undefined || target.runId === undefined ? null : { sprintId: target.sprintId, runId: target.runId }
}

/**
 * A sprint rating given while looking at one run: the rating is the sprint's (once per sprint, whichever run it was
 * given in), so the run only has to be the epic's and hold the sprint; the stored scope is the sprint's.
 */
function sprintRatingScope(ctx: Ctx, epicId: string, placed: { sprintId: string; runId: string }): MetricScope {
  const { sprintId, runId } = placed
  const run = requireRun(ctx, runId)
  if (run.epic_id !== epicId) {
    fail('invalid_input', `Run ${run.id} belongs to epic ${run.epic_id}, not ${epicId}.`, { runId: run.id })
  }
  if (!loadBundle(ctx, run.revision_id).sprints.some((sprint) => sprint.id === sprintId)) {
    fail('invalid_input', `Sprint ${sprintId} is not in run ${run.id}'s plan.`, { runId: run.id, sprintId })
  }
  return { level: 'sprint', epicId, sprintId, runId: null, ticketId: null, attemptId: null }
}

/**
 * The most specific id named sets the level: attempt, ticket, run, sprint, else the epic (a sprint rating naming its
 * run is placed by `sprintRatingScope` instead).
 */
function feedbackScope(ctx: Ctx, target: HumanFeedbackTarget): MetricScope {
  if (target.attemptId !== undefined) {
    return attemptScope(ctx, target, target.attemptId)
  }
  const { epicId, sprintId = null, runId = null, ticketId = null } = target
  const ids = { epicId, sprintId, runId, ticketId, attemptId: null }
  if (ticketId !== null) {
    return { level: 'ticket', ...ids }
  }
  if (runId !== null) {
    return { level: 'run', ...ids }
  }
  return { level: sprintId === null ? 'epic' : 'sprint', ...ids }
}

function ratingFields(scope: MetricScope, feedback: HumanRatingFeedback): Pick<ObservationInput, 'metric' | 'unit' | 'measurement' | 'attributes'> {
  if (scope.level !== 'ticket' && scope.level !== 'sprint') {
    fail('invalid_input', `A rating is about one ticket or one sprint, not a whole ${scope.level}.`, { level: scope.level })
  }
  const { min, max } = HUMAN_RATING_RANGE
  if (!Number.isInteger(feedback.value) || feedback.value < min || feedback.value > max) {
    fail('invalid_input', `A rating is a whole number from ${min} to ${max}.`, { value: feedback.value })
  }
  const isSprint = scope.level === 'sprint'
  if (isSprint === (feedback.sharedWithTickets === undefined)) {
    fail(
      'invalid_input',
      isSprint
        ? 'A sprint rating states whether it is shared with the sprint’s tickets as inherited context.'
        : 'Only a sprint rating is shared with tickets; a ticket rating is the ticket’s own.'
    )
  }
  return {
    metric: 'human_rating',
    unit: 'rating_1_5',
    measurement: { state: 'observed', value: feedback.value },
    attributes: isSprint ? { sharedWithTickets: feedback.sharedWithTickets === true } : {}
  }
}

type TimeFields = Pick<ObservationInput, 'metric' | 'unit' | 'measurement' | 'attributes' | 'intervention' | 'cause'>

/** Minutes when given (at least one, at most a working week), else `missing`: the time was not given, never 0. */
function minutesMeasurement(minutes: number | undefined): ObservationInput['measurement'] {
  if (minutes === undefined) {
    return { state: 'missing', reason: 'not_reported' }
  }
  if (!Number.isFinite(minutes) || minutes < MIN_FEEDBACK_MINUTES || minutes > MAX_RESCUE_MINUTES) {
    fail('invalid_input', `Minutes are at least ${MIN_FEEDBACK_MINUTES} and at most ${MAX_RESCUE_MINUTES}; leave them out when not known.`, { minutes })
  }
  return { state: 'observed', value: minutes }
}

/** A new rescue entry always says why (`cause`); older imported entries without one stay readable as they are. */
function rescueFields(feedback: RescueFeedback): TimeFields {
  return {
    metric: 'rescue_minutes',
    unit: 'minutes',
    measurement: minutesMeasurement(feedback.minutes),
    attributes: {},
    intervention: feedback.intervention,
    cause: feedback.cause
  }
}

function plannedReviewFields(feedback: PlannedReviewFeedback): TimeFields {
  return { metric: 'human_review_minutes', unit: 'minutes', measurement: minutesMeasurement(feedback.minutes), attributes: { activity: feedback.activity } }
}

/** Refuses every session but the desktop's: what a person says is recorded only where the person is. */
function assertPerson(ctx: Ctx): void {
  requireCapability(ctx.session, 'feedback.record', PERSON_ONLY)
  if (ctx.session.role !== 'desktop') {
    fail('unauthorized', PERSON_ONLY, { role: ctx.session.role })
  }
  ctx.assertBranch()
}

/** The person the desktop names, else the desktop session's label; never empty. */
function personOf(ctx: Ctx, given: string | undefined): string {
  const person = (given ?? ctx.session.label).trim()
  return person === '' ? fail('invalid_input', 'Human feedback names the person who gave it.') : person
}

/**
 * Records a person's rating, rescue time or planned review time. Who: the person the desktop names (else the desktop
 * session's label), plus the desktop session and machine. When: the server's clock. What about: the target's scope,
 * checked against the epic's saved plans and runs. Corrections are new entries; the latest per scope counts. A sprint
 * rating says whether it is shared with the sprint's tickets; a ticket rating overrides it for that ticket. Rescue and
 * planned review are separate metrics, so planned review or playtesting never reads as a rescue.
 */
export function recordHumanFeedback(ctx: Ctx, input: RecordHumanFeedbackInput): MetricObservation {
  assertPerson(ctx)
  return withIdempotency(ctx, { command: 'recordHumanFeedback', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const { feedback } = input
    const placed = sprintRatingIn(input)
    const scope = placed === null ? feedbackScope(ctx, input.target) : sprintRatingScope(ctx, input.target.epicId, placed)
    const person = personOf(ctx, input.person)
    const fields: TimeFields =
      feedback.kind === 'rating' ? ratingFields(scope, feedback) : feedback.kind === 'rescue' ? rescueFields(feedback) : plannedReviewFields(feedback)
    const observation: ObservationInput = {
      ...fields,
      scope,
      source: { kind: 'human', actor: person },
      accumulation: 'event',
      sequence: null,
      observedAt: ctx.clock.nowIso(),
      attributes: { ...fields.attributes, desktopSession: ctx.session.id, machine: ctx.machineId },
      evidence: []
    }
    const [stored] = recordObservations(ctx, [observation]).observations
    return stored ?? fail('internal', 'The feedback was not stored.')
  })
}

/** The defect vocabulary's attributes of one record, as given (the ledger's `defectProblem` checks them). */
function defectAttributes(record: EscapedDefectRecordInput): MetricAttributes {
  const { defectEvent, severity, attribution, discoveryPhase, defectKey } = record
  return {
    defectEvent,
    ...(severity === undefined ? {} : { severity }),
    ...(attribution === undefined ? {} : { attribution }),
    ...(discoveryPhase === undefined ? {} : { discoveryPhase }),
    ...(defectKey === undefined ? {} : { defectKey })
  }
}

/**
 * Records escaped defect records a person entered: reports, duplicates, reassessments, fixes and withdrawals, as source
 * `human` (which may change charging; see `defects.ts`), with the desktop session and machine like any human entry. The
 * records are stored all or none, in call order: the server assigns their ids, ordered within the call, so a report and
 * a later record about it never read out of order. A follow-up cites a stored report (ids are never the caller's), and
 * a retry with the same idempotency key returns the first answer.
 */
export function recordEscapedDefects(ctx: Ctx, input: RecordEscapedDefectsInput): RecordEscapedDefectsResultView {
  assertPerson(ctx)
  return withIdempotency(ctx, { command: 'recordEscapedDefects', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const scope = feedbackScope(ctx, input.target)
    const person = personOf(ctx, input.person)
    const observedAt = ctx.clock.nowIso()
    const observations = input.records.map(
      (record): ObservationInput => ({
        metric: 'escaped_defect',
        unit: 'count',
        scope,
        source: { kind: 'human', actor: person },
        measurement: { state: 'observed', value: record.defectEvent === 'report' ? 1 : 0 },
        accumulation: 'event',
        sequence: null,
        observedAt,
        attributes: { ...defectAttributes(record), desktopSession: ctx.session.id, machine: ctx.machineId },
        evidence: record.evidence
      })
    )
    return { observations: recordObservations(ctx, observations).observations }
  })
}
