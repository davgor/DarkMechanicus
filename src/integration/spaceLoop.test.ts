/**
 * The SPACE grading and corrective-work loop end to end on two real repositories (DM-193 c1, epic success criteria
 * s1-s7): measurement through `record_attempt_metrics` and `record_run_metrics`, grades read the way the three Scorecard
 * tabs and the Metrics dashboard read them (the renderer's own loaders over the desktop `dm:command` handler) and
 * through the MCP read tools, the frozen sprint report surviving a restart and a Git clone, the retro's experiments,
 * same-repository corrective work, corrective work routed by the desktop broker to a controlled Dark Mechanicus
 * checkout and worked there under its own run, both experiments assessed before/after, and a late regression that
 * reassesses without touching what was approved. Every number is reconciled to what the host relayed
 * (`src/test/spaceLoop.ts` holds the spend). `beforeAll` runs every step that writes, in order, and keeps what each step
 * read at its moment; the tests only read, so they pass alone and in any order.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadScore, type CommandRunner } from '../renderer/src/scorecard/scoreReads'
import type { CommandName } from '../shared/domain/api'
import { SPACE_COMPONENTS } from '../shared/domain/space'
import { callTool, withServer } from '../test/mcpHarness'
import { complete, correctLocal, data, fail, MIN, recordResult, regression, report1, requestDm, sprint1, sprint2, sprint3, statuses, workDm } from '../test/spaceLoop'
import { type Side, twoRepoMachine, type TwoRepoMachine } from '../test/twoRepoMachine'

/** A desktop command runner for the renderer's loaders, bound to a folder (the renderer's `runCommand`). */
const runnerFor = (m: TwoRepoMachine, side: Side): CommandRunner => ((name, input) => m.bridge.call(side.path, name, input)) as CommandRunner

/** The loop as it was built: each step's records and what was read right after it. */
async function build(m: TwoRepoMachine) {
  const p = m.project
  const s = await sprint1(m)
  const r = await report1(m, s)
  const run = runnerFor(m, p)
  // What the three Scorecard tabs read for Sprint 1 before anything later could move a live grade.
  const ticketCards = Object.fromEntries(
    await Promise.all(Object.entries(s.tickets).map(async ([name, ticketId]) => [name, await loadScore(run, { kind: 'ticketCard', runId: s.ledger.runId, ticketId })] as const))
  )
  const reportCard = await loadScore(run, { kind: 'reportCard', runId: s.ledger.runId, sprintId: s.sprintId, report: { reportId: r.report.id, reportRevision: r.report.reportRevision } })
  const savedBefore = (await p.desktop.getEpic({ epicId: s.epicId })).currentRevisionId ?? null
  let asCreated: { savedRevision: string | null; runState: string; draftTickets: number } | undefined
  const c = await correctLocal(m, s, r, async () => {
    const plan = await p.desktop.getPlan({ epicId: s.epicId, view: 'draft' })
    const runView = await p.desktop.getRun({ runId: s.ledger.runId })
    const epic = await p.desktop.getEpic({ epicId: s.epicId })
    asCreated = { savedRevision: epic.currentRevisionId ?? null, runState: runView?.state ?? 'none', draftTickets: plan.bundle.tickets.length }
  })
  const sourceState = async () => {
    const epic = await p.desktop.getEpic({ epicId: s.epicId })
    const runView = await p.desktop.getRun({ runId: s.ledger.runId })
    return `${epic.status} r${epic.revision} rev ${epic.currentRevisionId}; run ${runView?.state} sprint ${runView?.activeSprintId}`
  }
  const sourceBefore = await sourceState()
  const req = await requestDm(m, r)
  const target = await m.dm.desktop.getEpic({ epicId: req.epicId })
  const targetRun = await m.dm.desktop.getRun({ epicId: req.epicId })
  const targetAsCreated = { status: target.status, saved: target.currentRevisionId !== null, runs: targetRun === null ? 0 : 1, source: { before: sourceBefore, after: await sourceState() } }
  const w = await workDm(m, req)
  await complete(m.dm, w.ledger.runId, w.reports[1].id)
  const rep2 = await sprint2(m, s, c)
  const rep3 = await sprint3(m, s, c)
  await complete(p, s.ledger.runId, rep3.id)
  const epicCard = await loadScore(run, { kind: 'epicCard', epicId: s.epicId, completed: true })
  const collected = data(await m.broker.collectCrossRepoResults(p.path, req.key), 'collect')
  const cards = { tickets: ticketCards, report: reportCard, epic: epicCard }
  return { m, s, r, c, req, w, savedBefore, asCreated: asCreated ?? fail('beforeSave never ran'), targetAsCreated, reports: { sprint2: rep2.id, sprint3: rep3.id }, cards, collected }
}

