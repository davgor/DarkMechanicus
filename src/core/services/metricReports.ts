/**
 * Metric ingestion from agent sessions and external MCP hosts, and the run's usage read with its coverage.
 *
 * Who reports what: a worker reports only the attempt its live claim token proves (a stale or expired claim is refused
 * like any late write); an orchestrator reports any attempt of a run it owns, so a host that relays usage needs no
 * built-in chat adapter; orchestration, review and verification overhead goes to the run's own bucket. Human feedback
 * (ratings, rescue time) and server-derived measures are never accepted from an agent: they are the desktop's and the
 * server's, and are refused as `unauthorized`.
 *
 * Delivery: each report's identity (its scope, source, metric and cumulative `sequence` or source `eventId`) derives
 * its observation id, so a retried delivery lands on the stored record and is never counted twice, and the same
 * identity with another payload is a `conflict`. A stream (scope, source and metric) keeps one accumulation, and a
 * cumulative stream never goes down with a later sequence. Reads count a cumulative stream's latest report and add
 * deltas, and count usage nested under an inclusive parent once.
 */
import {
  AGENT_METRIC_SOURCES,
  type AttemptUsageView,
  type GetRunMetricsInput,
  type MetricReport,
  OVERHEAD_KINDS,
  type OverheadKind,
  type RecordAttemptMetricsInput,
  type RecordMetricsResultView,
  type RecordRunMetricsInput,
  RUN_METRICS_OBSERVATION_LIMIT,
  type RunMetricsView,
  type UsageCellView,
  type UsageCoverageState,
  USAGE_METRICS,
  type UsageMetric,
  type UsageTotalView
} from '../../shared/domain/metrics'
import {
  type Measurement,
  METRIC_DEFINITIONS,
  type MetricObservation,
  type MetricScope,
  type ObservationMissingReason
} from '../../shared/domain/space'
import { DEFECT_AUTHORITY } from '../../shared/domain/performance'
import type { AttemptState } from '../../shared/domain/status'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { derivedStableId } from '../ids'
import { defectChangesCharging } from '../space/defects'
import { settleLeases, verifyClaim } from './attempts'
import { loadAttempt, loadBundle, requireRun } from './execution'
import { listObservations, type ObservationInput, recordObservations } from './observations'
import { requireOwnedRun } from './runs'

/** Attribute names the server sets on a reported observation; a report may not set them itself. */
const SOURCE_EVENT = 'sourceEvent'
const OVERHEAD = 'overhead'

/** The bucket of one run a report is recorded in. */
type RunScope = MetricScope & { runId: string }

/** A report as the observation to record, with the id every delivery of it gets. */
type Delivery = ObservationInput & { observationId: string }

/** A measurement that holds a number (observed or estimated). */
type Numeric = Exclude<Measurement, { state: 'missing' }>

/**
 * Refuses what an agent may never report, as `unauthorized`: another source than `agent` or `host` (a person's
 * feedback or a server derivation), or a metric only a person or the server records.
 */
function refuseForeignReports(reports: readonly MetricReport[]): void {
  reports.forEach((report, index) => {
    const allowed = METRIC_DEFINITIONS[report.metric].sources
    if (!AGENT_METRIC_SOURCES.includes(report.source.kind)) {
      fail(
        'unauthorized',
        `Report ${index}: an agent session reports only as source agent or host; ${report.source.kind} measures come from ${report.source.kind === 'human' ? 'a person in the desktop app' : 'Dark Mechanicus itself'}.`,
        { index, sourceKind: report.source.kind }
      )
    }
    if (!allowed.some((source) => AGENT_METRIC_SOURCES.includes(source))) {
      const owner = allowed.includes('human') ? 'a person in the desktop app' : 'Dark Mechanicus from its lifecycle records'
      fail('unauthorized', `Report ${index}: ${report.metric} is recorded only by ${owner}, never by an agent.`, {
        index,
        metric: report.metric
      })
    }
  })
}

