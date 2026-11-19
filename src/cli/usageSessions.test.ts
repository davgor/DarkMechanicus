import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { rejectAttempt, submitAttempt } from '../core/services/attempts'
import { getRunMetrics, recordAttemptMetrics, recordRunMetrics } from '../core/services/metricReports'
import { HOST_USAGE_SUPPORT } from '../shared/domain/hostUsage'
import type { RunMetricsView, UsageMetric } from '../shared/domain/metrics'
import { makeBundle } from '../test/bundles'
import { claim, startedRun } from '../test/execution'
import { removeScratch } from '../test/removeScratch'
import { createTestClock, createTestCtx, type TestCtx, withRole } from '../test/testContext'
import type { UsageMode } from './args'
import { reportHostUsage } from './usage'

const FIXTURES = fileURLToPath(new URL('../core/space/fixtures/usage/', import.meta.url))
const OMP_MAIN = '2026-11-15T20-19-53-174Z_01a1e0dd-c6d6-7423-927a-00d64802c690'
const CLAUDE = '6f1c2a4e-9b3d-4c8a-a1e2-3f4b5c6d7e8f'
const zero = (last: string): string => `${'0'.repeat(25)}${last}`
const PLACEHOLDER = { run: `rn_${zero('1')}`, a: `at_${zero('a')}`, b: `at_${zero('b')}` }

const scratches: string[] = []
afterEach(() => {
  for (const folder of scratches.splice(0)) removeScratch(folder)
})

function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'dm-usage-'))
  scratches.push(folder)
  return folder
}

/** Copies a recorded session tree into a scratch folder, its placeholder ids replaced by this test's ids. */
function copySession(from: string, ids: Partial<Record<keyof typeof PLACEHOLDER, string>>): string {
  const target = scratch()
  for (const name of readdirSync(join(FIXTURES, from), { recursive: true, encoding: 'utf8' })) {
    const source = join(FIXTURES, from, name)
    if (!name.endsWith('.jsonl')) continue
    let text = readFileSync(source, 'utf8')
    for (const [key, id] of Object.entries(ids)) text = text.replaceAll(PLACEHOLDER[key as keyof typeof PLACEHOLDER], id)
    const destination = join(target, relative(join(FIXTURES, from), source))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, text)
  }
  return target
}

function api(ctx: TestCtx) {
  const orchestrator = withRole(ctx, 'orchestrator')
  return {
    getRunMetrics: async (input: Parameters<typeof getRunMetrics>[1]) => getRunMetrics(orchestrator, input),
    recordAttemptMetrics: async (input: Parameters<typeof recordAttemptMetrics>[1]) => recordAttemptMetrics(orchestrator, input),
    recordRunMetrics: async (input: Parameters<typeof recordRunMetrics>[1]) => recordRunMetrics(orchestrator, input)
  }
}

const mode = (runId: string, sessionFile: string, dryRun = false): UsageMode => ({ kind: 'usage', runId, sessionFile, billing: 'subscription', dryRun, unavailable: null })
const cellOf = (view: RunMetricsView, bucket: string, metric: UsageMetric) =>
  (bucket.startsWith('at_') ? view.attempts.find((item) => item.attemptId === bucket)?.usage : view.overheadByKind.find((item) => item.overhead === bucket)?.usage)?.find((item) => item.metric === metric)

/** A run whose first attempt was rejected and retried, as the recorded OMP session worked it. */
function ompWorld() {
  const clock = createTestClock('2026-11-15T22:39:00.000Z')
  const ctx = createTestCtx({ clock })
  const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
  const first = claim(ctx, runId, 1, { leaseSeconds: 7200 })
  clock.set('2026-11-15T22:44:10.000Z')
  submitAttempt(withRole(ctx, 'worker'), { attemptId: first.attempt.id, claimToken: first.packet.claimToken, outputs: { summary: 'x' } })
  rejectAttempt(ctx, { attemptId: first.attempt.id, reasons: ['redo'] })
  const second = claim(ctx, runId, 1, { leaseSeconds: 7200 })
  const folder = copySession('omp', { run: runId, a: first.attempt.id, b: second.attempt.id })
  return { ctx, runId, a: first.attempt.id, b: second.attempt.id, folder }
}

const OMP_NOW = Date.parse('2026-11-16T00:00:00.000Z')

