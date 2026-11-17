/**
 * The S, A and C signals of a ticket, sprint, run or epic, read from Dark Mechanicus's own records at a cutoff:
 *
 * - **S**: a person's ratings from the desktop (`humanFeedback.ts`). A ticket's own rating wins; a sprint rating
 *   reaches the sprint's tickets only when the person shared it, and is labeled inherited. Nothing is asked per
 *   ticket and nothing is inferred: without a rating S stays missing. Rescue minutes are listed beside it (a
 *   diagnostic, never scored).
 * - **A**: delivery against the scope frozen at the first dispatch: the saved plan revision the first claim ran
 *   under (`attempts.revision_id`, which adopting a newer revision never rewrites). A ticket commits its acceptance
 *   criteria (id and text, compared ignoring case and spacing); a sprint, run or epic commits its work tickets (by
 *   id; overhead tickets (acceptance nodes, administrative and Fireguard work), optional tickets and carried-forward
 *   work are not feature outcomes here). Committed items
 *   the plan later drops stay in the denominator; items it gains are added scope, listed apart and never in A. So
 *   splitting, renaming, rewording or deleting work cannot raise A: only accepting what was committed does. Every
 *   undelivered item says why (`ScopeItem.undelivered`).
 * - **C**: handoff checks the server derived from each submission when it arrived (`recordHandoffChecks`), plus
 *   recorded coordination defects, each citing a run record. Every deduction links to its check observation (and the
 *   review decision on that submission) or to the defect and the records it cites. A clarification is never a
 *   deduction.
 */
import type { PlanBundle, SprintDef, TicketContent } from '../../shared/domain/bundle'
import type { DeliveryInput, EvidenceRef, GradeSubjectLevel, MetricObservation, MetricScope, SatisfactionInput } from '../../shared/domain/space'
import {
  type CollaborationDeduction,
  type CollaborationSignal,
  type DeliverySignal,
  type GetSpaceSignalsInput,
  HANDOFF_CHECKS,
  type HandoffCheckName,
  type FeedbackProvenance,
  type HumanFeedbackEntry,
  type SatisfactionSignal,
  type ScopeItem,
  type SpaceSignalsView,
  type UncheckedSubmission,
  type UndeliveredReason
} from '../../shared/domain/spaceSignals'
import type { AttemptDecision, AttemptEvidence, AttemptOutputs } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { DomainError, fail } from '../errors'
import { derivedStableId } from '../ids'
import { isAcceptanceTicket } from '../plan/acceptance'
import { deriveHandoffChecks, type HandoffCheckResult } from '../space/handoff'
import { LEDGER_LIMITS } from '../space/ledger'
import { appendEvent } from './events'
import { type AttemptRow, loadAttempt, loadBundle, requireRun, type RunRow } from './execution'
import { listObservations, type ObservationInput, recordObservations, storedObservation } from './observations'

/** Logged when the ledger refuses a submission's derived handoff checks (see `recordHandoffChecks`). */
const HANDOFF_CHECKS_REFUSED_EVENT = 'attempt.handoff_checks_refused'

const EMPTY_OUTPUTS: AttemptOutputs = { summary: '', artifacts: [], commits: [], changedFiles: [], branch: null }
const EMPTY_EVIDENCE: AttemptEvidence = { checks: [], criteria: [], notes: '' }

function sprintHolding(bundle: PlanBundle, ticketId: string): SprintDef | undefined {
  return bundle.sprints.find((sprint) => sprint.ticketIds.includes(ticketId))
}

/** The number an observed or estimated measurement holds; 0 for a missing one (callers filter those out first). */
function valueOf(observation: MetricObservation): number {
  return observation.measurement.state === 'missing' ? 0 : observation.measurement.value
}

// ---------------------------------------------------------------------------------------------------------------
// Handoff checks, derived when a submission arrives

function checkId(attemptId: string, submittedAt: string, check: string): string {
  return derivedStableId('metricObservation', JSON.stringify(['handoff-check', attemptId, submittedAt, check]))
}

/**
 * The missing items as a JSON list of the whole items that fit one stored text (never a cut item), and how many there
 * were, so a long list is shortened, never corrupted, and an item holding a comma stays one item.
 */
function missingAttributes(missing: readonly string[]): { missing: string; missingCount: number } {
  const kept: string[] = []
  for (const item of missing) {
    if (JSON.stringify([...kept, item]).length > LEDGER_LIMITS.text) {
      break
    }
    kept.push(item)
  }
  return { missing: JSON.stringify(kept), missingCount: missing.length }
}

/** The bucket of one attempt of one ticket. */
type AttemptScope = MetricScope & { ticketId: string; attemptId: string }

function checkObservation(scope: AttemptScope, submittedAt: string, result: HandoffCheckResult): ObservationInput {
  const attemptId = scope.attemptId
  const missingCriteria = result.check === 'criteria_evidence' ? result.missing : []
  return {
    observationId: checkId(attemptId, submittedAt, result.check),
    metric: 'handoff_check',
    unit: 'pass_fail',
    scope,
    source: { kind: 'server', actor: null },
    measurement: { state: 'observed', value: result.passed ? 1 : 0 },
    accumulation: 'event',
    sequence: null,
    observedAt: submittedAt,
    attributes: { check: result.check, ...(result.passed ? {} : missingAttributes(result.missing)) },
    evidence: [
      { kind: 'attempt', id: attemptId, detail: 'submission' },
      ...missingCriteria.map((criterionId): EvidenceRef => ({ kind: 'criterion', id: scope.ticketId, detail: criterionId }))
    ]
  }
}

