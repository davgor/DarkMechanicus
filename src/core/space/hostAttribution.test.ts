import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { adoptRevision } from '../services/adoption'
import { acceptAttempt, failAttempt, rejectAttempt, submitAttempt } from '../services/attempts'
import { getRunMetrics, recordAttemptMetrics, recordRunMetrics } from '../services/metricReports'
import { cancelRun, pauseRun, resumeRun, startRun } from '../services/runs'
import type { RunMetricsView, UsageCellView, UsageMetric } from '../../shared/domain/metrics'
import { makeBundle, tid } from '../../test/bundles'
import { claim, type IssuedClaim, seedEpic, seedRevision, startedRun } from '../../test/execution'
import { createTestClock, createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { attributeHostUsage } from './hostAttribution'
import { type HostTranscript, readClaudeTranscript, readOmpTranscript } from './hostTranscripts'

const SETTLE = 15 * 60_000
const T0 = Date.parse('2026-11-15T09:00:00.000Z')
const at = (min: number): number => T0 + min * 60_000
const iso = (ms: number): string => new Date(ms).toISOString()
const jsonl = (lines: unknown[]): string => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`

// ---- recorded fixtures, with their placeholder ids replaced in memory (nothing is written) ----

const FIXTURE_ROOT = new URL('./fixtures/usage/', import.meta.url)
const OMP_MAIN = '2026-11-15T20-19-53-174Z_01a1e0dd-c6d6-7423-927a-00d64802c690'
const CLAUDE = '6f1c2a4e-9b3d-4c8a-a1e2-3f4b5c6d7e8f'
const zero = (last: string): string => `${'0'.repeat(25)}${last}`
const PLACEHOLDER = { run: `rn_${zero('1')}`, a: `at_${zero('a')}`, b: `at_${zero('b')}` }

function fixtureText(path: string, ids: Partial<Record<keyof typeof PLACEHOLDER, string>>): string {
  let text = readFileSync(new URL(path, FIXTURE_ROOT), 'utf8')
  for (const [key, id] of Object.entries(ids)) text = text.replaceAll(PLACEHOLDER[key as keyof typeof PLACEHOLDER], id)
  return text
}

function ompFixture(ids: Partial<Record<keyof typeof PLACEHOLDER, string>>): HostTranscript {
  const subagents = ['DM-1Worker', 'DM-1Helper', 'DM-1Review'].map((name) => ({ name: `${name}.jsonl`, text: fixtureText(`omp/${OMP_MAIN}/${name}.jsonl`, ids) }))
  return readOmpTranscript({ name: `${OMP_MAIN}.jsonl`, text: fixtureText(`omp/${OMP_MAIN}.jsonl`, ids) }, subagents)
}

function claudeFixture(ids: Partial<Record<keyof typeof PLACEHOLDER, string>>, asOf: number): HostTranscript {
  const sub = { name: 'agent-a1b2c3.jsonl', text: fixtureText(`claude/${CLAUDE}/subagents/agent-a1b2c3.jsonl`, ids) }
  return readClaudeTranscript({ name: `${CLAUDE}.jsonl`, text: fixtureText(`claude/${CLAUDE}.jsonl`, ids) }, [sub], { asOf, settleMs: SETTLE })
}

// ---- composed OMP sessions ----

let lineId = 0
const ompUsage = (tokens: number) => ({ input: 2, output: tokens - 1002, cacheRead: 1000, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 1_000_000 } })
const assistant = (min: number, tokens: number, calls: [string, string][] = []): unknown => ({
  type: 'message',
  id: `e${++lineId}`,
  timestamp: iso(at(min)),
  message: { role: 'assistant', model: 'm', usage: ompUsage(tokens), timestamp: at(min) - 10_000, completedAt: at(min), content: calls.map(([id, command]) => ({ type: 'toolCall', id, name: 'bash', arguments: { command } })) }
})
const result = (min: number, id: string, text = '{"ok": true}'): unknown => ({ type: 'message', id: `e${++lineId}`, timestamp: iso(at(min)), message: { role: 'toolResult', toolCallId: id, isError: false, content: [{ type: 'text', text }] } })
const userMessage = (min: number, text: string): unknown => ({ type: 'message', id: `e${++lineId}`, timestamp: iso(at(min)), message: { role: 'user', content: [{ type: 'text', text }] } })
// The session id names the stream's actor, so one session read twice must keep it: it depends only on the header.
const header = (min: number, sub: boolean): unknown => ({ type: 'session', version: 3, id: `sess-${sub ? 'sub' : 'main'}-${min}`, timestamp: iso(at(min)), ...(sub ? { parentSession: 'C:\\x\\main.jsonl' } : {}) })
const init = (min: number, task: string): unknown => ({ type: 'session_init', id: `e${++lineId}`, timestamp: iso(at(min)), task })
const toolStart = (min: number, id: string): unknown => ({ type: 'custom', customType: 'tool_execution_start', id: `e${++lineId}`, timestamp: iso(at(min)), data: { toolCallId: id, toolName: 'bash', startedAt: iso(at(min)) } })
const claimCall = (runId: string): string => `dm call claim_ticket '{"runId":"${runId}"}'`

function session(main: unknown[], threads: Record<string, unknown[]> = {}): HostTranscript {
  return readOmpTranscript(
    { name: 'main.jsonl', text: jsonl(main) },
    Object.entries(threads).map(([name, lines]) => ({ name: `${name}.jsonl`, text: jsonl(lines) }))
  )
}

// ---- what `dm usage` does with an attribution: record each bucket through the metric services ----

function report(ctx: TestCtx, runId: string, transcript: HostTranscript, asOf: number) {
  const orchestrator = withRole(ctx, 'orchestrator')
  const run = getRunMetrics(orchestrator, { runId })
  const attribution = attributeHostUsage(
    transcript,
    { runId, executing: new Set(run.attempts.map((attempt) => attempt.attemptId)), carriedForward: new Set(run.carriedForward) },
    { asOf, settleMs: SETTLE, gapToleranceMs: 5000, billing: 'subscription' }
  )
  let created = 0
  let unchanged = 0
  for (const { bucket, reports } of attribution.buckets) {
    const stored =
      bucket.kind === 'attempt'
        ? recordAttemptMetrics(orchestrator, { attemptId: bucket.attemptId, reports })
        : recordRunMetrics(orchestrator, { runId, overhead: bucket.overhead, reports })
    created += stored.created.length
    unchanged += stored.unchanged.length
  }
  return { attribution, created, unchanged }
}

const metrics = (ctx: TestCtx, runId: string, includeObservations = false): RunMetricsView => getRunMetrics(withRole(ctx, 'orchestrator'), { runId, includeObservations })
const cellOf = (cells: readonly UsageCellView[] | undefined, metric: UsageMetric): UsageCellView | undefined => cells?.find((item) => item.metric === metric)
const attemptCell = (view: RunMetricsView, attemptId: string, metric: UsageMetric) => cellOf(view.attempts.find((attempt) => attempt.attemptId === attemptId)?.usage, metric)
const overheadCell = (view: RunMetricsView, kind: string, metric: UsageMetric) => cellOf(view.overheadByKind.find((item) => item.overhead === kind)?.usage, metric)
const runTotal = (view: RunMetricsView): number | null => view.totals.find((item) => item.metric === 'tokens_total')?.reportedValue ?? null
const runState = (view: RunMetricsView) => view.totals.find((item) => item.metric === 'tokens_total')?.measurement.state
const tokens = (view: RunMetricsView, bucket: string): number | null | undefined =>
  (bucket.startsWith('at_') ? attemptCell(view, bucket, 'tokens_total') : overheadCell(view, bucket, 'tokens_total'))?.value

describe('DM-173 c2: OMP recorded session attributes through its session links', () => {
  function world() {
    const clock = createTestClock('2026-11-15T22:39:00.000Z')
    const ctx = createTestCtx({ clock })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const first = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    clock.set('2026-11-15T22:44:10.000Z')
    submitAttempt(withRole(ctx, 'worker'), { attemptId: first.attempt.id, claimToken: first.packet.claimToken, outputs: { summary: 'x' } })
    rejectAttempt(ctx, { attemptId: first.attempt.id, reasons: ['redo'] })
    const second = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    return { ctx, runId, first, second, transcript: ompFixture({ run: runId, a: first.attempt.id, b: second.attempt.id }) }
  }
  const NOW = Date.parse('2026-11-16T00:00:00.000Z')

  it('worker, helper and retry land on their attempts; orchestration and the claimless reviewer stay visible as overhead', () => {
    const { ctx, runId, first, second, transcript } = world()
    const { attribution } = report(ctx, runId, transcript, NOW)
    const view = metrics(ctx, runId)
    expect(attemptCell(view, first.attempt.id, 'tokens_total')).toMatchObject({ value: 300_271, coverage: 'observed' })
    expect(attemptCell(view, second.attempt.id, 'tokens_total')?.value).toBe(86_627)
    expect(overheadCell(view, 'orchestration', 'tokens_total')?.value).toBe(102_660)
    expect(overheadCell(view, 'unattributed', 'tokens_total')).toMatchObject({ value: 154_620, coverage: 'observed' })
    expect(runTotal(view)).toBe(644_178)
    expect(attribution.notes).toEqual([])
    expect(view.attempts).toHaveLength(2)
  })

  it('active time per bucket: attempt 1 199 s, attempt 2 14 s, orchestration 12 s, unattributed 29 s', () => {
    const { ctx, runId, first, second, transcript } = world()
    report(ctx, runId, transcript, NOW)
    const view = metrics(ctx, runId)
    expect(attemptCell(view, first.attempt.id, 'active_ms')?.value).toBe(199_000)
    expect(attemptCell(view, second.attempt.id, 'active_ms')?.value).toBe(14_000)
    expect(overheadCell(view, 'orchestration', 'active_ms')?.value).toBe(12_000)
    expect(overheadCell(view, 'unattributed', 'active_ms')?.value).toBe(29_000)
  })

  it('a session never linked to the run attributes nothing', () => {
    const ctx = createTestCtx({ clock: createTestClock('2026-11-15T09:59:00.000Z') })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const attribution = attributeHostUsage(ompFixture({}), { runId, executing: new Set(), carriedForward: new Set() }, { asOf: NOW, settleMs: SETTLE, gapToleranceMs: 5000, billing: 'unknown' })
    expect(attribution.linked).toBe(false)
    expect(attribution.buckets).toEqual([])
    expect(attribution.shares).toEqual([])
  })
})

describe('DM-173 c2: Claude Code recorded session', () => {
  it('the subagent holding the claim feeds the attempt; main is orchestration, partial until it settles', () => {
    const clock = createTestClock('2026-11-15T09:59:00.000Z')
    const ctx = createTestCtx({ clock })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    const asOf = Date.parse('2026-11-15T11:07:42.000Z')
    report(ctx, runId, claudeFixture({ run: runId, a: claimed.attempt.id }, asOf), asOf)
    const early = metrics(ctx, runId)
    expect(attemptCell(early, claimed.attempt.id, 'tokens_total')).toMatchObject({ value: 13_506, coverage: 'observed' })
    expect(attemptCell(early, claimed.attempt.id, 'active_ms')?.value).toBe(6000)
    expect(overheadCell(early, 'orchestration', 'tokens_total')?.coverage).toBe('partial')
    expect(runState(early)).toBe('missing')
    const later = asOf + 3_600_000
    report(ctx, runId, claudeFixture({ run: runId, a: claimed.attempt.id }, later), later)
    const settled = metrics(ctx, runId)
    expect(overheadCell(settled, 'orchestration', 'tokens_total')).toMatchObject({ value: 57_936, coverage: 'observed' })
    expect(overheadCell(settled, 'orchestration', 'active_ms')?.value).toBe(9000)
    expect(runTotal(settled)).toBe(13_506 + 57_936)
  })
})

describe('DM-173 c4: a measurement the host does not report stays unknown, never 0', () => {
  it('Anthropic reasoning is not reported: tokens_reasoning reads unavailable with no number', () => {
    const ctx = createTestCtx({ clock: createTestClock('2026-11-15T09:59:00.000Z') })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    const asOf = Date.parse('2026-11-15T12:07:42.000Z')
    report(ctx, runId, claudeFixture({ run: runId, a: claimed.attempt.id }, asOf), asOf)
    const cell = attemptCell(metrics(ctx, runId), claimed.attempt.id, 'tokens_reasoning')
    expect(cell?.coverage).toBe('unavailable')
    expect(cell?.value).toBeNull()
  })
})

describe('DM-173 c2: claim changes and foreign ids inside one session', () => {
  it("a retry's claim handed to the same thread by message binds from the message on (20000 / 97500)", () => {
    const ctx = createTestCtx({ clock: createTestClock(iso(at(0))) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const first = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    submitAttempt(withRole(ctx, 'worker'), { attemptId: first.attempt.id, claimToken: first.packet.claimToken, outputs: { summary: 'x' } })
    rejectAttempt(ctx, { attemptId: first.attempt.id, reasons: ['redo'] })
    const second = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    const transcript = session([header(0, false), assistant(1, 1000, [['m1', claimCall(runId)]]), result(1, 'm1')], {
      W: [header(2, true), init(2, `claimToken ${first.packet.claimToken}`), assistant(5, 20_000), userMessage(10, `Rejected; fix it. Your new claim: ${second.packet.claimToken}`), assistant(12, 90_000), assistant(14, 7500)]
    })
    report(ctx, runId, transcript, at(60))
    const view = metrics(ctx, runId)
    expect(attemptCell(view, first.attempt.id, 'tokens_total')?.value).toBe(20_000)
    expect(attemptCell(view, second.attempt.id, 'tokens_total')?.value).toBe(97_500)
  })

  it('a run id cited in a claim answer does not end the window; a reviewer quoting a foreign token stays unattributed', () => {
    const ctx = createTestCtx({ clock: createTestClock(iso(at(0))) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    const transcript = session(
      [
        header(0, false),
        assistant(1, 10_000, [['m1', claimCall(runId)]]),
        result(1, 'm1'),
        assistant(5, 11_000, [['m2', claimCall(runId)]]),
        result(5, 'm2', `{"ok": true, "data": {"ticket": {"body": "see run rn_${zero('z')} for the earlier attempt"}}}`),
        assistant(9, 15_000)
      ],
      { Rev: [header(10, true), init(10, `Review this. The fixture holds at_${zero('z')}.fixtureSecretZZ`), assistant(12, 100_000)] }
    )
    const { attribution } = report(ctx, runId, transcript, at(120))
    const view = metrics(ctx, runId)
    expect(overheadCell(view, 'orchestration', 'tokens_total')?.value).toBe(36_000)
    expect(overheadCell(view, 'unattributed', 'tokens_total')?.value).toBe(100_000)
    expect(runTotal(view)).toBe(136_000)
    expect(attribution.notes).toEqual([`Attempt at_${zero('z')} is not an attempt of run ${runId}; its thread started and worked in the run's window, so its usage is unattributed.`])
  })
})

