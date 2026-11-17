/**
 * The project metrics summary: one read model the Metrics dashboard and the MCP metrics tools share, so both show the
 * same numbers. It reads, never regrades:
 * - each epic's grade is `epicAggregate`'s at the cutoff, with its raw measures summed from the very scopes that grade
 *   summed (`sources.efficiency`, the runs that executed work), token categories from `getRunMetrics` of those runs and
 *   elapsed time from `projectRunTiming`;
 * - each sprint in the trend reads the scorecard frozen with its latest report revision (a legacy report stays
 *   ungraded), and only a sprint without a report reads its live `sprintAggregate` grade;
 * - project totals are recomputed from the raw measures of the epics that executed work (as the grader's own
 *   `measured` rule leaves out runs that executed nothing); letters and scores are never averaged.
 * Every run is graded once per read, and every other run's cohort source is built once for all of them (`runSources`).
 * A measure nobody reported is null with a reason, never zero.
 */
import type { PlanBundle } from '../../shared/domain/bundle'
import type { CorrectiveCause, ResourceActualView, ScopeEfficiencyView } from '../../shared/domain/efficiency'
import type { UsageMetric } from '../../shared/domain/metrics'
import type { EvidenceRef, GradeStatus, Measurement, MetricObservation, SpaceGrade } from '../../shared/domain/space'
import type { AggregateGradeView, FrozenResult, ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import type { WorkStatus } from '../../shared/domain/status'
import type { RunTiming } from '../../shared/domain/timing'
import type {
  GetMetricsSummaryInput,
  MetricsSummaryEpicRow,
  MetricsSummaryTotals,
  MetricsSummaryTrendEntry,
  MetricsSummaryView,
  SummaryComponentGap,
  SummaryCoverage,
  SummaryFailureGap,
  SummaryGrade,
  SummaryGradeStatus,
  SummaryMeasure,
  SummaryReworkGap,
  SummaryTicketRef,
  SummaryTime,
  SummaryTokens,
  TrendIncomparability,
  UnavailableField
} from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { CURRENT_SPACE_POLICY, policyRef } from '../space/rubric'
import type { OtherRunSources } from './efficiency'
import { loadBundle } from './execution'
import { getRunMetrics } from './metricReports'
import { listObservations, readingObservations } from './observations'
import { cutoffOf } from './performance'
import { epicAggregate, epicRunIds, gradeRunTickets, type RunGrading, sprintAggregate, sumMeasurements } from './spaceGrades'
import { type SignalsCache, signalsCache } from './spaceSignals'
import { projectRunTiming } from './timing'

const LOWEST_COMPONENTS = 10
const EVIDENCE_LIMIT = 20
/** A component's full score: a component scored at it is no gap. */
const MAX_COMPONENT_SCORE = 100

// ---------------------------------------------------------------------------------------------------------------
// Measures

const OBSERVED_ONLY = 'not reported'

function measureOf(measurement: Measurement, lowerBound: number | null = null): SummaryMeasure {
  if (measurement.state === 'missing') return { state: 'missing', value: null, reason: measurement.reason, lowerBound }
  return { state: measurement.state, value: measurement.value, reason: null, lowerBound: null }
}

function missing(reason: string, lowerBound: number | null = null): SummaryMeasure {
  return { state: 'missing', value: null, reason, lowerBound }
}

/** Back from a summary measure to a measurement, so totals are summed with the grader's own rule. */
function measurementOf(measure: SummaryMeasure): Measurement {
  if (measure.state === 'missing' || measure.value === null) return { state: 'missing', reason: 'not_reported' }
  return measure.state === 'estimated' ? { state: 'estimated', value: measure.value, method: 'summed estimate' } : { state: 'observed', value: measure.value }
}

/** Measures summed with `sumMeasurements`: missing keeps the first reason and the reported part as a lower bound. */
function summed(measures: readonly SummaryMeasure[], none: string): SummaryMeasure {
  if (measures.length === 0) return missing(none)
  const absent = measures.find((measure) => measure.state === 'missing')
  if (absent !== undefined) {
    const reported = measures.map((measure) => measure.value ?? measure.lowerBound).filter((value): value is number => value !== null)
    return missing(absent.reason ?? OBSERVED_ONLY, reported.length === 0 ? null : reported.reduce((sum, value) => sum + value, 0))
  }
  return measureOf(sumMeasurements(measures.map(measurementOf)))
}

function share(corrective: SummaryMeasure, productive: SummaryMeasure): SummaryMeasure {
  if (corrective.value === null) return missing(`corrective effort unknown: ${corrective.reason ?? OBSERVED_ONLY}`)
  if (productive.value === null) return missing(`productive effort unknown: ${productive.reason ?? OBSERVED_ONLY}`)
  const classified = corrective.value + productive.value
  if (classified === 0) return missing('no classified effort')
  const estimated = corrective.state === 'estimated' || productive.state === 'estimated'
  return { state: estimated ? 'estimated' : 'observed', value: corrective.value / classified, reason: null, lowerBound: null }
}

// ---------------------------------------------------------------------------------------------------------------
// One epic's raw measures

interface RawMeasures {
  tokens: SummaryTokens
  time: SummaryTime
  corrective: SummaryMeasure
  productive: SummaryMeasure
  coverage: SummaryCoverage
}

type Categories = Omit<SummaryTokens, 'total'>

const CATEGORY_METRICS = { input: 'tokens_input', cachedInput: 'tokens_cached_input', output: 'tokens_output', reasoning: 'tokens_reasoning' } as const satisfies Record<
  keyof Categories,
  UsageMetric
>

/** Whether a run holds a record or attempt stored after the cutoff, which its run metrics (read as stored now) would count. */
function changedSince(ctx: Ctx, runId: string, cutoff: string): boolean {
  const later = ctx.db.get(
    `SELECT 1 FROM metric_observations WHERE run_id = ? AND recorded_at > ?
     UNION ALL SELECT 1 FROM attempts WHERE run_id = ? AND created_at > ? LIMIT 1`,
    runId,
    cutoff,
    runId,
    cutoff
  )
  return later !== undefined
}

/**
 * The token categories of the runs whose measures the grade summed, from each run's totals (one `getRunMetrics` read
 * per run). Run metrics are read as stored now, so a run with records after the cutoff gives no category at it.
 */
function categoriesOf(ctx: Ctx, runIds: readonly string[], cutoff: string): Categories {
  const keys = Object.keys(CATEGORY_METRICS) as (keyof Categories)[]
  const all = (measure: SummaryMeasure): Categories => ({ input: measure, cachedInput: measure, output: measure, reasoning: measure })
  if (runIds.length === 0) return all(missing('no run'))
  if (runIds.some((runId) => changedSince(ctx, runId, cutoff))) {
    return all(missing('records stored after the cutoff: token categories are read as stored now and cannot be cut at it'))
  }
  const totals = runIds.map((runId) => getRunMetrics(ctx, { runId }).totals)
  const category = (metric: UsageMetric) =>
    summed(
      totals.flatMap((run) => run.filter((total) => total.metric === metric).map((total) => measureOf(total.measurement, total.reportedValue))),
      'no run'
    )
  return Object.fromEntries(keys.map((key) => [key, category(CATEGORY_METRICS[key])])) as Categories
}

/**
 * T's or K's actual as the grader reads it: an attempt that ran and reported nothing leaves the total partial
 * (`partial_telemetry`, the component missing), whatever the reported entries add up to.
 */
function resourceOf(actual: ResourceActualView): SummaryMeasure {
  const reported = actual.reportedValue ?? (actual.actual.state === 'missing' ? null : actual.actual.value)
  if (actual.unreportedAttemptIds.length > 0) return missing('partial_telemetry', reported)
  return measureOf(actual.actual, actual.reportedValue)
}

function waitsOf(scope: ScopeEfficiencyView): SummaryMeasure {
  const waits = scope.time.excludedWaitsMs
  if (waits === null) return missing('no wait was classified')
  return { state: 'observed', value: Object.values(waits).reduce((sum, value) => sum + value, 0), reason: null, lowerBound: null }
}

function effortOf(scope: ScopeEfficiencyView): SummaryMeasure {
  const { effortMs, state } = scope.classification.denominator
  if (effortMs === null || state === 'missing') return missing('no activity was reported')
  if (state === 'partial') return missing('partial_coverage', effortMs)
  return { state: state === 'estimated' ? 'estimated' : 'observed', value: effortMs, reason: null, lowerBound: null }
}

function elapsedOf(timings: readonly RunTiming[]): SummaryMeasure {
  return summed(
    timings.map((timing) => (timing.elapsed.ms === null ? missing('the run has no window') : { state: 'observed', value: timing.elapsed.ms, reason: null, lowerBound: null })),
    'no run'
  )
}

function coverageOf(scopes: readonly ScopeEfficiencyView[], effort: SummaryMeasure, corrective: SummaryMeasure, productive: SummaryMeasure): Omit<SummaryCoverage, 'unavailable'> {
  const classified = corrective.value !== null && productive.value !== null ? corrective.value + productive.value : null
  return {
    attempts: scopes.reduce((sum, scope) => sum + Math.max(scope.time.attempts, scope.tokens.attempts), 0),
    unreportedTokenAttempts: scopes.reduce((sum, scope) => sum + scope.tokens.unreportedAttemptIds.length, 0),
    unreportedTimeAttempts: scopes.reduce((sum, scope) => sum + scope.time.unreportedAttemptIds.length, 0),
    classificationCoverage: classified === null || effort.value === null || effort.value === 0 ? null : Math.min(1, classified / effort.value)
  }
}

function unavailableOf(entries: Record<string, SummaryMeasure>): UnavailableField[] {
  return Object.entries(entries).flatMap(([field, measure]) => (measure.state === 'missing' ? [{ field, reason: measure.reason ?? OBSERVED_ONLY }] : []))
}

function withUnavailable(raw: Omit<RawMeasures, 'coverage'> & { coverage: Omit<SummaryCoverage, 'unavailable'> }, share: SummaryMeasure): SummaryCoverage {
  const { tokens, time } = raw
  return {
    ...raw.coverage,
    unavailable: unavailableOf({
      'tokens.input': tokens.input,
      'tokens.cachedInput': tokens.cachedInput,
      'tokens.output': tokens.output,
      'tokens.reasoning': tokens.reasoning,
      'tokens.total': tokens.total,
      'time.elapsedMs': time.elapsedMs,
      'time.activeMs': time.activeMs,
      'time.waitingMs': time.waitingMs,
      'time.effortMs': time.effortMs,
      correctiveShare: share
    })
  }
}

/** The epic's raw measures from exactly the scopes (and runs) its grade summed. */
function rawMeasures(ctx: Ctx, view: AggregateGradeView, timings: readonly RunTiming[]): RawMeasures {
  const scopes = view.sources.efficiency
  const none = 'no run executed work'
  const tokens: SummaryTokens = {
    ...categoriesOf(ctx, view.measuredRunIds, view.cutoff),
    total: summed(
      scopes.map((scope) => resourceOf(scope.tokens)),
      none
    )
  }
  const time: SummaryTime = {
    elapsedMs: elapsedOf(timings),
    activeMs: summed(
      scopes.map((scope) => resourceOf(scope.time)),
      none
    ),
    waitingMs: summed(scopes.map(waitsOf), none),
    effortMs: summed(scopes.map(effortOf), none)
  }
  const corrective = summed(
    scopes.map((scope) => measureOf(scope.E.correctiveMs)),
    none
  )
  const productive = summed(
    scopes.map((scope) => measureOf(scope.E.productiveMs)),
    none
  )
  const coverage = coverageOf(scopes, time.effortMs, corrective, productive)
  return { tokens, time, corrective, productive, coverage: withUnavailable({ tokens, time, corrective, productive, coverage }, share(corrective, productive)) }
}

// ---------------------------------------------------------------------------------------------------------------
// Grades as read

function rowStatus(grade: { status: GradeStatus; outcome: string }, running: boolean): SummaryGradeStatus {
  if (grade.outcome === 'failed') return 'failed'
  return running ? 'in_progress' : grade.status
}

function liveGrade(grade: SpaceGrade, running: boolean): SummaryGrade {
  const { status, outcome, statusReasons, score, displayScore, letter, coverage, inputHash, policy } = grade
  return { status: rowStatus(grade, running), gradeStatus: status, outcome, statusReasons, score, displayScore, letter, coverage, inputHash, policy }
}

function frozenGrade(result: FrozenResult, policy: ScorecardSnapshot['policy']): SummaryGrade {
  const { status, outcome, statusReasons, score, displayScore, letter, coverage, inputHash } = result
  return { status: rowStatus(result, false), gradeStatus: status, outcome, statusReasons, score, displayScore, letter, coverage, inputHash, policy }
}

// ---------------------------------------------------------------------------------------------------------------
// Gaps

/**
 * What the gaps resolve evidence through: each attempt's ticket, the epic's stored observations by id, each run's
 * number and each ticket's name.
 */
interface EvidenceIndex {
  ticketOfAttempt: ReadonlyMap<string, string>
  observations: ReadonlyMap<string, MetricObservation>
  runNumbers: ReadonlyMap<string, number>
  names: ReadonlyMap<string, SummaryTicketRef>
}

function ticketOfObservation(observation: MetricObservation, index: EvidenceIndex): string | null {
  const { attemptId, ticketId } = observation.scope
  return (attemptId === null ? undefined : index.ticketOfAttempt.get(attemptId)) ?? ticketId
}

/** The tickets evidence names: directly, through an attempt or check, or through the observation it cites. */
function ticketIdsOf(evidence: readonly EvidenceRef[], index: EvidenceIndex): string[] {
  const ids = evidence.flatMap((ref): (string | null | undefined)[] => {
    if (ref.kind === 'ticket' || ref.kind === 'criterion') return [ref.id]
    if (ref.kind === 'attempt' || ref.kind === 'check') return [index.ticketOfAttempt.get(ref.id)]
    const observation = ref.kind === 'observation' ? index.observations.get(ref.id) : undefined
    return [observation === undefined ? null : ticketOfObservation(observation, index)]
  })
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))].sort()
}