describe('dm usage reads an OMP session from its files', () => {
  it('records every thread of the main file and its subagent folder in its bucket', async () => {
    const { ctx, runId, a, b, folder } = ompWorld()
    const methods = api(ctx)
    const report = await reportHostUsage(methods, mode(runId, join(folder, `${OMP_MAIN}.jsonl`)), OMP_NOW)
    expect([report.host, report.sessionId, report.support]).toEqual(['omp', '01a1e0dd-c6d6-7423-927a-00d64802c690', HOST_USAGE_SUPPORT.omp])
    expect(report.created).toBeGreaterThan(0)
    const view = await methods.getRunMetrics({ runId })
    expect([a, b, 'orchestration', 'unattributed'].map((bucket) => cellOf(view, bucket, 'tokens_total')?.value)).toEqual([300_271, 86_627, 102_660, 154_620])
  })

  it('a subagent\'s file nested two folders down reads the same whole session, so nothing new is recorded', async () => {
    const { ctx, runId, folder } = ompWorld()
    const methods = api(ctx)
    const first = await reportHostUsage(methods, mode(runId, join(folder, `${OMP_MAIN}.jsonl`)), OMP_NOW)
    const nested = join(folder, OMP_MAIN, 'DM-1Worker', 'DM-1Helper.jsonl')
    mkdirSync(dirname(nested), { recursive: true })
    writeFileSync(nested, readFileSync(join(folder, OMP_MAIN, 'DM-1Helper.jsonl'), 'utf8'))
    removeScratch(join(folder, OMP_MAIN, 'DM-1Helper.jsonl'))
    const again = await reportHostUsage(methods, mode(runId, nested), OMP_NOW)
    expect(again.sessionId).toBe(first.sessionId)
    expect([again.created, again.unchanged]).toEqual([0, first.created])
  })

  it('a dry run attributes the session but records nothing', async () => {
    const { ctx, runId, a, folder } = ompWorld()
    const methods = api(ctx)
    const report = await reportHostUsage(methods, mode(runId, join(folder, OMP_MAIN, 'DM-1Worker.jsonl'), true), OMP_NOW)
    expect([report.dryRun, report.created, report.unchanged]).toEqual([true, 0, 0])
    expect(report.threads.length).toBeGreaterThan(0)
    expect(cellOf(await methods.getRunMetrics({ runId }), a, 'tokens_total')?.coverage).toBe('unreported')
  })

  it('a session never linked to the run is refused as unmet_prerequisite', async () => {
    const ctx = createTestCtx({ clock: createTestClock('2026-11-15T22:39:00.000Z') })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const folder = copySession('omp', {})
    await expect(reportHostUsage(api(ctx), mode(runId, join(folder, `${OMP_MAIN}.jsonl`)), OMP_NOW)).rejects.toMatchObject({
      code: 'unmet_prerequisite',
      message: expect.stringMatching(/Run dm usage from the session that orchestrates the run\.$/) as unknown
    })
  })
})

const iso = (min: number): string => new Date(Date.parse('2026-11-15T09:00:00.000Z') + min * 60_000).toISOString()
const claimLines = (runId: string, from: number): string[] => [
  JSON.stringify({ type: 'message', id: `e${from}`, timestamp: iso(from), message: { role: 'assistant', model: 'm', usage: { input: 2, output: 998, cacheRead: 1000, cacheWrite: 0, totalTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.parse(iso(from)) - 10_000, completedAt: Date.parse(iso(from)), content: [{ type: 'toolCall', id: `m${from}`, name: 'bash', arguments: { command: `dm call claim_ticket '{"runId":"${runId}"}'` } }] } }),
  JSON.stringify({ type: 'message', id: `e${from + 1}`, timestamp: iso(from), message: { role: 'toolResult', toolCallId: `m${from}`, isError: false, content: [{ type: 'text', text: '{"ok": true}' }] } })
]
const sessionHeader = (id: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ type: 'session', version: 3, id, timestamp: iso(0), ...extra })

