import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getRunMetrics, recordAttemptMetrics } from '../services/metricReports'
import type { UsageFormat } from '../../shared/domain/hostUsage'
import type { MetricReport } from '../../shared/domain/metrics'
import { makeBundle } from '../../test/bundles'
import { claim, startedRun } from '../../test/execution'
import { createTestClock, createTestCtx, withRole } from '../../test/testContext'
import { readCodexTotals } from './hostTranscripts'
import { addSample, breakdownOf, cumulativeDeltas, emptyAggregate, tokenReports, type UsageBreakdown, type UsageStreamIdentity } from './hostUsage'

interface Sample {
  name: string
  format: UsageFormat
  usage: unknown
  expect: Record<string, unknown> & { unknown: string[] }
}

const fixture = (path: string): string => readFileSync(new URL(`./fixtures/usage/${path}`, import.meta.url), 'utf8')
const { samples } = JSON.parse(fixture('provider-samples.json')) as { samples: Sample[] }
const CODEX = 'codex/rollout-2026-11-15T10-00-00-0199a2b3-c4d5-7e6f-8091-a2b3c4d5e6f7.jsonl'
const SELF: UsageStreamIdentity = { actor: 'fixture:session', parentActor: null, coverage: 'self', billing: 'unknown' }

function deltaReports(breakdown: UsageBreakdown, identity: UsageStreamIdentity, eventId: string, model: string | null = null): MetricReport[] {
  const aggregate = emptyAggregate(breakdown.format)
  addSample(aggregate, breakdown, model)
  return tokenReports(aggregate, identity, { accumulation: 'delta', eventId, observedAt: '2026-11-15T10:00:00.000Z' })
}

function metric(reports: readonly MetricReport[], name: string): MetricReport | undefined {
  return reports.find((report) => report.metric === name)
}

describe('DM-173 c1: provider samples normalize to each provider definition', () => {
  it.each(samples.map((sample) => [sample.name, sample] as const))('%s: categories, unknown fields and stated subsets', (_name, sample) => {
    const b = breakdownOf(sample.format, sample.usage)
    const want = sample.expect
    expect({ input: b.input, cachedInput: b.cachedInput, cacheWrite: b.cacheWrite, output: b.output, reasoning: b.reasoning, total: b.total, totalBasis: b.totalBasis }).toEqual({
      input: want.input,
      cachedInput: want.cachedInput,
      cacheWrite: want.cacheWrite,
      output: want.output,
      reasoning: want.reasoning,
      total: want.total,
      totalBasis: want.totalBasis
    })
    expect(Object.keys(b.unknown).sort()).toEqual(want.unknown)
    if (want.listPriceUsd !== undefined) expect(b.listPriceUsd).toBe(want.listPriceUsd)
  })

  it.each(samples.map((sample) => [sample.name, sample] as const))('%s: reports state their subsets and keep unknown fields as raw.*', (_name, sample) => {
    const want = sample.expect
    const reports = deltaReports(breakdownOf(sample.format, sample.usage), SELF, `evt-${sample.name}`)
    const attributes = (name: string): Record<string, unknown> => metric(reports, name)?.attributes ?? {}
    expect(attributes('tokens_input').includesCachedInput).toBe(want.includesCachedInput)
    expect(attributes('tokens_cached_input').subsetOf).toBe(want.includesCachedInput ? 'tokens_input' : null)
    expect(attributes('tokens_output').includesReasoning).toBe(want.includesReasoning)
    expect(attributes('tokens_reasoning').subsetOf).toBe(want.includesReasoning ? 'tokens_output' : null)
    expect(Object.keys(attributes('tokens_total')).filter((key) => key.startsWith('raw.')).sort()).toEqual(want.unknown.map((key) => `raw.${key}`))
  })

  it('a reasoning count the provider does not report stays missing, never 0', () => {
    const reports = deltaReports(breakdownOf('anthropic_messages', samples[0]?.usage), SELF, 'evt-1')
    expect(metric(reports, 'tokens_reasoning')?.measurement.state).toBe('missing')
  })

  it('an unknown token category leaves the total missing (not derivable), never a guessed sum', () => {
    const reports = deltaReports(breakdownOf('anthropic_messages', samples[1]?.usage), SELF, 'evt-2')
    const total = metric(reports, 'tokens_total')
    expect(total?.measurement.state).toBe('missing')
    expect(total?.attributes?.totalBasis).toBe('not_derivable')
  })

  it('cached-input subsets: Anthropic cache reads sit apart from input (14461); OpenAI cached sits inside input (1500, not 2716)', () => {
    expect(breakdownOf('anthropic_messages', samples[0]?.usage).total).toBe(14_461)
    const chat = breakdownOf('openai_chat', samples[2]?.usage)
    expect(chat.total).toBe(1500)
    expect(chat.cachedInput).toBe(1024)
    expect(chat.reasoning).toBe(192)
  })

  it('reasoning-output subsets: Gemini thoughts sit apart from candidates (4000 + 350 + 1200 + 100 = 5650)', () => {
    expect(breakdownOf('gemini', samples[4]?.usage).total).toBe(5650)
  })
})

