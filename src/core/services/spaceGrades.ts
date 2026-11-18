/**
 * Balanced SPACE grades from Dark Mechanicus's own records, every one computed by `gradeSpace`.
 *
 * A ticket's input is assembled only from the server's read models, all read at one cutoff inside one transaction:
 * S, A and C from `getSpaceSignals` (ratings a person gave, scope frozen at dispatch, derived handoff checks); P from
 * the ticket's performance (independent review decisions and escaped defects); E, T and K from the run's efficiency
 * (classified effort, resource actuals with overhead, and the ticket's budget or cohort baseline). The dispatch time
 * comes from those reads' lifecycle records, never from a caller. Grading every ticket of a run loads the run's plans,
 * attempts, observations and lifecycle log once (`gradeRunTickets`), not once per ticket.
 *
 * A run's, sprint's or epic's input is recomputed from the raw measures of its scope, never by averaging ticket
 * letters or scores: S, A and C from `getSpaceSignals` at that level (A commits feature tickets only, so acceptance
 * nodes, administrative and Fireguard tickets never inflate delivery); E, T and K from the scope's efficiency, overhead
 * included; P from the scope's ticket outcomes, where a confirmed failure of any required or integrated outcome fails
 * P and caps the grade at F; and T and K against the roll-up of the baselines the scope's own ticket grades accepted
 * (budgets and cohorts are ticket-level only, and the grader refuses them at any other level). A ticket's role
 * (feature, overhead or optional) is frozen with the plan revision of its first dispatch, so a later adoption cannot
 * turn a failed required ticket optional; a sprint keeps the outcome a ticket had while it held it, even after an
 * adoption moved the ticket elsewhere.
 */
import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'
import type { RunEfficiencyView, ScopeEfficiencyView, TicketEfficiencyView } from '../../shared/domain/efficiency'
import type { PerformanceAssessmentInput, VerificationReason } from '../../shared/domain/performance'
import {
  BASELINE_UNITS,
  type BaselineMetric,
  type BaselineSelection,
  type EfficiencyInput,
  type EvidenceRef,
  type GradeSubject,
  type Measurement,
  type PerformanceInput,
  type RegressionInput,
  type ResourceInput,
  type RollupBaseline,
  type RollupMember,
  type SpaceGradeInput,
  type SpacePolicy,
  type VerificationState
} from '../../shared/domain/space'
import type { AggregateGradeView, GradeAssemblyAnomaly, OutcomeRole, RequiredOutcome, RollupView, TicketGradeView } from '../../shared/domain/spaceGrades'
import { requireCapability } from '../authz'
import { canonicalJson } from '../canonical'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { derivedStableId } from '../ids'
import { CURRENT_SPACE_POLICY, gradeSpace } from '../space/rubric'
import { outcomeEvidence } from '../space/snapshot'
import { getRunEfficiency, getTicketEfficiency, type OtherRunSources } from './efficiency'
import { type AttemptRow, loadBundle, requireRun, type RunRow } from './execution'
import { type AttemptFilter, cutoffOf, type PerformanceReader, ticketPerformanceReader } from './performance'
import { getSpaceSignals, isOverheadTicket, revisionAt, type SignalsCache, signalsCache } from './spaceSignals'

/** The earlier of two server times (the stricter one for the pre-dispatch baseline rule), ignoring absent ones. */
function earliest(a: string | null, b: string | null): string | null {
  if (a === null || b === null) {
    return a ?? b
  }
  return Date.parse(a) <= Date.parse(b) ? a : b
}

interface TicketSources {
  cache: SignalsCache
  performance: PerformanceReader
  policy: SpacePolicy
}