/**
 * The id every delivery of this report gets, wherever and however often it is sent: its bucket (scope and overhead
 * kind), source kind and actor, metric, and cumulative sequence or source event.
 */
function deliveryId(scope: MetricScope, report: MetricReport, overhead: OverheadKind | null): string {
  const position = report.accumulation === 'cumulative' ? ['sequence', report.sequence] : ['event', report.eventId]
  const { level, epicId, sprintId, runId, ticketId, attemptId } = scope
  const identity = [level, epicId, sprintId, runId, ticketId, attemptId, overhead, report.source.kind, report.source.actor, report.metric, ...position]
  return derivedStableId('metricObservation', JSON.stringify(['metric-delivery', ...identity]))
}

function observationOf(scope: RunScope, report: MetricReport, overhead: OverheadKind | null, index: number): Delivery {
  const attributes = report.attributes ?? {}
  for (const reserved of [SOURCE_EVENT, OVERHEAD, DEFECT_AUTHORITY.attribute]) {
    if (Object.hasOwn(attributes, reserved)) {
      fail('invalid_input', `Report ${index}: the attribute ${reserved} is set by the server.`, { index, attribute: reserved })
    }
  }
  return {
    observationId: deliveryId(scope, report, overhead),
    metric: report.metric,
    unit: report.unit,
    scope,
    source: { kind: report.source.kind, actor: report.source.actor },
    measurement: report.measurement,
    accumulation: report.accumulation,
    sequence: report.sequence ?? null,
    observedAt: report.observedAt,
    attributes: {
      ...attributes,
      ...(report.eventId === undefined ? {} : { [SOURCE_EVENT]: report.eventId }),
      ...(overhead === null ? {} : { [OVERHEAD]: overhead })
    },
    evidence: report.evidence ?? [],
    ...(report.cause === undefined ? {} : { cause: report.cause }),
    ...(report.usage === undefined ? {} : { usage: report.usage })
  }
}

/**
 * One stream of one metric in one bucket (scope and overhead kind): the actor's reports, whether its host or the agent
 * itself sent them, so a cumulative sequence counts once and a delivery both sent is deduplicated.
 */
function streamKey(observation: Pick<MetricObservation, 'scope' | 'source' | 'metric' | 'attributes'>): string {
  const { scope, source } = observation
  const overhead = observation.attributes[OVERHEAD] ?? null
  return JSON.stringify([scope.level, scope.sprintId, scope.runId, scope.ticketId, scope.attemptId, overhead, source.actor, observation.metric])
}

function numberOf(measurement: Measurement): number | null {
  return measurement.state === 'missing' ? null : measurement.value
}

/** Why `report` cannot join a stream that holds `earlier`, or null: another accumulation, or a cumulative regression. */
function streamDefect(earlier: MetricObservation, report: ObservationInput): string | null {
  if (earlier.accumulation !== report.accumulation) {
    return `stream ${report.source.actor} reports ${report.metric} as ${earlier.accumulation}; a ${report.accumulation} report would count it twice`
  }
  const [before, after] = [numberOf(earlier.measurement), numberOf(report.measurement)]
  if (report.accumulation !== 'cumulative' || earlier.sequence === report.sequence || before === null || after === null) {
    return null
  }
  const ordered = (earlier.sequence ?? 0) < (report.sequence ?? 0) ? before <= after : before >= after
  return ordered
    ? null
    : `cumulative ${report.metric} ${after} at sequence ${report.sequence} disagrees with ${before} at sequence ${earlier.sequence}; a stream total never goes down`
}

/**
 * Refuses a report that would make a stream count twice or go backwards: a stream keeps the accumulation it started
 * with, and a cumulative value is never below an earlier sequence's nor above a later one's. A resent sequence is
 * left to the ledger, which keeps the stored record or refuses a different payload as a `conflict`.
 */