function ticketRef(ticketId: string, index: EvidenceIndex): SummaryTicketRef {
  return index.names.get(ticketId) ?? { ticketId, key: null, title: null, removedAfterRevision: null }
}

function runNumberOf(runId: string, index: EvidenceIndex): number {
  const number = index.runNumbers.get(runId)
  if (number === undefined) throw new Error(`Run ${runId} is not among the graded runs.`)
  return number
}

/** The scored components below a full score: a component at 100 is no gap. */
function componentGaps(epicId: string, grade: SpaceGrade, index: EvidenceIndex): SummaryComponentGap[] {
  return grade.components.flatMap((component) => {
    if (component.score === null || component.score >= MAX_COMPONENT_SCORE) return []
    const ticketIds = ticketIdsOf(component.evidence, index)
    return [
      {
        epicId,
        component: component.component,
        score: component.score,
        rule: component.rule,
        evidence: component.evidence.slice(0, EVIDENCE_LIMIT),
        ticketIds,
        tickets: ticketIds.map((ticketId) => ticketRef(ticketId, index))
      }
    ]
  })
}

function failureGaps(epicId: string, view: AggregateGradeView, index: EvidenceIndex): SummaryFailureGap[] {
  return view.outcomes
    .filter((outcome) => outcome.counted && outcome.state === 'failed')
    .map((outcome) => ({
      epicId,
      runId: outcome.runId,
      runNumber: runNumberOf(outcome.runId, index),
      ticketId: outcome.ticketId,
      ticket: ticketRef(outcome.ticketId, index),
      attemptId: outcome.attemptId,
      reason: outcome.reason,
      evidence: [{ kind: 'ticket', id: outcome.ticketId, detail: null }, ...(outcome.attemptId === null ? [] : [{ kind: 'attempt' as const, id: outcome.attemptId, detail: null }])]
    }))
}