/**
 * Records the server's handoff checks of an attempt's submission, in the submission's own transaction: whether every
 * criterion has evidence, whether checks (and every check the packet required by name) were reported, and whether the
 * outputs keep their contract. The checks depend only on the submission as it arrived and the ticket in the revision
 * the attempt ran under. Their ids derive from the attempt, submission time and check, and once stored they are the
 * record of that submission: asking again (after a review merged its criteria in, say) changes nothing. They do not
 * depend on the review, so a submission canceled or expired before review keeps its checks.
 *
 * Measurement never blocks the lifecycle: when the ledger refuses the checks (a full ledger, a required check name the
 * storage screens refuse) nothing is recorded and the submission stands unchecked, which C reads as not reported. The
 * refusal is logged as a `attempt.handoff_checks_refused` event with its error code and message, which C's read lists
 * beside the unchecked submission (`CollaborationSignal.unchecked`). Returns whether the submission has its checks.
 */
export function recordHandoffChecks(ctx: Ctx, attemptId: string): boolean {
  const row = loadAttempt(ctx, attemptId)
  const submittedAt = row.submitted_at
  const bundle = loadBundle(ctx, row.revision_id)
  const ticket = bundle.tickets.find((item) => item.id === row.ticket_id)
  if (row.kind !== 'work' || submittedAt === null || ticket === undefined) {
    return false
  }
  if (HANDOFF_CHECKS.some((check) => storedObservation(ctx.db, checkId(row.id, submittedAt, check)) !== undefined)) {
    return true
  }
  const scope: AttemptScope = {
    level: 'attempt',
    epicId: requireRun(ctx, row.run_id).epic_id,
    sprintId: sprintHolding(bundle, ticket.id)?.id ?? null,
    runId: row.run_id,
    ticketId: ticket.id,
    attemptId: row.id
  }
  try {
    recordObservations(ctx, handoffChecksOf(ctx, row, ticket).map((result) => checkObservation(scope, submittedAt, result)))
    return true
  } catch (error) {
    // recordObservations ran in its own savepoint, so a refusal left nothing behind; the submission goes on, and the
    // refusal is logged so C's read can say why the submission is unchecked.
    if (error instanceof DomainError) {
      appendEvent(ctx, {
        kind: HANDOFF_CHECKS_REFUSED_EVENT,
        epicId: scope.epicId,
        runId: row.run_id,
        ticketId: ticket.id,
        payload: { attemptId: row.id, submittedAt, code: error.code, message: error.message.slice(0, 1_000) }
      })
      return false
    }
    throw error
  }
}

/** The checks of the attempt's stored submission against its ticket and the checks its packet required by name. */
function handoffChecksOf(ctx: Ctx, row: AttemptRow, ticket: TicketContent): HandoffCheckResult[] {
  // The project's Definition of Done is required by name only of a single repository's acceptance node (its packet).
  const required = isAcceptanceTicket(ticket) && ctx.repositories() === null ? ctx.definitionOfDone().map((check) => check.name) : []
  const submission = {
    outputs: parseJson<AttemptOutputs>(row.outputs_json, EMPTY_OUTPUTS),
    evidence: parseJson<AttemptEvidence>(row.evidence_json, EMPTY_EVIDENCE)
  }
  return deriveHandoffChecks(ticket, submission, required)
}

// ---------------------------------------------------------------------------------------------------------------
// The subject read

interface Subject {
  level: GradeSubjectLevel
  id: string
  epicId: string
  /** The subject's run; null for an epic, which reads every run of the epic. */
  run: RunRow | null
  cutoff: string
  /** Every attempt of the runs read, created by the cutoff, oldest first. */
  attempts: AttemptRow[]
  /** Every attempt of every run of the epic created by the cutoff: where a carried-forward ticket's acceptance is. */
  epicAttempts: AttemptRow[]
  /** The plan the (last) run held at the cutoff; the epic's saved plan when it has no run. */
  currentRevisionId: string
  currentBundle: PlanBundle
  bundle(revisionId: string): PlanBundle
}

/** How a subject level picks its attempts, its observations, its committed tickets and the claim that froze them. */
interface SubjectRules {
  /** Whether an attempt belongs to the subject. */
  holds(attempt: AttemptRow): boolean
  /** Whether a stored observation is about the subject. */
  covers(observation: MetricObservation): boolean
  /** The tickets a sprint, run or epic commits in a plan; null for a ticket, which commits its criteria. */
  ticketsIn(plan: PlanBundle): TicketContent[] | null
  /** The work claim whose plan revision froze the subject's scope, or undefined before any dispatch. */
  freezer(): AttemptRow | undefined
}

type Read = Subject & SubjectRules

function normalizedCutoff(ctx: Ctx, cutoff: string | undefined): string {
  const now = ctx.clock.nowIso()
  const ms = cutoff === undefined ? Date.parse(now) : Date.parse(cutoff)
  if (!Number.isFinite(ms)) {
    fail('invalid_input', `The cutoff ${cutoff} is not a time.`, { cutoff })
  }
  return new Date(Math.min(ms, Date.parse(now))).toISOString()
}