function checkStreams(stored: readonly MetricObservation[], fresh: readonly Delivery[]): void {
  const streams = new Map<string, MetricObservation[]>()
  // A stream holds one accumulation, so a delta or event is checked against the stream's first report only.
  const earlierOf = (item: MetricObservation): MetricObservation[] => {
    const key = streamKey(item)
    const stream = streams.get(key)
    if (stream === undefined) {
      streams.set(key, [item])
      return []
    }
    const earlier = item.accumulation === 'cumulative' ? stream.slice() : stream.slice(0, 1)
    stream.push(item)
    return earlier
  }
  stored.forEach(earlierOf)
  fresh.forEach((report, index) => {
    for (const earlier of earlierOf({ ...report, recordedAt: '' })) {
      const defect = streamDefect(earlier, report)
      if (defect !== null) {
        fail('invalid_input', `Report ${index}: ${defect}.`, { index, metric: report.metric })
      }
    }
  })
}

/**
 * An escaped defect record that changes charging (an attributed report, a duplicate, a reassessment, a fix, a
 * withdrawal) is taken only from a session holding `attempt.review` (an orchestrator or reviewer), which the server
 * stamps on it (`DEFECT_AUTHORITY`); a worker that sends one is refused, so no worker can blame, clear or redirect a
 * defect. A candidate or unassigned report charges no one and is taken from any reporter.
 */
function withDefectAuthority(ctx: Ctx, input: Delivery, index: number): Delivery {
  if (input.metric !== 'escaped_defect' || !defectChangesCharging(input.attributes)) {
    return input
  }
  if (!ctx.session.capabilities.has('attempt.review')) {
    fail('unauthorized', `Report ${index}: an escaped_defect ${String(input.attributes.defectEvent)} that changes charging is recorded only by a person, an orchestrator or a reviewer.`, {
      index
    })
  }
  return { ...input, attributes: { ...input.attributes, [DEFECT_AUTHORITY.attribute]: DEFECT_AUTHORITY.review } }
}

/** Records the reports in `scope`'s bucket: all of them, or none on the first refusal. */
function recordReports(ctx: Ctx, scope: RunScope, reports: readonly MetricReport[], overhead: OverheadKind | null): RecordMetricsResultView {
  const inputs = reports.map((report, index) => withDefectAuthority(ctx, observationOf(scope, report, overhead, index), index))
  const runId = scope.runId
  const stored = listObservations(ctx.db, { runId, ...(scope.attemptId === null ? {} : { attemptId: scope.attemptId }) }).filter(
    (observation) => observation.scope.level === scope.level
  )
  checkStreams(stored, inputs)
  const result = recordObservations(ctx, inputs)
  return { observations: result.observations, created: result.created, unchanged: result.unchanged }
}

/**
 * Records usage of one attempt. With a claim token the claim must be live and the attempt's latest (`stale_claim` or
 * `expired_claim` otherwise), so a worker reports only what it holds; a worker without one is refused. An
 * orchestrator may omit it for any attempt, in any state, of a run this machine owns.
 */
export function recordAttemptMetrics(ctx: Ctx, input: RecordAttemptMetricsInput): RecordMetricsResultView {
  requireCapability(ctx.session, 'metrics.report')
  ctx.assertBranch()
  refuseForeignReports(input.reports)
  if (input.claimToken !== undefined) {
    settleLeases(ctx, input.attemptId)
  }
  return ctx.db.tx(() => {
    const attempt = loadAttempt(ctx, input.attemptId)
    const run = requireRun(ctx, attempt.run_id)
    if (input.claimToken !== undefined) {
      verifyClaim(ctx, attempt, input.claimToken)
    } else if (ctx.session.role === 'worker') {
      fail('unauthorized', 'A worker reports usage only for the attempt it holds: present that attempt’s claim token.', {
        attemptId: attempt.id
      })
    } else {
      requireOwnedRun(ctx, run.id)
    }
    const sprint = loadBundle(ctx, attempt.revision_id).sprints.find((item) => item.ticketIds.includes(attempt.ticket_id))
    const scope: RunScope = {
      level: 'attempt',
      epicId: run.epic_id,
      sprintId: sprint?.id ?? null,
      runId: run.id,
      ticketId: attempt.ticket_id,
      attemptId: attempt.id
    }
    return recordReports(ctx, scope, input.reports, null)
  })
}