function twoRuns() {
  const clock = createTestClock(iso(at(0)))
  const ctx = createTestCtx({ clock })
  const { epicId } = seedEpic(ctx, { bundle: makeBundle([[1, 2]]) })
  const run1 = startRun(withRole(ctx, 'orchestrator'), { epicId })
  const a1 = claim(ctx, run1.id, 1, { leaseSeconds: 7200 })
  clock.set(iso(at(20)))
  cancelRun(ctx, { runId: run1.id, reason: 'restart' })
  const run2 = startRun(withRole(ctx, 'orchestrator'), { epicId })
  const b1 = claim(ctx, run2.id, 1, { leaseSeconds: 7200 })
  const main = [
    header(0, false),
    assistant(1, 10_000, [['s1', `dm call start_run '{"epicId":"ep"}'`]]),
    result(1, 's1', `{"ok": true, "data": {"id": "${run1.id}"}}`),
    assistant(3, 11_000),
    assistant(21, 12_000, [['s2', `dm call start_run '{"epicId":"ep"}'`]]),
    result(21, 's2', `{"ok": true, "data": {"id": "${run2.id}", "tickets": [{"body": "restarted from ${run1.id}"}]}}`),
    assistant(23, 13_000)
  ]
  return { ctx, run1: run1.id, run2: run2.id, a1, b1, main }
}