/** The steps after the loop: a restart and a clone, both experiments' results, then a late regression. */
async function afterLoop(loop: Awaited<ReturnType<typeof build>>) {
  const { m, s, r, c, req, w } = loop
  const p = m.project
  const rep3 = { id: loop.reports.sprint3 }

  // s4: the sealed Sprint 1 scorecard across a restart and a Git clone imported on another machine.
  const sealed = await m.bridge.call(p.path, 'getReportScorecard', { reportId: r.report.id })
  await p.desktop.flushPortableState()
  m.pool.close(p.path)
  const restarted = await m.bridge.call(p.path, 'getReportScorecard', { reportId: r.report.id })
  p.repo.git('add', '.darkmechanicus')
  p.repo.git('commit', '--quiet', '-m', 'Dark Mechanicus records')
  const clone = join(m.root, 'shop-clone')
  p.repo.git('clone', '--quiet', p.repo.root, clone)
  const elsewhere = m.openAt(clone, 'desktop', '2026-11-20T09:00:00.000Z')
  await elsewhere.reconcileRepository()
  const cloned = await elsewhere.getReportScorecard({ reportId: r.report.id })

  // s7: both experiments' statuses and results.
  const card3 = await p.desktop.getReportScorecard({ reportId: rep3.id })
  const targetCard = await m.dm.desktop.getReportScorecard({ reportId: w.reports[1].id })
  if (card3.state !== 'frozen' || targetCard.state !== 'frozen') fail('a result scorecard is not frozen')
  await statuses(p, r.xp.local.id, `Sprint 3 (${c.sprint3Id})`)
  await recordResult(p, r.xp.local, { reportId: rep3.id, assessmentId: card3.scorecard.snapshot.sprint.assessmentId ?? fail('no assessment') }, 'Sprint 3 sprint grade')
  await statuses(p, r.xp.dm.id, `the checkout epic ${req.epicId}`)
  await recordResult(p, r.xp.dm, { reportId: w.reports[1].id, assessmentId: targetCard.scorecard.snapshot.sprint.assessmentId ?? fail('no assessment') }, 'checkout Sprint 2 sprint grade')
  const outcomes = {
    local: (await p.desktop.getExperiment({ experimentId: r.xp.local.id })).outcome,
    dm: (await p.desktop.getExperiment({ experimentId: r.xp.dm.id })).outcome
  }

  // s4: a defect escapes an hour after everything was approved.
  const regressedFrom = p.clock.nowIso()
  await regression(m, s)
  const reassessed = await m.bridge.call(p.path, 'reassessReportScorecard', { reportId: r.report.id })
  const afterRegression = await m.bridge.call(p.path, 'getReportScorecard', { reportId: r.report.id })
  const epicAfter = await p.desktop.getEpic({ epicId: s.epicId })
  return { ...loop, frozen: { sealed, restarted, cloned }, outcomes, late: { regressedFrom, reassessed, afterRegression, epicStatus: epicAfter.status } }
}

type Stages = Awaited<ReturnType<typeof afterLoop>>