/**
 * The plan revision a run held at `cutoff`: the one the first adoption after the cutoff replaced, else its current
 * one. Adoptions are read from this machine's event log; without it the run's current revision stands.
 */
export function revisionAt(ctx: Ctx, run: RunRow, cutoff: string): string {
  const adopted = ctx.db.get<{ payload_json: string }>(
    "SELECT payload_json FROM events WHERE run_id = ? AND kind = 'run.revision_adopted' AND at > ? ORDER BY seq LIMIT 1",
    run.id,
    cutoff
  )
  const from = parseJson<{ from?: unknown }>(adopted?.payload_json, {}).from
  return typeof from === 'string' ? from : run.revision_id
}

/** The runs read: the subject's own, or every run of the epic created by the cutoff. */
function subjectRuns(ctx: Ctx, input: GetSpaceSignalsInput, cutoff: string): { epicId: string; runs: RunRow[] } {
  if (input.level === 'epic') {
    if (ctx.db.get('SELECT id FROM epics WHERE id = ?', input.id) === undefined) {
      fail('not_found', `Epic ${input.id} not found.`, { epicId: input.id })
    }
    return { epicId: input.id, runs: ctx.db.all<RunRow>('SELECT * FROM runs WHERE epic_id = ? AND created_at <= ? ORDER BY created_at, number', input.id, cutoff) }
  }
  const runId = input.level === 'run' ? input.id : input.runId
  if (runId === undefined) {
    fail('invalid_input', `A ${input.level} is read within one run: name its runId.`, { level: input.level })
  }
  const run = requireRun(ctx, runId)
  return { epicId: run.epic_id, runs: [run] }
}

/**
 * What reads of several subjects of one epic at one cutoff share, loaded once: plan bundles, each run's attempts,
 * the epic's attempts, and the epic's observations stored by the cutoff with their handoff checks by attempt. Grading
 * every ticket of a run then costs one load, not one per ticket. Use one cache per transaction and cutoff.
 */
export interface SignalsCache {
  bundles: Map<string, PlanBundle>
  runAttempts: Map<string, AttemptRow[]>
  epicAttempts: Map<string, AttemptRow[]>
  observations: Map<string, { list: MetricObservation[]; checks: Map<string, MetricObservation[]> }>
}

export function signalsCache(): SignalsCache {
  return { bundles: new Map(), runAttempts: new Map(), epicAttempts: new Map(), observations: new Map() }
}

function cached<T>(map: Map<string, T>, key: string, load: () => T): T {
  const held = map.get(key)
  if (held !== undefined) return held
  const loaded = load()
  map.set(key, loaded)
  return loaded
}

