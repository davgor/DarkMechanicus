/**
 * The failure matrix of the SPACE measurement and grading loop (DM-193 c2), each row on its own real repository
 * (`src/test/twoRepoMachine.ts`) through the real commands, read through the desktop `dm:command` handler and, where a
 * row's point is what every channel shows, the MCP read tools: legacy, all-unknown and partial data, fast failing
 * work, failed and rejected retries, scope changes, parallel timing, duplicate cumulative usage, parent-child usage,
 * late regressions and policy changes. No row fabricates a complete grade from data that is not there.
 */
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { storedScorecard } from '../core/services/scorecards'
import type { DraftOp } from '../shared/domain/api'
import type { PlanBundle } from '../shared/domain/bundle'
import type { MetricReport } from '../shared/domain/metrics'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { underPolicyV1 } from '../test/policyV1'
import { callTool, withServer } from '../test/mcpHarness'
import { attempt, fail, MIN, type RunLedger, type Spend } from '../test/spaceLoop'
import { type Side, type TwoRepoMachine, twoRepoMachine } from '../test/twoRepoMachine'

const machines: TwoRepoMachine[] = []

afterEach(() => {
  for (const m of machines.splice(0)) m.cleanup()
})

const budget = { tokens: 50_000, activeMs: 30 * MIN }

interface Row {
  m: TwoRepoMachine
  p: Side
  epicId: string
  bundle: PlanBundle
  ledger: RunLedger
  /** Ticket ids by ref. */
  t: Record<string, string>
  sprintIds: string[]
}

/**
 * A project whose epic plans `sprints` (each a list of ticket refs, every ticket medium and budgeted at 30 minutes and
 * 50,000 tokens), without acceptance nodes (this matrix is about measurement), saved, with its run started.
 */
async function row(sprints: string[][]): Promise<Row> {
  const m = twoRepoMachine()
  machines.push(m)
  const p = m.project
  await p.desktop.initializeRepository({ name: 'shop', keyPrefix: 'SHOP' })
  const epic = await p.orchestrator.createEpic({ title: 'Matrix row', successCriteria: ['It is measured'] })
  // Sprint refs (`s2`, …) name sprints only within the update that adds them, so sprints and tickets go in one update.
  const extra: DraftOp[] = sprints.slice(1).map((_, n) => ({ op: 'add_sprint', ref: `s${n + 2}`, sprint: { goal: `Sprint ${n + 2}` } }))
  const tickets: DraftOp[] = sprints.flatMap((refs, s) =>
    refs.map((ref): DraftOp => ({ op: 'add_ticket', ref, sprint: s === 0 ? '1' : `s${s + 1}`, ticket: { title: `Ticket ${ref}`, size: 'medium', acceptanceCriteria: ['It works'], budget } }))
  )
  const added = await p.orchestrator.updatePlanDraft({ epicId: epic.id, ops: [...extra, ...tickets] })
  const saved = await p.desktop.savePlan({ epicId: epic.id, expectedDraftRevision: await dropAcceptanceNodes(p.orchestrator, epic.id) })
  if (saved.status !== 'saved') fail(`not saved: ${saved.status}`)
  const bundle = (await p.desktop.getPlan({ epicId: epic.id, view: 'saved' })).bundle
  p.clock.advanceSeconds(60)
  const run = await p.orchestrator.startRun({ epicId: epic.id })
  const t = Object.fromEntries(sprints.flat().map((ref) => [ref, added.refMap[ref] ?? fail(`no ref ${ref}`)]))
  return { m, p, epicId: epic.id, bundle, ledger: { runId: run.id, attempts: [], overhead: [] }, t, sprintIds: [...bundle.sprints].sort((a, b) => a.ordinal - b.ordinal).map((sprint) => sprint.id) }
}

const work = (w: Row, ref: string, spend: Spend) => attempt({ side: w.p, ledger: w.ledger, bundle: w.bundle }, w.t[ref] ?? fail(`no ref ${ref}`), spend)
const sprintGrade = (w: Row, n = 0) => w.p.desktop.getSprintGrade({ runId: w.ledger.runId, sprintId: w.sprintIds[n] ?? fail('no sprint') })
const component = <T extends { component: string }>(grade: { components: T[] }, key: string): T => grade.components.find((entry) => entry.component === key) ?? fail(`no ${key}`)
const report = (w: Row, n = 0) => w.p.orchestrator.submitSprintReport({ runId: w.ledger.runId, sprintId: w.sprintIds[n] ?? fail('no sprint'), report: { summary: `Sprint ${n + 1} is over.` } })