let stages: Stages | undefined
const st = (): Stages => stages ?? fail('the loop was not built')

beforeAll(async () => {
  const m = twoRepoMachine()
  try {
    stages = await afterLoop(await build(m))
  } catch (error) {
    m.cleanup()
    throw error
  }
}, 180_000)

afterAll(() => {
  stages?.m.cleanup()
})

/** The ledger's sums for the run: every attempt (rejected and retried ones included) and every overhead bucket. */
function ledgerSums(s: Stages['s'], sprintId?: string): { tokens: number; minutes: number } {
  const attempts = s.ledger.attempts.filter((entry) => sprintId === undefined || entry.sprintId === sprintId)
  const overheads = s.ledger.overhead.filter((entry) => sprintId === undefined || entry.sprintId === sprintId)
  return {
    tokens: attempts.reduce((sum, entry) => sum + (entry.spend.tokens ?? 0), 0) + overheads.reduce((sum, entry) => sum + entry.tokens, 0),
    minutes: attempts.reduce((sum, entry) => sum + entry.spend.minutes, 0) + overheads.reduce((sum, entry) => sum + entry.minutes, 0)
  }
}

describe('measurement: every attempt, retry and overhead attributed once (s2)', () => {
  it('sums the host-relayed spend of Sprint 1 to the sprint grade and the run efficiency', async () => {
    const { m, s } = st()
    const p = m.project.desktop
    // api 30,000 (its cumulative 18,000 then 30,000 counted once) + page 12,000 rejected + 16,000 retry + docs 4,000
    // + node 6,000 + orchestration 5,000; 20 + 10 + 15 + 10 + 5 + 8 minutes.
    expect(ledgerSums(s, s.sprintId)).toEqual({ tokens: 73_000, minutes: 68 })
    const overheadMinutes = s.ledger.overhead.filter((entry) => entry.sprintId === s.sprintId).reduce((sum, entry) => sum + entry.minutes, 0)
    const efficiency = await p.getRunEfficiency({ runId: s.ledger.runId })
    const sprint = efficiency.sprints.find((entry) => entry.scope.level === 'sprint' && entry.scope.sprintId === s.sprintId) ?? fail('no sprint 1 efficiency')
    expect(sprint.tokens).toMatchObject({ actual: { state: 'observed', value: 73_000 }, attempts: 5, unreportedAttemptIds: [] })
    expect(sprint.time).toMatchObject({ actual: { state: 'observed', value: 68 * MIN }, overheadValue: overheadMinutes * MIN })
    const grade = await p.getSprintGrade({ runId: s.ledger.runId, sprintId: s.sprintId })
    const component = (key: string) => grade.grade.components.find((entry) => entry.component === key) ?? fail(`no ${key}`)
    expect([component('K').inputs, component('T').inputs]).toMatchObject([{ actual: 73_000, actualState: 'observed' }, { actual: 68 * MIN, actualState: 'observed' }])
    // The retry and the rejection are counted, not hidden: C sees the rejected submission, E the corrective retry.
    expect(component('C').inputs).toMatchObject({ rejectedSubmissions: 1 })
    expect(component('E').inputs).toMatchObject({ correctiveMs: 15 * MIN })
    // The usage table: each attempt its own row, the rejected one included; api's two cumulative readings count once.
    const usage = await p.getRunMetrics({ runId: s.ledger.runId })
    const total = (attemptId: string) => usage.attempts.find((entry) => entry.attemptId === attemptId)?.usage.find((cell) => cell.metric === 'tokens_total')?.value
    expect([total(s.apiAttempt), total(s.pageAttempts[0]), total(s.pageAttempts[1])]).toEqual([30_000, 12_000, 16_000])
  })
})