/** A corrective classification record's cause, as E files it (`unstated` without a known one). */
function causeOf(observation: MetricObservation): CorrectiveCause | null {
  if (observation.metric !== 'corrective_effort_ms' || observation.attributes.classification !== 'corrective') return null
  return observation.cause ?? 'unstated'
}

/**
 * Corrective effort by cause over the scopes the grade summed (E's own `correctiveByCause`), each cause citing only
 * the classification records filed under it, and the tickets those records were spent on.
 */
function reworkGaps(epicId: string, view: AggregateGradeView, index: EvidenceIndex): SummaryReworkGap[] {
  const byCause = new Map<CorrectiveCause, { ms: number; observations: Set<string>; tickets: Set<string> }>()
  for (const scope of view.sources.efficiency) {
    for (const [cause, ms] of Object.entries(scope.classification.correctiveByCause) as [CorrectiveCause, number][]) {
      const held = byCause.get(cause) ?? { ms: 0, observations: new Set<string>(), tickets: new Set<string>() }
      held.ms += ms
      byCause.set(cause, held)
    }
    for (const id of scope.classification.observationIds) {
      const observation = index.observations.get(id)
      const cause = observation === undefined ? null : causeOf(observation)
      const held = cause === null ? undefined : byCause.get(cause)
      if (observation === undefined || held === undefined) continue
      held.observations.add(id)
      const ticketId = ticketOfObservation(observation, index)
      if (ticketId !== null) held.tickets.add(ticketId)
    }
  }
  return [...byCause.entries()]
    .filter(([, held]) => held.ms > 0)
    .map(([cause, held]) => {
      const ticketIds = [...held.tickets].sort()
      return {
        epicId,
        cause,
        ms: held.ms,
        evidence: [...held.observations].slice(0, EVIDENCE_LIMIT).map((id) => ({ kind: 'observation' as const, id, detail: `corrective effort: ${cause}` })),
        ticketIds,
        tickets: ticketIds.map((ticketId) => ticketRef(ticketId, index))
      }
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Sprint trend

interface StoredReport {
  id: string
  sprint_id: string
  report_revision: number
  scorecard_json: string | null
  created_at: string
}

/** Each sprint's latest report revision submitted by the cutoff. */
function latestReports(ctx: Ctx, runId: string, cutoff: string): Map<string, StoredReport> {
  const rows = ctx.db.all<StoredReport>(
    'SELECT id, sprint_id, report_revision, scorecard_json, created_at FROM sprint_reports WHERE run_id = ? AND created_at <= ? ORDER BY report_revision',
    runId,
    cutoff
  )
  return new Map(rows.map((row) => [row.sprint_id, row]))
}

const UNSIZED = 'unsized'

function cohortKeyOf(bundle: PlanBundle, ticketId: string): string {
  const ticket = bundle.tickets.find((entry) => entry.id === ticketId)
  if (ticket?.size === undefined) return UNSIZED
  return `${ticket.capability.workType}/${ticket.size}/${ticket.capability.reasoning.level}`
}

/** The sprint's cohort from its tickets' keys: the keys sorted, and how many tickets hold each. */
function cohortOf(keys: readonly string[]): Pick<MetricsSummaryTrendEntry, 'cohort' | 'cohortTickets'> {
  const counts = new Map<string, number>()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  const cohort = [...counts.keys()].sort()
  const cohortTickets = [...counts].map(([key, tickets]) => ({ key, tickets })).sort((a, b) => cohort.indexOf(a.key) - cohort.indexOf(b.key))
  return { cohort, cohortTickets }
}

/**
 * Whether the ticket is work the cohort describes: an overhead ticket (an acceptance node, administrative or Fireguard
 * work, by the role the scorecards froze for it) is no feature outcome, so it is left out of the cohort.
 */
function inCohort(grading: RunGrading, ticketId: string): boolean {
  return grading.roles.get(ticketId) !== 'integrated'
}

type TrendDraft = Omit<MetricsSummaryTrendEntry, 'comparison'> & { endsAt: string }

function frozenEntry(grading: RunGrading, sprint: PlanBundle['sprints'][number], report: StoredReport): TrendDraft {
  const base = {
    epicId: grading.run.epic_id,
    runId: grading.run.id,
    runNumber: grading.run.number,
    sprintId: sprint.id,
    ordinal: sprint.ordinal,
    report: { reportId: report.id, reportRevision: report.report_revision }
  }
  if (report.scorecard_json === null) {
    const plan = grading.bundle(grading.run.revision_id)
    return {
      ...base,
      source: 'legacy_report',
      grade: null,
      ...cohortOf(sprint.ticketIds.filter((ticketId) => inCohort(grading, ticketId)).map((ticketId) => cohortKeyOf(plan, ticketId))),
      window: { from: null, to: report.created_at, closed: true, basis: 'report_cutoff' },
      endsAt: report.created_at
    }
  }
  // Checked (schema, seal, regrade) when it was written or imported; read as stored, like `storedSummary`.
  const snapshot = JSON.parse(report.scorecard_json) as ScorecardSnapshot
  const plan = grading.bundle(snapshot.planRevisionId)
  return {
    ...base,
    source: 'frozen_report',
    grade: frozenGrade(snapshot.sprint.result, snapshot.policy),
    ...cohortOf(snapshot.tickets.filter((ticket) => inCohort(grading, ticket.subject.id)).map((ticket) => cohortKeyOf(plan, ticket.subject.id))),
    window: { from: snapshot.timing.sprint?.startedAt ?? null, to: snapshot.cutoff, closed: true, basis: 'report_cutoff' },
    endsAt: snapshot.cutoff
  }
}

/** Whether the run executed any attempt in the sprint: a sprint a run only activated has nothing to show. */
function executedIn(grading: RunGrading, sprintId: string): boolean {
  const scope = grading.efficiency.sprints.find((entry) => entry.scope.level === 'sprint' && entry.scope.sprintId === sprintId)
  return scope !== undefined && (scope.time.attempts > 0 || scope.tokens.attempts > 0)
}

function liveEntry(ctx: Ctx, grading: RunGrading, sprint: PlanBundle['sprints'][number], timing: RunTiming): TrendDraft | null {
  const window = timing.sprints.find((entry) => entry.sprintId === sprint.id)
  if (window?.startedAt === null || window === undefined || !executedIn(grading, sprint.id)) return null
  const view = sprintAggregate(ctx, grading, sprint.id)
  const closed = window.endedAt !== null
  return {
    epicId: grading.run.epic_id,
    runId: grading.run.id,
    runNumber: grading.run.number,
    sprintId: sprint.id,
    ordinal: sprint.ordinal,
    source: 'live',
    report: null,
    grade: liveGrade(view.grade, !closed),
    ...cohortOf(
      view.tickets
        .filter((ticket) => inCohort(grading, ticket.ticketId))
        .map((ticket) => ticket.sources.efficiency.cohortKey)
        .map((key) => (key === null ? UNSIZED : `${key.workType}/${key.size}/${key.risk}`))
    ),
    window: { from: window.startedAt, to: window.endedAt ?? grading.cutoff, closed, basis: 'live_cutoff' },
    endsAt: window.endedAt ?? grading.cutoff
  }
}

function runTrend(ctx: Ctx, grading: RunGrading, timing: RunTiming): TrendDraft[] {
  const reports = latestReports(ctx, grading.run.id, grading.cutoff)
  const sprints = [...grading.bundle(grading.run.revision_id).sprints].sort((a, b) => a.ordinal - b.ordinal)
  return sprints.flatMap((sprint) => {
    const report = reports.get(sprint.id)
    const entry = report === undefined ? liveEntry(ctx, grading, sprint, timing) : frozenEntry(grading, sprint, report)
    return entry === null ? [] : [entry]
  })
}

/** No cohort vouches for a sprint with no ticket, or with a ticket nobody sized. */
const cohortUnknown = (entry: TrendDraft): boolean => entry.cohortTickets.length === 0 || entry.cohort.includes(UNSIZED)

/** What makes two trend entries incomparable, each a reason of its own. */
const INCOMPARABLE: [TrendIncomparability, (a: TrendDraft, b: TrendDraft) => boolean][] = [
  // A legacy report was graded under no policy, so it never shares one.
  ['policy_changed', (a, b) => a.grade === null || b.grade === null || a.grade.policy.hash !== b.grade.policy.hash],
  ['cohort_changed', (a, b) => JSON.stringify(a.cohortTickets) !== JSON.stringify(b.cohortTickets)],
  ['cohort_unknown', (a, b) => cohortUnknown(a) || cohortUnknown(b)],
  ['window_open', (a, b) => !a.window.closed || !b.window.closed],
  ['window_basis_changed', (a, b) => a.window.basis !== b.window.basis],
  ['not_scored', (a, b) => (a.grade?.score ?? null) === null || (b.grade?.score ?? null) === null]
]

/** The reasons that leave two epics' sprints with nothing vouching for comparing them. */
const UNVOUCHED: readonly TrendIncomparability[] = ['policy_changed', 'cohort_changed', 'cohort_unknown']

function incomparability(entry: TrendDraft, previous: TrendDraft | undefined): TrendIncomparability[] {
  if (previous === undefined) return ['first_entry']
  const reasons = INCOMPARABLE.filter(([, differs]) => differs(entry, previous)).map(([reason]) => reason)
  const crossEpic = entry.epicId !== previous.epicId && reasons.some((reason) => UNVOUCHED.includes(reason))
  return crossEpic ? [...reasons, 'cross_epic'] : reasons
}

/** Sprints by end time (open windows last), each compared with the one before only when the two are comparable. */
function trendOf(drafts: TrendDraft[]): MetricsSummaryTrendEntry[] {
  const ordered = [...drafts].sort((a, b) => Number(!a.window.closed) - Number(!b.window.closed) || Date.parse(a.endsAt) - Date.parse(b.endsAt))
  return ordered.map((draft, index) => {
    const { endsAt: _endsAt, ...entry } = draft
    const previous = ordered[index - 1]
    const reasons = incomparability(draft, previous)
    // Comparable means both were scored (`not_scored` otherwise), so the delta is a number exactly when comparable.
    const delta = reasons.length === 0 ? (entry.grade?.score ?? 0) - (previous?.grade?.score ?? 0) : null
    return {
      ...entry,
      comparison: {
        previous: previous === undefined ? null : { epicId: previous.epicId, runId: previous.runId, runNumber: previous.runNumber, sprintId: previous.sprintId },
        comparable: reasons.length === 0,
        reasons,
        scoreDelta: delta
      }
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// The summary

interface EpicRecord {
  id: string
  title: string
  status: WorkStatus
}

interface EpicReading {
  row: MetricsSummaryEpicRow
  raw: RawMeasures
  /** Null for an epic with no saved plan at the cutoff: nothing can be graded or measured. */
  view: AggregateGradeView | null
  /** Whether any run executed work in it: only these epics' measures are summed into the totals. */
  executed: boolean
  trend: TrendDraft[]
  index: EvidenceIndex
}

interface Shared {
  cutoff: string
  since: string | null
  cache: SignalsCache
  runSources: OtherRunSources
}

/** The epics that existed at the cutoff (each id asked for must exist), oldest first. */
function selectedEpics(ctx: Ctx, epicIds: readonly string[] | undefined, cutoff: string): EpicRecord[] {
  if (epicIds !== undefined) {
    const known = new Set(ctx.db.all<{ id: string }>('SELECT id FROM epics').map((row) => row.id))
    const unknown = epicIds.find((id) => !known.has(id))
    if (unknown !== undefined) fail('not_found', `Epic ${unknown} not found.`, { epicId: unknown })
  }
  const epics = ctx.db.all<EpicRecord>('SELECT id, title, status FROM epics WHERE created_at <= ? ORDER BY created_at, id', cutoff)
  return epicIds === undefined ? epics : epics.filter((epic) => epicIds.includes(epic.id))
}

/** The epic's latest plan revision saved by the cutoff; null when it had none then. */
function savedRevisionAt(ctx: Ctx, epicId: string, cutoff: string): string | null {
  const row = ctx.db.get<{ id: string }>(
    `SELECT id FROM plan_revisions WHERE epic_id = ? AND state = 'saved' AND COALESCE(saved_at, created_at) <= ? ORDER BY number DESC LIMIT 1`,
    epicId,
    cutoff
  )
  return row?.id ?? null
}

/** An epic not planned at the cutoff (no saved revision, so no run): ungraded, every measure unknown. */
function unplannedReading(epic: EpicRecord, policy: SummaryGrade['policy']): EpicReading {
  const unknown = missing('the epic has no saved plan')
  const tokens: SummaryTokens = { input: unknown, cachedInput: unknown, output: unknown, reasoning: unknown, total: unknown }
  const time: SummaryTime = { elapsedMs: unknown, activeMs: unknown, waitingMs: unknown, effortMs: unknown }
  const coverage = withUnavailable({ tokens, time, corrective: unknown, productive: unknown, coverage: { attempts: 0, unreportedTokenAttempts: 0, unreportedTimeAttempts: 0, classificationCoverage: null } }, unknown)
  const grade: SummaryGrade = {
    status: 'ungraded',
    gradeStatus: 'ungraded',
    outcome: 'unverified',
    statusReasons: ['insufficient_coverage'],
    score: null,
    displayScore: null,
    letter: null,
    coverage: 0,
    inputHash: null,
    policy
  }
  const row: MetricsSummaryEpicRow = { epicId: epic.id, title: epic.title, status: epic.status, runIds: [], measuredRunIds: [], sprintCount: 0, grade, tokens, time, correctiveShare: unknown, coverage }
  const index: EvidenceIndex = { ticketOfAttempt: new Map(), observations: new Map(), runNumbers: new Map(), names: new Map() }
  return { row, raw: { tokens, time, corrective: unknown, productive: unknown, coverage }, view: null, executed: false, trend: [], index }
}

/**
 * Each ticket named from the epic's plan saved last by the cutoff, and a ticket it no longer holds from the newest
 * revision a run was pinned to (with that revision's number).
 */
function ticketNames(ctx: Ctx, saved: PlanBundle, gradings: readonly RunGrading[]): Map<string, SummaryTicketRef> {
  const names = new Map<string, SummaryTicketRef>()
  const name = (bundle: PlanBundle, removedAfterRevision: number | null): void => {
    for (const ticket of bundle.tickets) {
      if (!names.has(ticket.id)) names.set(ticket.id, { ticketId: ticket.id, key: ticket.key, title: ticket.title, removedAfterRevision })
    }
  }
  name(saved, null)
  for (const grading of [...gradings].reverse()) {
    const revision = ctx.db.get<{ number: number }>('SELECT number FROM plan_revisions WHERE id = ?', grading.run.revision_id)
    name(grading.bundle(grading.run.revision_id), revision?.number ?? null)
  }
  return names
}

function evidenceIndex(ctx: Ctx, gradings: readonly RunGrading[], saved: PlanBundle): EvidenceIndex {
  return {
    ticketOfAttempt: new Map(gradings.flatMap((grading) => grading.attempts.map((attempt): [string, string] => [attempt.id, attempt.ticket_id]))),
    observations: new Map(gradings.flatMap((grading) => listObservations(ctx.db, { runId: grading.run.id }).map((observation): [string, MetricObservation] => [observation.observationId, observation]))),
    runNumbers: new Map(gradings.map((grading) => [grading.run.id, grading.run.number])),
    names: ticketNames(ctx, saved, gradings)
  }
}

function readEpic(ctx: Ctx, epic: EpicRecord, shared: Shared): EpicReading | null {
  const { cutoff, since } = shared
  const revisionId = savedRevisionAt(ctx, epic.id, cutoff)
  if (revisionId === null) return since === null ? unplannedReading(epic, policyRef(CURRENT_SPACE_POLICY)) : null
  const gradings = epicRunIds(ctx, epic.id, cutoff).map((runId) => gradeRunTickets(ctx, runId, cutoff, { cache: shared.cache, runSources: shared.runSources }))
  if (since !== null && !gradings.some((grading) => Date.parse(grading.run.ended_at ?? cutoff) >= Date.parse(since))) return null
  const view = epicAggregate(ctx, epic.id, cutoff, gradings)
  const timed = gradings.map((grading) => ({ grading, timing: projectRunTiming(ctx, { runId: grading.run.id, asOf: cutoff }) }))
  const raw = rawMeasures(ctx, view, timed.map((entry) => entry.timing))
  // A run not ended by the cutoff is still running there, so its epic's live grade can still change.
  const running = gradings.some((grading) => grading.run.ended_at === null || Date.parse(grading.run.ended_at) > Date.parse(cutoff))
  const trend = timed.flatMap(({ grading, timing }) => runTrend(ctx, grading, timing)).filter((entry) => since === null || Date.parse(entry.endsAt) >= Date.parse(since))
  const saved = loadBundle(ctx, revisionId)
  const row: MetricsSummaryEpicRow = {
    epicId: epic.id,
    title: epic.title,
    status: epic.status,
    runIds: view.runIds,
    measuredRunIds: view.measuredRunIds,
    sprintCount: saved.sprints.length,
    grade: liveGrade(view.grade, running),
    tokens: raw.tokens,
    time: raw.time,
    correctiveShare: share(raw.corrective, raw.productive),
    coverage: raw.coverage
  }
  const executed = view.sources.efficiency.some((scope) => scope.time.attempts > 0 || scope.tokens.attempts > 0)
  return { row, raw, view, executed, trend, index: evidenceIndex(ctx, gradings, saved) }
}

/**
 * Project totals from the raw measures of the epics that executed work, summed with the grader's own rule. An epic
 * whose runs executed nothing (or that has no run or plan yet) keeps its row but adds no measure, as a run that
 * executed nothing adds none to its epic's grade.
 */
function totalsOf(all: readonly EpicReading[]): MetricsSummaryTotals {
  const readings = all.filter((reading) => reading.executed)
  const sum = (pick: (raw: RawMeasures) => SummaryMeasure) => summed(readings.map((reading) => pick(reading.raw)), 'no epic executed work')
  const tokens: SummaryTokens = {
    input: sum((raw) => raw.tokens.input),
    cachedInput: sum((raw) => raw.tokens.cachedInput),
    output: sum((raw) => raw.tokens.output),
    reasoning: sum((raw) => raw.tokens.reasoning),
    total: sum((raw) => raw.tokens.total)
  }
  const time: SummaryTime = {
    elapsedMs: sum((raw) => raw.time.elapsedMs),
    activeMs: sum((raw) => raw.time.activeMs),
    waitingMs: sum((raw) => raw.time.waitingMs),
    effortMs: sum((raw) => raw.time.effortMs)
  }
  const corrective = sum((raw) => raw.corrective)
  const productive = sum((raw) => raw.productive)
  const correctiveShare = share(corrective, productive)
  const counted = readings.map((reading) => reading.raw.coverage)
  const coverage = {
    attempts: counted.reduce((total, entry) => total + entry.attempts, 0),
    unreportedTokenAttempts: counted.reduce((total, entry) => total + entry.unreportedTokenAttempts, 0),
    unreportedTimeAttempts: counted.reduce((total, entry) => total + entry.unreportedTimeAttempts, 0),
    classificationCoverage: coverageOf([], time.effortMs, corrective, productive).classificationCoverage
  }
  return {
    epics: readings.length,
    measuredEpicIds: readings.map((reading) => reading.row.epicId),
    tokens,
    time,
    correctiveShare,
    coverage: withUnavailable({ tokens, time, corrective, productive, coverage }, correctiveShare)
  }
}

function distributionOf(rows: readonly MetricsSummaryEpicRow[]): MetricsSummaryView['distribution'] {
  const byStatus: Record<SummaryGradeStatus, number> = { final: 0, provisional: 0, ungraded: 0, in_progress: 0, failed: 0 }
  const byGradeStatus: Record<GradeStatus, number> = { final: 0, provisional: 0, ungraded: 0 }
  for (const row of rows) {
    byStatus[row.grade.status] += 1
    byGradeStatus[row.grade.gradeStatus] += 1
  }
  return { byStatus, byGradeStatus }
}

function gapsOf(readings: readonly EpicReading[]): MetricsSummaryView['gaps'] {
  const graded = readings.flatMap((reading) => (reading.view === null ? [] : [{ epicId: reading.row.epicId, view: reading.view, index: reading.index }]))
  return {
    lowestComponents: graded
      .flatMap(({ epicId, view, index }) => componentGaps(epicId, view.grade, index))
      .sort((a, b) => a.score - b.score)
      .slice(0, LOWEST_COMPONENTS),
    failures: graded.flatMap(({ epicId, view, index }) => failureGaps(epicId, view, index)),
    rework: graded.flatMap(({ epicId, view, index }) => reworkGaps(epicId, view, index)).sort((a, b) => b.ms - a.ms)
  }
}

/**
 * The project metrics summary as of `until` (default now, never later; the clock is read once): per-epic rows,
 * project totals, the grade distribution, the sprint trend and the top gaps. See the module comment for what each
 * part reads. Each run's observations are parsed once for the whole read (`readingObservations`).
 */
export function getMetricsSummary(ctx: Ctx, input: GetMetricsSummaryInput): MetricsSummaryView {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => readingObservations(ctx.db, () => summaryAt(ctx, input)))
}

function summaryAt(ctx: Ctx, input: GetMetricsSummaryInput): MetricsSummaryView {
  const cutoff = cutoffOf(ctx, input.until)
  const since = input.since ?? null
  if (since !== null && Date.parse(since) > Date.parse(cutoff)) {
    fail('invalid_input', `The window starts (${since}) after its cutoff (${cutoff}).`, { since, cutoff })
  }
  const shared: Shared = { cutoff, since, cache: signalsCache(), runSources: new Map() }
  const readings = selectedEpics(ctx, input.epicIds, cutoff).flatMap((epic) => {
    const reading = readEpic(ctx, epic, shared)
    return reading === null ? [] : [reading]
  })
  const rows = readings.map((reading) => reading.row)
  const graded = rows.filter((row) => row.grade.gradeStatus !== 'ungraded').length
  return {
    policy: policyRef(CURRENT_SPACE_POLICY),
    window: { since, cutoff },
    epics: rows,
    totals: totalsOf(readings),
    distribution: distributionOf(rows),
    trend: trendOf(readings.flatMap((reading) => reading.trend)),
    gaps: gapsOf(readings),
    coverage: {
      epics: rows.length,
      gradedEpics: graded,
      ungradedEpics: rows.length - graded,
      unavailable: [
        ...rows.flatMap((row) => row.coverage.unavailable.map((field) => ({ ...field, epicId: row.epicId }))),
        ...rows.filter((row) => row.grade.gradeStatus === 'ungraded').map((row) => ({ epicId: row.epicId, field: 'grade', reason: row.grade.statusReasons.join(', ') || 'ungraded' }))
      ]
    }
  }
}