/** One ticket's grade from its signals, its performance and the efficiency view already read for its run. */
function ticketGradeOf(ctx: Ctx, input: { runId: string; ticketId: string; cutoff: string }, efficiency: TicketEfficiencyView, sources: TicketSources): TicketGradeView {
  const { runId, ticketId, cutoff } = input
  const signals = getSpaceSignals(ctx, { level: 'ticket', id: ticketId, runId, cutoff }, sources.cache)
  const performance = sources.performance(ticketId)
  const anomalies: GradeAssemblyAnomaly[] = []
  if (signals.A.dispatchedAt !== efficiency.dispatchedAt) {
    anomalies.push({
      kind: 'dispatch_mismatch',
      detail: `signals read the first dispatch at ${signals.A.dispatchedAt ?? 'none'}, efficiency at ${efficiency.dispatchedAt ?? 'none'}`
    })
  }
  const gradeInput: SpaceGradeInput = {
    subject: { level: 'ticket', id: ticketId },
    cutoff,
    dispatchedAt: earliest(signals.A.dispatchedAt, efficiency.dispatchedAt),
    components: {
      S: signals.S.input,
      P: performance.performance,
      A: signals.A.input,
      C: signals.C.input,
      E: efficiency.E,
      T: efficiency.T,
      K: efficiency.K
    }
  }
  return { runId, ticketId, cutoff, input: gradeInput, grade: gradeSpace(gradeInput, sources.policy), sources: { signals, performance, efficiency }, anomalies }
}

/** One ticket's grade in a run as of `cutoff` (default now, never later), with its input and sources. */
export function getTicketGrade(ctx: Ctx, input: { runId: string; ticketId: string; cutoff?: string }): TicketGradeView {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => {
    const cutoff = cutoffOf(ctx, input.cutoff)
    const efficiency = getTicketEfficiency(ctx, { runId: input.runId, ticketId: input.ticketId, cutoff })
    const sources = { cache: signalsCache(), performance: ticketPerformanceReader(ctx, input.runId, cutoff), policy: CURRENT_SPACE_POLICY }
    return ticketGradeOf(ctx, { runId: input.runId, ticketId: input.ticketId, cutoff }, efficiency, sources)
  })
}

// ---------------------------------------------------------------------------------------------------------------
// One run's ticket grades, read once for every level that rolls them up

/** A run graded ticket by ticket at one cutoff, with what its sprint and epic roll-ups read again. */
export interface RunGrading {
  run: RunRow
  cutoff: string
  policy: SpacePolicy
  efficiency: RunEfficiencyView
  tickets: TicketGradeView[]
  /** Each ticket's role, frozen with the plan revision of its first dispatch in the epic (else the run's plan). */
  roles: ReadonlyMap<string, OutcomeRole>
  /** Every attempt of the run created by the cutoff, oldest first. */
  attempts: readonly AttemptRow[]
  performance: PerformanceReader
  cache: SignalsCache
  bundle(revisionId: string): PlanBundle
}

function roleOf(ticket: TicketContent | undefined): OutcomeRole {
  if (ticket !== undefined && isOverheadTicket(ticket)) return 'integrated'
  return ticket?.optional === true ? 'optional' : 'work'
}

/**
 * Each ticket's role as the plan held it when the ticket was first dispatched in the epic: like A's committed scope,
 * an adoption after that (marking a failed required ticket optional, or retagging it overhead) never changes it. A
 * ticket not yet dispatched takes its role from the run's plan.
 */
function frozenRoles(ctx: Ctx, run: RunRow, cutoff: string, bundle: (revisionId: string) => PlanBundle): Map<string, OutcomeRole> {
  const roles = new Map<string, OutcomeRole>()
  const firsts = ctx.db.all<Pick<AttemptRow, 'ticket_id' | 'revision_id'>>(
    `SELECT a.ticket_id, a.revision_id FROM attempts a JOIN runs r ON r.id = a.run_id
     WHERE r.epic_id = ? AND a.kind = 'work' AND a.created_at <= ? ORDER BY a.created_at, a.number`,
    run.epic_id,
    cutoff
  )
  for (const first of firsts) {
    if (!roles.has(first.ticket_id)) roles.set(first.ticket_id, roleOf(bundle(first.revision_id).tickets.find((ticket) => ticket.id === first.ticket_id)))
  }
  for (const ticket of bundle(run.revision_id).tickets) {
    if (!roles.has(ticket.id)) roles.set(ticket.id, roleOf(ticket))
  }
  return roles
}

/**
 * Every ticket of a run graded at `cutoff`, with the run's efficiency, plans, attempts, observations and lifecycle log
 * read once for all of them. A ticket counts when the plan the run held at the cutoff holds it or it ran by then, so a
 * reading at an earlier cutoff never grades a ticket a later adoption added. Pass the same `cache` to grade several
 * runs of one epic at one cutoff, and the same `runSources` to build each other run's cohort source once across them.
 */