describe('reconciliation: per ticket and the whole run, to the ledger (s2, s3)', () => {
  it('charges the page ticket both of its attempts: 12,000 rejected + 16,000 retried', async () => {
    const { m, s } = st()
    const page = await m.project.desktop.getTicketGrade({ runId: s.ledger.runId, ticketId: s.tickets.page, cutoff: st().late.regressedFrom })
    const pageSpend = s.ledger.attempts.filter((entry) => entry.ticketId === s.tickets.page).reduce((sum, entry) => sum + (entry.spend.tokens ?? 0), 0)
    expect(pageSpend).toBe(28_000)
    expect(page.grade.components.find((entry) => entry.component === 'K')?.inputs).toMatchObject({ actual: pageSpend, actualState: 'observed' })
  })

  it('reconciles the whole run, all three sprints, to the run grade and the Metrics dashboard totals', async () => {
    const { m, s, late } = st()
    const sums = ledgerSums(s)
    expect(sums).toEqual({ tokens: 160_000, minutes: 157 })
    const runGrade = await m.project.desktop.getRunGrade({ runId: s.ledger.runId, cutoff: late.regressedFrom })
    const component = (key: string) => runGrade.grade.components.find((entry) => entry.component === key) ?? fail(`no ${key}`)
    // The run's K and T compare actuals with the sum of the ticket baselines, so the one executed work ticket without a
    // baseline (it names it) is left out of the actual and the roll-up reads estimated, never padded or silently complete.
    const leftOut = /left out \((tk_\w+)\)/u.exec(component('K').explanation.normalization)?.[1] ?? fail('K names no ticket left out')
    const excluded = s.ledger.attempts.filter((entry) => entry.ticketId === leftOut).map((entry) => entry.spend)
    expect(excluded).toEqual([{ minutes: 6, tokens: 5_000 }])
    expect([component('K').inputs, component('T').inputs]).toMatchObject([
      { actual: sums.tokens - 5_000, actualState: 'estimated' },
      { actual: (sums.minutes - 6) * MIN, actualState: 'estimated' }
    ])
    const summary = await m.bridge.call(m.project.path, 'getMetricsSummary', {})
    expect(summary.totals.tokens.total).toMatchObject({ state: 'observed', value: sums.tokens })
    expect(summary.totals.time.activeMs).toMatchObject({ state: 'observed', value: sums.minutes * MIN })
  })

  it('keeps queue, review and human-approval waits apart from active execution', async () => {
    const { m, s } = st()
    const timing = await m.project.desktop.getRunTiming({ runId: s.ledger.runId, cutoff: '2026-11-15T10:14:00.000Z' })
    expect(Object.keys(timing.waits).sort()).toEqual(['blocked', 'build_test', 'human_approval', 'queue', 'review'])
    expect(timing.effort.total).toMatchObject({ ms: 68 * MIN, state: 'observed' })
    expect(timing.effort.byRole).toMatchObject({ orchestrator: 8 * MIN, worker: 60 * MIN })
    // Five submissions, each reviewed a minute after it was submitted.
    expect(timing.waits.review.ms).toBe(300_000)
    expect(timing.waits.queue.ms).toBeGreaterThan(0)
    expect(timing.activeWallClock.ms).toBeLessThan(timing.elapsed.ms ?? fail('no elapsed time'))
    // Later, the Sprint 1 checkpoint waited on the person: a human-approval wait, never counted as active time.
    const later = await m.project.desktop.getRunTiming({ runId: s.ledger.runId, cutoff: st().late.regressedFrom })
    expect(later.waits.human_approval.ms).toBeGreaterThan(0)
    expect(later.effort.total.ms).toBe(ledgerSums(s).minutes * MIN)
  })

  it('leaves token categories the host did not relay for every attempt unknown, with what was seen as a lower bound', async () => {
    const { m } = st()
    const summary = await m.project.desktop.getMetricsSummary({})
    expect(summary.totals.tokens.input).toMatchObject({ state: 'missing', value: null, reason: 'partial_coverage', lowerBound: 21_000 })
    expect(summary.totals.tokens.reasoning).toMatchObject({ state: 'missing', value: null, lowerBound: 2_400 })
  })
})