function loadSubject(ctx: Ctx, input: GetSpaceSignalsInput, cache: SignalsCache): Subject {
  const cutoff = normalizedCutoff(ctx, input.cutoff)
  const bundle = (revisionId: string): PlanBundle => cached(cache.bundles, revisionId, () => loadBundle(ctx, revisionId))
  const { epicId, runs } = subjectRuns(ctx, input, cutoff)
  const byCreation = (rows: AttemptRow[]): AttemptRow[] =>
    rows.filter((attempt) => attempt.created_at <= cutoff).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const runAttempts = (runId: string): AttemptRow[] =>
    cached(cache.runAttempts, runId, () => ctx.db.all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at, number', runId))
  const attempts = byCreation(runs.flatMap((run) => runAttempts(run.id)))
  const epicAttempts =
    input.level === 'epic'
      ? attempts
      : byCreation(
          cached(cache.epicAttempts, epicId, () =>
            ctx.db.all<AttemptRow>('SELECT a.* FROM attempts a JOIN runs r ON r.id = a.run_id WHERE r.epic_id = ? ORDER BY a.created_at, a.number', epicId)
          )
        )
  const lastRun = runs.at(-1)
  const saved = ctx.db.get<{ current_revision_id: string | null }>('SELECT current_revision_id FROM epics WHERE id = ?', epicId)?.current_revision_id
  const currentRevisionId = lastRun === undefined ? saved : revisionAt(ctx, lastRun, cutoff)
  if (currentRevisionId === null || currentRevisionId === undefined) {
    fail('not_found', `Epic ${epicId} has no saved plan.`, { epicId })
  }
  const run = input.level === 'epic' ? null : (lastRun ?? null)
  return { level: input.level, id: input.id, epicId, run, cutoff, attempts, epicAttempts, currentRevisionId, currentBundle: bundle(currentRevisionId), bundle }
}

/**
 * Whether an attempt's ticket was in sprint `id` in the revision the attempt ran under; a sprint an adoption renamed is
 * the one with the same ordinal, the way adoption maps the active sprint. Null when no plan the subject saw holds it.
 */
function sprintMatch(
  subject: Subject,
  id: string
): { ofAttempt: (attempt: AttemptRow) => boolean; inPlan: (plan: PlanBundle, sprint: SprintDef | undefined) => boolean } | null {
  const known = [subject.currentBundle, ...subject.attempts.map((attempt) => subject.bundle(attempt.revision_id))]
  const ordinal = known.flatMap((plan) => plan.sprints).find((sprint) => sprint.id === id)?.ordinal
  if (ordinal === undefined) {
    return null
  }
  const inPlan = (plan: PlanBundle, sprint: SprintDef | undefined): boolean =>
    sprint !== undefined && (sprint.id === id || (sprint.ordinal === ordinal && !plan.sprints.some((item) => item.id === id)))
  return {
    inPlan,
    ofAttempt: (attempt) => {
      const plan = subject.bundle(attempt.revision_id)
      return inPlan(plan, sprintHolding(plan, attempt.ticket_id))
    }
  }
}

/**
 * A ticket's scope is frozen with its sprint's: by the first work claim of the sprint that held the ticket at its own
 * first claim, when that claim's plan already held the ticket there. A ticket added to the sprint later is frozen by
 * its own first claim.
 */
function ticketFreezer(subject: Subject): AttemptRow | undefined {
  const own = subject.attempts.find((attempt) => attempt.kind === 'work' && attempt.ticket_id === subject.id)
  if (own === undefined) {
    return undefined
  }
  const sprintId = sprintHolding(subject.bundle(own.revision_id), subject.id)?.id
  const match = sprintId === undefined ? null : sprintMatch(subject, sprintId)
  const first = match === null ? undefined : subject.attempts.find((attempt) => attempt.kind === 'work' && match.ofAttempt(attempt))
  if (first === undefined || match === null) {
    return own
  }
  const plan = subject.bundle(first.revision_id)
  return match.inPlan(plan, sprintHolding(plan, subject.id)) ? first : own
}

function firstWork(subject: Subject, holds: (attempt: AttemptRow) => boolean): AttemptRow | undefined {
  return subject.attempts.find((attempt) => attempt.kind === 'work' && holds(attempt))
}

function ticketRules(subject: Subject): SubjectRules {
  const { id, run } = subject
  if (!subject.attempts.some((attempt) => attempt.ticket_id === id) && !subject.currentBundle.tickets.some((ticket) => ticket.id === id)) {
    fail('not_found', `Ticket ${id} is not in run ${run?.id}.`, { ticketId: id })
  }
  return {
    holds: (attempt) => attempt.ticket_id === id,
    covers: (observation) => observation.scope.ticketId === id && (observation.scope.runId === null || observation.scope.runId === run?.id),
    ticketsIn: () => null,
    freezer: () => ticketFreezer(subject)
  }
}

function sprintRules(subject: Subject): SubjectRules {
  const { id, run } = subject
  const match = sprintMatch(subject, id) ?? fail('not_found', `Sprint ${id} is not in run ${run?.id}.`, { sprintId: id })
  const ticketsIn = (plan: PlanBundle): TicketContent[] => {
    const sprint = plan.sprints.find((item) => match.inPlan(plan, item))
    return plan.tickets.filter((ticket) => sprint?.ticketIds.includes(ticket.id) === true)
  }
  // A ticket-level record that names no sprint counts for the sprint holding its ticket.
  const tickets = new Set([...subject.attempts.filter(match.ofAttempt).map((attempt) => attempt.ticket_id), ...ticketsIn(subject.currentBundle).map((ticket) => ticket.id)])
  return {
    holds: match.ofAttempt,
    covers: ({ scope }) =>
      (scope.runId === null || scope.runId === run?.id) && (scope.sprintId === id || (scope.sprintId === null && scope.ticketId !== null && tickets.has(scope.ticketId))),
    ticketsIn,
    freezer: () => firstWork(subject, match.ofAttempt)
  }
}

function runRules(subject: Subject): SubjectRules {
  // A record that names no run counts for the run when its ticket ran in it or is in its plan, or its sprint is.
  const tickets = new Set([...subject.attempts.map((attempt) => attempt.ticket_id), ...subject.currentBundle.tickets.map((ticket) => ticket.id)])
  const sprints = new Set(subject.currentBundle.sprints.map((sprint) => sprint.id))
  const unrun = (scope: MetricScope): boolean => (scope.ticketId === null ? scope.sprintId !== null && sprints.has(scope.sprintId) : tickets.has(scope.ticketId))
  return {
    holds: () => true,
    covers: ({ scope }) => scope.runId === subject.run?.id || (scope.runId === null && unrun(scope)),
    ticketsIn: (plan) => plan.tickets,
    freezer: () => firstWork(subject, () => true)
  }
}

const SUBJECT_RULES: Readonly<Record<GradeSubjectLevel, (subject: Subject) => SubjectRules>> = {
  ticket: ticketRules,
  sprint: sprintRules,
  run: runRules,
  epic: (subject) => ({ holds: () => true, covers: () => true, ticketsIn: (plan) => plan.tickets, freezer: () => firstWork(subject, () => true) })
}

// ---------------------------------------------------------------------------------------------------------------
// S

/** What this machine can verify about a person's entry: its own machine id and its own desktop sessions. */
interface LocalRecorder {
  machineId: string
  isDesktopSession(sessionId: string): boolean
}

/**
 * Where a person's entry was recorded, from the desktop session and machine `recordHumanFeedback` stores with it. The
 * attributes travel in portable files anyone can copy, so `this_machine` needs proof only this machine holds: the
 * session is one of its own desktop sessions (the sessions table never leaves the machine). An entry claiming this
 * machine without such a session is `unattested`; another machine's claim cannot be verified here and reads as such.
 */
function provenanceOf(observation: MetricObservation, here: LocalRecorder): FeedbackProvenance {
  const { desktopSession, machine } = observation.attributes
  const session = typeof desktopSession === 'string' ? desktopSession : null
  const recordedOn = typeof machine === 'string' ? machine : null
  const recorded = { desktopSession: session, machine: recordedOn }
  if (session === null || recordedOn === null) {
    return { origin: 'unattested', ...recorded }
  }
  if (recordedOn !== here.machineId) {
    return { origin: 'other_machine', ...recorded }
  }
  return { origin: here.isDesktopSession(session) ? 'this_machine' : 'unattested', ...recorded }
}

function feedbackEntry(observation: MetricObservation, here: LocalRecorder): HumanFeedbackEntry {
  const { sharedWithTickets: shared, activity } = observation.attributes
  return {
    observationId: observation.observationId,
    person: observation.source.actor ?? '',
    recordedAt: observation.recordedAt,
    scope: observation.scope,
    value: observation.measurement.state === 'missing' ? null : observation.measurement.value,
    sharedWithTickets: typeof shared === 'boolean' ? shared : null,
    intervention: observation.intervention ?? null,
    cause: observation.cause ?? null,
    activity: activity === 'review' || activity === 'playtest' ? activity : null,
    recordedBy: provenanceOf(observation, here)
  }
}

/**
 * The sprint whose rating the subject may use: a sprint's own; a ticket's sprint when it was first dispatched (else
 * now); for a run or epic, which has no rating of its own in policy v1, its only sprint, else none.
 */
function ratedSprint(read: Read): string | null {
  if (read.level === 'sprint') {
    return read.id
  }
  if (read.level === 'ticket') {
    const first = read.attempts.find((attempt) => attempt.ticket_id === read.id)
    return sprintHolding(first === undefined ? read.currentBundle : read.bundle(first.revision_id), read.id)?.id ?? null
  }
  const sprints = read.currentBundle.sprints
  return sprints.length === 1 ? (sprints[0]?.id ?? null) : null
}

function sprintRatingUse(read: Read, rating: SatisfactionInput['sprintRating']): SatisfactionSignal['sprintRatingUse'] {
  if (rating === null) {
    return 'none'
  }
  if (read.level === 'sprint') {
    return 'own'
  }
  return rating.sharedWithTickets ? 'inherited' : 'not_shared'
}

function satisfaction(read: Read, observations: readonly MetricObservation[], here: LocalRecorder): SatisfactionSignal {
  const human = observations.filter((item) => item.source.kind === 'human')
  // A rating always has a value; rescue and planned review entries may say their time was not given.
  const ratings = human.filter((item) => item.metric === 'human_rating' && item.measurement.state !== 'missing')
  const own = read.level === 'ticket' ? ratings.filter((item) => item.scope.level === 'ticket' && read.covers(item)) : []
  const sprintId = ratedSprint(read)
  const sprint = ratings.filter((item) => item.scope.level === 'sprint' && sprintId !== null && item.scope.sprintId === sprintId)
  // Corrections are new entries: the latest per scope counts.
  const ticketRating = own.at(-1)
  const sprintRating = sprint.at(-1)
  const input: SatisfactionInput = {
    ticketRating: ticketRating === undefined ? null : { observationId: ticketRating.observationId, source: 'human', value: valueOf(ticketRating) },
    sprintRating:
      sprintRating === undefined
        ? null
        : { observationId: sprintRating.observationId, source: 'human', value: valueOf(sprintRating), sharedWithTickets: sprintRating.attributes.sharedWithTickets === true }
  }
  const rescue = human.filter((item) => item.metric === 'rescue_minutes' && read.covers(item))
  const plannedReview = human.filter((item) => item.metric === 'human_review_minutes' && read.covers(item))
  return {
    input,
    sprintRatingUse: sprintRatingUse(read, input.sprintRating),
    ratings: [...sprint, ...own]
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.observationId.localeCompare(b.observationId))
      .map((item) => feedbackEntry(item, here)),
    rescue: rescue.map((item) => feedbackEntry(item, here)),
    // An entry without minutes adds nothing here (valueOf reads missing as 0 only to sum); it is counted apart.
    rescueMinutes: rescue.reduce((sum, item) => sum + valueOf(item), 0),
    plannedReview: plannedReview.map((item) => feedbackEntry(item, here)),
    plannedReviewMinutes: plannedReview.reduce((sum, item) => sum + valueOf(item), 0),
    entriesWithoutMinutes: [...rescue, ...plannedReview].filter((item) => item.measurement.state === 'missing').length
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A

/**
 * The ticket's accepted work attempt that stands at the cutoff: decided by then and not superseded by then. A ticket
 * the subject carried forward was accepted in an earlier run, so its acceptance is looked up across the epic.
 */
function acceptedBy(read: Read, ticketId: string): AttemptRow | undefined {
  const { cutoff } = read
  const forwarded = read.attempts.some((attempt) => attempt.kind === 'carry_forward' && attempt.ticket_id === ticketId)
  return (forwarded ? read.epicAttempts : read.attempts)
    .filter(
      (attempt) =>
        attempt.ticket_id === ticketId &&
        attempt.kind === 'work' &&
        attempt.state === 'accepted' &&
        attempt.decided_at !== null &&
        attempt.decided_at <= cutoff &&
        (attempt.superseded_at === null || attempt.superseded_at > cutoff)
    )
    .at(-1)
}

/**
 * A criterion is the same deliverable only with the same id and the same text, compared ignoring case and runs of
 * whitespace: a casing or spacing edit is not new scope, substantive rewording is.
 */
function criterionKey(ticketId: string, criterion: { id: string; text: string }): string {
  return `${ticketId}#${criterion.id}\u0000${criterion.text.trim().replace(/\s+/g, ' ').toLowerCase()}`
}

/**
 * A ticket's criteria as scope items; delivered when the standing acceptance verified that very criterion met,
 * otherwise with the reason: no acceptance, a criterion the acceptance held but did not verify, or one it no longer
 * held (reworded or removed).
 */
function criterionItems(read: Read, ticket: TicketContent | undefined): Map<string, ScopeItem> {
  if (ticket === undefined) {
    return new Map()
  }
  const accepted = acceptedBy(read, ticket.id)
  const acceptedCriteria = accepted === undefined ? [] : (read.bundle(accepted.revision_id).tickets.find((item) => item.id === ticket.id)?.acceptanceCriteria ?? [])
  const met = new Set(parseJson<AttemptEvidence>(accepted?.evidence_json, EMPTY_EVIDENCE).criteria.filter((item) => item.met).map((item) => item.criterionId))
  const held = new Set(acceptedCriteria.map((item) => criterionKey(ticket.id, item)))
  const verified = new Set(acceptedCriteria.filter((item) => met.has(item.id)).map((item) => criterionKey(ticket.id, item)))
  return new Map(
    ticket.acceptanceCriteria.map((criterion) => {
      const key = criterionKey(ticket.id, criterion)
      const delivered = verified.has(key)
      const undelivered: UndeliveredReason | null = delivered
        ? null
        : accepted === undefined
          ? { reason: 'not_accepted', criteria: [] }
          : { reason: 'criteria_unverified', criteria: [{ criterionId: criterion.id, cause: held.has(key) ? 'not_met' : 'changed' }] }
      return [key, { id: `${ticket.id}#${criterion.id}`, label: criterion.text, delivered, undelivered }]
    })
  )
}

/**
 * Tags that mark a work ticket as overhead rather than a feature outcome: administrative work, and Fireguard's grading
 * of the epic's tests. Like acceptance nodes, such tickets are not committed scope of a sprint, run or epic (A); their
 * outcome still counts as a required outcome (P) and their cost as overhead (T, K). Compared ignoring case.
 */
const OVERHEAD_TICKET_TAGS = ['administrative', 'fireguard', 'overhead'] as const

/** Whether a ticket is overhead: a sprint acceptance node, or a work ticket tagged as administrative or Fireguard work. */
export function isOverheadTicket(ticket: Pick<TicketContent, 'kind' | 'tags'>): boolean {
  return isAcceptanceTicket(ticket) || ticket.tags.some((tag) => (OVERHEAD_TICKET_TAGS as readonly string[]).includes(tag.toLowerCase()))
}

/**
 * The scope a plan holds for the subject: a ticket's criteria, or the work tickets of a sprint, run or epic. A ticket
 * counts as delivered only when its standing acceptance verified every criterion it holds in this plan (same id and
 * text, ignoring case and spacing), so trimming a ticket's criteria after dispatch cannot make it delivered. An
 * undelivered ticket names why: no acceptance, or the criteria its acceptance did not verify. Overhead tickets
 * (acceptance nodes, administrative and Fireguard work) and optional tickets are not feature outcomes.
 */
function scopeOf(read: Read, plan: PlanBundle, carried: ReadonlySet<string>): Map<string, ScopeItem> {
  const tickets = read.ticketsIn(plan)
  if (tickets === null) {
    return criterionItems(read, plan.tickets.find((ticket) => ticket.id === read.id))
  }
  return new Map(
    tickets
      .filter((ticket) => !isOverheadTicket(ticket) && ticket.optional !== true && !carried.has(ticket.id))
      .map((ticket) => {
        const accepted = acceptedBy(read, ticket.id) !== undefined
        const unverified = [...criterionItems(read, ticket).values()].flatMap((item) => item.undelivered?.criteria ?? [])
        const delivered = accepted && unverified.length === 0
        const undelivered: UndeliveredReason | null = delivered
          ? null
          : accepted
            ? { reason: 'criteria_unverified', criteria: unverified }
            : { reason: 'not_accepted', criteria: [] }
        return [ticket.id, { id: ticket.id, label: `${ticket.key} ${ticket.title}`, delivered, undelivered }]
      })
  )
}

/**
 * Tickets the subject took as already done: carried forward before its scope was frozen, with no work attempt of its
 * own. A ticket the subject also worked on, or carried forward only after the first claim, stays committed.
 */
function carriedTickets(read: Read, work: readonly AttemptRow[], freezer: AttemptRow | undefined): Set<string> {
  const worked = new Set(work.map((attempt) => attempt.ticket_id))
  return new Set(
    read.attempts
      .filter((attempt) => attempt.kind === 'carry_forward' && read.holds(attempt) && !worked.has(attempt.ticket_id))
      .filter((attempt) => freezer === undefined || attempt.created_at <= freezer.created_at)
      .map((attempt) => attempt.ticket_id)
  )
}

/** Activity volume beside A (never scored) and the standing acceptances A's delivered items rest on. */
function deliveryEvidence(read: Read, work: readonly AttemptRow[], committed: readonly ScopeItem[]): Pick<DeliveryInput, 'activity' | 'evidence'> {
  const submitted = work.filter((attempt) => attempt.submitted_at !== null && attempt.submitted_at <= read.cutoff)
  const commits = new Set(submitted.flatMap((attempt) => parseJson<AttemptOutputs>(attempt.outputs_json, EMPTY_OUTPUTS).commits))
  const ticketIds = read.level === 'ticket' ? [read.id] : committed.map((item) => item.id)
  const accepted = ticketIds.map((ticketId) => acceptedBy(read, ticketId)).filter((attempt) => attempt !== undefined)
  return {
    activity: { attempts: work.length, commits: commits.size, changedLines: null },
    evidence: accepted.map((attempt): EvidenceRef => ({ kind: 'attempt', id: attempt.id, detail: 'accepted' }))
  }
}

function delivery(read: Read): DeliverySignal {
  const work = read.attempts.filter((attempt) => attempt.kind === 'work' && read.holds(attempt))
  const freezer = read.freezer()
  const carried = carriedTickets(read, work, freezer)
  const current = scopeOf(read, read.currentBundle, carried)
  // Before the first dispatch nothing is frozen, so nothing is committed, removed or added yet.
  const frozen = freezer === undefined ? current : scopeOf(read, read.bundle(freezer.revision_id), carried)
  const committed = freezer === undefined ? [] : [...frozen.values()]
  const removed = [...frozen].filter(([key]) => !current.has(key)).map(([, item]) => item)
  const added = [...current].filter(([key]) => !frozen.has(key)).map(([, item]) => item)
  return {
    input: {
      committed: freezer === undefined ? null : committed.length,
      delivered: committed.filter((item) => item.delivered).length,
      added: added.length,
      removed: removed.length,
      ...deliveryEvidence(read, work, committed)
    },
    frozenRevisionId: freezer?.revision_id ?? null,
    frozenAt: freezer?.created_at ?? null,
    dispatchedAt: work.at(0)?.created_at ?? null,
    currentRevisionId: read.currentRevisionId,
    committed,
    removed,
    added,
    carriedForward: [...carried]
  }
}

// ---------------------------------------------------------------------------------------------------------------
// C

type FailedCheck = Extract<CollaborationDeduction, { kind: 'failed_handoff_check' }>

function reviewOf(attempt: AttemptRow, cutoff: string): FailedCheck['review'] {
  if (attempt.decided_at === null || attempt.decided_at > cutoff) {
    return null
  }
  const decision = parseJson<AttemptDecision | null>(attempt.decision_json, null)
  return decision === null ? null : { outcome: decision.outcome, decidedBy: decision.decidedBy, decidedAt: attempt.decided_at }
}

/** The missing items a check stored (a JSON list of whole items), never a cut one. */
function storedMissing(check: MetricObservation): string[] {
  try {
    const parsed: unknown = JSON.parse(String(check.attributes.missing ?? '[]'))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function failedCheck(attempt: AttemptRow, check: MetricObservation, cutoff: string): FailedCheck {
  const missing = storedMissing(check)
  const count = check.attributes.missingCount
  return {
    kind: 'failed_handoff_check',
    observationId: check.observationId,
    attemptId: attempt.id,
    check: String(check.attributes.check ?? ''),
    missing,
    missingCount: typeof count === 'number' ? count : missing.length,
    review: reviewOf(attempt, cutoff),
    evidence: [{ kind: 'observation', id: check.observationId, detail: null }, ...check.evidence]
  }
}

/** The server's handoff checks of each submission, by attempt, in `HANDOFF_CHECKS` order. */
function checksByAttempt(observations: readonly MetricObservation[]): Map<string, MetricObservation[]> {
  const checks = new Map<string, MetricObservation[]>()
  for (const item of observations) {
    const attemptId = item.scope.attemptId
    if (item.metric === 'handoff_check' && item.source.kind === 'server' && attemptId !== null) {
      checks.set(attemptId, [...(checks.get(attemptId) ?? []), item])
    }
  }
  const rank = (item: MetricObservation): number => HANDOFF_CHECKS.indexOf(item.attributes.check as HandoffCheckName)
  for (const list of checks.values()) {
    list.sort((a, b) => rank(a) - rank(b))
  }
  return checks
}

/** What C's read collects across submissions. */
interface CollaborationTally {
  tally: { passed: number; failed: number }
  rejected: { submissions: number; passedChecks: number }
  deductions: CollaborationDeduction[]
  evidence: EvidenceRef[]
}

/** One submission's derived checks, as found, and (when the review rejected it by the cutoff) the rejection. */
function tallySubmission(into: CollaborationTally, attempt: AttemptRow, own: readonly MetricObservation[], cutoff: string): void {
  for (const check of own) {
    const passed = valueOf(check) === 1
    into.tally[passed ? 'passed' : 'failed'] += 1
    into.evidence.push({ kind: 'observation', id: check.observationId, detail: String(check.attributes.check ?? '') })
    if (!passed) into.deductions.push(failedCheck(attempt, check, cutoff))
  }
  const review = reviewOf(attempt, cutoff)
  if (review?.outcome !== 'rejected' || own.length === 0) return
  const passedChecks = own.filter((check) => valueOf(check) === 1).length
  into.rejected.submissions += 1
  into.rejected.passedChecks += passedChecks
  const reference: EvidenceRef = { kind: 'attempt', id: attempt.id, detail: 'rejected' }
  into.evidence.push(reference)
  into.deductions.push({ kind: 'rejected_submission', attemptId: attempt.id, checks: passedChecks, decidedBy: review.decidedBy, decidedAt: review.decidedAt, evidence: [reference] })
}

/**
 * C's tally: each derived check as it found, plus the submissions the review rejected by the cutoff and how many
 * checks they passed on their own (`rejected`). The policy's C rule reads that: `C.handoff-pass-rate.v2` counts those
 * passed checks failed, so one more rejected attempt only ever adds failed checks and can never raise C.
 */
function collaboration(read: Read, observations: readonly MetricObservation[], checks: ReadonlyMap<string, MetricObservation[]>): Omit<CollaborationSignal, 'unchecked'> {
  const submissions = read.attempts.filter(
    (attempt) => attempt.kind === 'work' && read.holds(attempt) && attempt.submitted_at !== null && attempt.submitted_at <= read.cutoff
  )
  const collected: CollaborationTally = { tally: { passed: 0, failed: 0 }, rejected: { submissions: 0, passedChecks: 0 }, deductions: [], evidence: [] }
  for (const attempt of submissions) tallySubmission(collected, attempt, checks.get(attempt.id) ?? [], read.cutoff)
  const { tally, rejected, deductions, evidence } = collected
  const defects = observations.filter((item) => item.metric === 'coordination_defect' && item.measurement.state !== 'missing' && read.covers(item))
  for (const defect of defects) {
    evidence.push({ kind: 'observation', id: defect.observationId, detail: 'coordination defect' })
    deductions.push({ kind: 'coordination_defect', observationId: defect.observationId, count: valueOf(defect), reportedBy: defect.source.actor, evidence: defect.evidence })
  }
  const unchecked = submissions.filter((attempt) => !checks.has(attempt.id)).map((attempt) => attempt.id)
  // No submission: no handoff happened (zero checks). A submission without derived checks (recorded before they
  // existed, or not yet imported) is an unavailable observation: C is not reported rather than guessed.
  const handoffChecks = unchecked.length > 0 ? null : tally
  return {
    input: {
      handoffChecks,
      ...(handoffChecks !== null && rejected.submissions > 0 ? { rejected } : {}),
      coordinationDefects: defects.reduce((sum, item) => sum + valueOf(item), 0),
      evidence
    },
    submissions: submissions.length,
    uncheckedSubmissions: unchecked,
    deductions,
    clarifications: observations.filter((item) => item.intervention === 'clarification' && read.covers(item)).length
  }
}

/** Why each unchecked submission has no checks: the refusal this machine logged when it arrived, or none logged. */
function uncheckedReasons(ctx: Ctx, epicId: string, attemptIds: readonly string[]): UncheckedSubmission[] {
  if (attemptIds.length === 0) {
    return []
  }
  const refusals = new Map<string, { code: string; message: string }>()
  const logged = ctx.db.all<{ payload_json: string }>('SELECT payload_json FROM events WHERE kind = ? AND epic_id = ? ORDER BY seq', HANDOFF_CHECKS_REFUSED_EVENT, epicId)
  for (const row of logged) {
    const payload = parseJson<{ attemptId?: unknown; code?: unknown; message?: unknown }>(row.payload_json, {})
    if (typeof payload.attemptId === 'string') {
      refusals.set(payload.attemptId, { code: String(payload.code ?? 'internal'), message: String(payload.message ?? '') })
    }
  }
  return attemptIds.map((attemptId): UncheckedSubmission => {
    const refusal = refusals.get(attemptId)
    return refusal === undefined
      ? { attemptId, reason: 'not_recorded', code: null, detail: 'No handoff checks are stored for this submission and no refusal was logged on this machine: it was submitted before checks were derived, or brought in from another machine without them.' }
      : { attemptId, reason: 'checks_refused', code: refusal.code, detail: `The ledger refused the handoff checks when the submission arrived: ${refusal.message}` }
  })
}

/**
 * The S, A and C signals of a ticket or sprint (within a run), a run, or an epic (every run), from records stored by
 * the cutoff (now when absent; never later than now), each with the grader's input and the records behind it. Reads
 * of several subjects at one cutoff may share a `cache` (see `SignalsCache`).
 */
export function getSpaceSignals(ctx: Ctx, input: GetSpaceSignalsInput, cache: SignalsCache = signalsCache()): SpaceSignalsView {
  requireCapability(ctx.session, 'read')
  const subject = loadSubject(ctx, input, cache)
  const read: Read = { ...subject, ...SUBJECT_RULES[subject.level](subject) }
  const stored = cached(cache.observations, `${subject.epicId}\u0000${subject.cutoff}`, () => {
    const list = listObservations(ctx.db, { epicId: subject.epicId }).filter((item) => item.recordedAt <= subject.cutoff)
    return { list, checks: checksByAttempt(list) }
  })
  const handoffs = collaboration(read, stored.list, stored.checks)
  return {
    subject: { level: subject.level, id: subject.id },
    runId: subject.run?.id ?? null,
    epicId: subject.epicId,
    cutoff: subject.cutoff,
    S: satisfaction(read, stored.list, {
      machineId: ctx.machineId,
      isDesktopSession: (sessionId) => ctx.db.get("SELECT 1 FROM sessions WHERE id = ? AND role = 'desktop'", sessionId) !== undefined
    }),
    A: delivery(read),
    C: { ...handoffs, unchecked: uncheckedReasons(ctx, subject.epicId, handoffs.uncheckedSubmissions) }
  }
}
