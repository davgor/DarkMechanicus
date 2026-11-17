// DM-176 (pinned by DM-269): E, T and K inputs read from stored records through the services, as of a cutoff.
import { describe, expect, it } from 'vitest'
import type { MetricReport } from '../../shared/domain/metrics'
import { makeBundle, makeTicket, tid } from '../../test/bundles'
import { grade, MIN } from '../../test/efficiencyRuns'
import { claim, seedRevision, startedRun, submitClaim } from '../../test/execution'
import { domainErrorOf } from '../../test/repoFixtures'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { acceptAttempt, heartbeatAttempt } from './attempts'
import { getRunEfficiency, getTicketEfficiency } from './efficiency'
import { getRunMetrics, recordAttemptMetrics, recordRunMetrics } from './metricReports'

const START = Date.parse('2026-11-15T09:00:00.000Z')
const iso = (m: number): string => new Date(START + m * MIN).toISOString()

/** A host's closed span (a delta with `spanStart`) from `start` to `end` minutes. */
const span = (start: number, end: number, actor: string): MetricReport => ({
  metric: 'active_ms',
  unit: 'milliseconds',
  source: { kind: 'host', actor },
  measurement: { state: 'observed', value: (end - start) * MIN },
  accumulation: 'delta',
  eventId: `span-${start}`,
  observedAt: iso(end),
  attributes: { spanStart: iso(start), activeBasis: 'requests_and_tools' },
  usage: { coverage: 'self', parentActor: null }
})

/** A host's cumulative token read at `sequence` (null: a `partial_coverage` gap). */
const tokens = (value: number | null, sequence: number, m: number, actor: string): MetricReport => ({
  metric: 'tokens_total',
  unit: 'tokens',
  source: { kind: 'host', actor },
  measurement: value === null ? { state: 'missing', reason: 'partial_coverage' } : { state: 'observed', value },
  accumulation: 'cumulative',
  sequence,
  observedAt: iso(m),
  usage: { coverage: 'self', parentActor: null }
})

const sized = (n: number, budget?: { activeMs: number; tokens: number }) => makeTicket(n, budget === undefined ? { size: 'medium' } : { size: 'medium', budget })
const criteria = [{ criterionId: 'c1', met: true, note: 'checked' }]

/**
 * Ticket 1 (30-minute and 50,000-token budgets) claimed at 10; a revision raising its budgets tenfold saved at 15; the
 * worker's 36-minute span and 60,000 tokens and the run's 50-minute orchestration with 400,000 tokens recorded at 47;
 * submitted at 48, accepted at 55; read at 60.
 */
function budgetedRun(): { ctx: TestCtx; runId: string; epicId: string; attemptId: string } {
  const ctx = createTestCtx()
  ctx.clock.set(iso(0))
  const orchestrator = withRole(ctx, 'orchestrator')
  const bundle = { ...makeBundle([[1, 2]]), tickets: [sized(1, { activeMs: 30 * MIN, tokens: 50_000 }), sized(2, { activeMs: 30 * MIN, tokens: 50_000 })] }
  const run = startedRun(ctx, { bundle })
  ctx.clock.set(iso(10))
  const claimed = claim(ctx, run.runId, 1)
  ctx.clock.set(iso(15))
  seedRevision(ctx, run.epicId, { ...bundle, tickets: [sized(1, { activeMs: 300 * MIN, tokens: 500_000 }), sized(2, { activeMs: 30 * MIN, tokens: 50_000 })] })
  for (const m of [20, 30, 40]) {
    ctx.clock.set(iso(m))
    heartbeatAttempt(withRole(ctx, 'worker'), { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken })
  }
  ctx.clock.set(iso(47))
  recordAttemptMetrics(orchestrator, { attemptId: claimed.attempt.id, reports: [span(10, 46, 'omp:worker'), tokens(60_000, 2, 46, 'omp:worker')] })
  recordRunMetrics(orchestrator, { runId: run.runId, overhead: 'orchestration', reports: [span(0, 50, 'omp:main'), tokens(400_000, 2, 50, 'omp:main')] })
  ctx.clock.set(iso(48))
  submitClaim(withRole(ctx, 'worker'), claimed)
  ctx.clock.set(iso(55))
  acceptAttempt(withRole(ctx, 'reviewer'), { attemptId: claimed.attempt.id, notes: 'reviewed', criteria })
  ctx.clock.set(iso(60))
  return { ctx, runId: run.runId, epicId: run.epicId, attemptId: claimed.attempt.id }
}