describe('grades in the three Scorecard tabs (s1, s3)', () => {
  it('shows every Sprint 1 ticket graded on all seven components with its policy, coverage and evidence', () => {
    const { cards } = st()
    const letters: Record<string, string | null> = {}
    for (const [name, card] of Object.entries(cards.tickets)) {
      const { grade } = card.grade
      expect(grade.components.map((entry) => entry.component)).toEqual([...SPACE_COMPONENTS])
      expect(grade.policy).toMatchObject({ policyId: 'dm-space', version: 2 })
      expect(grade.explanation).toBeTruthy()
      // Coverage of the base weight, and every scored component names the evidence it was scored from.
      expect(grade.coverage).toBeGreaterThan(0)
      for (const entry of grade.components.filter((component) => component.state !== 'missing')) expect(entry.evidence.length, `${name} ${entry.component}`).toBeGreaterThan(0)
      expect(card.usage.ok && card.timing.ok).toBe(true)
      letters[name] = grade.status === 'ungraded' ? `ungraded` : `${grade.letter} ${grade.status} ${grade.displayScore} coverage ${grade.coverage}`
    }
    // The node has no budget of its own (T and K not scored): provisional, never a fabricated complete grade. The
    // page's rejected attempt and corrective retry cost it C and E: C, while its cheap cost cannot lift it.
    expect(letters).toEqual({ api: 'A final 96.4 coverage 1', page: 'C final 76.4 coverage 1', docs: 'A final 96.4 coverage 1', node: expect.stringMatching(/^A provisional 95\.0 coverage 0\.\d+$/u) })
  })

  it('freezes the sprint report scorecard and shows the completed epic\'s immutable grade', () => {
    const { cards } = st()
    const report = cards.report
    if (!('state' in report) || report.state !== 'frozen') fail('the Sprint 1 report froze no scorecard')
    expect(report.scorecard.sprint.grade).toMatchObject({ letter: 'B', status: 'final' })
    expect(report.scorecard.snapshot.sprint.result).toMatchObject({ letter: 'B', status: 'final', displayScore: '88.2' })
    const epic = cards.epic
    expect(epic.assessment.state).toBe('frozen')
    // Frozen with the epic's last report (Sprint 3): T and K estimated across the run, so provisional.
    expect(epic.assessment).toMatchObject({ report: { reportId: st().reports.sprint3 }, view: { grade: { letter: 'A', status: 'provisional', displayScore: '96.2' } } })
    expect(epic.runs.map((entry) => entry.read.ok)).toEqual([true])
  })
})