export function gradeRunTickets(
  ctx: Ctx,
  runId: string,
  cutoff: string,
  shared: { cache?: SignalsCache; policy?: SpacePolicy; runSources?: OtherRunSources } = {}
): RunGrading {
  const cache = shared.cache ?? signalsCache()
  const policy = shared.policy ?? CURRENT_SPACE_POLICY
  const run = requireRun(ctx, runId)
  const efficiency = getRunEfficiency(ctx, { runId, cutoff }, shared.runSources)
  const performance = ticketPerformanceReader(ctx, runId, efficiency.cutoff)
  const bundle = (revisionId: string): PlanBundle => {
    const held = cache.bundles.get(revisionId) ?? loadBundle(ctx, revisionId)
    cache.bundles.set(revisionId, held)
    return held
  }
  const attempts = ctx.db.all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ? AND created_at <= ? ORDER BY created_at, number', runId, efficiency.cutoff)
  const held = new Set([...bundle(revisionAt(ctx, run, efficiency.cutoff)).tickets.map((ticket) => ticket.id), ...attempts.map((row) => row.ticket_id)])
  const sources = { cache, performance, policy }
  const tickets = efficiency.tickets.flatMap((ticket) =>
    ticket.scope.level === 'ticket' && held.has(ticket.scope.ticketId)
      ? [ticketGradeOf(ctx, { runId, ticketId: ticket.scope.ticketId, cutoff: efficiency.cutoff }, ticket, sources)]
      : []
  )
  return { run, cutoff: efficiency.cutoff, policy, efficiency, tickets, roles: frozenRoles(ctx, run, efficiency.cutoff, bundle), attempts, performance, cache, bundle }
}

// ---------------------------------------------------------------------------------------------------------------
// Outcomes

/** One ticket's place in an aggregate: its outcome there, and the performance read it came from. */
interface OutcomeEntry {
  outcome: RequiredOutcome
  performance: PerformanceAssessmentInput
}

/**
 * Work outcomes without reviewed evidence or a confirmed failure (accepted without reviewed evidence, or out of tries
 * as far as records without the run's retry grants show): they leave the aggregate's verification missing.
 */
const EVIDENCE_GAPS: Partial<Record<VerificationReason, true>> = {
  legacy_review_basis_unknown: true,
  worker_claims_only: true,
  required_evidence_missing: true,
  retry_grants_unknown: true
}

function outcomeOf(runId: string, performance: PerformanceAssessmentInput, role: OutcomeRole, movedOut: boolean): OutcomeEntry {
  const { state, reason, attemptId, ticketId } = performance.verification
  const counted =
    role === 'integrated' ? reason !== 'carried_forward' : role === 'work' && (state !== 'missing' || EVIDENCE_GAPS[reason] === true)
  return { outcome: { runId, ticketId, role, state, reason, attemptId, movedOut, counted }, performance }
}

/**
 * Whether an outcome is the ticket's own in its run: not carried forward from an earlier run, and not a run that ended
 * (or has not yet dispatched it) without any attempt of it. A run with no outcome of its own for a ticket never
 * supersedes an earlier run's.
 */
function ownOutcome(outcome: RequiredOutcome): boolean {
  return outcome.reason !== 'carried_forward' && outcome.attemptId !== null
}

/** The rank of an outcome when several runs hold the ticket: an own decided one first, then an own undecided one. */
function standingRank(outcome: RequiredOutcome): number {
  if (!ownOutcome(outcome)) return 0
  return outcome.reason === 'run_ended' ? 1 : 2
}

/**
 * Each ticket's outcome in an epic counts once: from the last run where it had an own outcome that ended in a
 * decision or is still under way, else the last run where it ran at all, else the last run that held it. A run that
 * ended without an attempt of the ticket, a carried-forward record or a run that ended mid-attempt therefore never
 * erases an earlier run's failure. The others are listed, not counted.
 */
function standing(entries: readonly OutcomeEntry[]): OutcomeEntry[] {
  const best = new Map<string, number>()
  entries.forEach((entry, index) => {
    const held = best.get(entry.outcome.ticketId)
    const heldEntry = held === undefined ? undefined : entries[held]
    if (heldEntry === undefined || standingRank(entry.outcome) >= standingRank(heldEntry.outcome)) best.set(entry.outcome.ticketId, index)
  })
  return entries.map((entry, index) => (best.get(entry.outcome.ticketId) === index ? entry : { ...entry, outcome: { ...entry.outcome, counted: false } }))
}

