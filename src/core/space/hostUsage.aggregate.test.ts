// DM-273: usage streams whose samples disagree: partly reported categories, mixed fields and list prices, and the
// attribute budget of a report.
import { describe, expect, it } from 'vitest'
import type { MetricReport } from '../../shared/domain/metrics'
import { addSample, breakdownOf, cumulativeDeltas, emptyAggregate, tokenReports, type UsageBreakdown, type UsageStreamIdentity } from './hostUsage'

const SELF: UsageStreamIdentity = { actor: 'fixture:session', parentActor: null, coverage: 'self', billing: 'subscription' }

/** The cumulative reports of a stream holding `breakdowns`, one sample each. */
function reportsOf(breakdowns: readonly UsageBreakdown[]): MetricReport[] {
  const aggregate = emptyAggregate(breakdowns[0]?.format ?? 'omp')
  for (const breakdown of breakdowns) addSample(aggregate, breakdown, null)
  return tokenReports(aggregate, SELF, { accumulation: 'cumulative', sequence: breakdowns.length, observedAt: '2026-11-15T10:00:00.000Z' })
}

const byMetric = (reports: readonly MetricReport[]) => Object.fromEntries(reports.map((report) => [report.metric, report]))

describe('DM-273: a Gemini total is derived only with its separate reasoning count', () => {
  it('without thoughtsTokenCount no total is derived; with it, input, output and reasoning add up', () => {
    expect(breakdownOf('gemini', { promptTokenCount: 10, candidatesTokenCount: 5 })).toMatchObject({ total: null, totalBasis: null, reasoning: null })
    expect(breakdownOf('gemini', { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 })).toMatchObject({ total: 18, totalBasis: 'derived_disjoint' })
  })

  it('a stream of Gemini samples without reasoning reports its total as not derivable', () => {
    const total = byMetric(reportsOf([breakdownOf('gemini', { promptTokenCount: 10, candidatesTokenCount: 5 })])).tokens_total
    expect(total?.measurement).toEqual({ state: 'missing', reason: 'host_unavailable' })
    expect(total?.attributes).toMatchObject({ totalBasis: 'not_derivable', billing: 'subscription' })
  })
})

describe('DM-273: running list prices become deltas', () => {
  it('the first price is its own delta, later ones the increase, and an update with no price has none', () => {
    const totals = [
      breakdownOf('omp', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.25 } }),
      breakdownOf('omp', { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0.75 } }),
      breakdownOf('omp', { input: 30, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 40 })
    ]
    expect(cumulativeDeltas(totals).map((delta) => [delta.total, delta.listPriceUsd])).toEqual([
      [15, 0.25],
      [15, 0.5],
      [10, null]
    ])
  })
})

describe('DM-273: a stream whose samples disagree', () => {
  it('a category some samples left out is a partial gap, one none reported is unavailable from the host', () => {
    const reports = byMetric(reportsOf([breakdownOf('openai_chat', { prompt_tokens: 10, completion_tokens: 4 }), breakdownOf('openai_chat', { prompt_tokens: 5, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 1 } })]))
    expect(reports.tokens_input?.measurement).toEqual({ state: 'observed', value: 15 })
    expect(reports.tokens_reasoning?.measurement).toEqual({ state: 'missing', reason: 'partial_coverage' })
    expect(reports.tokens_cached_input?.measurement).toEqual({ state: 'missing', reason: 'host_unavailable' })
    expect(reports.tokens_total?.attributes).toMatchObject({ totalBasis: 'derived_disjoint', billing: 'subscription' })
  })

  it('reported and derived totals read mixed, a price some samples left out is unknown, and a partial cache write is null', () => {
    const reports = byMetric(
      reportsOf([
        breakdownOf('omp', { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 18, cost: { total: 0.1 } }),
        breakdownOf('omp', { input: 10, output: 5, cacheRead: 1, cacheWrite: 2 }),
        breakdownOf('omp', { input: 10, output: 5, cacheRead: 1 })
      ])
    )
    expect(reports.tokens_total?.attributes).toMatchObject({ totalBasis: 'mixed', listPriceUsd: null, costBasis: 'list_price' })
    expect(reports.tokens_input?.attributes).toMatchObject({ cacheWriteTokens: null })
  })

  it('an unknown text field stated differently by two samples reads mixed; the same text stays', () => {
    const reports = byMetric(reportsOf([breakdownOf('codex', { total_tokens: 1, tier: 'a', region: 'eu' }), breakdownOf('codex', { total_tokens: 1, tier: 'b', region: 'eu' })]))
    expect(reports.tokens_total?.attributes).toMatchObject({ 'raw.tier': 'mixed', 'raw.region': 'eu' })
  })

  it('a stream refuses a sample of another format', () => {
    const aggregate = emptyAggregate('codex')
    expect(() => addSample(aggregate, breakdownOf('omp', { input: 1 }), null)).toThrow('A codex stream cannot take a omp sample.')
  })
})

describe('DM-273: raw fields beyond the attribute budget are counted, never failing the report', () => {
  it('keeps the shallowest fields that fit and counts the rest in rawOmitted', () => {
    const extra = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`field${String(n).padStart(2, '0')}`, 'x']))
    const total = byMetric(reportsOf([breakdownOf('codex', { total_tokens: 7, ...extra })])).tokens_total
    const raw = Object.keys(total?.attributes ?? {}).filter((name) => name.startsWith('raw.'))
    expect(raw.length).toBeGreaterThan(0)
    expect(raw).toEqual(Object.keys(extra).slice(0, raw.length).map((name) => `raw.${name}`))
    expect(total?.attributes?.rawOmitted).toBe(20 - raw.length)
    expect(Object.keys(total?.attributes ?? {}).length).toBeLessThanOrEqual(18)
  })
})