describe('MCP reads and the Metrics dashboard (s3)', () => {
  it('answers every MCP scorecard and metrics read with the JSON the desktop reads', async () => {
    const { m, s, r, reports } = st()
    const cutoff = m.project.clock.nowIso()
    const { runId } = s.ledger
    const reads: [string, CommandName, Record<string, unknown>][] = [
      ...Object.values(s.tickets).map((ticketId): [string, CommandName, Record<string, unknown>] => ['get_ticket_grade', 'getTicketGrade', { runId, ticketId, cutoff }]),
      ['get_sprint_grade', 'getSprintGrade', { runId, sprintId: s.sprintId, cutoff }],
      ['get_run_grade', 'getRunGrade', { runId, cutoff }],
      ['get_epic_grade', 'getEpicGrade', { epicId: s.epicId, cutoff }],
      ...[r.report.id, reports.sprint2, reports.sprint3].map((reportId): [string, CommandName, Record<string, unknown>] => ['get_report_scorecard', 'getReportScorecard', { reportId }]),
      ['reassess_report_scorecard', 'reassessReportScorecard', { reportId: r.report.id, cutoff }],
      ['get_space_signals', 'getSpaceSignals', { level: 'sprint', id: s.sprintId, runId, cutoff }],
      ['get_ticket_performance', 'getTicketPerformance', { runId, ticketId: s.tickets.page, cutoff }],
      ['get_escaped_defects', 'getEscapedDefects', { epicId: s.epicId, cutoff }],
      ['get_run_efficiency', 'getRunEfficiency', { runId, cutoff }],
      ['get_run_timing', 'getRunTiming', { runId, cutoff }],
      ['get_metrics_summary', 'getMetricsSummary', { until: cutoff }],
      ['get_run_metrics', 'getRunMetrics', { runId }]
    ]
    await withServer(m.mcp(m.project, 'reader'), async (rig) => {
      for (const [tool, command, args] of reads) {
        const desktop = await m.bridge.command(m.project.path, command, args as never)
        expect({ tool, ok: desktop.ok }).toEqual({ tool, ok: true })
        expect((await callTool(rig, tool, args)).payload, tool).toEqual(JSON.parse(JSON.stringify(desktop)))
      }
    })
  })

  it('shows the Metrics dashboard trend across the three sprints with the comparable prior-wave change', async () => {
    const { m, s } = st()
    const summary = await m.bridge.call(m.project.path, 'getMetricsSummary', {})
    const trend = summary.trend.filter((entry) => entry.epicId === s.epicId)
    const rows = trend.map((entry) => [entry.source, entry.grade?.letter, entry.grade?.status, entry.comparison.comparable, entry.comparison.reasons, entry.comparison.scoreDelta?.toFixed(1) ?? null])
    // Every sprint holds two medium tickets and a small one, so each compares with the one before (prior wave).
    expect(rows).toEqual([
      ['frozen_report', 'B', 'final', false, ['first_entry'], null],
      ['frozen_report', 'A', 'provisional', true, [], '11.8'],
      ['frozen_report', 'A', 'final', true, [], '0.0']
    ])
  })
})

describe('frozen reports survive restart and clone, and late regressions reassess without rewriting (s4)', () => {
  it('reads the same sealed Sprint 1 scorecard after a restart and from a Git clone of the project', () => {
    const { frozen } = st()
    if (frozen.sealed.state !== 'frozen') fail('not frozen')
    expect(frozen.restarted).toEqual(frozen.sealed)
    expect(frozen.cloned).toEqual(frozen.sealed)
  })

  it('dates a reassessment for an escaped defect an hour later without changing the approved snapshot or reopening the epic', () => {
    const { late, frozen } = st()
    const sprint = late.reassessed.subjects.find((entry) => entry.subject.level === 'sprint') ?? fail('no sprint subject')
    expect(sprint.differences.map((entry) => [entry.component, entry.approved?.score, entry.current?.score])).toEqual([['P', 100, 70]])
    // Dated at the reading, after the defect was recorded (an hour after the last approval), never at the snapshot.
    expect(Date.parse(late.reassessed.assessedAt)).toBeGreaterThan(Date.parse(late.regressedFrom) + 3_600_000 - 1)
    expect(late.afterRegression).toEqual(frozen.sealed)
    expect(late.epicStatus).toBe('completed')
  })
})