describe('DM-173 c3: one session across two runs counts each sample in one run only', () => {
  it('separate threads per run: run 1 71000 + run 2 115000 = the 186000 spent', () => {
    const { ctx, run1, run2, a1, b1, main } = twoRuns()
    const transcript = session(main, {
      W1: [header(4, true), init(4, `claimToken ${a1.packet.claimToken}`), assistant(6, 20_000)],
      Rev1: [header(10, true), init(10, 'Review run 1.'), assistant(11, 30_000)],
      W2: [header(24, true), init(24, `claimToken ${b1.packet.claimToken}`), assistant(26, 40_000)],
      Rev2: [header(30, true), init(30, 'Review run 2.'), assistant(31, 50_000)]
    })
    report(ctx, run1, transcript, at(120))
    report(ctx, run2, transcript, at(120))
    const v1 = metrics(ctx, run1)
    const v2 = metrics(ctx, run2)
    expect([tokens(v1, 'orchestration'), tokens(v1, a1.attempt.id), tokens(v1, 'unattributed')]).toEqual([21_000, 20_000, 30_000])
    expect([tokens(v2, 'orchestration'), tokens(v2, b1.attempt.id), tokens(v2, 'unattributed')]).toEqual([25_000, 40_000, 50_000])
    expect((runTotal(v1) ?? 0) + (runTotal(v2) ?? 0)).toBe(186_000)
  })

  it('a worker thread reused by run 2 counts its run-2 samples only in run 2 (run 1 41000 + run 2 75000 = the 116000 spent)', () => {
    const { ctx, run1, run2, a1, b1, main } = twoRuns()
    const transcript = session(main, {
      W: [header(4, true), init(4, `claimToken ${a1.packet.claimToken}`), assistant(6, 20_000), userMessage(24, `New run, new claim: ${b1.packet.claimToken}`), assistant(26, 40_000), assistant(27, 10_000)]
    })
    const first = report(ctx, run1, transcript, at(120))
    report(ctx, run2, transcript, at(120))
    const v1 = metrics(ctx, run1)
    const v2 = metrics(ctx, run2)
    expect(tokens(v1, a1.attempt.id)).toBe(20_000)
    expect(overheadCell(v1, 'unattributed', 'tokens_total')).toBeUndefined()
    expect(runTotal(v1)).toBe(41_000)
    expect(tokens(v2, b1.attempt.id)).toBe(50_000)
    expect(runTotal(v2)).toBe(75_000)
    expect((runTotal(v1) ?? 0) + (runTotal(v2) ?? 0)).toBe(116_000)
    expect(first.attribution.notes).toEqual([])
  })

  it("a run-1 worker thread still writing under its run-1 claim after run 2 starts stays in run 1 only (81000 + 25000 = the 106000 spent)", () => {
    const { ctx, run1, run2, a1, main } = twoRuns()
    const transcript = session(main, { W: [header(4, true), init(4, `claimToken ${a1.packet.claimToken}`), assistant(6, 20_000), assistant(26, 40_000)] })
    report(ctx, run1, transcript, at(120))
    const second = report(ctx, run2, transcript, at(120))
    const v1 = metrics(ctx, run1)
    const v2 = metrics(ctx, run2)
    expect(tokens(v1, a1.attempt.id)).toBe(60_000)
    expect(runTotal(v1)).toBe(81_000)
    expect(overheadCell(v2, 'unattributed', 'tokens_total')).toBeUndefined()
    expect(runTotal(v2)).toBe(25_000)
    expect((runTotal(v1) ?? 0) + (runTotal(v2) ?? 0)).toBe(106_000)
    expect(second.attribution.notes).toEqual([])
  })
})