/** An integrated outcome not yet dispatched has not happened yet: it is pending, not missing. */
function effectiveState(outcome: RequiredOutcome): VerificationState {
  return outcome.role === 'integrated' && outcome.reason === 'no_attempt' ? 'pending' : outcome.state
}

function aggregateState(counted: readonly OutcomeEntry[]): VerificationState {
  const states = new Set(counted.map((entry) => effectiveState(entry.outcome)))
  if (states.has('failed')) return 'failed'
  if (states.has('pending')) return 'pending'
  return states.has('missing') || !states.has('verified') ? 'missing' : 'verified'
}

/**
 * The aggregate P input: failed when any counted outcome is confirmed failed (an integrated outcome or a required
 * ticket, however well the others scored), else pending while one is, else missing when one lacks reviewed evidence or
 * nothing was verified, else verified. Every counted outcome is cited; a failed one with its own evidence. Regressions
 * of every ticket in scope are charged once each (an attributed reading wins over an unassigned one).
 */
function aggregatePerformance(entries: readonly OutcomeEntry[]): PerformanceInput {
  const counted = entries.filter((entry) => entry.outcome.counted)
  const evidence: EvidenceRef[] = counted.flatMap(({ outcome, performance }) => [
    outcomeEvidence(outcome),
    ...(outcome.state === 'failed' ? performance.performance.verification.evidence : [])
  ])
  const regressions = new Map<string, RegressionInput>()
  for (const entry of entries.flatMap(({ performance }) => performance.performance.regressions)) {
    if (regressions.get(entry.observationId)?.attribution !== 'attributed') regressions.set(entry.observationId, entry)
  }
  return { verification: { state: aggregateState(counted), evidence }, regressions: [...regressions.values()] }
}

// ---------------------------------------------------------------------------------------------------------------
// E, T and K

/** One run's share of an aggregate: the scope's efficiency in that run, the ticket grades in scope and their outcomes. */
interface AggregatePart {
  grading: RunGrading
  scope: ScopeEfficiencyView
  tickets: TicketGradeView[]
  outcomes: OutcomeEntry[]
}

/** Whether any attempt ran in the part's scope: a run that never executed anything adds no measure, only its outcomes. */
const executed = (part: AggregatePart): boolean => part.scope.time.attempts > 0 || part.scope.tokens.attempts > 0

/** Measurements of several runs (or scopes) summed: missing when any is (its reason), estimated when any is. */
export function sumMeasurements(parts: readonly Measurement[]): Measurement {
  const absent = parts.find((part) => part.state === 'missing')
  if (absent !== undefined) return absent
  if (parts.length === 0) return { state: 'missing', reason: 'not_reported' }
  // No part is missing here; the guard only tells the types so.
  const known = parts.filter((part): part is Exclude<Measurement, { state: 'missing' }> => part.state !== 'missing')
  const value = known.reduce((sum, part) => sum + part.value, 0)
  const estimated = known.filter((part) => part.state === 'estimated').length
  return estimated === 0 ? { state: 'observed', value } : { state: 'estimated', value, method: `sum of ${parts.length} runs, ${estimated} estimated` }
}

function aggregateEfficiency(scopes: readonly ScopeEfficiencyView[]): EfficiencyInput {
  const only = scopes.length === 1 ? scopes[0] : undefined
  if (only !== undefined) return only.E
  const retries = scopes.map((scope) => scope.E.retries).filter((value) => value !== null)
  return {
    correctiveMs: sumMeasurements(scopes.map((scope) => scope.E.correctiveMs)),
    productiveMs: sumMeasurements(scopes.map((scope) => scope.E.productiveMs)),
    unclassifiedMs: sumMeasurements(scopes.map((scope) => scope.E.unclassifiedMs)),
    retries: retries.length === 0 ? null : retries.reduce((sum, value) => sum + value, 0),
    evidence: scopes.flatMap((scope) => scope.E.evidence)
  }
}