describe('getTicketEfficiency', () => {
  it('reads host delta spans as activity and scores T and K against the budgets frozen before dispatch', () => {
    const { ctx, runId } = budgetedRun()
    const ticket = getTicketEfficiency(ctx, { runId, ticketId: tid(1) })
    const graded = grade(ticket)
    expect(ticket.dispatchedAt).toBe(iso(10))
    expect(ticket.T.actual).toEqual({ state: 'observed', value: 36 * MIN })
    expect(graded.T.inputs.baselineValue).toBe(30 * MIN)
    expect(graded.T.score).toBe(90)
    expect(ticket.K.actual).toEqual({ state: 'observed', value: 60_000 })
    expect(graded.K.score).toBe(90)
    expect(ticket.cohortKey?.size).toBe('medium')
  })

  it('refuses budgets of a revision saved after the dispatch', () => {
    const { ctx, runId } = budgetedRun()
    const ticket = getTicketEfficiency(ctx, { runId, ticketId: tid(1) })
    expect(ticket.T.baseline.rejected.map((r) => r.reason)).toEqual(['frozen_after_dispatch'])
    expect(ticket.K.baseline.rejected.map((r) => r.reason)).toEqual(['frozen_after_dispatch'])
  })

  it('does not list a budget version saved after the read cutoff', () => {
    const { ctx, runId } = budgetedRun()
    const early = getTicketEfficiency(ctx, { runId, ticketId: tid(1), cutoff: iso(12) })
    expect(early.T.baseline.rejected).toEqual([])
    expect(early.T.baseline).toMatchObject({ state: 'selected', baseline: { value: 30 * MIN } })
  })

  it('turns T and K missing when a thread keeps working, and reads the earlier cutoff unchanged', () => {
    const { ctx, runId, attemptId } = budgetedRun()
    const before = getTicketEfficiency(ctx, { runId, ticketId: tid(1) })
    ctx.clock.set(iso(70))
    recordAttemptMetrics(withRole(ctx, 'orchestrator'), { attemptId, reports: [tokens(65_000, 3, 70, 'omp:worker'), tokens(null, 4, 70, 'omp:worker')] })
    ctx.clock.set(iso(75))
    const later = getTicketEfficiency(ctx, { runId, ticketId: tid(1) })
    expect(later.T.actual).toEqual({ state: 'missing', reason: 'partial_coverage' })
    expect(later.K.actual).toEqual({ state: 'missing', reason: 'partial_coverage' })
    expect(getTicketEfficiency(ctx, { runId, ticketId: tid(1), cutoff: iso(60) })).toEqual(before)
  })

  it('gives a ticket never dispatched no actual and no baseline', () => {
    const { ctx, runId } = budgetedRun()
    const ticket = getTicketEfficiency(ctx, { runId, ticketId: tid(2) })
    expect(ticket.T.actual.state).toBe('missing')
    expect(ticket.T.baseline.state).toBe('missing')
    expect(ticket.cohorts.T.missingReason).toBe('not_dispatched')
  })
})

describe('getTicketEfficiency: a ticket the run does not hold', () => {
  it('refuses a ticket the run does not hold, naming the ticket and the run', () => {
    const { ctx, runId } = budgetedRun()
    expect(domainErrorOf(() => getTicketEfficiency(ctx, { runId, ticketId: tid(9) }))).toEqual({
      code: 'not_found',
      message: `Ticket ${tid(9)} is not a ticket of run ${runId}.`,
      details: { ticketId: tid(9) }
    })
  })
})

describe('getTicketEfficiency: a budget a later revision cleared', () => {
  it('offers no baseline from a later version that cleared the budget', () => {
    const { ctx, runId, epicId } = budgetedRun()
    seedRevision(ctx, epicId, { ...makeBundle([[1, 2]]), tickets: [sized(1), sized(2, { activeMs: 30 * MIN, tokens: 50_000 })] })
    const ticket = getTicketEfficiency(ctx, { runId, ticketId: tid(1) })
    expect(ticket.T.baseline).toMatchObject({ state: 'selected', baseline: { value: 30 * MIN, version: 1 } })
    expect(ticket.T.baseline.rejected.map((r) => r.reason)).toEqual(['frozen_after_dispatch'])
  })
})