/** A run whose attempts were rejected and retried, failed, accepted then superseded, and left running, with a carry-forward. */
function lifecycleRun() {
  const clock = createTestClock(iso(at(0)))
  const ctx = createTestCtx({ clock })
  const worker = withRole(ctx, 'worker')
  const bundle = makeBundle([[1, 2, 3, 4, 5]])
  const { epicId } = seedEpic(ctx, { bundle })
  ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(5))
  const runId = startRun(withRole(ctx, 'orchestrator'), { epicId, carryForward: [{ ticketId: tid(5), note: 'accepted in the last run' }] }).id
  const lease = { leaseSeconds: 7200 }
  const a1 = claim(ctx, runId, 1, lease)
  clock.set(iso(at(10)))
  submitAttempt(worker, { attemptId: a1.attempt.id, claimToken: a1.packet.claimToken, outputs: { summary: 'x' } })
  rejectAttempt(ctx, { attemptId: a1.attempt.id, reasons: ['redo'] })
  const a2 = claim(ctx, runId, 1, lease)
  clock.set(iso(at(20)))
  submitAttempt(worker, { attemptId: a2.attempt.id, claimToken: a2.packet.claimToken, outputs: { summary: 'x' } })
  acceptAttempt(ctx, { attemptId: a2.attempt.id })
  const b1 = claim(ctx, runId, 2, lease)
  failAttempt(worker, { attemptId: b1.attempt.id, claimToken: b1.packet.claimToken, failure: { reason: 'blocked by tooling' } })
  const d1 = claim(ctx, runId, 4, lease)
  clock.set(iso(at(30)))
  submitAttempt(worker, { attemptId: d1.attempt.id, claimToken: d1.packet.claimToken, outputs: { summary: 'x' } })
  acceptAttempt(ctx, { attemptId: d1.attempt.id })
  pauseRun(ctx, { runId, reason: 'replan' })
  const changed = seedRevision(ctx, epicId, { ...bundle, tickets: bundle.tickets.map((ticket) => (ticket.id === tid(4) ? { ...ticket, title: 'Ticket 4, changed' } : ticket)) })
  adoptRevision(withRole(ctx, 'orchestrator'), { runId, revisionId: changed })
  resumeRun(ctx, { runId })
  const d2 = claim(ctx, runId, 4, lease)
  const c1 = claim(ctx, runId, 3, lease)
  clock.set(iso(at(60)))
  const carry = metrics(ctx, runId).carriedForward[0] ?? ''
  return { ctx, clock, runId, a1, a2, b1, d1, d2, c1, carry }
}