interface TokenReading {
  actor: string
  value: number
  at: string
  usage: MetricReport['usage']
  /** A delta event's id; or, for a cumulative reading, its sequence. */
  eventId?: string
  sequence?: number
}

/** A host-relayed token total for an attempt, as `record_attempt_metrics` takes it. */
function tokens({ actor, value, at, usage, eventId, sequence }: TokenReading): MetricReport {
  const base = { metric: 'tokens_total' as const, unit: 'tokens' as const, source: { kind: 'host' as const, actor }, measurement: { state: 'observed' as const, value }, observedAt: at, usage }
  return sequence === undefined ? { ...base, accumulation: 'delta', eventId: eventId ?? fail('a delta without an event id') } : { ...base, accumulation: 'cumulative', sequence }
}

describe('missing and legacy data never become a complete grade (c2)', () => {
  it('legacy: reads a report recorded before scorecards as legacy, ungraded, in every channel', async () => {
    const m = twoRepoMachine()
    machines.push(m)
    // A project whose records come from an older checkout (src/core/repo/__mocks__/legacy): its report froze nothing.
    cpSync(join(__dirname, '..', 'core', 'repo', '__mocks__', 'legacy'), join(m.project.path, '.darkmechanicus'), { recursive: true })
    m.pool.close(m.project.path)
    const imported = await m.project.desktop.reconcileRepository()
    const runId = 'rn_01m3txzt9wj79mxsq50f5ktf1q'
    const run = (await m.project.desktop.getRun({ runId })) ?? fail(`the legacy run was not imported: ${JSON.stringify(imported)}`)
    const plan = await m.project.desktop.getPlan({ epicId: run.epicId, view: 'saved', revisionId: run.revisionId })
    const reports = await Promise.all(plan.bundle.sprints.map((sprint) => m.project.desktop.getSprintReport({ runId, sprintId: sprint.id })))
    const reportId = reports.find((entry) => entry !== null)?.id ?? fail('no legacy report')
    const card = await m.bridge.call(m.project.path, 'getReportScorecard', { reportId })
    expect(card).toMatchObject({ state: 'legacy', report: { reportId, runId } })
    const reassessed = await m.bridge.call(m.project.path, 'reassessReportScorecard', { reportId })
    expect([reassessed.legacy, reassessed.approved]).toEqual([true, null])
    const summary = await m.bridge.call(m.project.path, 'getMetricsSummary', {})
    expect(summary.trend.filter((entry) => entry.runId === runId).map((entry) => [entry.source, entry.grade])).toEqual([['legacy_report', null]])
    await withServer(m.mcp(m.project, 'reader'), async (rig) => {
      expect((await callTool(rig, 'get_report_scorecard', { reportId })).payload).toEqual({ ok: true, data: JSON.parse(JSON.stringify(card)) })
    })
  })

  it('all unknown: a sprint whose host relayed nothing is ungraded, its totals not reported, never 0', async () => {
    const w = await row([['a', 'b']])
    await work(w, 'a', { minutes: 20, tokens: null, unmeasured: true })
    await work(w, 'b', { minutes: 15, tokens: null, unmeasured: true })
    const { grade } = await sprintGrade(w)
    expect([grade.status, grade.letter]).toEqual(['ungraded', null])
    expect(['T', 'K', 'E'].map((key) => component(grade, key).state)).toEqual(['missing', 'missing', 'missing'])
    const summary = await w.p.desktop.getMetricsSummary({})
    expect(summary.totals.tokens.total).toMatchObject({ state: 'missing', value: null })
    expect(summary.totals.time.activeMs).toMatchObject({ state: 'missing', value: null })
  })

  it('partial: one attempt without a token count leaves K unknown with what was seen as a lower bound', async () => {
    const w = await row([['a', 'b']])
    await work(w, 'a', { minutes: 20, tokens: 30_000 })
    await work(w, 'b', { minutes: 10, tokens: null })
    const { grade } = await sprintGrade(w)
    // What was seen stays visible (30,000), but K is not scored from it: one attempt reported no tokens.
    expect(component(grade, 'K')).toMatchObject({ state: 'missing', score: null, inputs: { actual: 30_000, unreportedAttempts: 1 } })
    expect(component(grade, 'T')).toMatchObject({ state: 'observed', inputs: { actual: 30 * MIN } })
    expect(grade.status).not.toBe('final')
    const summary = await w.p.desktop.getMetricsSummary({})
    expect(summary.totals.tokens.total).toMatchObject({ state: 'missing', value: null, reason: 'partial_telemetry', lowerBound: 30_000 })
  })
})

