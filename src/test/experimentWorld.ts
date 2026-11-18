/**
 * Worlds for tests of retro experiments and measured findings (DM-184, DM-185). Not shipped.
 *
 * A started run whose sprint 1 work tickets are claimed, measured (host spans and tokens, and effort classified as
 * productive or corrective, through `recordAttemptMetrics`), submitted and reviewed through the real services, in a
 * repository environment (so its run history can be exported, copied to another machine and imported there). Experiment
 * inputs come from the checked-in fixtures (`src/core/plan/fixtures/experiments/`, read in place, `{{tokens}}` filled
 * from the world). The clock and ids are fixed, so every world is the same and nothing is shared between worlds.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DomainError } from '../core/errors'
import { parseInput, sprintReportInput } from '../core/schemas'
import { acceptAttempt, heartbeatAttempt, rejectAttempt } from '../core/services/attempts'
import { recordAttemptMetrics } from '../core/services/metricReports'
import { enqueueOutbox } from '../core/services/outbox'
import { submitSprintReport } from '../core/services/reports'
import { getReportScorecard } from '../core/services/scorecards'
import type { SprintReportInput } from '../shared/domain/api'
import type { TicketContent } from '../shared/domain/bundle'
import type { MetricReport } from '../shared/domain/metrics'
import type { ScorecardSnapshot } from '../shared/domain/spaceGrades'
import type { CriterionResult, SprintReportView } from '../shared/domain/views'
import { makeBundle, makeTicket, sid, tid } from './bundles'
import { claim, startedRun, submitClaim } from './execution'
import { createRepoEnv, initProject, type RepoEnv } from './repoEnv'
import { createTestCtx, type TestCtx, withRole } from './testContext'

export const MIN = 60_000
const T0 = '2026-11-15T09:00:00.000Z'
const FIXTURES = join(__dirname, '../core/plan/fixtures/experiments')

/** The domain error code and message an action throws, or `ok`. */
export function outcome(action: () => unknown): { code: string; message: string } {
  try {
    action()
    return { code: 'ok', message: '' }
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, message: error.message }
    throw error
  }
}

export interface World {
  env: RepoEnv
  ctx: TestCtx
  orchestrator: TestCtx
  reviewer: TestCtx
  worker: TestCtx
  desktop: TestCtx
  epicId: string
  runId: string
  sprintId: string
  /** The sprint's acceptance node (the ticket after the work tickets), or null without one. */
  node: number | null
}

interface WorldOptions {
  /** Work tickets 1..size of sprint 1 (medium, criteria c1 and c2, budget 30 minutes and 50,000 tokens). Default 3. */
  size?: number
  /** Ticket size + 1 is the sprint's acceptance node. Default true; without it the sprint can be approved in memory. */
  acceptanceNode?: boolean
  retryLimit?: number
}

export function world(options: WorldOptions = {}): World {
  const env = createRepoEnv()
  const ctx = createTestCtx({ db: env.db, clock: env.clock })
  ctx.clock.set(T0)
  const size = options.size ?? 3
  const node = options.acceptanceNode ?? true ? size + 1 : null
  const base = makeBundle([Array.from({ length: node ?? size }, (_, index) => index + 1)])
  const ticket = (n: number): TicketContent =>
    n === node
      ? makeTicket(n, { kind: 'acceptance', title: 'Sprint 1 acceptance', size: 'medium', acceptanceCriteria: [{ id: 'c1', text: 'The sprint works end to end' }] })
      : makeTicket(n, {
          size: 'medium',
          acceptanceCriteria: [
            { id: 'c1', text: 'It works' },
            { id: 'c2', text: 'It is documented' }
          ],
          budget: { activeMs: 30 * MIN, tokens: 50_000 }
        })
  const bundle = { ...base, policies: { ...base.policies, retryLimit: options.retryLimit ?? 2 }, tickets: base.tickets.map((_, index) => ticket(index + 1)) }
  const run = startedRun(ctx, { bundle })
  ctx.clock.advanceSeconds(60)
  return {
    env,
    ctx,
    orchestrator: withRole(ctx, 'orchestrator'),
    reviewer: withRole(ctx, 'reviewer'),
    worker: withRole(ctx, 'worker'),
    desktop: withRole(ctx, 'desktop'),
    epicId: run.epicId,
    runId: run.runId,
    sprintId: sid(1),
    node
  }
}

interface WorkOptions {
  /** Active minutes the host reports as one closed span; null reports none. */
  minutes: number | null
  tokens: number | null
  /** Minutes of effort the worker classifies as productive or corrective; unset classifies none. */
  productive?: number
  corrective?: number
  claims?: CriterionResult[]
}

const met = (criterionId: string): CriterionResult => ({ criterionId, met: true, note: 'checked' })

const iso = (ms: number): string => new Date(ms).toISOString()