/** The orchestrator's main thread and one thread per worker; worker 1 is reused for the retry, a stray thread holds the carry-forward id. */
function lifecycle() {
  const world = lifecycleRun()
  const { runId, a1, a2, b1, d1, d2, c1, carry } = world
  const spawn = (min: number, claimed: IssuedClaim) => [header(min, true), init(min, `packet claimToken ${claimed.packet.claimToken}`)]
  const heartbeat = `dm call heartbeat_attempt '{"attemptId":"${a2.attempt.id}","claimToken":"${a2.packet.claimToken}"}'`
  const transcript = session([header(0, false), assistant(1, 10_000, [['m1', claimCall(runId)]]), result(1, 'm1'), assistant(59, 11_000)], {
    W1: [...spawn(2, a1), assistant(5, 20_000), assistant(11, 21_000, [['w1', heartbeat]]), result(12, 'w1'), assistant(15, 22_000)],
    W2: [...spawn(13, b1), assistant(14, 30_000)],
    W4a: [...spawn(21, d1), assistant(25, 40_000)],
    W4b: [...spawn(41, d2), assistant(45, 41_000)],
    W3: [...spawn(42, c1), assistant(50, 50_000)],
    Stray: [header(43, true), init(43, `packet claimToken ${carry}.notarealsecret`), assistant(44, 60_000)]
  })
  return { ...world, transcript }
}
const SPENT = 10_000 + 11_000 + 20_000 + 21_000 + 22_000 + 30_000 + 40_000 + 41_000 + 50_000 + 60_000

