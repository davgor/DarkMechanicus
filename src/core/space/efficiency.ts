/**
 * E, T and K inputs (docs/space-grading.md, "Efficiency, execution time and tokens"). Pure: the service
 * (`src/core/services/efficiency.ts`) hands it one scope's timing, observations and token cells as of a cutoff.
 *
 * - E is the corrective share of classified effort. Its denominator is the scope's observed effort (every actor's
 *   activity, summed by the timing projection); `corrective_effort_ms` records classify parts of it as corrective
 *   (with a cause) or productive (planned tests, research and other needed work). Classified effort can never exceed
 *   the observed effort. Retries are listed as a diagnostic and never counted as corrective or wasted.
 * - T is the observed effort itself (worker, review, orchestration and verification activity; waits are not
 *   activity), K the tokens of the scope's executed attempts and overhead. Both compare with a frozen baseline.
 * - Unknown is never zero: an open attempt, a span or usage stream known to be still running or unreported, or an
 *   attempt that reported nothing keeps the measure missing (or `partial_telemetry`), never complete.
 */
import type {
  ActivityGap,
  CohortExclusion,
  CohortMemberView,
  CohortView,
  CorrectiveCause,
  EffortClassificationView,
  EfficiencyAnomaly,
  EfficiencyScope,
  ResourceActualView,
  RetryDiagnostic,
  RunEfficiencyView,
  ScopeEfficiencyView,
  TicketEfficiencyView
} from '../../shared/domain/efficiency'
import { EFFORT_CLASSIFICATIONS, type EffortClassification } from '../../shared/domain/efficiency'
import type { UsageCellView } from '../../shared/domain/metrics'
import {
  type Baseline,
  type BaselineMetric,
  type BaselineRejection,
  type BaselineSelection,
  BASELINE_UNITS,
  type BudgetBaseline,
  type CohortBaseline,
  type CohortKey,
  type EfficiencyInput,
  type EvidenceRef,
  type Measurement,
  type MetricObservation,
  type ObservationMissingReason,
  type ResourceInput,
  type SpacePolicy,
  WORKFLOW_CAUSES
} from '../../shared/domain/space'
import type { AttemptTiming, EffortTotals, RunTiming, TicketTiming, TimingAnomaly, WaitTotals } from '../../shared/domain/timing'
import { WAIT_CLASSES } from '../../shared/domain/timing'
import { derivedStableId } from '../ids'
import { selectBaseline } from './baselines'
import { projectTiming, type TimingEvent, type TimingInput } from './timing'
import { claimKeys } from './timingActivity'
import { iso } from './timingIntervals'

/** The contract caps an evidence list at 500 references. */
const EVIDENCE_LIMIT = 450

const TOKEN_METRICS: Readonly<Record<string, true>> = { tokens_input: true, tokens_cached_input: true, tokens_output: true, tokens_reasoning: true, tokens_total: true }

// ---------------------------------------------------------------------------------------------------------------
// Observations

/**
 * The first delivery of each observation id, in input (ledger) order. A later delivery is listed (`duplicate_event`
 * or `conflicting_delivery`) and never read, so it can neither add effort nor stand in as a stream's later report.
 */
function firstDeliveries(observations: readonly MetricObservation[], anomalies: EfficiencyAnomaly[]): MetricObservation[] {
  const firsts = new Map<string, MetricObservation>()
  for (const observation of observations) {
    const seen = firsts.get(observation.observationId)
    if (seen === undefined) {
      firsts.set(observation.observationId, observation)
      continue
    }
    const same = JSON.stringify({ ...seen, recordedAt: '' }) === JSON.stringify({ ...observation, recordedAt: '' })
    anomalies.push({
      kind: same ? 'duplicate_event' : 'conflicting_delivery',
      subject: observation.observationId,
      detail: same ? 'delivered again' : 'delivered again with a different payload; the first delivery is kept'
    })
  }
  return [...firsts.values()]
}

function push<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [item])
  else list.push(item)
}

/** A usage stream: one bucket (scope and overhead kind), actor and metric, whichever of host or agent reported it. */
function streamKey(observation: MetricObservation): string {
  const { scope, source } = observation
  return JSON.stringify([scope.level, scope.sprintId, scope.ticketId, scope.attemptId, observation.attributes.overhead ?? null, source.actor, observation.metric])
}

function gapOf(observation: MetricObservation, kind: ActivityGap['kind'], reason: ObservationMissingReason): ActivityGap {
  return { kind, observationId: observation.observationId, metric: observation.metric, actor: observation.source.actor, attemptId: observation.scope.attemptId, reason }
}

/** The report a cumulative stream stands at: its highest sequence, the host's when both reported that position. */
function latestOf(stream: readonly MetricObservation[]): MetricObservation | undefined {
  let latest: MetricObservation | undefined
  for (const item of stream) {
    const ahead = latest === undefined || (item.sequence ?? 0) > (latest.sequence ?? 0)
    const hostAtSame = latest !== undefined && item.sequence === latest.sequence && item.source.kind === 'host' && latest.source.kind !== 'host'
    if (ahead || hostAtSame) latest = item
  }
  return latest
}

/**
 * The gap one delta or event report shows by itself: an `active_ms` with no value, one the timing projection refused
 * or could not place in time (`refused`: an inconsistent, inverted or unparseable span, an amount with no start), or a
 * token delta still growing.
 */
function reportGap(observation: MetricObservation, refused: ReadonlySet<string>): ActivityGap | null {
  const { measurement } = observation
  if (observation.metric === 'active_ms') {
    if (measurement.state === 'missing') return gapOf(observation, 'missing_span', measurement.reason)
    return refused.has(observation.observationId) ? gapOf(observation, 'refused_span', 'partial_coverage') : null
  }
  if (measurement.state !== 'missing') return null
  return TOKEN_METRICS[observation.metric] === true && measurement.reason === 'partial_coverage' ? gapOf(observation, 'unsettled_stream', 'partial_coverage') : null
}