/** Records run-level overhead in the bucket of a run this machine owns, or of one of its sprints. */
export function recordRunMetrics(ctx: Ctx, input: RecordRunMetricsInput): RecordMetricsResultView {
  requireCapability(ctx.session, 'metrics.report_run')
  ctx.assertBranch()
  refuseForeignReports(input.reports)
  return ctx.db.tx(() => {
    const run = requireOwnedRun(ctx, input.runId)
    const scope: RunScope = {
      level: 'run',
      epicId: run.epic_id,
      sprintId: input.sprintId ?? null,
      runId: run.id,
      ticketId: null,
      attemptId: null
    }
    return recordReports(ctx, scope, input.reports, input.overhead)
  })
}

/** Actors whose usage is already inside an inclusive report of an ancestor, so counting them again would double it. */
function nestedActors(observations: readonly MetricObservation[]): Set<string> {
  const inclusive = new Set(observations.filter((item) => item.usage?.coverage === 'inclusive').map((item) => item.source.actor ?? ''))
  const parents = new Map<string, string>()
  for (const item of observations) {
    const parent = item.usage?.parentActor ?? null
    if (parent !== null) {
      parents.set(item.source.actor ?? '', parent)
    }
  }
  const nested = new Set<string>()
  for (const actor of parents.keys()) {
    const visited = new Set([actor])
    for (let parent = parents.get(actor); parent !== undefined && !visited.has(parent); parent = parents.get(parent)) {
      if (inclusive.has(parent)) {
        nested.add(actor)
        break
      }
      visited.add(parent)
    }
  }
  return nested
}

/**
 * One report per delivery position of a stream (its cumulative sequence or its source event). When an agent and its
 * host both report the same delivery of one actor, the host's telemetry wins over the agent's own account.
 */
function deduplicated(stream: readonly MetricObservation[]): MetricObservation[] {
  const kept = new Map<string, MetricObservation>()
  for (const item of stream) {
    const position = item.accumulation === 'cumulative' ? `sequence ${item.sequence}` : `event ${item.attributes[SOURCE_EVENT] ?? item.observationId}`
    const held = kept.get(position)
    if (held === undefined || (held.source.kind !== 'host' && item.source.kind === 'host')) {
      kept.set(position, item)
    }
  }
  return [...kept.values()]
}

interface StreamTotal {
  /** The numbers counted (a lower bound when `gap` is set); null when none. */
  value: number | null
  estimated: boolean
  /** Why part of the stream is unknown: the reason of a missing delta, or of a missing latest cumulative report. */
  gap: ObservationMissingReason | null
}

function gapOf(missing: readonly MetricObservation[]): ObservationMissingReason | null {
  const reasons = missing
    .map((item) => item.measurement)
    .filter((measurement): measurement is Extract<Measurement, { state: 'missing' }> => measurement.state === 'missing')
    .map((measurement) => measurement.reason)
  if (reasons.length === 0) {
    return null
  }
  return reasons.find((reason) => reason !== 'host_unavailable') ?? 'host_unavailable'
}

/**
 * A stream's contribution: its latest cumulative report (a missing latest one is a gap, with the latest number as the
 * lower bound), or the sum of its deltas and events (any missing one is a gap).
 */