const RESOURCE_METRIC = { T: 'active_ms', K: 'tokens' } as const satisfies Record<'T' | 'K', BaselineMetric>

const resourceOf = (grade: TicketGradeView, component: 'T' | 'K') => (component === 'T' ? grade.sources.efficiency.time : grade.sources.efficiency.tokens)

/** The ticket baseline a ticket grade accepted for T or K, as a roll-up member; null when it accepted none. */
function memberOf(component: 'T' | 'K', runId: string, grade: TicketGradeView): RollupMember | null {
  const accepted = grade.grade.components.find((entry) => entry.component === component)?.inputs.baselineId ?? null
  const selection = grade.input.components[component].baseline
  const dispatchedAt = grade.input.dispatchedAt
  if (accepted === null || selection.state !== 'selected' || selection.baseline.baselineId !== accepted || selection.baseline.kind === 'rollup' || dispatchedAt === null) {
    return null
  }
  const { baselineId, kind, value, frozenAt } = selection.baseline
  return { runId, ticketId: grade.ticketId, baselineId, kind, value, frozenAt, dispatchedAt }
}

interface RollupTally {
  members: Map<string, RollupMember>
  uncovered: Map<string, { runId: string; ticketId: string }>
  overhead: Map<string, { runId: string; ticketId: string }>
}

/** Places one executed ticket of one run in the tally: a member (once), else overhead or uncovered until covered. */
function tallyTicket(tally: RollupTally, component: 'T' | 'K', part: AggregatePart, grade: TicketGradeView): void {
  const runId = part.grading.run.id
  const member = memberOf(component, runId, grade)
  const entry = { runId, ticketId: grade.ticketId }
  if (member !== null) {
    tally.members.set(grade.ticketId, member)
    tally.uncovered.delete(grade.ticketId)
    return
  }
  const into = part.grading.roles.get(grade.ticketId) === 'integrated' ? tally.overhead : tally.uncovered
  if (!into.has(grade.ticketId)) into.set(grade.ticketId, entry)
}

function tallyRollup(component: 'T' | 'K', parts: readonly AggregatePart[]): RollupTally {
  const tally: RollupTally = { members: new Map(), uncovered: new Map(), overhead: new Map() }
  for (const part of parts) {
    for (const grade of part.tickets.filter((ticket) => resourceOf(ticket, component).attempts > 0 && !tally.members.has(ticket.ticketId))) {
      tallyTicket(tally, component, part, grade)
    }
  }
  return tally
}

/**
 * The roll-up baseline T or K is offered: the baselines the scope's executed tickets' own grades accepted, each ticket
 * once (its first run's), summed, so restarting a run never buys a ticket a fresh allowance. An executed work ticket
 * whose grade accepted none is listed as uncovered and makes the roll-up partial; an executed overhead ticket without
 * one is overhead, whose cost stays in the actual.
 */
function rollupOf(component: 'T' | 'K', parts: readonly AggregatePart[]): RollupView {
  const metric = RESOURCE_METRIC[component]
  const tally = tallyRollup(component, parts)
  const members = [...tally.members.values()]
  const uncovered = [...tally.uncovered.values()]
  const overhead = [...tally.overhead.values()]
  if (members.length === 0) return { metric, baseline: null, uncovered, overhead, partial: false }
  const frozenAt = members.map((member) => member.frozenAt).reduce((latest, at) => (Date.parse(at) > Date.parse(latest) ? at : latest))
  return {
    metric,
    baseline: {
      baselineId: derivedStableId('baseline', canonicalJson({ rollup: metric, members, uncovered })),
      kind: 'rollup',
      metric,
      unit: BASELINE_UNITS[metric],
      value: members.reduce((sum, member) => sum + member.value, 0),
      version: 1,
      frozenAt,
      members,
      uncovered
    },
    uncovered,
    overhead,
    partial: uncovered.length > 0
  }
}

function selectionOf(rollup: RollupView): BaselineSelection {
  return rollup.baseline === null ? { state: 'missing', reason: 'no_eligible_baseline', rejected: [] } : { state: 'selected', baseline: rollup.baseline, rejected: [] }
}

/**
 * A partial roll-up's actual: the scope's actual (overhead included) less what the uncovered tickets themselves spent,
 * as an estimate, so the covered tickets are compared with their own baselines and the grade reads provisional.
 */
