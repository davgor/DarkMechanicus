// DM-273: attribution of threads built directly: orphan threads, provider switches, totals not reported, empty spans
// and threads still writing.
import { describe, expect, it } from 'vitest'
import { attributeHostUsage } from './hostAttribution'
import type { HostThread, HostTranscript } from './hostTranscripts'
import { breakdownOf } from './hostUsage'

const T0 = Date.parse('2026-11-15T09:00:00.000Z')
const at = (min: number): number => T0 + min * 60_000
const RUN = `rn_${'0'.repeat(25)}1`
const ATTEMPT = `at_${'0'.repeat(25)}a`
const RUN_SET = { runId: RUN, executing: new Set([ATTEMPT]), carriedForward: new Set<string>() }
const OPTIONS = { asOf: at(600), settleMs: 15 * 60_000, gapToleranceMs: 60_000, billing: 'unknown' as const }
const ompSample = (min: number, total: number) => ({ key: `k${min}`, at: at(min), breakdown: breakdownOf('omp', { input: 1, output: total - 1, cacheRead: 0, cacheWrite: 0, totalTokens: total }), model: 'm' })

/** A thread with nothing recorded; `patch` fills in what a test needs. */
const thread = (name: string, patch: Partial<HostThread> = {}): HostThread => ({ name, parent: name === 'main' ? null : 'main', startedAt: at(0), usage: [], activity: [], claims: [], runLinks: [], pendingUsage: false, ...patch })

/** The main thread linked to the run at minute 1. */
const linkedMain = (patch: Partial<HostThread> = {}): HostThread => thread('main', { runLinks: [{ at: at(1), runId: RUN }], ...patch })

const attribute = (threads: HostThread[]) => attributeHostUsage({ host: 'omp', sessionId: 'sess', threads } satisfies HostTranscript, RUN_SET, OPTIONS)
const shareRows = (threads: HostThread[]) => attribute(threads).shares.map((share) => [share.actor, share.bucket.kind === 'attempt' ? share.bucket.attemptId : share.bucket.overhead, share.tokensTotal, share.settled])

describe('DM-273: a session without a main thread is not linked', () => {
  it('attributes nothing and says the run was never named', () => {
    const result = attribute([thread('worker', { usage: [ompSample(5, 100)] })])
    expect(result).toEqual({ linked: false, buckets: [], shares: [], notes: [`The omp session sess never named run ${RUN} in a completed run call.`] })
  })
})

describe('DM-273: a thread holding no claim whose parent is unknown', () => {
  it.each([
    ['no parent at all', null],
    ['a parent missing from the session', 'gone']
  ])('with %s, its usage in the run window is unattributed', (_label, parent) => {
    const orphan = thread('helper', { parent, startedAt: at(5), usage: [ompSample(6, 300)] })
    expect(shareRows([linkedMain(), orphan])).toEqual([['omp:sess/helper', 'unattributed', 300, true]])
  })
})

describe('DM-273: one thread, two providers, and totals not reported', () => {
  it('a thread that switched provider reports one stream per format', () => {
    const codex = { key: 'c', at: at(7), breakdown: breakdownOf('codex', { input_tokens: 5, output_tokens: 5, total_tokens: 10 }), model: 'gpt' }
    const worker = thread('worker', { claims: [{ at: at(0), attemptId: ATTEMPT }], usage: [ompSample(6, 100), codex] })
    const actors = attribute([linkedMain(), worker]).buckets.flatMap((bucket) => bucket.reports.filter((report) => report.metric === 'tokens_total').map((report) => report.source.actor))
    expect(actors).toEqual(['omp:sess/worker#omp', 'omp:sess/worker#codex'])
  })

  it('a stream whose samples carry no total keeps the share total unknown', () => {
    const gemini = { key: 'g', at: at(6), breakdown: breakdownOf('gemini', { promptTokenCount: 10, candidatesTokenCount: 5 }), model: 'g' }
    const worker = thread('worker', { claims: [{ at: at(0), attemptId: ATTEMPT }], usage: [gemini] })
    expect(shareRows([linkedMain(), worker])).toEqual([['omp:sess/worker', ATTEMPT, null, true]])
  })
})

describe('DM-273: activity spans and threads still writing', () => {
  it('an instant with no length reports no active time', () => {
    const worker = thread('worker', { claims: [{ at: at(0), attemptId: ATTEMPT }], activity: [{ start: at(10), end: at(10) }, { start: at(20), end: at(25) }] })
    const spans = attribute([linkedMain(), worker]).buckets.flatMap((bucket) => bucket.reports.filter((report) => report.metric === 'active_ms').map((report) => report.measurement))
    expect(spans).toEqual([{ state: 'observed', value: 5 * 60_000 }])
  })

  it('a main thread still writing its first message, with no sample or span yet, reports nothing', () => {
    expect(attribute([linkedMain({ pendingUsage: true })])).toEqual({ linked: true, buckets: [], shares: [], notes: [] })
  })

  it('a pending thread last seen outside the run window keeps its earlier samples settled', () => {
    const main = linkedMain({ runLinks: [{ at: at(1), runId: RUN }, { at: at(50), runId: `rn_${'0'.repeat(25)}2` }], usage: [ompSample(10, 400), ompSample(60, 500)], pendingUsage: true })
    expect(shareRows([main])).toEqual([['omp:sess', 'orchestration', 400, true]])
  })
})