function usageReports(attemptId: string, window: { start: number; end: number }, options: WorkOptions): MetricReport[] {
  const actor = `omp:worker-${attemptId.slice(-6)}`
  const reports: MetricReport[] = []
  if (options.minutes !== null) {
    reports.push({
      metric: 'active_ms',
      unit: 'milliseconds',
      source: { kind: 'host', actor },
      measurement: { state: 'observed', value: window.end - window.start },
      accumulation: 'delta',
      eventId: `span-${attemptId}`,
      observedAt: iso(window.end),
      attributes: { spanStart: iso(window.start), activeBasis: 'requests_and_tools' },
      usage: { coverage: 'self', parentActor: null }
    })
  }
  if (options.tokens !== null) {
    reports.push({ metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor }, measurement: { state: 'observed', value: options.tokens }, accumulation: 'cumulative', sequence: 1, observedAt: iso(window.end), usage: { coverage: 'self', parentActor: null } })
  }
  const classify = (kind: 'productive' | 'corrective', minutes: number): MetricReport => ({
    metric: 'corrective_effort_ms',
    unit: 'milliseconds',
    source: { kind: 'agent', actor },
    measurement: { state: 'observed', value: minutes * MIN },
    accumulation: 'event',
    eventId: `${kind}-${attemptId}`,
    observedAt: iso(window.end),
    attributes: kind === 'productive' ? { classification: 'productive', work: 'implementation' } : { classification: 'corrective' },
    ...(kind === 'corrective' ? { cause: 'implementation' as const } : {})
  })
  if (options.productive !== undefined) reports.push(classify('productive', options.productive))
  if (options.corrective !== undefined) reports.push(classify('corrective', options.corrective))
  return reports
}

/** Claims ticket `n`, reports its usage as the orchestrator relaying the host, and submits; returns the attempt id. */
export function work(w: World, n: number, options: WorkOptions): string {
  const claimed = claim(w.ctx, w.runId, n)
  const attemptId = claimed.attempt.id
  const start = w.ctx.clock.nowMs()
  for (let left = options.minutes ?? 10; left > 0; left -= 10) {
    w.ctx.clock.advanceSeconds(Math.min(10, left) * 60)
    heartbeatAttempt(w.worker, { attemptId, claimToken: claimed.packet.claimToken })
  }
  const reports = usageReports(attemptId, { start, end: w.ctx.clock.nowMs() }, options)
  if (reports.length > 0) recordAttemptMetrics(w.orchestrator, { attemptId, reports })
  w.ctx.clock.advanceSeconds(60)
  submitClaim(w.worker, claimed, {
    outputs: { summary: 'done', artifacts: [], commits: ['a'.repeat(40)], changedFiles: [], branch: `ticket-${n}` },
    evidence: { checks: [{ name: 'typecheck', status: 'passed', detail: 'ok' }], criteria: options.claims ?? [met('c1'), met('c2')], notes: '' }
  })
  w.ctx.clock.advanceSeconds(60)
  return attemptId
}

function accept(w: World, attemptId: string): void {
  acceptAttempt(w.reviewer, { attemptId, notes: 'reviewed', criteria: [met('c1'), met('c2')] })
  w.ctx.clock.advanceSeconds(60)
}

export function reject(w: World, attemptId: string, reason: string): void {
  rejectAttempt(w.reviewer, { attemptId, reasons: [reason] })
  w.ctx.clock.advanceSeconds(60)
}

/** Works and accepts ticket `n`. */
export function deliver(w: World, n: number, options: WorkOptions): string {
  const attemptId = work(w, n, options)
  accept(w, attemptId)
  return attemptId
}

/** Submits a report revision for sprint 1 the way the command layer does: parsed with `sprintReportInput`, then the service. */
export function submit(w: World, report: unknown): SprintReportView {
  const parsed = parseInput(sprintReportInput, report, 'report') as SprintReportInput
  const view = submitSprintReport(w.orchestrator, { runId: w.runId, sprintId: w.sprintId, report: parsed })
  w.ctx.clock.advanceSeconds(60)
  return view
}

/** The sealed snapshot frozen with a report revision. */
export function frozenSnapshot(w: World, reportId: string): ScorecardSnapshot {
  const read = getReportScorecard(w.ctx, { reportId })
  if (read.state !== 'frozen') throw new Error(`report ${reportId} froze no scorecard`)
  return read.scorecard.snapshot
}

/** A world whose tickets 1-3 were delivered on 20, 30 and 20 measured minutes (30,000, 40,000 and 20,000 tokens). */
interface Delivered extends World {
  attempts: string[]
}

export function delivered(options: WorldOptions = {}): Delivered {
  const w = world(options)
  const plain = (minutes: number, tokens: number): WorkOptions => ({ minutes, tokens })
  return { ...w, attempts: [deliver(w, 1, plain(20, 30_000)), deliver(w, 2, plain(30, 40_000)), deliver(w, 3, plain(20, 20_000))] }
}

/** A delivered sprint with a first report revision (a prose retro), whose sealed scorecard later revisions may cite. */
export interface Reported extends Delivered {
  first: SprintReportView
  snapshot: ScorecardSnapshot
}