/**
 * Activity known to exist but not counted, among first deliveries: an `active_ms` record with no value or that the
 * timing projection refused (the span is unknown, so its time is missing, never zero), and a token stream whose latest
 * report is a `partial_coverage` gap (its thread is still working, so its open span has not been reported yet). One
 * pass and one group per stream: linear in the observations.
 */
function activityGaps(observations: readonly MetricObservation[], refused: ReadonlySet<string>): ActivityGap[] {
  const gaps: ActivityGap[] = []
  const cumulative = new Map<string, MetricObservation[]>()
  for (const observation of observations) {
    if (observation.accumulation === 'cumulative' && TOKEN_METRICS[observation.metric] === true) {
      push(cumulative, streamKey(observation), observation)
      continue
    }
    const gap = reportGap(observation, refused)
    if (gap !== null) gaps.push(gap)
  }
  for (const stream of cumulative.values()) {
    const latest = latestOf(stream)
    if (latest?.measurement.state === 'missing' && latest.measurement.reason === 'partial_coverage') gaps.push(gapOf(latest, 'unsettled_stream', 'partial_coverage'))
  }
  return gaps
}

// ---------------------------------------------------------------------------------------------------------------
// Scope records

/** One scope's records as of the cutoff. */
interface ScopeRecords {
  scope: EfficiencyScope
  /** The attempts that executed in scope (carried-forward attempts ran nothing here and are not listed). */
  attempts: readonly AttemptTiming[]
  /** The scope's effort from the timing projection (ticket, sprint or run `effort`). */
  effort: EffortTotals
  /** The scope's classified waits, shown beside T (never counted as active). */
  waits: WaitTotals
  /** First deliveries stored by the cutoff that belong to the scope. */
  observations: readonly MetricObservation[]
  /** Activity observations the timing projection refused or could not place (their time is unknown). */
  refused: ReadonlySet<string>
  /** `tokens_total` cells: each executed attempt's, the scope's records of no attempt, and all of them together. */
  tokens: { byAttempt: ReadonlyMap<string, UsageCellView>; overhead: UsageCellView; combined: UsageCellView }
}

/** Still running at the cutoff, so its effort, review and usage can still grow: any number is a lower bound. */
const isOpen = (attempt: AttemptTiming): boolean => attempt.outcome === 'open' || attempt.outcome === 'awaiting_review'

const missing = (reason: ObservationMissingReason): Measurement => ({ state: 'missing', reason })

/** A gap's reason for the whole measure: `host_unavailable` only when every gap is a host that cannot report it. */
function gapReason(gaps: readonly ActivityGap[]): ObservationMissingReason {
  return gaps.every((gap) => gap.reason === 'host_unavailable') ? 'host_unavailable' : 'partial_coverage'
}

function attemptRefs(attempts: readonly AttemptTiming[]): EvidenceRef[] {
  return attempts.slice(0, EVIDENCE_LIMIT).map((attempt) => ({ kind: 'attempt', id: attempt.attemptId, detail: attempt.superseded ? 'superseded' : attempt.outcome }))
}

// ---------------------------------------------------------------------------------------------------------------
// E

interface ClassTally {
  ms: number
  estimated: boolean
  /** The reason of the first record of this class that had no value. */
  missing: ObservationMissingReason | null
}

function classificationOf(observation: MetricObservation, anomalies: EfficiencyAnomaly[]): EffortClassification | null {
  if (observation.accumulation !== 'event') {
    anomalies.push({ kind: 'not_an_event', subject: observation.observationId, detail: `a ${observation.accumulation} corrective_effort_ms is not one classified piece of effort` })
    return null
  }
  const stated = observation.attributes.classification
  if (typeof stated === 'string' && (EFFORT_CLASSIFICATIONS as readonly string[]).includes(stated)) return stated as EffortClassification
  anomalies.push({ kind: 'unknown_classification', subject: observation.observationId, detail: `classification ${String(stated)}; counted as unclassified` })
  return null
}

function tallyMeasure(tally: ClassTally): Measurement {
  if (tally.missing !== null) return missing(tally.missing)
  return tally.estimated ? { state: 'estimated', value: tally.ms, method: 'sum of classifications including estimated ones' } : { state: 'observed', value: tally.ms }
}

function retriesOf(attempts: readonly AttemptTiming[]): RetryDiagnostic {
  const perTicket = new Map<string, number>()
  for (const attempt of attempts) perTicket.set(attempt.ticketId, (perTicket.get(attempt.ticketId) ?? 0) + 1)
  let retries = 0
  for (const count of perTicket.values()) retries += count - 1
  return {
    retries: attempts.length === 0 ? null : retries,
    attempts: attempts.map((a) => ({ attemptId: a.attemptId, ticketId: a.ticketId, number: a.number, outcome: a.outcome, superseded: a.superseded, effortMs: a.effort.total.ms }))
  }
}

/** Why the observed effort cannot be a denominator yet: a known gap, an open attempt, an unreported attempt or nothing measured. */
function effortGap(records: ScopeRecords, gaps: readonly ActivityGap[]): ObservationMissingReason | null {
  if (gaps.length > 0) return gapReason(gaps)
  if (records.attempts.some(isOpen) || records.effort.total.state === 'partial') return 'partial_coverage'
  return records.effort.total.ms === null ? 'not_reported' : null
}

/**
 * Effort no record classified, against the observed effort. Unknown whenever the effort is (`effortGap`). Classified
 * effort above the observed effort cannot be a share of it (two records classify the same work, or effort went
 * unreported), so it is listed and the measure is missing.
 */
function unclassifiedOf(records: ScopeRecords, classified: number | null, gaps: readonly ActivityGap[], anomalies: EfficiencyAnomaly[]): Measurement {
  const total = records.effort.total
  const gap = effortGap(records, gaps)
  if (gap !== null || total.ms === null) return missing(gap ?? 'not_reported')
  if (classified === null) return missing('not_reported')
  if (classified > total.ms) {
    const scope = records.scope
    const subject = scope.level === 'ticket' ? scope.ticketId : scope.level === 'sprint' ? scope.sprintId : 'run'
    anomalies.push({ kind: 'over_classified', subject, detail: `${classified} ms classified of ${total.ms} ms observed effort` })
    return missing('partial_coverage')
  }
  const value = total.ms - classified
  return total.state === 'estimated' ? { state: 'estimated', value, method: 'observed effort includes estimated spans' } : { state: 'observed', value }
}