function partialActual(full: Measurement, component: 'T' | 'K', parts: readonly AggregatePart[], baseline: RollupBaseline): Measurement {
  if (full.state === 'missing') return full
  const uncovered = new Set(baseline.uncovered.map((entry) => entry.ticketId))
  const spent = sumMeasurements(parts.flatMap((part) => part.tickets.filter((grade) => uncovered.has(grade.ticketId)).map((grade) => resourceOf(grade, component).actual)))
  if (spent.state === 'missing') return spent
  const covered = baseline.members.length
  return {
    state: 'estimated',
    value: Math.max(0, full.value - spent.value),
    method: `partial roll-up: ${covered} of ${covered + uncovered.size} executed work tickets have a baseline; the ${uncovered.size} without one are left out of the actual`
  }
}

function aggregateResource(component: 'T' | 'K', parts: readonly AggregatePart[], rollup: RollupView): ResourceInput {
  const scopes = parts.map((part) => part.scope[component])
  const full = scopes.length === 1 && scopes[0] !== undefined ? scopes[0].actual : sumMeasurements(scopes.map((scope) => scope.actual))
  return {
    actual: rollup.partial && rollup.baseline !== null ? partialActual(full, component, parts, rollup.baseline) : full,
    unreportedAttempts: scopes.reduce((sum, scope) => sum + scope.unreportedAttempts, 0),
    baseline: selectionOf(rollup),
    evidence: scopes.flatMap((scope) => scope.evidence)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Aggregates

/**
 * A run, sprint or epic graded from its signals and the parts of its scope in each run. Runs that executed nothing
 * add their outcomes but no measures, so starting a run that never dispatched work leaves the epic's E, T and K as
 * they were. The measured window starts at the scope's first dispatch, or earlier when the scope carries the measures
 * of a ticket first dispatched before that: sprint totals follow the current plan, so a ticket an adoption moved into a
 * later sprint after it ran in an earlier one brings every attempt's cost with it, and its baseline is compared with
 * that cost from the ticket's own first dispatch instead of being refused as dispatched before the scope.
 */
function aggregateGrade(ctx: Ctx, subject: GradeSubject, cutoff: string, parts: readonly AggregatePart[]): AggregateGradeView {
  const first = parts[0]?.grading
  const runId = subject.level === 'epic' ? undefined : first?.run.id
  const cache = first?.cache ?? signalsCache()
  const policy = first?.policy ?? CURRENT_SPACE_POLICY
  const signals = getSpaceSignals(ctx, { level: subject.level, id: subject.id, cutoff, ...(runId === undefined ? {} : { runId }) }, cache)
  const entries = standing(parts.flatMap((part) => part.outcomes))
  const measured = parts.filter(executed)
  const measures = measured.length > 0 ? measured : parts.slice(-1)
  const rollups = { T: rollupOf('T', parts), K: rollupOf('K', parts) }
  const input: SpaceGradeInput = {
    subject,
    cutoff,
    dispatchedAt: parts.flatMap((part) => part.tickets).reduce((start, ticket) => earliest(start, ticket.input.dispatchedAt), signals.A.dispatchedAt),
    components: {
      S: signals.S.input,
      P: aggregatePerformance(entries),
      A: signals.A.input,
      C: signals.C.input,
      E: aggregateEfficiency(measures.map((part) => part.scope)),
      T: aggregateResource('T', measures, rollups.T),
      K: aggregateResource('K', measures, rollups.K)
    }
  }
  return {
    subject,
    runIds: parts.map((part) => part.grading.run.id),
    measuredRunIds: measures.map((part) => part.grading.run.id),
    cutoff,
    input,
    grade: gradeSpace(input, policy),
    outcomes: entries.map((entry) => entry.outcome),
    rollups,
    tickets: parts.flatMap((part) => part.tickets),
    sources: { signals, efficiency: measures.map((part) => part.scope) },
    anomalies: parts.flatMap((part) => part.tickets.flatMap((ticket) => ticket.anomalies))
  }
}

/** A sprint with no timing yet (never activated, nothing measured): every E, T and K measure is missing, never zero. */
function unmeasuredScope(sprintId: string): ScopeEfficiencyView {
  const missing: Measurement = { state: 'missing', reason: 'not_reported' }
  const resource = (metric: BaselineMetric) => ({
    metric,
    actual: missing,
    reportedValue: null,
    attempts: 0,
    unreportedAttemptIds: [],
    openAttemptIds: [],
    gaps: [],
    overheadValue: null,
    excludedWaitsMs: null
  })
  const noBaseline: BaselineSelection = { state: 'missing', reason: 'no_eligible_baseline', rejected: [] }
  return {
    scope: { level: 'sprint', sprintId },
    E: { correctiveMs: missing, productiveMs: missing, unclassifiedMs: missing, retries: null, evidence: [] },
    T: { actual: missing, unreportedAttempts: 0, baseline: noBaseline, evidence: [] },
    K: { actual: missing, unreportedAttempts: 0, baseline: noBaseline, evidence: [] },
    classification: {
      denominator: { effortMs: null, state: 'missing', coverage: { covered: 0, of: 0, unit: 'attempts' }, overheadMs: null },
      correctiveMs: null,
      productiveMs: null,
      unclassifiedMs: null,
      classificationCoverage: null,
      correctiveByCause: {},
      productiveByWork: {},
      observationIds: [],
      retries: { retries: null, attempts: [] }
    },
    time: resource('active_ms'),
    tokens: resource('tokens')
  }
}

/**
 * Whether a plan held the ticket in the sprint `sprintId` names: by id, or by the same ordinal in a plan that renamed
 * it (as adoption maps the active sprint).
 */
function sprintHolds(plan: PlanBundle, ticketId: string, sprintId: string, ordinal: number | undefined): boolean {
  const sprint = plan.sprints.find((entry) => entry.ticketIds.includes(ticketId))
  return sprint !== undefined && (sprint.id === sprintId || (sprint.ordinal === ordinal && !plan.sprints.some((entry) => entry.id === sprintId)))
}

/**
 * The tickets a sprint grade reads and their outcomes there: the sprint's tickets in the run's current plan, and every
 * ticket that ran while the sprint held it and has since been moved out by an adoption. Each outcome is read from the
 * attempts the ticket ran while this sprint held it, so a failure stays with the sprint that incurred it; a moved-out
 * ticket's later retry grants are not counted here, since they only enable attempts elsewhere.
 */
function sprintOutcomes(grading: RunGrading, sprintId: string, members: readonly TicketGradeView[]): OutcomeEntry[] {
  const ordinal = [grading.bundle(grading.run.revision_id), ...grading.attempts.map((row) => grading.bundle(row.revision_id))]
    .flatMap((plan) => plan.sprints)
    .find((sprint) => sprint.id === sprintId)?.ordinal
  const holds: AttemptFilter = (row, plan) => sprintHolds(plan, row.ticket_id, sprintId, ordinal)
  const memberIds = new Set(members.map((grade) => grade.ticketId))
  const ran = grading.attempts.filter((row) => row.kind === 'work' && holds(row, grading.bundle(row.revision_id)))
  // Each ticket that ran here with its last claim here (`ran` is oldest first, so later claims overwrite earlier ones).
  const lastRan = new Map(ran.map((row) => [row.ticket_id, row.created_at]))
  const movedOut = [...lastRan].filter(([ticketId]) => !memberIds.has(ticketId))
  const runId = grading.run.id
  const role = (ticketId: string): OutcomeRole => grading.roles.get(ticketId) ?? 'work'
  return [
    ...members.map((grade) => outcomeOf(runId, grading.performance(grade.ticketId, { holds }), role(grade.ticketId), false)),
    ...movedOut.map(([ticketId, last]) => outcomeOf(runId, grading.performance(ticketId, { holds, movedOut: { grantsUntil: last } }), role(ticketId), true))
  ]
}

/** The run's tickets the current plan holds in a sprint. */
function sprintMembers(grading: RunGrading, sprintId: string): TicketGradeView[] {
  return grading.tickets.filter((grade) => grade.sources.efficiency.scope.level === 'ticket' && grade.sources.efficiency.scope.sprintId === sprintId)
}

/**
 * Every ticket's outcomes over the whole run, sprint by sprint in plan order (a ticket an adoption moved keeps the
 * outcome it had in the sprint it left, beside its reading in the sprint that holds it now; `standing` counts the
 * later own one), then the tickets no sprint of the current plan holds, over all their attempts.
 */
function runOutcomes(grading: RunGrading): OutcomeEntry[] {
  const sprints = [...grading.bundle(grading.run.revision_id).sprints].sort((a, b) => a.ordinal - b.ordinal)
  const scoped = sprints.flatMap((sprint) => sprintOutcomes(grading, sprint.id, sprintMembers(grading, sprint.id)))
  const seen = new Set(scoped.map((entry) => entry.outcome.ticketId))
  const rest = grading.tickets
    .filter((grade) => !seen.has(grade.ticketId))
    .map((grade) => outcomeOf(grading.run.id, grade.sources.performance, grading.roles.get(grade.ticketId) ?? 'work', false))
  return [...scoped, ...rest]
}

/** The sprint's grade within an already graded run: its tickets by the run's current plan, its scope's efficiency. */
export function sprintAggregate(ctx: Ctx, grading: RunGrading, sprintId: string): AggregateGradeView {
  const scope = grading.efficiency.sprints.find((entry) => entry.scope.level === 'sprint' && entry.scope.sprintId === sprintId) ?? unmeasuredScope(sprintId)
  const tickets = sprintMembers(grading, sprintId)
  return aggregateGrade(ctx, { level: 'sprint', id: sprintId }, grading.cutoff, [{ grading, scope, tickets, outcomes: sprintOutcomes(grading, sprintId, tickets) }])
}

/** The run's grade from an already graded run. */
export function runAggregate(ctx: Ctx, grading: RunGrading): AggregateGradeView {
  return aggregateGrade(ctx, { level: 'run', id: grading.run.id }, grading.cutoff, [{ grading, scope: grading.efficiency.run, tickets: grading.tickets, outcomes: runOutcomes(grading) }])
}

/** The epic's runs created by the cutoff, oldest first (as `getSpaceSignals` reads them). */
export function epicRunIds(ctx: Ctx, epicId: string, cutoff: string): string[] {
  if (ctx.db.get('SELECT id FROM epics WHERE id = ?', epicId) === undefined) {
    fail('not_found', `Epic ${epicId} not found.`, { epicId })
  }
  return ctx.db.all<{ id: string }>('SELECT id FROM runs WHERE epic_id = ? AND created_at <= ? ORDER BY created_at, number', epicId, cutoff).map((row) => row.id)
}

/** The epic's grade across its runs, reusing any run already graded at the same cutoff (and its cache). */
export function epicAggregate(ctx: Ctx, epicId: string, cutoff: string, graded: readonly RunGrading[] = []): AggregateGradeView {
  const cache = graded[0]?.cache ?? signalsCache()
  const policy = graded[0]?.policy ?? CURRENT_SPACE_POLICY
  const parts = epicRunIds(ctx, epicId, cutoff).map((runId): AggregatePart => {
    const grading = graded.find((entry) => entry.run.id === runId) ?? gradeRunTickets(ctx, runId, cutoff, { cache, policy })
    return { grading, scope: grading.efficiency.run, tickets: grading.tickets, outcomes: runOutcomes(grading) }
  })
  return aggregateGrade(ctx, { level: 'epic', id: epicId }, cutoff, parts)
}

/** A sprint's grade in a run as of `cutoff` (default now, never later), recomputed from the sprint's own measures. */
export function getSprintGrade(ctx: Ctx, input: { runId: string; sprintId: string; cutoff?: string }): AggregateGradeView {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => sprintAggregate(ctx, gradeRunTickets(ctx, input.runId, cutoffOf(ctx, input.cutoff)), input.sprintId))
}

/** A run's grade as of `cutoff` (default now, never later), recomputed from the run's own measures. */
export function getRunGrade(ctx: Ctx, input: { runId: string; cutoff?: string }): AggregateGradeView {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => runAggregate(ctx, gradeRunTickets(ctx, input.runId, cutoffOf(ctx, input.cutoff))))
}

/** An epic's grade across its runs as of `cutoff` (default now, never later), recomputed from the epic's own measures. */
export function getEpicGrade(ctx: Ctx, input: { epicId: string; cutoff?: string }): AggregateGradeView {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => epicAggregate(ctx, input.epicId, cutoffOf(ctx, input.cutoff)))
}