function streamTotal(stream: readonly MetricObservation[]): StreamTotal {
  const reports = deduplicated(stream)
  const isNumeric = (item: MetricObservation): item is MetricObservation & { measurement: Numeric } => item.measurement.state !== 'missing'
  const bySequence = (a: MetricObservation, b: MetricObservation): number => (a.sequence ?? 0) - (b.sequence ?? 0)
  const cumulative = reports[0]?.accumulation === 'cumulative'
  const counted = cumulative ? reports.filter(isNumeric).sort(bySequence).slice(-1) : reports.filter(isNumeric)
  const latest = cumulative ? [...reports].sort(bySequence).at(-1) : undefined
  const missing = cumulative ? [latest].filter((item): item is MetricObservation => item !== undefined && !isNumeric(item)) : reports.filter((item) => !isNumeric(item))
  return {
    value: counted.length === 0 ? null : counted.reduce((sum, item) => sum + item.measurement.value, 0),
    estimated: counted.some((item) => item.measurement.state === 'estimated'),
    gap: gapOf(missing)
  }
}

function coverageOf(value: number | null, estimated: boolean, gaps: readonly ObservationMissingReason[]): UsageCoverageState {
  if (gaps.length > 0) {
    // A stream that said part of its usage is known to exist but not counted yet (a host session still working) is a
    // gap even before any number arrived, so the totals never read complete over it.
    if (value !== null || gaps.includes('partial_coverage')) {
      return 'partial'
    }
    return gaps.every((gap) => gap === 'host_unavailable') ? 'unavailable' : 'unreported'
  }
  if (value === null) {
    return 'unreported'
  }
  return estimated ? 'estimated' : 'observed'
}

/**
 * One bucket's (or the whole run's) total of one metric with how much of it was reported. Usage of an actor nested
 * under an inclusive ancestor among the observations given is already inside that report and is not counted again.
 */
export function usageCell(observations: readonly MetricObservation[], metric: UsageMetric): UsageCellView {
  const relevant = observations.filter((item) => item.metric === metric)
  const skip = nestedActors(relevant)
  const streams = new Map<string, MetricObservation[]>()
  for (const item of relevant.filter((observation) => !skip.has(observation.source.actor ?? ''))) {
    const key = streamKey(item)
    const stream = streams.get(key)
    if (stream === undefined) streams.set(key, [item])
    else stream.push(item)
  }
  const totals = [...streams.values()].map(streamTotal)
  const numbers = totals.map((total) => total.value).filter((value): value is number => value !== null)
  const value = numbers.length === 0 ? null : numbers.reduce((sum, item) => sum + item, 0)
  const gaps = totals.map((total) => total.gap).filter((gap): gap is ObservationMissingReason => gap !== null)
  const coverage = coverageOf(value, totals.some((total) => total.estimated), gaps)
  return { metric, unit: METRIC_DEFINITIONS[metric].unit, coverage, value }
}

/**
 * Whether a run total is complete: only when every executing attempt reported fully and the overhead bucket holds no
 * known gap. Otherwise it is missing: `partial_coverage` when anything was reported, `host_unavailable` when every
 * gap is a host that cannot report it, else `not_reported`.
 */
function totalMeasurement(counts: Record<UsageCoverageState, number>, run: UsageCellView, overhead: UsageCellView): Measurement {
  const overheadGap = overhead.coverage === 'partial' || overhead.coverage === 'unavailable'
  const gaps = counts.partial + counts.unavailable + counts.unreported + (overheadGap ? 1 : 0)
  if (run.value === null || gaps > 0) {
    const reported = counts.observed + counts.estimated + counts.partial + (overhead.value === null ? 0 : 1)
    const reason = reported > 0 ? 'partial_coverage' : gaps > 0 && counts.unreported === 0 ? 'host_unavailable' : 'not_reported'
    return { state: 'missing', reason }
  }
  if (run.coverage === 'estimated') {
    return { state: 'estimated', value: run.value, method: 'sum including estimated reports' }
  }
  return { state: 'observed', value: run.value }
}