interface Tallies {
  corrective: ClassTally
  productive: ClassTally
  correctiveByCause: Partial<Record<CorrectiveCause, number>>
  productiveByWork: Record<string, number>
  used: MetricObservation[]
}

/** What a classified piece of effort is shown under: a corrective one's cause (`unstated` without one), a productive one's `work`. */
function labelOf(observation: MetricObservation, classification: EffortClassification): string {
  if (classification === 'corrective') {
    const cause = observation.cause
    return cause !== undefined && (WORKFLOW_CAUSES as readonly string[]).includes(cause) ? cause : 'unstated'
  }
  const work = observation.attributes.work
  return typeof work === 'string' && work !== '' ? work : 'unspecified'
}

/** Adds one classification record: its value to its class, and to its cause (corrective) or its `work` (productive). */
function addClassification(tallies: Tallies, observation: MetricObservation, classification: EffortClassification): void {
  tallies.used.push(observation)
  const tally = tallies[classification]
  const { measurement } = observation
  if (measurement.state === 'missing') {
    tally.missing ??= measurement.reason
    return
  }
  tally.ms += measurement.value
  tally.estimated ||= measurement.state === 'estimated'
  const breakdown: Record<string, number> = classification === 'corrective' ? tallies.correctiveByCause : tallies.productiveByWork
  const label = labelOf(observation, classification)
  breakdown[label] = (breakdown[label] ?? 0) + measurement.value
}

function tallyClassifications(records: ScopeRecords, anomalies: EfficiencyAnomaly[]): Tallies {
  const tallies: Tallies = {
    corrective: { ms: 0, estimated: false, missing: null },
    productive: { ms: 0, estimated: false, missing: null },
    correctiveByCause: {},
    productiveByWork: {},
    used: []
  }
  for (const observation of records.observations) {
    if (observation.metric !== 'corrective_effort_ms') continue
    const classification = classificationOf(observation, anomalies)
    if (classification !== null) addClassification(tallies, observation, classification)
  }
  return tallies
}

const known = (measurement: Measurement): number | null => (measurement.state === 'missing' ? null : measurement.value)