describe('DM-173 c1: cumulative updates count each token once', () => {
  it('the codex rollout skips rate-limit-only events and its deltas add to the last running total', () => {
    const totals = readCodexTotals(fixture(CODEX))
    expect(totals.map((item) => item.breakdown.total)).toEqual([12_800, 26_700, 26_700, 41_600])
    const deltas = cumulativeDeltas(totals.map((item) => item.breakdown))
    expect(deltas.map((item) => item.total)).toEqual([12_800, 13_900, 0, 14_900])
    const sum = (key: 'cachedInput' | 'reasoning'): number => deltas.reduce((acc, item) => acc + (item[key] ?? 0), 0)
    expect(sum('cachedInput')).toBe(24_960)
    expect(sum('reasoning')).toBe(1408)
  })

  it('a running total that drops starts a new base (100, 150, 40)', () => {
    const restarted = cumulativeDeltas([100, 250, 40].map((value) => breakdownOf('codex', { input_tokens: value, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: value })))
    expect(restarted.map((item) => item.total)).toEqual([100, 150, 40])
  })

  it('unknown fields keep their latest value through running totals, not a sum', () => {
    const totals = [3, 5, 8].map((calls, index) =>
      breakdownOf('codex', { input_tokens: 100 * (index + 1), cached_input_tokens: 0, output_tokens: 10 * (index + 1), reasoning_output_tokens: 0, total_tokens: 110 * (index + 1), tool_calls: calls })
    )
    const aggregate = emptyAggregate('codex')
    for (const delta of cumulativeDeltas(totals)) addSample(aggregate, delta, null)
    expect(aggregate.unknown.tool_calls).toBe(8)
    expect(aggregate.categories.total.value).toBe(330)
    const later = emptyAggregate('omp')
    addSample(later, breakdownOf('omp', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }), null)
    addSample(later, breakdownOf('omp', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, service: 'flex' }), null)
    expect(later.unknown.service).toBe('flex')
  })
})

describe('DM-173 c1: parent/child inclusion through the metric services', () => {
  it('a child inside an inclusive parent counts once (10000, not 13000) and the unknown field reaches the ledger', () => {
    const clock = createTestClock('2026-11-15T10:00:00.000Z')
    const ctx = createTestCtx({ clock })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    clock.set('2026-11-15T10:30:00.000Z')
    const parentUsage = breakdownOf('openai_responses', { input_tokens: 9000, input_tokens_details: { cached_tokens: 6000 }, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 400 }, total_tokens: 10000, service_tier: 'priority' })
    const childUsage = breakdownOf('openai_responses', { input_tokens: 2500, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 3000 })
    const parent = deltaReports(parentUsage, { actor: 'host:parent', parentActor: null, coverage: 'inclusive', billing: 'api_key' }, 'resp-parent', 'gpt-5')
    const child = deltaReports(childUsage, { actor: 'host:parent/child', parentActor: 'host:parent', coverage: 'self', billing: 'api_key' }, 'resp-child', 'gpt-5')
    const orchestrator = withRole(ctx, 'orchestrator')
    recordAttemptMetrics(orchestrator, { attemptId: claimed.attempt.id, reports: [...child, ...parent] })
    const view = getRunMetrics(orchestrator, { runId, includeObservations: true })
    const usage = view.attempts.find((attempt) => attempt.attemptId === claimed.attempt.id)?.usage ?? []
    const values = Object.fromEntries(usage.map((item) => [item.metric, [item.value, item.coverage]]))
    expect(values.tokens_total).toEqual([10_000, 'observed'])
    expect(values.tokens_cached_input).toEqual([6000, 'observed'])
    expect(values.tokens_reasoning).toEqual([400, 'observed'])
    const stored = view.observations?.find((item) => item.metric === 'tokens_total' && item.source.actor === 'host:parent')
    expect(stored?.attributes['raw.service_tier']).toBe('priority')
    expect(stored?.usage?.coverage).toBe('inclusive')
  })
})