describe('cheap or retried work is graded on what happened (c2)', () => {
  it('fast failing work: a one-minute, 500-token ticket with a failed mandatory criterion fails P and caps the grade at F', async () => {
    const w = await row([['a', 'b']])
    await work(w, 'a', { minutes: 20, tokens: 30_000 })
    await work(w, 'b', { minutes: 1, tokens: 500, unmet: 'the card number is not validated' })
    const ticket = (await w.p.desktop.getTicketGrade({ runId: w.ledger.runId, ticketId: w.t['b'] ?? '' })).grade
    expect([component(ticket, 'T').score, component(ticket, 'K').score]).toEqual([100, 100])
    expect([ticket.outcome, ticket.letter]).toEqual(['failed', 'F'])
    const { grade } = await sprintGrade(w)
    expect([grade.outcome, grade.letter, component(grade, 'P').state]).toEqual(['failed', 'F', 'observed'])
    expect(grade.uncappedScore ?? 0).toBeGreaterThan(grade.score ?? 0)
  })

  it('failed and rejected retries: every attempt\'s spend counts, and C and E see the rework', async () => {
    const w = await row([['a']])
    await work(w, 'a', { minutes: 10, tokens: 8_000, reject: 'The API returns 500 on an empty cart.' })
    await work(w, 'a', { minutes: 5, tokens: 3_000, fail: 'The test database would not start.' })
    await work(w, 'a', { minutes: 15, tokens: 12_000, effort: 'corrective' })
    const { grade } = await sprintGrade(w)
    expect([component(grade, 'K').inputs, component(grade, 'T').inputs]).toMatchObject([{ actual: 23_000 }, { actual: 30 * MIN }])
    expect(component(grade, 'C').inputs).toMatchObject({ rejectedSubmissions: 1 })
    expect(component(grade, 'E').inputs).toMatchObject({ correctiveMs: 15 * MIN, productiveMs: 15 * MIN })
    const usage = await w.p.desktop.getRunMetrics({ runId: w.ledger.runId })
    expect(usage.attempts.map((entry) => [entry.number, entry.state])).toEqual([
      [1, 'rejected'],
      [2, 'failed'],
      [3, 'accepted']
    ])
  })
})