export function reported(options: WorldOptions = {}): Reported {
  const w = delivered(options)
  const first = submit(w, { summary: 'Sprint 1 is over.', retro: { wentWell: ['Tickets 1-3 landed'], actions: ['Keep reviews short'] } })
  return { ...w, first, snapshot: frozenSnapshot(w, first.id) }
}

/** Makes the world's repository exportable: a project file and the epic's saved plan and state queued for export. */
export function portable(w: World): void {
  initProject(w.env)
  const revisionId = w.ctx.db.get<{ revision_id: string }>('SELECT revision_id FROM runs WHERE id = ?', w.runId)?.revision_id ?? ''
  enqueueOutbox(w.ctx, { kind: 'snapshot', epicId: w.epicId, revisionId })
  enqueueOutbox(w.ctx, { kind: 'epic_state', epicId: w.epicId })
}

/** The `{{token}}` values the experiment fixtures are filled with; an earlier report's grades when the world has one. */
export function tokens(w: Delivered | Reported, extra: Record<string, string> = {}): Record<string, string> {
  const earlier: Record<string, string> =
    'first' in w
      ? { sourceReport: w.first.id, sprintAssessment: w.snapshot.sprint.assessmentId, runAssessment: w.snapshot.run.assessmentId, ticketAssessment: w.snapshot.tickets[0]?.assessmentId ?? '' }
      : {}
  return { sprintId: w.sprintId, runId: w.runId, ticket1: tid(1), attempt1: w.attempts[0] ?? '', ...earlier, ...extra }
}

/** Reads a fixture file in place and fills its `{{tokens}}`. */
export function fixture<T>(name: string, values: Record<string, string>): T {
  const text = readFileSync(join(FIXTURES, name), 'utf8').replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
  return JSON.parse(text) as T
}

/** The `valid` experiment of `experiment-cases.json`, filled for the world. */
export function validExperiment(w: Delivered | Reported): Record<string, unknown> {
  return fixture<{ valid: Record<string, unknown> }>('experiment-cases.json', tokens(w)).valid
}

interface MeasuredSprint {
  w: World
  report: SprintReportView
  attempts: Record<'dm1' | 'first2' | 'second2' | 'dm3' | 'dm4' | 'first6' | 'second6', string>
}

/**
 * A sprint of six budgeted work tickets (30 minutes and 50,000 tokens each), no acceptance node, two tries each:
 *   DM-1 delivered on budget (2 corrective minutes of 20); with `defect`, the orchestrator also records a coordination
 *        defect citing its attempt;
 *   DM-2 rejected once (c1 unmet), redone with 25 corrective minutes and accepted (70 minutes in all);
 *   DM-3 delivered in 50 minutes with no corrective effort (an overrun spent on productive work);
 *   DM-4 delivered with nothing reported by the host (no time, tokens or effort);
 *   DM-5 never claimed;
 *   DM-6 rejected twice, using its tries (a confirmed failure).
 * Then report revision 1 freezes its scorecard.
 */
export function measuredSprint(options: { defect?: boolean } = {}): MeasuredSprint {
  const w = world({ size: 6, acceptanceNode: false, retryLimit: 2 })
  const dm1 = deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
  if (options.defect === true) {
    recordAttemptMetrics(w.orchestrator, {
      attemptId: dm1,
      reports: [
        {
          metric: 'coordination_defect',
          unit: 'count',
          source: { kind: 'agent', actor: 'orchestrator-session' },
          measurement: { state: 'observed', value: 1 },
          accumulation: 'event',
          eventId: 'defect-1',
          observedAt: w.ctx.clock.nowIso(),
          attributes: { kind: 'lost_handoff' },
          evidence: [{ kind: 'attempt', id: dm1, detail: 'handed off without the notes its reviewer needed' }]
        }
      ]
    })
  }
  const first2 = work(w, 2, { minutes: 30, tokens: 40_000, productive: 30 })
  reject(w, first2, 'c1 does not hold: the export misses the retro')
  const second2 = work(w, 2, { minutes: 40, tokens: 30_000, productive: 15, corrective: 25 })
  accept(w, second2)
  const dm3 = deliver(w, 3, { minutes: 50, tokens: 45_000, productive: 50, corrective: 0 })
  const dm4 = deliver(w, 4, { minutes: null, tokens: null })
  const first6 = work(w, 6, { minutes: 20, tokens: 20_000, productive: 20 })
  reject(w, first6, 'c1 fails: the import refuses the file')
  const second6 = work(w, 6, { minutes: 20, tokens: 20_000, productive: 10, corrective: 10 })
  reject(w, second6, 'c1 still fails')
  const report = sprintReport(w)
  return { w, report, attempts: { dm1, first2, second2, dm3, dm4, first6, second6 } }
}

/** A report revision of a one-sprint epic with a prose retro and the epic's outcome. */
export function sprintReport(w: World): SprintReportView {
  return submit(w, { summary: 'Sprint 1 is over.', retro: { wentWell: ['The scorecard froze with the report'] }, epicOutcome: { summary: 'Done', successCriteria: [{ criterionId: 's1', met: true, note: 'ok' }] } })
}
