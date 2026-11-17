/**
 * A measured workspace for scorecard tests (DM-178): a started run whose tickets are claimed, measured (host spans,
 * tokens and effort classifications through `record_attempt_metrics`), submitted and reviewed through the real
 * services, with helpers to report the sprint, cancel a run and start another, and adopt a changed plan. The database
 * lives in a repository environment, so the run history can be exported, copied to a second machine and imported.
 * Ids come from the test context's sequence and times from its clock, so the same steps give the same records.
 * Not shipped.
 */
import { adoptRevision } from '../core/services/adoption'
import { acceptAttempt, heartbeatAttempt, rejectAttempt } from '../core/services/attempts'
import { loadBundle } from '../core/services/execution'
import { recordAttemptMetrics, recordRunMetrics } from '../core/services/metricReports'
import { enqueueOutbox } from '../core/services/outbox'
import { submitSprintReport } from '../core/services/reports'
import { cancelRun, pauseRun, resumeRun, startRun } from '../core/services/runs'
import type { PlanBundle, TicketContent } from '../shared/domain/bundle'
import type { MetricReport } from '../shared/domain/metrics'
import type { CriterionResult, SprintReportView } from '../shared/domain/views'
import { makeBundle, makeTicket, sid } from './bundles'
import { claim, seedRevision, startedRun, submitClaim } from './execution'
import { createRepoEnv, initProject, type RepoEnv } from './repoEnv'
import { createTestCtx, type TestCtx, withRole } from './testContext'

export const MIN = 60_000
const T0 = '2026-11-15T09:00:00.000Z'

export interface SpaceWorld {
  env: RepoEnv
  ctx: TestCtx
  orchestrator: TestCtx
  reviewer: TestCtx
  worker: TestCtx
  desktop: TestCtx
  epicId: string
  runId: string
  sprintId: string
  /** Tickets 4 and 5 are the acceptance node and the Fireguard ticket (one criterion each). */
  overhead: boolean
}

const CRITERIA = [
  { id: 'c1', text: 'It works' },
  { id: 'c2', text: 'It is documented' }
]

interface SpaceWorldOptions {
  /** Work tickets listed here have no budget; the others have 30 minutes of active time and 50,000 tokens. */
  unbudgeted?: number[]
  /** Ticket 4: the sprint's acceptance node; ticket 5: a Fireguard ticket (tag `fireguard`). Default true. */
  overhead?: boolean
  /** Sprint 2 holds work ticket 6 (so sprint 1 is not the final sprint). Default false: one sprint. */
  secondSprint?: boolean
  retryLimit?: number
  /** Sprint 1 holds work tickets 1..size instead (all budgeted; no acceptance node or Fireguard ticket). */
  size?: number
}

/**
 * Sprint 1: work tickets 1-3 (medium, criteria c1 and c2, a pre-dispatch budget of 30 minutes of active time and
 * 50,000 tokens), and unless `overhead` is false the sprint's acceptance node 4 and a Fireguard ticket 5 (no budget);
 * with `size`, work tickets 1..size only.
 */
export function spaceWorld(options: SpaceWorldOptions = {}): SpaceWorld {
  const env = createRepoEnv()
  const ctx = createTestCtx({ db: env.db, clock: env.clock })
  ctx.clock.set(T0)
  const overhead = options.size === undefined && (options.overhead ?? true)
  const sprint1 = options.size !== undefined ? Array.from({ length: options.size }, (_, i) => i + 1) : overhead ? [1, 2, 3, 4, 5] : [1, 2, 3]
  const layout = options.secondSprint === true ? [sprint1, [6]] : [sprint1]
  const base = makeBundle(layout)
  const unbudgeted = new Set(options.unbudgeted ?? [])
  const ticket = (n: number): TicketContent => {
    if (overhead && n === 4) return makeTicket(4, { kind: 'acceptance', title: 'Sprint 1 acceptance', size: 'medium', acceptanceCriteria: [{ id: 'c1', text: 'The sprint works end to end' }] })
    if (overhead && n === 5) return makeTicket(5, { title: 'Grade the tests with Fireguard', tags: ['fireguard'], size: 'small', acceptanceCriteria: [{ id: 'c1', text: 'Fireguard grades the tests' }] })
    return makeTicket(n, { size: 'medium', acceptanceCriteria: CRITERIA, ...(unbudgeted.has(n) ? {} : { budget: { activeMs: 30 * MIN, tokens: 50_000 } }) })
  }
  const bundle = { ...base, policies: { ...base.policies, retryLimit: options.retryLimit ?? 2 }, tickets: layout.flat().map(ticket) }
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
    overhead
  }
}

interface WorkOptions {
  /** Active minutes the host reports as one closed span; null reports none. */
  minutes: number | null
  /** Tokens the host reports; null reports none. */
  tokens: number | null
  productive?: number
  corrective?: number
  claims?: CriterionResult[]
}

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
  const classify = (id: string, minutes: number, attributes: Record<string, string>): MetricReport => ({
    metric: 'corrective_effort_ms',
    unit: 'milliseconds',
    source: { kind: 'agent', actor },
    measurement: { state: 'observed', value: minutes * MIN },
    accumulation: 'event',
    eventId: `${id}-${attemptId}`,
    observedAt: iso(window.end),
    attributes,
    ...(id === 'corrective' ? { cause: 'implementation' as const } : {})
  })
  if (options.productive !== undefined) reports.push(classify('productive', options.productive, { classification: 'productive', work: 'implementation' }))
  if (options.corrective !== undefined) reports.push(classify('corrective', options.corrective, { classification: 'corrective' }))
  return reports
}

