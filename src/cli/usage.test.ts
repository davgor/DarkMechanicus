import { describe, expect, it } from 'vitest'
import { getRunMetrics, recordAttemptMetrics, recordRunMetrics } from '../core/services/metricReports'
import { HOST_USAGE_SUPPORT } from '../shared/domain/hostUsage'
import type { RunMetricsView, UsageMetric } from '../shared/domain/metrics'
import { makeBundle } from '../test/bundles'
import { claim, startedRun } from '../test/execution'
import { createTestClock, createTestCtx, type TestCtx, withRole } from '../test/testContext'
import type { UsageMode } from './args'
import { reportHostUsage } from './usage'

const T0 = Date.parse('2026-11-15T10:00:00.000Z')
const at = (min: number): number => T0 + min * 60_000

function api(ctx: TestCtx) {
  const orchestrator = withRole(ctx, 'orchestrator')
  return {
    getRunMetrics: async (input: Parameters<typeof getRunMetrics>[1]) => getRunMetrics(orchestrator, input),
    recordAttemptMetrics: async (input: Parameters<typeof recordAttemptMetrics>[1]) => recordAttemptMetrics(orchestrator, input),
    recordRunMetrics: async (input: Parameters<typeof recordRunMetrics>[1]) => recordRunMetrics(orchestrator, input)
  }
}

const unavailable = (runId: string, host: string): UsageMode => ({ kind: 'usage', runId, sessionFile: null, billing: 'unknown', dryRun: false, unavailable: host })
const cell = (view: RunMetricsView, attemptId: string, metric: UsageMetric) => view.attempts.find((attempt) => attempt.attemptId === attemptId)?.usage.find((item) => item.metric === metric)

describe('DM-173 c4: hosts that cannot report usage', () => {
  it('only OMP and Claude Code hosts are read; every other built-in agent is marked unavailable', () => {
    const states = Object.fromEntries(Object.entries(HOST_USAGE_SUPPORT).map(([agent, support]) => [agent, `${support.tokens}/${support.activeTime}`]))
    expect(states).toEqual({ omp: 'host/host', claude: 'host/host', codex: 'unavailable/unavailable', cursor: 'unavailable/unavailable', autonomous: 'unavailable/unavailable' })
  })

  it('an unsupported host reads unavailable everywhere with no number and no estimate', async () => {
    const ctx = createTestCtx({ clock: createTestClock(new Date(T0).toISOString()) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    claim(ctx, runId, 1, { leaseSeconds: 7200 })
    claim(ctx, runId, 2, { leaseSeconds: 7200 })
    const methods = api(ctx)
    await reportHostUsage(methods, unavailable(runId, 'codex'), at(30))
    const view = await methods.getRunMetrics({ runId, includeObservations: true })
    const attemptCells = view.attempts.flatMap((attempt) => attempt.usage)
    expect(attemptCells.length).toBeGreaterThan(0)
    expect(attemptCells.filter((item) => item.coverage !== 'unavailable' || item.value !== null)).toEqual([])
    expect(view.overhead.filter((item) => item.coverage !== 'unavailable')).toEqual([])
    expect(view.totals.map((item) => item.measurement)).toEqual(view.totals.map(() => ({ state: 'missing', reason: 'host_unavailable' })))
    expect((view.observations ?? []).filter((item) => item.measurement.state !== 'missing')).toEqual([])
  })

  it('real numbers relayed later sit beside the unavailable mark as partial, never replaced by an estimate', async () => {
    const ctx = createTestCtx({ clock: createTestClock(new Date(T0).toISOString()) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const first = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    const methods = api(ctx)
    await reportHostUsage(methods, unavailable(runId, 'codex'), at(30))
    await methods.recordAttemptMetrics({
      attemptId: first.attempt.id,
      reports: [{ metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor: 'external-host:codex' }, measurement: { state: 'observed', value: 1200 }, accumulation: 'delta', eventId: 'turn-1', observedAt: new Date(at(31)).toISOString() }]
    })
    expect(cell(await methods.getRunMetrics({ runId }), first.attempt.id, 'tokens_total')).toMatchObject({ coverage: 'partial', value: 1200 })
  })
})

describe('DM-173 c4: dm usage --unavailable never overwrites or invents numbers', () => {
  it('marking unavailable again marks only attempts that reported nothing, and a third call sends nothing', async () => {
    const clock = createTestClock(new Date(T0).toISOString())
    const ctx = createTestCtx({ clock })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    const methods = api(ctx)
    const first = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    await reportHostUsage(methods, unavailable(runId, 'codex'), at(1))
    const second = claim(ctx, runId, 2, { leaseSeconds: 7200 })
    clock.set(new Date(at(5)).toISOString())
    const again = await reportHostUsage(methods, unavailable(runId, 'codex'), at(5))
    const view = await methods.getRunMetrics({ runId })
    expect(again.created).toBe(6)
    expect(cell(view, first.attempt.id, 'tokens_total')?.coverage).toBe('unavailable')
    expect(cell(view, second.attempt.id, 'tokens_total')?.coverage).toBe('unavailable')
    const third = await reportHostUsage(methods, unavailable(runId, 'codex'), at(9))
    expect([third.created, third.unchanged]).toEqual([0, 0])
  })

  it('an orchestration bucket already holding real usage keeps it', async () => {
    const ctx = createTestCtx({ clock: createTestClock(new Date(T0).toISOString()) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const methods = api(ctx)
    await methods.recordRunMetrics({ runId, overhead: 'orchestration', reports: [{ metric: 'tokens_total', unit: 'tokens', source: { kind: 'host', actor: 'relay' }, measurement: { state: 'observed', value: 30_000 }, accumulation: 'delta', eventId: 'turn-1', observedAt: new Date(at(1)).toISOString() }] })
    await reportHostUsage(methods, unavailable(runId, 'codex'), at(2))
    const kept = (await methods.getRunMetrics({ runId })).overheadByKind.find((item) => item.overhead === 'orchestration')?.usage.find((item) => item.metric === 'tokens_total')
    expect(kept).toMatchObject({ value: 30_000, coverage: 'observed' })
  })

  it('no session file and no --unavailable is refused with invalid_input rather than guessed', async () => {
    const ctx = createTestCtx({ clock: createTestClock(new Date(T0).toISOString()) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    await expect(reportHostUsage(api(ctx), { ...unavailable(runId, 'x'), unavailable: null }, at(1))).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