/**
 * The run total of one metric. Its value counts every executing attempt's and the overhead bucket's usage once,
 * with nesting resolved across the whole run (a child attempt's usage inside an inclusive parent elsewhere is not
 * added again). Overhead adds to the sum but cannot complete missing attempts.
 */
function usageTotal(metric: UsageMetric, attempts: readonly AttemptUsageView[], overhead: UsageCellView, run: UsageCellView): UsageTotalView {
  const counts: Record<UsageCoverageState, number> = { observed: 0, estimated: 0, partial: 0, unavailable: 0, unreported: 0 }
  for (const attempt of attempts) {
    counts[attempt.usage.find((cell) => cell.metric === metric)?.coverage ?? 'unreported'] += 1
  }
  return {
    metric,
    unit: METRIC_DEFINITIONS[metric].unit,
    measurement: totalMeasurement(counts, run, overhead),
    reportedValue: run.value,
    attempts: counts,
    overhead: overhead.value,
    overheadCoverage: overhead.coverage
  }
}

/** Every executing attempt's and the overhead bucket's observations, which the run totals count. */
function countedObservations(observations: readonly MetricObservation[], executing: ReadonlySet<string>): MetricObservation[] {
  return observations.filter((item) => item.scope.level === 'run' || (item.scope.attemptId !== null && executing.has(item.scope.attemptId)))
}

/**
 * A run's usage: each executing attempt's (every claimed work attempt, whatever became of it) and the run overhead
 * bucket's, per token and active-time metric, with the totals and their coverage. Carry-forward attempts ran nothing
 * and are listed apart. The stored observations come with their provenance when asked for.
 */
export function getRunMetrics(ctx: Ctx, input: GetRunMetricsInput): RunMetricsView {
  requireCapability(ctx.session, 'read')
  const run = requireRun(ctx, input.runId)
  const rows = ctx.db.all<{ id: string; ticket_id: string; number: number; state: AttemptState; kind: string }>(
    'SELECT id, ticket_id, number, state, kind FROM attempts WHERE run_id = ? ORDER BY created_at, number',
    run.id
  )
  if (input.attemptId !== undefined && !rows.some((row) => row.id === input.attemptId)) {
    fail('not_found', `Attempt ${input.attemptId} is not an attempt of run ${run.id}.`, { attemptId: input.attemptId })
  }
  const observations = listObservations(ctx.db, { runId: run.id })
  const executing = rows.filter((row) => row.kind !== 'carry_forward')
  const attempts = executing.map((row): AttemptUsageView => {
    const own = observations.filter((item) => item.scope.attemptId === row.id)
    return { attemptId: row.id, ticketId: row.ticket_id, number: row.number, state: row.state, usage: USAGE_METRICS.map((metric) => usageCell(own, metric)) }
  })
  const runLevel = observations.filter((item) => item.scope.level === 'run')
  const overhead = USAGE_METRICS.map((metric) => usageCell(runLevel, metric))
  const overheadByKind = OVERHEAD_KINDS.flatMap((kind) => {
    const own = runLevel.filter((item) => item.attributes[OVERHEAD] === kind)
    return own.length === 0 ? [] : [{ overhead: kind, usage: USAGE_METRICS.map((metric) => usageCell(own, metric)) }]
  })
  const counted = countedObservations(observations, new Set(executing.map((row) => row.id)))
  const listed = input.attemptId === undefined ? observations : observations.filter((item) => item.scope.attemptId === input.attemptId)
  return {
    runId: run.id,
    epicId: run.epic_id,
    attempts,
    carriedForward: rows.filter((row) => row.kind === 'carry_forward').map((row) => row.id),
    overhead,
    overheadByKind,
    totals: overhead.map((cell) => usageTotal(cell.metric, attempts, cell, usageCell(counted, cell.metric))),
    observationCount: listed.length,
    observations: input.includeObservations === true ? listed.slice(0, RUN_METRICS_OBSERVATION_LIMIT) : null
  }
}