/** E's input: corrective and productive effort from classification records, and the observed effort they share. */
function classifyEffort(records: ScopeRecords, gaps: readonly ActivityGap[], anomalies: EfficiencyAnomaly[]): { input: EfficiencyInput; view: EffortClassificationView } {
  const tallies = tallyClassifications(records, anomalies)
  const correctiveMs = tallyMeasure(tallies.corrective)
  const productiveMs = tallyMeasure(tallies.productive)
  const corrective = known(correctiveMs)
  const productive = known(productiveMs)
  const classified = corrective === null || productive === null ? null : corrective + productive
  const unclassifiedMs = unclassifiedOf(records, classified, gaps, anomalies)
  const total = records.effort.total
  const unclassified = known(unclassifiedMs)
  const evidence: EvidenceRef[] = tallies.used.slice(0, EVIDENCE_LIMIT).map((o) => ({ kind: 'observation', id: o.observationId, detail: String(o.attributes.classification) }))
  const retries = retriesOf(records.attempts)
  return {
    input: { correctiveMs, productiveMs, unclassifiedMs, retries: retries.retries, evidence },
    view: {
      denominator: { effortMs: total.ms, state: total.state, coverage: total.coverage, overheadMs: records.effort.overhead.ms },
      correctiveMs: corrective,
      productiveMs: productive,
      unclassifiedMs: unclassified,
      classificationCoverage: classified === null || unclassified === null || classified + unclassified === 0 ? null : classified / (classified + unclassified),
      correctiveByCause: tallies.correctiveByCause,
      productiveByWork: tallies.productiveByWork,
      observationIds: tallies.used.map((o) => o.observationId),
      retries
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// T and K actuals

function excludedWaits(waits: WaitTotals): ResourceActualView['excludedWaitsMs'] {
  const shown: Partial<Record<(typeof WAIT_CLASSES)[number], number>> = {}
  for (const kind of WAIT_CLASSES) {
    const ms = waits[kind].ms
    if (ms !== null) shown[kind] = ms
  }
  return shown
}

/**
 * T's actual: the scope's observed effort, summed over every actor (worker, review, orchestration, verification),
 * each stream's overlapping spans once and nested sessions once (the timing projection's `resource_effort`). Waits
 * are not activity. Missing while an attempt is open or a span is known but uncounted; nothing measured is missing.
 */
function timeActual(records: ScopeRecords, gaps: readonly ActivityGap[]): ResourceActualView {
  const total = records.effort.total
  const open = records.attempts.filter(isOpen).map((a) => a.attemptId)
  const unreported = records.attempts.filter((a) => a.active.coverage.covered === 0).map((a) => a.attemptId)
  let actual: Measurement
  if (open.length > 0) actual = missing('partial_coverage')
  else if (gaps.length > 0) actual = missing(gapReason(gaps))
  else if (total.ms === null) actual = missing('not_reported')
  else if (total.state === 'estimated') actual = { state: 'estimated', value: total.ms, method: 'effort includes estimated activity spans' }
  else actual = { state: 'observed', value: total.ms }
  return {
    metric: 'active_ms',
    actual,
    reportedValue: total.ms,
    attempts: records.attempts.length,
    unreportedAttemptIds: unreported,
    openAttemptIds: open,
    gaps: [...gaps],
    overheadValue: records.effort.overhead.ms,
    excludedWaitsMs: excludedWaits(records.waits)
  }
}

const UNREPORTED_CELL: UsageCellView = { metric: 'tokens_total', unit: 'tokens', coverage: 'unreported', value: null }

/**
 * K's actual: `tokens_total` of every executed attempt in scope (retried, rejected, failed, canceled and superseded
 * ones too) plus the scope's overhead records, nested sessions once. A stream with a known gap or a host that cannot
 * report keeps it missing; an attempt that reported nothing is counted for `partial_telemetry`.
 */
function tokenActual(records: ScopeRecords, gaps: readonly ActivityGap[]): ResourceActualView {
  const { byAttempt, overhead, combined } = records.tokens
  const cells = records.attempts.map((a) => ({ attemptId: a.attemptId, cell: byAttempt.get(a.attemptId) ?? UNREPORTED_CELL }))
  const open = records.attempts.filter(isOpen).map((a) => a.attemptId)
  const unreported = cells.filter((c) => c.cell.coverage === 'unreported').map((c) => c.attemptId)
  const all = [...cells.map((c) => c.cell), overhead]
  const partial = all.some((cell) => cell.coverage === 'partial')
  const unavailable = all.some((cell) => cell.coverage === 'unavailable')
  let actual: Measurement
  if (open.length > 0 || partial) actual = missing('partial_coverage')
  else if (unavailable) actual = missing(combined.value === null ? 'host_unavailable' : 'partial_coverage')
  else if (combined.value === null) actual = missing('not_reported')
  else if (combined.coverage === 'estimated') actual = { state: 'estimated', value: combined.value, method: 'sum including estimated reports' }
  else actual = { state: 'observed', value: combined.value }
  return {
    metric: 'tokens',
    actual,
    reportedValue: combined.value,
    attempts: records.attempts.length,
    unreportedAttemptIds: unreported,
    openAttemptIds: open,
    gaps: gaps.filter((gap) => TOKEN_METRICS[gap.metric] === true),
    overheadValue: null,
    excludedWaitsMs: null
  }
}

function resourceInput(view: ResourceActualView, baseline: BaselineSelection, evidence: EvidenceRef[]): ResourceInput {
  return { actual: view.actual, unreportedAttempts: view.unreportedAttemptIds.length, baseline, evidence }
}

const NO_BASELINE: BaselineSelection = { state: 'missing', reason: 'no_eligible_baseline', rejected: [] }

/**
 * E, T and K inputs of one scope. Sprint and run scopes get no baseline here: in policy v1 a budget applies only to a
 * ticket grade, and aggregate resource scores roll up from ticket measures.
 */
function scopeEfficiency(records: ScopeRecords, anomalies: EfficiencyAnomaly[], baselines: { T: BaselineSelection; K: BaselineSelection } = { T: NO_BASELINE, K: NO_BASELINE }): ScopeEfficiencyView {
  const gaps = activityGaps(records.observations, records.refused)
  const { input, view } = classifyEffort(records, gaps, anomalies)
  const time = timeActual(records, gaps)
  const tokens = tokenActual(records, gaps)
  const evidence = attemptRefs(records.attempts)
  return {
    scope: records.scope,
    E: input,
    T: resourceInput(time, baselines.T, evidence),
    K: resourceInput(tokens, baselines.K, evidence),
    classification: view,
    time,
    tokens
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cohorts

/** One prior accepted ticket's actuals, measured from records stored strictly before the subject's dispatch. */
export interface CohortSample {
  ticketId: string
  runId: string
  key: CohortKey | null
  time: ResourceActualView
  tokens: ResourceActualView
  basisAt: string
}

/** The `p` quantile of sorted values, linearly interpolated between closest ranks. */
function quantile(sorted: readonly number[], p: number): number {
  const position = (sorted.length - 1) * p
  const low = Math.floor(position)
  const high = Math.ceil(position)
  const a = sorted[low] ?? 0
  const b = sorted[high] ?? a
  return a + (b - a) * (position - low)
}

function memberValue(sample: CohortSample, metric: BaselineMetric): { value: number } | { reason: CohortExclusion } {
  const view = metric === 'active_ms' ? sample.time : sample.tokens
  if (view.actual.state !== 'observed' || view.unreportedAttemptIds.length > 0) return { reason: 'not_observed' }
  return view.actual.value >= 1 ? { value: view.actual.value } : { reason: 'zero_value' }
}

/** A ticket that baselines are chosen for: its cohort key and the server time of its first claim in the run. */
interface TicketSubject {
  ticketId: string
  key: CohortKey | null
  dispatchedAt: string | null
}

/** A dispatched subject with a cohort key. */
type CohortSubject = TicketSubject & { key: CohortKey; dispatchedAt: string }

/** A prior ticket's value for the cohort, or why it is not a member: the subject itself, no or another key, its actual. */
function memberOf(sample: CohortSample, subject: CohortSubject, metric: BaselineMetric): { value: number } | { reason: CohortExclusion } {
  const { key } = subject
  if (sample.ticketId === subject.ticketId) return { reason: 'subject' }
  if (sample.key === null) return { reason: 'no_cohort_key' }
  if (sample.key.workType !== key.workType || sample.key.size !== key.size || sample.key.risk !== key.risk) return { reason: 'cohort_mismatch' }
  return memberValue(sample, metric)
}

type Sampled = { ticketId: string; runId: string }
const byTicket = (a: Sampled, b: Sampled): number => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)

/**
 * Each prior ticket once (its latest sample, when it was accepted in several runs), in ticket order, as a qualified
 * member value or an exclusion.
 */
function cohortCandidates(samples: readonly CohortSample[], subject: CohortSubject, metric: BaselineMetric) {
  const latest = new Map<string, CohortSample>()
  for (const sample of [...samples].sort(byTicket)) {
    const held = latest.get(sample.ticketId)
    if (held === undefined || sample.basisAt > held.basisAt) latest.set(sample.ticketId, sample)
  }
  const excluded: CohortView['excluded'] = []
  const qualified: { sample: CohortSample; value: number }[] = []
  for (const sample of [...latest.values()].sort(byTicket)) {
    const member = memberOf(sample, subject, metric)
    if ('reason' in member) excluded.push({ ticketId: sample.ticketId, runId: sample.runId, reason: member.reason })
    else qualified.push({ sample, value: member.value })
  }
  return { excluded, qualified }
}

/**
 * The cohort of prior accepted tickets comparable to the subject (same work type, size and risk), for one metric:
 * the median of their observed actuals, with its sample size, spread (p25/p75) and Tukey outliers (shown, still in
 * the median, which they barely move). `samples` must be measured from records stored strictly before the subject's
 * dispatch (`CohortSource.samplesBefore`), so `frozenAt` (the latest record any member was built from) is before it.
 * Only observed, complete, non-zero actuals qualify (estimated, partial or missing ones are listed as excluded), each
 * ticket once, never the subject itself.
 */
export function buildCohort(samples: readonly CohortSample[], subject: TicketSubject, metric: BaselineMetric): CohortView {
  const empty: CohortView = { metric, key: subject.key, baseline: null, missingReason: null, members: [], outlierTicketIds: [], excluded: [] }
  const { key, dispatchedAt } = subject
  if (dispatchedAt === null) return { ...empty, missingReason: 'not_dispatched' }
  if (key === null) return { ...empty, missingReason: 'no_cohort_key' }
  const { excluded, qualified } = cohortCandidates(samples, { ...subject, key, dispatchedAt }, metric)
  if (qualified.length === 0) return { ...empty, missingReason: 'no_members', excluded }
  const sorted = qualified.map((q) => q.value).sort((a, b) => a - b)
  const p25 = quantile(sorted, 0.25)
  const p75 = quantile(sorted, 0.75)
  const fence = 1.5 * (p75 - p25)
  const members: CohortMemberView[] = qualified.map(({ sample, value }) => ({
    ticketId: sample.ticketId,
    runId: sample.runId,
    value,
    basisAt: sample.basisAt,
    outlier: sorted.length >= 4 && (value < p25 - fence || value > p75 + fence)
  }))
  const baseline: CohortBaseline = {
    baselineId: derivedStableId('baseline', JSON.stringify(['cohort', metric, key, members.map((m) => [m.ticketId, m.runId, m.value, m.basisAt])])),
    kind: 'cohort',
    metric,
    unit: BASELINE_UNITS[metric],
    cohort: key,
    statistic: 'median',
    value: quantile(sorted, 0.5),
    sampleSize: members.length,
    spread: sorted.length >= 2 ? { p25, p75 } : null,
    memberTicketIds: members.map((m) => m.ticketId),
    version: 1,
    frozenAt: members.reduce((at, m) => (m.basisAt > at ? m.basisAt : at), '')
  }
  return { ...empty, baseline, members, outlierTicketIds: members.filter((m) => m.outlier).map((m) => m.ticketId), excluded }
}

// ---------------------------------------------------------------------------------------------------------------
// Ticket baselines

/** A ticket's budget versions for one metric: the one pinned to its dispatch revision, and every other saved one. */
export interface BudgetCandidates {
  pinned: BudgetBaseline | null
  others: readonly BudgetBaseline[]
}

type Rejected = { baselineId: string; reason: BaselineRejection }[]

const byBaselineId = (a: { baselineId: string }, b: { baselineId: string }): number => (a.baselineId < b.baselineId ? -1 : a.baselineId > b.baselineId ? 1 : 0)

/**
 * The baseline T or K uses for a ticket: its pinned budget, else its cohort, by `selectBaseline` (which refuses a
 * budget frozen at or after dispatch and a cohort under the minimum sample). Every other budget version is listed:
 * one frozen at or after dispatch as `frozen_after_dispatch` (raising a budget mid-run never helps), the rest as
 * `superseded`. Without a dispatch nothing applies.
 */
export function ticketBaseline(
  metric: BaselineMetric,
  subject: TicketSubject,
  candidates: { budgets: BudgetCandidates; cohort: CohortView },
  policy: Pick<SpacePolicy, 'minCohortSampleSize'>
): BaselineSelection {
  const { budgets, cohort } = candidates
  const chosen: Baseline[] = [...(budgets.pinned === null ? [] : [budgets.pinned]), ...(cohort.baseline === null ? [] : [cohort.baseline])]
  const dispatchedAt = subject.dispatchedAt
  if (dispatchedAt === null) {
    const rejected: Rejected = [...chosen, ...budgets.others].map((c) => ({ baselineId: c.baselineId, reason: 'invalid_time' }))
    return { state: 'missing', reason: 'no_eligible_baseline', rejected: rejected.sort(byBaselineId) }
  }
  // Without a cohort key no cohort candidate exists, so the subject's key is only ever compared with a cohort built for it.
  const key: CohortKey = subject.key ?? { workType: 'implementation', size: 'medium', risk: 'routine' }
  const selection = selectBaseline(chosen, { ticketId: subject.ticketId, metric, cohort: key, dispatchedAt }, policy)
  const dispatched = Date.parse(dispatchedAt)
  const others: Rejected = budgets.others.map((b) => ({ baselineId: b.baselineId, reason: Date.parse(b.frozenAt) >= dispatched ? 'frozen_after_dispatch' : 'superseded' }))
  return { ...selection, rejected: [...selection.rejected, ...others].sort(byBaselineId) }
}

/** What a ticket's baselines are chosen from. */
interface TicketBaselineSources {
  subject: TicketSubject
  budgets: { T: BudgetCandidates; K: BudgetCandidates }
  cohorts: { T: CohortView; K: CohortView }
}

/** A ticket's E, T and K inputs with its baselines chosen. */
function ticketEfficiency(records: ScopeRecords, sources: TicketBaselineSources, policy: Pick<SpacePolicy, 'minCohortSampleSize'>, anomalies: EfficiencyAnomaly[]): TicketEfficiencyView {
  const { subject, budgets, cohorts } = sources
  const baselines = {
    T: ticketBaseline('active_ms', subject, { budgets: budgets.T, cohort: cohorts.T }, policy),
    K: ticketBaseline('tokens', subject, { budgets: budgets.K, cohort: cohorts.K }, policy)
  }
  return { ...scopeEfficiency(records, anomalies, baselines), dispatchedAt: subject.dispatchedAt, cohortKey: subject.key, cohorts }
}

// ---------------------------------------------------------------------------------------------------------------
// Runs

/**
 * `tokens_total` of a set of observations: cumulative streams at their latest report, deltas summed, a delivery both
 * host and agent sent once, nested sessions once (the run usage read's `usageCell`).
 */
export type TokenCell = (observations: readonly MetricObservation[]) => UsageCellView

/** One run's projection and its observations, each in the scopes it counts in. */
interface RunScopes {
  timing: RunTiming
  byTicket: Map<string, MetricObservation[]>
  bySprint: Map<string, MetricObservation[]>
  byAttempt: Map<string, MetricObservation[]>
  all: MetricObservation[]
  /** Activity observations the projection refused or could not place in time. */
  refused: Set<string>
  tokenCell: TokenCell
  /** The projection's anomalies, then the read's own (re-deliveries of other records, records of uncounted attempts). */
  anomalies: EfficiencyAnomaly[]
}

/** Timing anomalies that mean an activity record could not be placed, so the time it reports is unknown. */
const REFUSALS: Readonly<Partial<Record<TimingAnomaly['kind'], true>>> = { invalid_time: true, negative_span: true, inconsistent_span: true, not_an_interval: true }

/** Where the projection places a record: the ticket and sprint it counts in, and whether its attempt was counted. */
interface Placement {
  attemptTicket: ReadonlyMap<string, string>
  ticketSprint: ReadonlyMap<string, string | null>
  aliases: Readonly<Record<string, string | null>>
}

function placeObservation(observation: MetricObservation, placement: Placement, anomalies: EfficiencyAnomaly[]): { ticketId: string | null; sprintId: string | null } {
  const { attemptId, ticketId: named } = observation.scope
  const counted = attemptId === null ? undefined : placement.attemptTicket.get(attemptId)
  if (attemptId !== null && counted === undefined) {
    anomalies.push({ kind: 'unattributed', subject: observation.observationId, detail: `scoped to attempt ${attemptId}, which has no claim counted in this run` })
  }
  const ticketId = counted ?? named
  return { ticketId, sprintId: sprintOf(ticketId, observation.scope.sprintId, placement) }
}

/**
 * A ticket's sprint in the current plan; for a record of no such ticket, the sprint it names, an older revision's id
 * mapped to the current plan's (null: no counterpart; an id not listed is current).
 */
function sprintOf(ticketId: string | null, stated: string | null, placement: Placement): string | null {
  if (ticketId !== null && placement.ticketSprint.has(ticketId)) return placement.ticketSprint.get(ticketId) ?? null
  if (stated === null) return null
  return stated in placement.aliases ? (placement.aliases[stated] ?? null) : stated
}

/**
 * Projects the run's timing and places each observation (first deliveries stored by the cutoff) in the scopes it
 * counts in, the way the projection places spans: its attempt's ticket (else the ticket it names), that ticket's
 * sprint in the current plan (else the sprint it names, mapped like older sprint ids), and the run. Records of a
 * carry-forward attempt ran nothing and are left out. The projection's anomalies are kept, and the activity records
 * it refused are remembered, so their time reads unknown rather than absent.
 */
export function runScopes(timingInput: TimingInput, observations: readonly MetricObservation[], tokenCell: TokenCell): RunScopes {
  const timing = projectTiming(timingInput)
  const asOf = Date.parse(timing.asOf)
  const placement: Placement = {
    attemptTicket: new Map(timing.tickets.flatMap((t) => t.attempts.map((a) => [a.attemptId, t.ticketId] as const))),
    ticketSprint: new Map(timing.tickets.map((t) => [t.ticketId, t.sprintId])),
    aliases: timingInput.sprintAliases ?? {}
  }
  const carried = new Set(timing.carriedForwardAttemptIds)
  const refused = new Set(timing.anomalies.filter((a) => REFUSALS[a.kind] === true).map((a) => a.subject))
  const scopes: RunScopes = { timing, byTicket: new Map(), bySprint: new Map(), byAttempt: new Map(), all: [], refused, tokenCell, anomalies: [...timing.anomalies] }
  // The projection already lists re-deliveries of the activity records it was given.
  const delivery: EfficiencyAnomaly[] = []
  const activity = new Set(timingInput.activity.map((o) => o.observationId))
  const firsts = firstDeliveries(observations, delivery)
  scopes.anomalies.push(...delivery.filter((anomaly) => !activity.has(anomaly.subject)))
  for (const observation of firsts) {
    const { attemptId } = observation.scope
    if (Date.parse(observation.recordedAt) > asOf || (attemptId !== null && carried.has(attemptId))) continue
    const { ticketId, sprintId } = placeObservation(observation, placement, scopes.anomalies)
    scopes.all.push(observation)
    if (ticketId !== null) push(scopes.byTicket, ticketId, observation)
    if (sprintId !== null) push(scopes.bySprint, sprintId, observation)
    if (attemptId !== null) push(scopes.byAttempt, attemptId, observation)
  }
  return scopes
}

function recordsOf(scope: EfficiencyScope, parts: Omit<ScopeRecords, 'scope' | 'tokens' | 'refused'>, scopes: RunScopes): ScopeRecords {
  const byAttempt = new Map<string, UsageCellView>()
  for (const attempt of parts.attempts) byAttempt.set(attempt.attemptId, scopes.tokenCell(scopes.byAttempt.get(attempt.attemptId) ?? []))
  const overhead = scopes.tokenCell(parts.observations.filter((o) => o.scope.attemptId === null))
  return { scope, ...parts, refused: scopes.refused, tokens: { byAttempt, overhead, combined: scopes.tokenCell(parts.observations) } }
}

function ticketRecords(ticket: TicketTiming, scopes: RunScopes): ScopeRecords {
  const scope: EfficiencyScope = { level: 'ticket', ticketId: ticket.ticketId, sprintId: ticket.sprintId }
  return recordsOf(scope, { attempts: ticket.attempts, effort: ticket.effort, waits: ticket.waits, observations: scopes.byTicket.get(ticket.ticketId) ?? [] }, scopes)
}

/** What a ticket was planned as, from the revision it was first dispatched under (else the run's current one). */
export interface PlannedTicket {
  cohortKey: CohortKey | null
  /** An acceptance node verifies its sprint; it is never a cohort member. */
  acceptance: boolean
}

/** The records a sample's value is built from: activity spans, waits and token reports. */
const ACTIVITY_METRICS: Readonly<Record<string, true>> = { active_ms: true, wait_ms: true }
const VALUE_METRICS: Readonly<Record<string, true>> = { ...ACTIVITY_METRICS, ...TOKEN_METRICS }

/** The latest server time among a ticket's attempt times and the records its value was built from. */
function basisOf(ticket: TicketTiming, observations: readonly MetricObservation[]): string {
  let basis = ''
  for (const attempt of ticket.attempts) {
    for (const at of [attempt.claimedAt, attempt.submittedAt, attempt.decidedAt, attempt.endedAt]) if (at !== null && at > basis) basis = at
  }
  for (const observation of observations) if (VALUE_METRICS[observation.metric] === true && observation.recordedAt > basis) basis = observation.recordedAt
  return basis
}

/** Every work ticket of the run with a standing accepted attempt, as a cohort sample measured at the scopes' cutoff. */
function runSamples(scopes: RunScopes, plan: Readonly<Record<string, PlannedTicket>>): CohortSample[] {
  const samples: CohortSample[] = []
  for (const ticket of scopes.timing.tickets) {
    const planned = plan[ticket.ticketId]
    if (planned === undefined || planned.acceptance || !ticket.attempts.some((a) => a.outcome === 'accepted' && !a.superseded)) continue
    const records = ticketRecords(ticket, scopes)
    const view = scopeEfficiency(records, [])
    samples.push({ ticketId: ticket.ticketId, runId: scopes.timing.runId, key: planned.cohortKey, time: view.time, tokens: view.tokens, basisAt: basisOf(ticket, records.observations) })
  }
  return samples
}

/** A run's records, enough to measure its accepted tickets as cohort samples at any instant up to its cutoff. */
export interface CohortRunInput {
  /** The timing projection's input for the run as of the cutoff. */
  timing: TimingInput
  /** The run's observations in ledger order. */
  observations: readonly MetricObservation[]
  plan: Readonly<Record<string, PlannedTicket>>
}

/** A run's cohort samples as a subject dispatched at `dispatchedAt` sees them. */
export interface CohortSource {
  samplesBefore(dispatchedAt: string): CohortSample[]
}

interface TicketHistory {
  /** The first acceptance of one of its own (not carried-forward) attempts, epoch ms. */
  acceptedAt: number
  /** The latest event of its attempts or stored record feeding its value, epoch ms. */
  changedAt: number
}

/** The ticket an event concerns, through its attempt's claim (carry-forward claims ran nothing and are left out). */
function ticketOfEvent(event: TimingEvent, attempts: ReadonlyMap<string, string>): string | undefined {
  if (event.kind === 'attempt_claimed') return event.carriedForward ? undefined : event.ticketId
  if ('attemptId' in event) return attempts.get(event.attemptId)
  return 'ticketId' in event ? event.ticketId : undefined
}

/** Each ticket's first own acceptance and the latest of its lifecycle events, by the cutoff (epoch ms). */
function eventHistories(events: readonly TimingEvent[], asOf: number): { accepted: Map<string, number>; changed: Map<string, number> } {
  const attempts = new Map<string, string>()
  for (const event of events) if (event.kind === 'attempt_claimed' && !event.carriedForward) attempts.set(event.attemptId, event.ticketId)
  const accepted = new Map<string, number>()
  const changed = new Map<string, number>()
  for (const event of events) {
    const at = Date.parse(event.at)
    const ticketId = ticketOfEvent(event, attempts)
    if (ticketId === undefined || !(at <= asOf)) continue
    changed.set(ticketId, Math.max(changed.get(ticketId) ?? at, at))
    if (event.kind === 'attempt_accepted') accepted.set(ticketId, Math.min(accepted.get(ticketId) ?? at, at))
  }
  return { accepted, changed }
}

/**
 * When a record could first change what a projection as of an instant counts: its storage, and for an activity span
 * also its end (a projection clamps a span to its cutoff, so a span stored earlier but ending later reads shorter).
 */
function changeAt(observation: MetricObservation): number {
  const recorded = Date.parse(observation.recordedAt)
  return ACTIVITY_METRICS[observation.metric] === true ? Math.max(recorded, Date.parse(observation.observedAt)) : recorded
}

/**
 * The keys through which an activity record can change spans of other scopes: its claim keys (one stream, or a host
 * record dropping the agent's), and `nested` for every actor in a usage nesting (an inclusive parent's span loses its
 * descendants' time, whichever scope they report in).
 */
function interactionKeys(observation: MetricObservation, nestedActors: ReadonlySet<string>): string[] {
  const keys = claimKeys(observation)
  return nestedActors.has(observation.source.actor ?? '') ? [...keys, 'nested'] : keys
}

/** Every actor of an `active_ms` usage nesting: each child that names a parent, and the parent. */
function nestedActorsOf(observations: readonly MetricObservation[]): Set<string> {
  const actors = new Set<string>()
  for (const observation of observations) {
    const parent = observation.usage?.parentActor
    const actor = observation.source.actor ?? ''
    if (observation.metric !== 'active_ms' || parent === undefined || parent === null || parent === actor) continue
    actors.add(actor)
    actors.add(parent)
  }
  return actors
}

/**
 * The latest change, per record, of anything that can change what it counts: the record itself, and for an activity
 * record every activity record of the run sharing an interaction key with it (a run-level span of another identity
 * cannot change it, so it is not one).
 */
function changesOf(observations: readonly MetricObservation[]): (observation: MetricObservation) => number {
  const nestedActors = nestedActorsOf(observations)
  const latestByKey = new Map<string, number>()
  for (const observation of observations) {
    if (ACTIVITY_METRICS[observation.metric] !== true) continue
    const at = changeAt(observation)
    for (const key of interactionKeys(observation, nestedActors)) latestByKey.set(key, Math.max(latestByKey.get(key) ?? at, at))
  }
  return (observation) => {
    let latest = changeAt(observation)
    if (ACTIVITY_METRICS[observation.metric] !== true) return latest
    for (const key of interactionKeys(observation, nestedActors)) latest = Math.max(latest, latestByKey.get(key) ?? latest)
    return latest
  }
}

/**
 * Per ticket of the run that was ever accepted: its first acceptance and the last time anything feeding its sample
 * changed (its lifecycle events, and the latest change of each of its value records).
 */
function ticketHistories(scopes: RunScopes, events: readonly TimingEvent[]): Map<string, TicketHistory> {
  const { accepted, changed } = eventHistories(events, Date.parse(scopes.timing.asOf))
  const changeOf = changesOf(scopes.all)
  const histories = new Map<string, TicketHistory>()
  for (const [ticketId, acceptedAt] of accepted) {
    let changedAt = changed.get(ticketId) ?? acceptedAt
    for (const observation of scopes.byTicket.get(ticketId) ?? []) {
      if (VALUE_METRICS[observation.metric] === true) changedAt = Math.max(changedAt, changeOf(observation))
    }
    histories.set(ticketId, { acceptedAt, changedAt })
  }
  return histories
}

/**
 * A run's cohort samples as of any dispatch: each accepted ticket measured only from records stored strictly before it
 * (the projection as of one millisecond earlier: later records, ratings, reads and supersessions are ignored, never
 * disqualifying), so the samples a subject sees are the same at every cutoff from its dispatch on. The samples at the
 * cutoff are reused when nothing that feeds a candidate's sample changed at or after the dispatch; otherwise the run
 * is projected once more for that instant (cached per instant).
 */
export function cohortSource(run: CohortRunInput, tokenCell: TokenCell, atCutoff?: RunScopes): CohortSource {
  const scopes = atCutoff ?? runScopes(run.timing, run.observations, tokenCell)
  const current = new Map(runSamples(scopes, run.plan).map((sample) => [sample.ticketId, sample]))
  const histories = [...ticketHistories(scopes, run.timing.events)].filter(([ticketId]) => run.plan[ticketId]?.acceptance === false)
  const projected = new Map<number, CohortSample[]>()
  return {
    samplesBefore(dispatchedAt: string): CohortSample[] {
      const before = Date.parse(dispatchedAt)
      const candidates = histories.filter(([, history]) => history.acceptedAt < before)
      const reused = candidates.flatMap(([ticketId, history]) => {
        const sample = current.get(ticketId)
        return sample !== undefined && history.changedAt < before ? [sample] : []
      })
      if (reused.length === candidates.length) return reused
      const known = projected.get(before) ?? runSamples(runScopes({ ...run.timing, asOf: iso(before - 1) }, run.observations, tokenCell), run.plan)
      projected.set(before, known)
      return known
    }
  }
}

export interface RunEfficiencyInput extends CohortRunInput {
  /** Each ticket's budget versions per metric. */
  budgets: Readonly<Record<string, { active_ms: BudgetCandidates; tokens: BudgetCandidates }>>
  /** The project's other runs, read at the same cutoff, for cohorts. */
  otherRuns: readonly CohortRunInput[]
  /** Limits the ticket list to these tickets. */
  ticketIds?: readonly string[]
}

const NO_BUDGET: BudgetCandidates = { pinned: null, others: [] }

/**
 * A run's E, T and K inputs as of the cutoff: per ticket with its baselines (its pinned budget, else the cohort of
 * tickets accepted before its dispatch, measured from records stored before it), per sprint and for the run.
 * `prebuilt`, when given, are the other runs' cohort sources (`cohortSource` of each of `otherRuns`) built once by a
 * read that grades several runs at one cutoff; they stand in for `otherRuns`, with the same result.
 */
export function runEfficiency(
  input: RunEfficiencyInput,
  tokenCell: TokenCell,
  policy: Pick<SpacePolicy, 'minCohortSampleSize'>,
  prebuilt?: readonly CohortSource[]
): RunEfficiencyView {
  const scopes = runScopes(input.timing, input.observations, tokenCell)
  const { timing, anomalies } = scopes
  const sources = [cohortSource(input, tokenCell, scopes), ...(prebuilt ?? input.otherRuns.map((run) => cohortSource(run, tokenCell)))]
  const wanted = input.ticketIds === undefined ? null : new Set(input.ticketIds)
  const tickets = timing.tickets
    .filter((ticket) => wanted === null || wanted.has(ticket.ticketId))
    .map((ticket): TicketEfficiencyView => {
      const dispatchedAt = ticket.firstClaimAt
      const subject: TicketSubject = { ticketId: ticket.ticketId, key: input.plan[ticket.ticketId]?.cohortKey ?? null, dispatchedAt }
      const samples = dispatchedAt === null || subject.key === null ? [] : sources.flatMap((source) => source.samplesBefore(dispatchedAt))
      const budgets = input.budgets[ticket.ticketId]
      const baselineSources: TicketBaselineSources = {
        subject,
        budgets: { T: budgets?.active_ms ?? NO_BUDGET, K: budgets?.tokens ?? NO_BUDGET },
        cohorts: { T: buildCohort(samples, subject, 'active_ms'), K: buildCohort(samples, subject, 'tokens') }
      }
      return ticketEfficiency(ticketRecords(ticket, scopes), baselineSources, policy, anomalies)
    })
  const sprints = timing.sprints.map((sprint): ScopeEfficiencyView => {
    const members = new Set(sprint.ticketIds)
    const attempts = timing.tickets.filter((t) => members.has(t.ticketId)).flatMap((t) => t.attempts)
    const parts = { attempts, effort: sprint.effort, waits: sprint.waits, observations: scopes.bySprint.get(sprint.sprintId) ?? [] }
    return scopeEfficiency(recordsOf({ level: 'sprint', sprintId: sprint.sprintId }, parts, scopes), anomalies)
  })
  const runParts = { attempts: timing.tickets.flatMap((t) => t.attempts), effort: timing.effort, waits: timing.waits, observations: scopes.all }
  const run = scopeEfficiency(recordsOf({ level: 'run' }, runParts, scopes), anomalies)
  return { runId: timing.runId, cutoff: timing.asOf, tickets, sprints, run, anomalies }
}