export const met = (criterionId: string, note = 'checked'): CriterionResult => ({ criterionId, met: true, note })
export const unmet = (criterionId: string, note = 'not met'): CriterionResult => ({ criterionId, met: false, note })

const defaultClaims = (w: SpaceWorld, n: number): CriterionResult[] => (w.overhead && (n === 4 || n === 5) ? [met('c1')] : [met('c1'), met('c2')])

/** Claims ticket `n`, reports its usage as the orchestrator relaying the host, and submits; returns the attempt id. */
export function work(w: SpaceWorld, n: number, options: WorkOptions): string {
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
    evidence: { checks: [{ name: 'typecheck', status: 'passed', detail: 'ok' }], criteria: options.claims ?? defaultClaims(w, n), notes: '' }
  })
  w.ctx.clock.advanceSeconds(60)
  return attemptId
}

export function accept(w: SpaceWorld, attemptId: string, criteria?: CriterionResult[]): void {
  acceptAttempt(w.reviewer, { attemptId, notes: 'reviewed', ...(criteria === undefined ? {} : { criteria }) })
  w.ctx.clock.advanceSeconds(60)
}

export function reject(w: SpaceWorld, attemptId: string, reason: string): void {
  rejectAttempt(w.reviewer, { attemptId, reasons: [reason] })
  w.ctx.clock.advanceSeconds(60)
}

/** Works and accepts ticket `n` with every criterion the reviewer checked met; returns the attempt id. */
export function deliver(w: SpaceWorld, n: number, options: WorkOptions): string {
  const attemptId = work(w, n, options)
  accept(w, attemptId, defaultClaims(w, n))
  return attemptId
}

/**
 * Overhead no attempt owns, as the host relays it: an orchestrator span (and its tokens) in the bucket of the world's
 * sprint, or of the run when `sprintId` is null.
 */
export function overhead(w: SpaceWorld, minutes: number, tokens: number, sprintId: string | null = w.sprintId): void {
  const end = w.ctx.clock.nowMs()
  const actor = 'omp:orchestrator'
  const reports: MetricReport[] = [
    {
      metric: 'active_ms',
      unit: 'milliseconds',
      source: { kind: 'host', actor },
      measurement: { state: 'observed', value: minutes * MIN },
      accumulation: 'delta',
      eventId: `orchestration-${end}`,
      observedAt: iso(end),
      attributes: { spanStart: iso(end - minutes * MIN), role: 'orchestrator', handle: 'orchestrator-main' },
      usage: { coverage: 'self', parentActor: null }
    },
    { metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor }, measurement: { state: 'observed', value: tokens }, accumulation: 'delta', eventId: `orchestration-tokens-${end}`, observedAt: iso(end), usage: { coverage: 'self', parentActor: null } }
  ]
  recordRunMetrics(w.orchestrator, { runId: w.runId, ...(sprintId === null ? {} : { sprintId }), overhead: 'orchestration', reports })
}

/** Submits the report of the world's sprint as the orchestrator. */
export function report(w: SpaceWorld, summary = 'Sprint 1 is over.'): SprintReportView {
  return submitSprintReport(w.orchestrator, {
    runId: w.runId,
    sprintId: w.sprintId,
    report: { summary, retro: { wentWell: ['The scorecard froze with the report'] }, epicOutcome: { summary: 'Done', successCriteria: [{ criterionId: 's1', met: true, note: 'ok' }] } }
  })
}

/** Makes the world's repository exportable: a project file and the epic's saved plan and state queued for export. */
export function portable(w: SpaceWorld): void {
  initProject(w.env)
  const revisionId = w.ctx.db.get<{ revision_id: string }>('SELECT revision_id FROM runs WHERE id = ?', w.runId)?.revision_id ?? ''
  enqueueOutbox(w.ctx, { kind: 'snapshot', epicId: w.epicId, revisionId })
  enqueueOutbox(w.ctx, { kind: 'epic_state', epicId: w.epicId })
}

/** Cancels the world's run (nothing left open) and starts another on the same epic; the world now drives the new run. */
export function nextRun(w: SpaceWorld): string {
  cancelRun(w.orchestrator, { runId: w.runId, reason: 'restarted' })
  w.ctx.clock.advanceSeconds(60)
  w.runId = startRun(w.orchestrator, { epicId: w.epicId }).id
  w.ctx.clock.advanceSeconds(60)
  return w.runId
}

/** Saves a changed copy of the run's plan and adopts it into the run (pausing a running run around the adoption). */
export function adopt(w: SpaceWorld, change: (plan: PlanBundle) => PlanBundle): string {
  const run = w.ctx.db.get<{ revision_id: string; state: string }>('SELECT revision_id, state FROM runs WHERE id = ?', w.runId)
  const adopted = seedRevision(w.ctx, w.epicId, change(loadBundle(w.ctx, run?.revision_id ?? '')))
  const running = run?.state === 'running'
  if (running) pauseRun(w.orchestrator, { runId: w.runId, reason: 'adopting a changed plan' })
  adoptRevision(w.ctx, { runId: w.runId, revisionId: adopted })
  if (running) resumeRun(w.orchestrator, { runId: w.runId })
  w.ctx.clock.advanceSeconds(60)
  return adopted
}

/** Moves ticket `ticketId` from sprint 1 to sprint 2 of the run's plan (an adoption). */
export function moveToSprint2(w: SpaceWorld, ticketId: string): string {
  return adopt(w, (plan) => ({
    ...plan,
    sprints: plan.sprints.map((sprint) =>
      sprint.id === sid(1) ? { ...sprint, ticketIds: sprint.ticketIds.filter((id) => id !== ticketId) } : { ...sprint, ticketIds: [...sprint.ticketIds, ticketId] }
    )
  }))
}