describe('DM-173 c3: every attempted piece of work counts once across the attempt lifecycle', () => {
  it('rejected, retried, failed, superseded and canceled attempts each keep their own usage; the carry-forward takes none', () => {
    const { ctx, clock, runId, a1, a2, b1, d1, d2, c1, carry, transcript } = lifecycle()
    const { attribution } = report(ctx, runId, transcript, at(70))
    clock.set(iso(at(70)))
    cancelRun(ctx, { runId, reason: 'stop' })
    const view = metrics(ctx, runId)
    const row = (claimed: IssuedClaim) => [view.attempts.find((attempt) => attempt.attemptId === claimed.attempt.id)?.state, attemptCell(view, claimed.attempt.id, 'tokens_total')?.value]
    expect(row(a1)).toEqual(['rejected', 41_000])
    expect(row(a2)).toEqual(['accepted', 22_000])
    expect(row(b1)).toEqual(['failed', 30_000])
    expect(row(d1)[1]).toBe(40_000)
    expect(row(d2)[1]).toBe(41_000)
    expect(row(c1)).toEqual(['canceled', 50_000])
    expect(view.carriedForward).toEqual([carry])
    expect(view.attempts.some((attempt) => attempt.attemptId === carry)).toBe(false)
    expect(overheadCell(view, 'unattributed', 'tokens_total')?.value).toBe(60_000)
    expect(attribution.notes).toEqual([`Attempt ${carry} is a carry-forward attempt, which runs nothing: its thread's usage is unattributed.`])
    expect(runTotal(view)).toBe(SPENT)
  })

  it('subscription usage keeps the host list price as list_price, never as a marginal or actual cost', () => {
    const { ctx, runId, a2, transcript } = lifecycle()
    report(ctx, runId, transcript, at(90))
    const view = metrics(ctx, runId, true)
    const stored = view.observations?.find((item) => item.metric === 'tokens_total' && item.scope.attemptId === a2.attempt.id)
    expect(stored?.attributes.costBasis).toBe('list_price')
    expect(stored?.attributes.billing).toBe('subscription')
    expect(stored?.attributes.listPriceUsd).toBe(0.022)
    expect(Object.keys(stored?.attributes ?? {}).filter((key) => /marginal|^cost(Usd)?$|spend/i.test(key))).toEqual([])
    const hostMetrics = new Set((view.observations ?? []).filter((item) => item.metric !== 'handoff_check').map((item) => item.metric))
    expect([...hostMetrics].every((name) => name.startsWith('tokens_') || name === 'active_ms')).toBe(true)
  })
})