describe('dm usage tells an OMP subagent file from a main one by its session header', () => {
  it.each([
    ['an empty parentSession names no parent: the file is read as a main session', [sessionHeader('sess-x', { parentSession: '' })], 'sess-x'],
    ['a torn line mentioning the session stops the search: the file is read as it is', ['{"type":"session","version":3,"id":"tor', sessionHeader('sess-x', { parentSession: 'C:\\x\\main.jsonl' })], 'sess-x'],
    ['lines mentioning "session" that are not the header are skipped until it names a parent', ['"session"', JSON.stringify({ type: 'title', title: 'session' }), sessionHeader('sess-x', { parentSession: 'C:\\x\\main.jsonl' })], 'sess-main'],
    ['a header past the first 20 lines is not searched: the file is read as a main session', [...Array.from({ length: 20 }, () => ''), sessionHeader('sess-x', { parentSession: 'C:\\x\\main.jsonl' })], 'sess-x']
  ])('%s', async (_name, head, sessionId) => {
    const ctx = createTestCtx({ clock: createTestClock(iso(0)) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const folder = scratch()
    writeFileSync(join(folder, 'main.jsonl'), [sessionHeader('sess-main'), ...claimLines(runId, 1)].join('\n'))
    mkdirSync(join(folder, 'main'))
    writeFileSync(join(folder, 'main', 'x.jsonl'), [...head, ...claimLines(runId, 3)].join('\n'))
    const report = await reportHostUsage(api(ctx), mode(runId, join(folder, 'main', 'x.jsonl'), true), Date.parse(iso(120)))
    expect(report.sessionId).toBe(sessionId)
  })
})

describe('dm usage reads a Claude Code session from its files', () => {
  it('a subagent file under subagents/ reads its whole session: the claimed subagent feeds the attempt', async () => {
    const ctx = createTestCtx({ clock: createTestClock('2026-11-15T09:59:00.000Z') })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    const folder = copySession('claude', { run: runId, a: claimed.attempt.id })
    const methods = api(ctx)
    const asOf = Date.parse('2026-11-15T11:07:42.000Z')
    const report = await reportHostUsage(methods, mode(runId, join(folder, CLAUDE, 'subagents', 'agent-a1b2c3.jsonl')), asOf)
    expect([report.host, report.sessionId, report.support]).toEqual(['claude_code', CLAUDE, HOST_USAGE_SUPPORT.claude])
    const view = await methods.getRunMetrics({ runId })
    expect(cellOf(view, claimed.attempt.id, 'tokens_total')).toMatchObject({ value: 13_506, coverage: 'observed' })
    expect(cellOf(view, 'orchestration', 'tokens_total')?.coverage).toBe('partial')
  })

  it('the main file reads the same session as its subagent file', async () => {
    const ctx = createTestCtx({ clock: createTestClock('2026-11-15T09:59:00.000Z') })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    const folder = copySession('claude', { run: runId, a: claimed.attempt.id })
    const methods = api(ctx)
    const asOf = Date.parse('2026-11-15T11:07:42.000Z')
    await reportHostUsage(methods, mode(runId, join(folder, CLAUDE, 'subagents', 'agent-a1b2c3.jsonl')), asOf)
    const again = await reportHostUsage(methods, mode(runId, join(folder, `${CLAUDE}.jsonl`)), asOf)
    expect(again.created).toBe(0)
    expect(again.unchanged).toBeGreaterThan(0)
  })
})

describe('dm usage refuses what it cannot read', () => {
  it('a session file that does not exist is not_found', async () => {
    const ctx = createTestCtx({ clock: createTestClock(iso(0)) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    await expect(reportHostUsage(api(ctx), mode(runId, join(scratch(), 'missing.jsonl')), Date.parse(iso(1)))).rejects.toMatchObject({ code: 'not_found', message: 'The host session file does not exist.' })
  })

  it('a file from neither host is refused as invalid_input, never guessed', async () => {
    const ctx = createTestCtx({ clock: createTestClock(iso(0)) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const file = join(scratch(), 'other.jsonl')
    writeFileSync(file, '{"type":"call","agent":"Main"}\n')
    await expect(reportHostUsage(api(ctx), mode(runId, file), Date.parse(iso(1)))).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/^The session file is neither an OMP nor a Claude Code session/) as unknown })
  })

  it('--unavailable refuses a host name that is not a plain label', async () => {
    const ctx = createTestCtx({ clock: createTestClock(iso(0)) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const unavailable: UsageMode = { kind: 'usage', runId, sessionFile: null, billing: 'unknown', dryRun: false, unavailable: 'my host!' }
    await expect(reportHostUsage(api(ctx), unavailable, Date.parse(iso(1)))).rejects.toMatchObject({ code: 'invalid_input', message: '--unavailable names the host in 1-40 letters, digits and . _ -.' })
  })

  it('--unavailable as a dry run says what it would mark and records nothing', async () => {
    const ctx = createTestCtx({ clock: createTestClock(iso(0)) })
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    claim(ctx, runId, 1, { leaseSeconds: 7200 })
    const methods = api(ctx)
    const report = await reportHostUsage(methods, { kind: 'usage', runId, sessionFile: null, billing: 'unknown', dryRun: true, unavailable: 'codex' }, Date.parse(iso(1)))
    expect([report.created, report.unchanged, report.notes]).toEqual([0, 0, ["Recorded as unavailable from codex: the run's orchestration bucket and 1 attempt(s) that reported nothing."]])
    expect((await methods.getRunMetrics({ runId })).attempts.flatMap((attempt) => attempt.usage).filter((cell) => cell.coverage !== 'unreported')).toEqual([])
  })
})