describe('getRunEfficiency', () => {
  it('charges orchestration to the run once, never to the ticket, and agrees with the run token total', () => {
    const { ctx, runId } = budgetedRun()
    const view = getRunEfficiency(ctx, { runId })
    expect(view.run.T.actual).toEqual({ state: 'observed', value: 86 * MIN })
    expect(view.run.K.actual).toEqual({ state: 'observed', value: 460_000 })
    const total = getRunMetrics(ctx, { runId }).totals.find((t) => t.metric === 'tokens_total')
    expect(total?.measurement).toEqual({ state: 'observed', value: 460_000 })
    expect(view.tickets.find((t) => t.scope.level === 'ticket' && t.scope.ticketId === tid(1))?.T.actual).toEqual({ state: 'observed', value: 36 * MIN })
  })
})

describe('cohorts across runs', () => {
  /** Five comparable tickets (10-14 minutes, 10,000-50,000 tokens) accepted in another run, then ticket 21 dispatched. */
  function cohortRuns(): { ctx: TestCtx; subjectRunId: string; heldAttemptId: string } {
    const ctx = createTestCtx()
    ctx.clock.set(iso(100))
    const orchestrator = withRole(ctx, 'orchestrator')
    const prior = startedRun(ctx, { bundle: { ...makeBundle([[11, 12, 13, 14, 15, 16]]), tickets: [11, 12, 13, 14, 15, 16].map((n) => sized(n)) } })
    let at = 100
    for (const [index, n] of [11, 12, 13, 14, 15].entries()) {
      ctx.clock.set(iso(at))
      const c = claim(ctx, prior.runId, n)
      ctx.clock.set(iso(at + 10 + index))
      recordAttemptMetrics(orchestrator, { attemptId: c.attempt.id, reports: [span(at, at + 10 + index, `omp:w${n}`), tokens(10_000 * (index + 1), 2, at + 10 + index, `omp:w${n}`)] })
      submitClaim(withRole(ctx, 'worker'), c)
      acceptAttempt(withRole(ctx, 'reviewer'), { attemptId: c.attempt.id, notes: 'ok', criteria })
      at += 20
    }
    const held = claim(ctx, prior.runId, 16)
    const subject = startedRun(ctx, { bundle: { ...makeBundle([[21]]), tickets: [sized(21)] } })
    ctx.clock.set(iso(at))
    const c21 = claim(ctx, subject.runId, 21)
    ctx.clock.set(iso(at + 14.4))
    recordAttemptMetrics(orchestrator, { attemptId: c21.attempt.id, reports: [span(at, at + 14.4, 'omp:w21'), tokens(36_000, 2, at + 14.4, 'omp:w21')] })
    submitClaim(withRole(ctx, 'worker'), c21)
    acceptAttempt(withRole(ctx, 'reviewer'), { attemptId: c21.attempt.id, notes: 'ok', criteria })
    return { ctx, subjectRunId: subject.runId, heldAttemptId: held.attempt.id }
  }

  it('takes another run\'s accepted comparable tickets as the baseline when there is no budget', () => {
    const { ctx, subjectRunId } = cohortRuns()
    const ticket = getTicketEfficiency(ctx, { runId: subjectRunId, ticketId: tid(21) })
    const graded = grade(ticket)
    expect(ticket.cohorts.T.baseline).toMatchObject({ value: 12 * MIN, sampleSize: 5, memberTicketIds: [11, 12, 13, 14, 15].map(tid) })
    expect(graded.T.inputs.baselineKind).toBe('cohort')
    expect(graded.T.score).toBe(90)
    expect(ticket.cohorts.K.baseline?.value).toBe(30_000)
    expect(graded.K.score).toBe(90)
  })

  it('never settles another run\'s expired lease while reading', () => {
    const { ctx, subjectRunId, heldAttemptId } = cohortRuns()
    ctx.clock.set(iso(1000))
    const state = () => ctx.db.get<{ state: string }>('SELECT state FROM attempts WHERE id = ?', heldAttemptId)?.state
    const before = state()
    getTicketEfficiency(ctx, { runId: subjectRunId, ticketId: tid(21) })
    expect(before).toBe('claimed')
    expect(state()).toBe('claimed')
  })
})