function oneRun() {
  const ctx = createTestCtx({ clock: createTestClock(iso(at(0))) })
  const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
  return { ctx, runId }
}
/** The orchestrator's main thread, its last request running `dm usage` itself: `extra` is the tool's start (in session) or result. */
const mainThread = (runId: string, extra: unknown[]) => [header(0, false), assistant(1, 20_000, [['m1', claimCall(runId)]]), result(1, 'm1'), assistant(30, 26_000, [['m2', 'dm usage --run x']]), ...extra]
const inSession = (runId: string, more: unknown[] = []) => session(mainThread(runId, [toolStart(30, 'm2'), ...more]))
const settled = (runId: string, more: unknown[] = []) => session(mainThread(runId, [result(31, 'm2'), ...more]))
const orchestration = (ctx: TestCtx, runId: string) => overheadCell(metrics(ctx, runId), 'orchestration', 'tokens_total')

describe('DM-173 c3: read order never double-counts (sequences 3n, 3n+1, 3n+2)', () => {
  it('growing then settled: the in-session read keeps 46000 as a lower bound, the settled read the same 46000 as observed', () => {
    const { ctx, runId } = oneRun()
    report(ctx, runId, inSession(runId), at(70))
    expect(orchestration(ctx, runId)).toMatchObject({ value: 46_000, coverage: 'partial' })
    expect(runState(metrics(ctx, runId))).toBe('missing')
    report(ctx, runId, settled(runId), at(120))
    expect(orchestration(ctx, runId)).toMatchObject({ value: 46_000, coverage: 'observed' })
    expect(runTotal(metrics(ctx, runId))).toBe(46_000)
  })

  it('repeated reads of the same file store nothing new', () => {
    const { ctx, runId } = oneRun()
    const first = report(ctx, runId, settled(runId), at(120))
    const again = report(ctx, runId, settled(runId), at(150))
    expect(again.created).toBe(0)
    expect(again.unchanged).toBe(first.created)
    expect(runTotal(metrics(ctx, runId))).toBe(46_000)
  })

  it('settled then in-session: a later in-session read of the same samples does not reopen or recount them', () => {
    const { ctx, runId } = oneRun()
    report(ctx, runId, settled(runId), at(120))
    report(ctx, runId, inSession(runId), at(121))
    expect(orchestration(ctx, runId)).toMatchObject({ value: 46_000, coverage: 'observed' })
    expect(runTotal(metrics(ctx, runId))).toBe(46_000)
  })

  it('a later file state then an older copy: the older copy never lowers or repeats the count', () => {
    const { ctx, runId } = oneRun()
    report(ctx, runId, settled(runId, [assistant(40, 7000)]), at(120))
    expect(orchestration(ctx, runId)).toMatchObject({ value: 53_000, coverage: 'observed' })
    report(ctx, runId, settled(runId), at(121))
    report(ctx, runId, inSession(runId), at(122))
    expect(orchestration(ctx, runId)).toMatchObject({ value: 53_000, coverage: 'observed' })
    expect(runTotal(metrics(ctx, runId))).toBe(53_000)
  })
})