describe('retrospective to corrective work in the same repository (s5)', () => {
  it('drew both experiments from the frozen Sprint 1 scorecard', () => {
    const { r } = st()
    expect([r.xp.local.baseline, r.xp.dm.baseline]).toMatchObject([
      { measure: 'T.actual_ms', unit: 'milliseconds', value: 68 * MIN },
      { measure: 'K.actual_tokens', unit: 'tokens', value: 73_000 }
    ])
    expect([r.xp.local.destination.kind, r.xp.dm.destination.kind]).toEqual(['source_repository', 'darkmechanicus_source'])
  })

  it('created what it previewed: a valid corrective sprint with its work, Fireguard ticket, acceptance node and provenance, saving and running nothing', () => {
    const { asCreated, c, s, savedBefore, r } = st()
    const { created, preview } = c
    const shape = (view: typeof preview) => view.tickets.map((ticket) => [ticket.role, ticket.experimentId, ticket.title])
    expect(shape(created)).toEqual(shape(preview))
    expect(created.target).toMatchObject({ ...preview.target, sprintId: expect.any(String) })
    expect(created.validation.errors).toEqual([])
    expect(created.tickets.map((ticket) => ticket.role).sort()).toEqual(['acceptance', 'fireguard', 'work'])
    expect(created.dependencies.length).toBeGreaterThan(0)
    expect(created.target).toMatchObject({ kind: 'new_sprint', epicId: s.epicId, sprintOrdinal: 2 })
    // Provenance: the work names the experiment it came from, and the result names the report it was drawn from.
    expect(created.tickets.find((ticket) => ticket.role === 'work')?.experimentId).toBe(r.xp.local.id)
    expect(created.source).toMatchObject({ reportId: r.report.id })
    // Nothing saved: the saved revision is still Sprint 1's; the tickets sit only in the draft; the run waits.
    expect(asCreated.savedRevision).toBe(savedBefore)
    expect(asCreated.draftTickets).toBe(s.bundle.tickets.length + created.tickets.filter((ticket) => !ticket.existing).length)
    expect(asCreated.runState).toBe('awaiting_checkpoint')
    expect(created.nextSteps.join(' ')).toMatch(/Save/)
  })
})

describe('corrective work in the Dark Mechanicus checkout (s6)', () => {
  it('created the epic in the checkout\'s own project as an unsaved draft and left the source run alone', async () => {
    const { m, req, targetAsCreated, s } = st()
    expect(targetAsCreated).toMatchObject({ status: 'backlog', saved: false, runs: 0 })
    expect(targetAsCreated.source.after).toBe(targetAsCreated.source.before)
    const links = await m.broker.listCrossRepoCorrections(m.project.path, {})
    expect(links.ok && links.data.map((link) => [link.state, link.target?.epicId])).toEqual([['linked', req.epicId]])
    const target = await m.dm.desktop.getEpic({ epicId: req.epicId })
    expect(target.provenance).toMatchObject({ kind: 'cross_repo_correction' })
    expect(req.epicId).not.toBe(s.epicId)
  })

  it('ran the correction under the checkout\'s own run identity and brought its grades back to the source', async () => {
    const { m, req, w, s, collected } = st()
    expect(w.ledger.runId).not.toBe(s.ledger.runId)
    expect((await m.dm.desktop.getRun({ runId: w.ledger.runId }))?.epicId).toBe(req.epicId)
    // The source project holds no record of the checkout's run: the two projects never share a run.
    const elsewhere = await m.project.desktop.getRun({ runId: w.ledger.runId }).then(
      (run) => run?.id ?? 'none',
      (error: { code?: string }) => error.code ?? 'thrown'
    )
    expect(['none', 'not_found']).toContain(elsewhere)
    expect(collected.results?.grades.length).toBeGreaterThan(0)
  })
})

describe('before/after assessment of both experiments (s7)', () => {
  it('classifies each experiment from its sealed baseline and the grade measured after its work landed', () => {
    const { m, outcomes } = st()
    const { local, dm } = outcomes
    // Per ticket: Sprint 1 took 68 min over 4 tickets (17 min); Sprint 3 45 min (11.25 min): 5.75 min less, 3.4 expected.
    expect([local.classification, local.baseline.value, local.reasons]).toEqual(['improved', 68 * MIN, [expect.stringContaining('moved 345000 toward the target (204000 expected)')]])
    // Per ticket: 73,000 tokens over 4 (18,250); the checkout's Sprint 2 32,000 over 4 (8,000): 10,250 less, 3,650 expected.
    expect([dm.classification, dm.baseline.value, dm.reasons]).toEqual(['improved', 73_000, [expect.stringContaining('moved 10250 toward the target (3650 expected)')]])
    expect(m.unexpected).toEqual([])
  })
})