describe('scope and time are attributed to the work that was committed and done (c2)', () => {
  it('scope change: a ticket worked, rejected and then moved out of Sprint 1 stays in its committed scope, marked moved out and undelivered', async () => {
    const w = await row([['a', 'b'], ['c']])
    await work(w, 'a', { minutes: 20, tokens: 30_000 })
    // b is dispatched in Sprint 1 and rejected before the person moves it on.
    await work(w, 'b', { minutes: 10, tokens: 10_000, reject: 'not this sprint' })
    const p = w.p
    await p.orchestrator.updatePlanDraft({ epicId: w.epicId, ops: [{ op: 'move_ticket', ticket: w.t['b'] ?? '', toSprint: w.sprintIds[1] ?? '' }] })
    const draft = await p.desktop.getPlan({ epicId: w.epicId, view: 'draft' })
    await p.desktop.pauseRun({ runId: w.ledger.runId, reason: 'moving b to Sprint 2' })
    const saved = await p.desktop.savePlan({ epicId: w.epicId, expectedDraftRevision: draft.draftRevision ?? fail('no draft') })
    if (saved.status !== 'saved') fail('not saved')
    await p.desktop.adoptRevision({ runId: w.ledger.runId, revisionId: (await p.desktop.getEpic({ epicId: w.epicId })).currentRevisionId ?? fail('no revision') })
    await p.orchestrator.resumeRun({ runId: w.ledger.runId })
    const sprint = await sprintGrade(w)
    // Sprint 1 committed both at its first dispatch; b was moved out before delivery, so A reads 1 of 2 delivered.
    expect(sprint.outcomes.map((entry) => [entry.ticketId === w.t['b'] ? 'b' : 'a', entry.movedOut, entry.counted])).toEqual([
      ['a', false, true],
      ['b', true, true]
    ])
    expect(component(sprint.grade, 'A').inputs).toEqual({ committed: 2, delivered: 1 })
  })

  it('parallel timing: two overlapping 20-minute attempts are 40 minutes of effort in 20 minutes of active wall clock', async () => {
    const w = await row([['a', 'b']])
    const { orchestrator, clock } = w.p
    const claims = [await orchestrator.claimTicket({ runId: w.ledger.runId, ticketId: w.t['a'] ?? '', worker: { label: 'worker a' } }), await orchestrator.claimTicket({ runId: w.ledger.runId, ticketId: w.t['b'] ?? '', worker: { label: 'worker b' } })]
    const start = clock.nowMs()
    for (let minute = 10; minute <= 20; minute += 10) {
      clock.advanceSeconds(600)
      for (const claim of claims) await orchestrator.heartbeatAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken ?? '' })
    }
    const end = clock.nowMs()
    for (const claim of claims) {
      const actor = `omp:worker-${claim.attempt.id.slice(-4)}`
      await orchestrator.recordAttemptMetrics({
        attemptId: claim.attempt.id,
        reports: [
          { metric: 'active_ms', unit: 'milliseconds', source: { kind: 'host', actor }, measurement: { state: 'observed', value: end - start }, accumulation: 'delta', eventId: `span-${claim.attempt.id}`, observedAt: new Date(end).toISOString(), attributes: { spanStart: new Date(start).toISOString(), activeBasis: 'requests_and_tools' }, usage: { coverage: 'self', parentActor: null } }
        ]
      })
    }
    const timing = await w.p.desktop.getRunTiming({ runId: w.ledger.runId })
    expect(timing.effort.total).toMatchObject({ ms: 40 * MIN })
    expect(timing.activeWallClock).toMatchObject({ ms: 20 * MIN, aggregation: 'union' })
  })
})

describe('usage is counted once (c2)', () => {
  it('duplicate cumulative usage: a resent and a stale cumulative reading count once, at the latest total', async () => {
    const w = await row([['a']])
    const { orchestrator, clock } = w.p
    const claim = await orchestrator.claimTicket({ runId: w.ledger.runId, ticketId: w.t['a'] ?? '', worker: { label: 'worker a' } })
    clock.advanceSeconds(300)
    const at = clock.nowIso()
    const reading = { actor: 'omp:a', usage: { coverage: 'self' as const, parentActor: null } }
    const first = await orchestrator.recordAttemptMetrics({ attemptId: claim.attempt.id, reports: [tokens({ ...reading, value: 10_000, at, sequence: 1 })] })
    const resent = await orchestrator.recordAttemptMetrics({ attemptId: claim.attempt.id, reports: [tokens({ ...reading, value: 10_000, at, sequence: 1 })] })
    expect([first.created.length, resent.created.length]).toEqual([1, 0])
    clock.advanceSeconds(300)
    await orchestrator.recordAttemptMetrics({ attemptId: claim.attempt.id, reports: [tokens({ ...reading, value: 25_000, at: clock.nowIso(), sequence: 2 })] })
    // The first reading arrives once more, late: a cumulative total that is not the latest adds nothing.
    await orchestrator.recordAttemptMetrics({ attemptId: claim.attempt.id, reports: [tokens({ ...reading, value: 10_000, at, sequence: 1 })] })
    const usage = await w.p.desktop.getRunMetrics({ runId: w.ledger.runId })
    expect(usage.attempts[0]?.usage.find((cell) => cell.metric === 'tokens_total')?.value).toBe(25_000)
  })

  it('parent-child usage: a child inside an inclusive parent adds nothing; beside a self-only parent it adds its own', async () => {
    const w = await row([['a', 'b']])
    const { orchestrator, clock } = w.p
    const relay = async (ref: string, parent: 'inclusive' | 'self') => {
      const claim = await orchestrator.claimTicket({ runId: w.ledger.runId, ticketId: w.t[ref] ?? '', worker: { label: `worker ${ref}` } })
      clock.advanceSeconds(300)
      const at = clock.nowIso()
      await orchestrator.recordAttemptMetrics({
        attemptId: claim.attempt.id,
        reports: [
          tokens({ actor: `omp:parent-${ref}`, eventId: `p-${ref}`, value: 20_000, at, usage: { coverage: parent, parentActor: null } }),
          tokens({ actor: `omp:child-${ref}`, eventId: `c-${ref}`, value: 8_000, at, usage: { coverage: 'self', parentActor: `omp:parent-${ref}` } })
        ]
      })
      return claim.attempt.id
    }
    const inclusive = await relay('a', 'inclusive')
    const separate = await relay('b', 'self')
    const usage = await w.p.desktop.getRunMetrics({ runId: w.ledger.runId })
    const total = (attemptId: string) => usage.attempts.find((entry) => entry.attemptId === attemptId)?.usage.find((cell) => cell.metric === 'tokens_total')?.value
    expect([total(inclusive), total(separate)]).toEqual([20_000, 28_000])
  })
})

