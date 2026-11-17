/**
 * A real in-memory workspace for ticket-grade tests: one started run whose tickets are claimed, measured (host spans,
 * cumulative tokens, effort classifications through `recordAttemptMetrics`), submitted and reviewed through the real
 * services, then graded with `getTicketGrade`. Not shipped.
 */
import { acceptAttempt, heartbeatAttempt, rejectAttempt } from '../core/services/attempts'
import { recordHumanFeedback } from '../core/services/humanFeedback'
import { recordAttemptMetrics } from '../core/services/metricReports'
import { getTicketGrade } from '../core/services/spaceGrades'
import type { MetricReport } from '../shared/domain/metrics'
import type { WorkflowCause } from '../shared/domain/space'
import type { TicketGradeView } from '../shared/domain/spaceGrades'
import type { CriterionResult } from '../shared/domain/views'
import { makeBundle, makeTicket, tid } from './bundles'
import { claim, startedRun, submitClaim } from './execution'
import { createTestCtx, type TestCtx, withRole } from './testContext'

const MIN = 60_000

interface GradeWorld {
  ctx: TestCtx
  orchestrator: TestCtx
  reviewer: TestCtx
  worker: TestCtx
  desktop: TestCtx
  epicId: string
  runId: string
}

/**
 * Sprint 1 holds tickets 1-6, each medium-sized with criteria c1 and c2 and a pre-dispatch budget of 30 minutes of
 * active time and 50,000 tokens (frozen when the plan was saved, before any claim). The retry limit is `retryLimit`.
 */
export function gradeWorld(retryLimit = 2): GradeWorld {
  const ctx = createTestCtx()
  ctx.clock.set('2026-11-15T09:00:00.000Z')
  const base = makeBundle([[1, 2, 3, 4, 5, 6]])
  const criteria = [
    { id: 'c1', text: 'It works' },
    { id: 'c2', text: 'It is documented' }
  ]
  const bundle = {
    ...base,
    policies: { ...base.policies, retryLimit },
    tickets: [1, 2, 3, 4, 5, 6].map((n) => makeTicket(n, { size: 'medium', budget: { activeMs: 30 * MIN, tokens: 50_000 }, acceptanceCriteria: criteria }))
  }
  const run = startedRun(ctx, { bundle })
  ctx.clock.advanceSeconds(60)
  return {
    ctx,
    orchestrator: withRole(ctx, 'orchestrator'),
    reviewer: withRole(ctx, 'reviewer'),
    worker: withRole(ctx, 'worker'),
    desktop: withRole(ctx, 'desktop'),
    epicId: run.epicId,
    runId: run.runId
  }
}

interface WorkOptions {
  /** Active minutes the host reports as one closed span; null reports no span. */
  minutes: number | null
  /** Tokens the host reports for the attempt; null reports none. */
  tokens: number | null
  /** Effort classifications in minutes (`corrective` with its cause). */
  productive?: number
  corrective?: { minutes: number; cause: WorkflowCause }
  /** The worker's own criterion claims (default: c1 and c2 met). */
  claims?: CriterionResult[]
  /** Commits the worker lists in its outputs: activity volume, never scored. */
  commits?: string[]
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** The host's span and token reports and the agent's effort classifications for one attempt's window. */
function usageReports(attemptId: string, window: { start: number; end: number }, options: WorkOptions): MetricReport[] {
  const { start, end } = window
  const actor = `omp:worker-${attemptId.slice(-6)}`
  const reports: MetricReport[] = []
  if (options.minutes !== null) {
    reports.push({
      metric: 'active_ms',
      unit: 'milliseconds',
      source: { kind: 'host', actor },
      measurement: { state: 'observed', value: end - start },
      accumulation: 'delta',
      eventId: `span-${attemptId}`,
      observedAt: iso(end),
      attributes: { spanStart: iso(start), activeBasis: 'requests_and_tools' },
      usage: { coverage: 'self', parentActor: null }
    })
  }
  if (options.tokens !== null) {
    const measurement = { state: 'observed' as const, value: options.tokens }
    reports.push({ metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor }, measurement, accumulation: 'cumulative', sequence: 1, observedAt: iso(end), usage: { coverage: 'self', parentActor: null } })
  }
  const classify = (id: string, minutes: number, attributes: Record<string, string>, cause?: WorkflowCause): MetricReport => ({
    metric: 'corrective_effort_ms',
    unit: 'milliseconds',
    source: { kind: 'agent', actor },
    measurement: { state: 'observed', value: minutes * MIN },
    accumulation: 'event',
    eventId: `${id}-${attemptId}`,
    observedAt: iso(end),
    attributes,
    ...(cause === undefined ? {} : { cause })
  })
  if (options.productive !== undefined) reports.push(classify('productive', options.productive, { classification: 'productive', work: 'implementation' }))
  if (options.corrective !== undefined) reports.push(classify('corrective', options.corrective.minutes, { classification: 'corrective' }, options.corrective.cause))
  return reports
}

/** Claims ticket `n`, reports its usage as the orchestrator relaying the host, and submits; returns the attempt id. */
export function work(w: GradeWorld, n: number, options: WorkOptions): string {
  const claimed = claim(w.ctx, w.runId, n)
  const attemptId = claimed.attempt.id
  const start = w.ctx.clock.nowMs()
  // Heartbeat every ten minutes so the 15-minute lease holds while the worker is active.
  for (let left = options.minutes ?? 10; left > 0; left -= 10) {
    w.ctx.clock.advanceSeconds(Math.min(10, left) * 60)
    heartbeatAttempt(w.worker, { attemptId, claimToken: claimed.packet.claimToken })
  }
  const reports = usageReports(attemptId, { start, end: w.ctx.clock.nowMs() }, options)
  if (reports.length > 0) recordAttemptMetrics(w.orchestrator, { attemptId, reports })
  w.ctx.clock.advanceSeconds(60)
  submitClaim(w.worker, claimed, {
    outputs: { summary: 'done', artifacts: [], commits: options.commits ?? ['a'.repeat(40)], changedFiles: [], branch: `ticket-${n}` },
    evidence: { checks: [{ name: 'typecheck', status: 'passed', detail: 'ok' }], criteria: options.claims ?? [met('c1'), met('c2')], notes: '' }
  })
  w.ctx.clock.advanceSeconds(60)
  return attemptId
}

export function accept(w: GradeWorld, attemptId: string, criteria?: CriterionResult[]): void {
  acceptAttempt(w.reviewer, { attemptId, notes: 'reviewed', ...(criteria === undefined ? {} : { criteria }) })
  w.ctx.clock.advanceSeconds(60)
}

export function reject(w: GradeWorld, attemptId: string, reason: string): void {
  rejectAttempt(w.reviewer, { attemptId, reasons: [reason] })
  w.ctx.clock.advanceSeconds(60)
}

/** A person's rating of ticket `n` in this run, from the desktop; returns the observation id. */
export function rate(w: GradeWorld, n: number, value: number): string {
  return recordHumanFeedback(w.desktop, { target: { epicId: w.epicId, ticketId: tid(n), runId: w.runId }, feedback: { kind: 'rating', value }, person: 'Dana (desktop)' }).observationId
}

export const met = (criterionId: string, note = 'checked'): CriterionResult => ({ criterionId, met: true, note })
export const unmet = (criterionId: string, note = 'not met'): CriterionResult => ({ criterionId, met: false, note })

export function ticketGrade(w: GradeWorld, n: number, cutoff?: string): TicketGradeView {
  return getTicketGrade(w.ctx, { runId: w.runId, ticketId: tid(n), ...(cutoff === undefined ? {} : { cutoff }) })
}