describe('approved scorecards are reassessed, never rewritten (c2)', () => {
  it('late regression: an escaped defect after approval is a dated difference in P; the frozen scorecard stays', async () => {
    const w = await row([['a', 'b']])
    const api = await work(w, 'a', { minutes: 20, tokens: 30_000 })
    await work(w, 'b', { minutes: 20, tokens: 30_000 })
    const reported = await report(w)
    const frozen = await w.p.desktop.getReportScorecard({ reportId: reported.id })
    w.p.clock.advanceSeconds(86_400)
    await w.p.desktop.recordEscapedDefects({
      target: { epicId: w.epicId, runId: w.ledger.runId },
      records: [{ defectEvent: 'report', severity: 'high', attribution: 'attributed', discoveryPhase: 'later_sprint', defectKey: 'SHOP-2', evidence: [{ kind: 'commit', id: 'a'.repeat(40), detail: 'source build' }, { kind: 'ticket', id: w.t['a'] ?? '', detail: 'origin' }, { kind: 'attempt', id: api, detail: 'origin' }] }]
    })
    const reassessed = await w.p.desktop.reassessReportScorecard({ reportId: reported.id })
    const sprint = reassessed.subjects.find((entry) => entry.subject.level === 'sprint') ?? fail('no sprint')
    expect(sprint.differences.map((entry) => [entry.component, entry.approved?.score, entry.current?.score])).toEqual([['P', 100, 70]])
    expect(await w.p.desktop.getReportScorecard({ reportId: reported.id })).toEqual(frozen)
  })

  it('policy change: a scorecard frozen under policy v1 is read as frozen and its reassessment names the policy', async () => {
    const w = await row([['a', 'b']])
    await work(w, 'a', { minutes: 20, tokens: 30_000 })
    await work(w, 'b', { minutes: 10, tokens: 10_000, reject: 'not yet' })
    await work(w, 'b', { minutes: 20, tokens: 30_000 })
    const reported = await report(w)
    const card = await w.p.desktop.getReportScorecard({ reportId: reported.id })
    if (card.state !== 'frozen') fail('not frozen')
    // The record as an older app froze it, under policy v1 (the one record written in place: no command writes a past policy).
    w.p.desktop.ctx().db.run('UPDATE sprint_reports SET scorecard_json = ? WHERE id = ?', storedScorecard(underPolicyV1(card.scorecard.snapshot)), reported.id)
    const read = await w.p.desktop.getReportScorecard({ reportId: reported.id })
    expect(read.state === 'frozen' && read.scorecard.snapshot.policy.version).toBe(1)
    const reassessed = await w.p.desktop.reassessReportScorecard({ reportId: reported.id })
    expect(reassessed.policy.version).toBe(2)
    const causes = reassessed.subjects.flatMap((subject) => subject.differences.flatMap((difference) => difference.causes))
    expect(causes).toContain('policy_changed')
    // Reassessing wrote nothing: the scorecard still reads as v1 froze it.
    expect(await w.p.desktop.getReportScorecard({ reportId: reported.id })).toEqual(read)
  })
})
