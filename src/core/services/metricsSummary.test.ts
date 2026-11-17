import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { MetricsSummaryEpicRow, MetricsSummaryTrendEntry, MetricsSummaryView, SummaryMeasure, SummaryTicketRef } from '../../shared/domain/views'
import {
  ATTEMPT_ACTIVE_MS,
  ATTEMPT_TOKENS,
  deliverEpic,
  type DeliveredEpic,
  deliverSprint,
  plan,
  type Project,
  project,
  report,
  reportedEpic,
  type UsageKind
} from '../../test/metricsProject'
import { COMMAND_CAPABILITIES } from '../commands/capabilities'
import { policyRef, SPACE_POLICY_V1 } from '../space/rubric'
import { getMetricsSummary } from './metricsSummary'
import { getEpicGrade } from './spaceGrades'

const observed = (value: number): SummaryMeasure => ({ state: 'observed', value, reason: null, lowerBound: null })
/** Every ticket sized small, the acceptance node included: a cohort that can vouch for comparing sprints. */
const SMALL = { work: 'small', acceptance: 'small' } as const
const unknown = (reason: string, lowerBound: number | null = null): SummaryMeasure => ({ state: 'missing', value: null, reason, lowerBound })

function named(bundle: PlanBundle, ticketId: string): SummaryTicketRef {
  const ticket = bundle.tickets.find((entry) => entry.id === ticketId)
  if (ticket === undefined) throw new Error(`No ticket ${ticketId}`)
  return { ticketId, key: ticket.key, title: ticket.title, removedAfterRevision: null }
}

function rowOf(summary: MetricsSummaryView, epicId: string): MetricsSummaryEpicRow {
  const row = summary.epics.find((entry) => entry.epicId === epicId)
  if (row === undefined) throw new Error(`No row for ${epicId}`)
  return row
}

function entryOf(summary: MetricsSummaryView, runId: string): MetricsSummaryTrendEntry {
  const entry = summary.trend.find((candidate) => candidate.runId === runId)
  if (entry === undefined) throw new Error(`No trend entry for ${runId}`)
  return entry
}

/** Fails the attempts of a one-ticket epic until the ticket has used every try, then closes the run: a confirmed failure. */
async function failedEpic(p: Project, title: string): Promise<DeliveredEpic & { lastAttemptId: string }> {
  const { epicId, bundle } = await plan(p, title, 1, undefined)
  const run = await p.orchestrator.startRun({ epicId })
  const ticketId = bundle.tickets.find((ticket) => ticket.kind !== 'acceptance')?.id ?? ''
  const attemptIds: string[] = []
  for (let n = 0; n < 3; n += 1) {
    const claim = await p.orchestrator.claimTicket({ runId: run.id, ticketId, worker: { label: 'test-worker' } })
    p.harness.clock.advanceSeconds(60)
    await p.orchestrator.failAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken ?? '', failure: { reason: 'broke the build' } })
    attemptIds.push(claim.attempt.id)
    p.harness.clock.advanceSeconds(60)
  }
  await p.orchestrator.cancelRun({ runId: run.id, reason: 'closing the run' })
  p.harness.clock.advanceSeconds(120)
  return { epicId, runId: run.id, sprintId: bundle.sprints[0]?.id ?? '', bundle, ticketIds: [ticketId], attemptIds, lastAttemptId: attemptIds.at(-1) ?? '' }
}

async function closedEpic(p: Project, spec: Parameters<typeof deliverEpic>[1]): Promise<DeliveredEpic> {
  const epic = await deliverEpic(p, spec)
  await p.orchestrator.cancelRun({ runId: epic.runId, reason: 'closing the run' })
  p.harness.clock.advanceSeconds(120)
  return epic
}

interface World {
  p: Project
  /** Reported, all tickets sized small: two work tickets and the acceptance node, all measured. */
  sizedA: DeliveredEpic
  /** As `sizedA` (the same cohort), its first ticket's effort half corrective. */
  sizedB: DeliveredEpic
  /** Restarted once (an empty run first), then three small work tickets and the acceptance node. */
  sizedC: DeliveredEpic
  /** Unsized, not reported (live, closed), one ticket's tokens estimated. */
  liveEstimated: DeliveredEpic
  /** Unsized, not reported (live, closed), measured: the same unsized cohort as `liveEstimated`. */
  liveUnsized: DeliveredEpic
  /** One work ticket reported no usage at all. */
  partial: DeliveredEpic
  failed: DeliveredEpic & { lastAttemptId: string }
  plannedOnly: string
  unplanned: string
  /** Still running (its tickets submitted, not reviewed). */
  running: DeliveredEpic
  /** A cutoff after `sizedA` was reported, before `sizedB` was created. */
  afterA: string
  summary: MetricsSummaryView
}

let world: World

beforeAll(async () => {
  const p = await project('Summary')
  const sizedA = await reportedEpic(p, { title: 'Sized A', tickets: ['measured', 'measured'], accept: true, shape: SMALL })
  const afterA = p.harness.clock.nowIso()
  p.harness.clock.advanceSeconds(60)
  const sizedB = await reportedEpic(p, { title: 'Sized B', tickets: ['corrective', 'measured'], accept: true, shape: SMALL })
  const sizedC = await reportedEpic(p, { title: 'Sized C', tickets: ['measured', 'measured', 'measured'], accept: true, shape: SMALL, emptyRuns: 1 })
  const liveEstimated = await closedEpic(p, { title: 'Estimated', tickets: ['measured', 'estimated'], accept: true })
  const liveUnsized = await closedEpic(p, { title: 'Unsized', tickets: ['measured', 'measured'], accept: true })
  const partial = await closedEpic(p, { title: 'Partial', tickets: ['measured', 'unmeasured'], accept: true })
  const failed = await failedEpic(p, 'Failed')
  const plannedOnly = (await plan(p, 'Planned only', 1, undefined)).epicId
  const unplanned = (await p.orchestrator.createEpic({ title: 'Never planned', intent: 'Created only.', successCriteria: ['Exists'] })).id
  const running = await deliverEpic(p, { title: 'Running', tickets: ['measured'], accept: false })
  p.harness.clock.advanceSeconds(60)
  const summary = getMetricsSummary(p.desktop.ctx(), {})
  world = { p, sizedA, sizedB, sizedC, liveEstimated, liveUnsized, partial, failed, plannedOnly, unplanned, running, afterA, summary }
}, 60_000)

afterAll(() => {
  world.p.harness.cleanup()
})

describe('getMetricsSummary epic rows (DM-265 c1)', () => {
  it('is a read command the desktop reaches through the command API, returning the core summary', async () => {
    expect(COMMAND_CAPABILITIES.getMetricsSummary).toBe('read')
    const viaApi = await world.p.desktop.getMetricsSummary({ until: world.summary.window.cutoff })
    expect(viaApi).toEqual(world.summary)
  })

  it('gives each planned epic the grade a fresh getEpicGrade gives at the summary cutoff', () => {
    const { p, summary } = world
    const planned = summary.epics.filter((row) => row.grade.inputHash !== null)
    expect(planned.map((row) => row.title)).toEqual(['Sized A', 'Sized B', 'Sized C', 'Estimated', 'Unsized', 'Partial', 'Failed', 'Planned only', 'Running'])
    for (const row of planned) {
      const fresh = getEpicGrade(p.desktop.ctx(), { epicId: row.epicId, cutoff: summary.window.cutoff })
      expect({ epicId: row.epicId, score: row.grade.score, letter: row.grade.letter, status: row.grade.gradeStatus, inputHash: row.grade.inputHash, policy: row.grade.policy }).toEqual({
        epicId: row.epicId,
        score: fresh.grade.score,
        letter: fresh.grade.letter,
        status: fresh.grade.status,
        inputHash: fresh.grade.inputHash,
        policy: fresh.grade.policy
      })
      expect(row.measuredRunIds).toEqual(fresh.measuredRunIds)
    }
  })

  it('sums each row from the scopes its grade summed: token total, active time and effort per executed attempt', () => {
    const { summary, sizedA, sizedC, liveEstimated } = world
    const a = rowOf(summary, sizedA.epicId)
    expect([a.tokens.total, a.time.activeMs, a.time.effortMs]).toEqual([observed(3 * ATTEMPT_TOKENS.total), observed(3 * ATTEMPT_ACTIVE_MS), observed(3 * ATTEMPT_ACTIVE_MS)])
    const c = rowOf(summary, sizedC.epicId)
    expect([c.tokens.total, c.time.activeMs]).toEqual([observed(4 * ATTEMPT_TOKENS.total), observed(4 * ATTEMPT_ACTIVE_MS)])
    expect(rowOf(summary, liveEstimated.epicId).tokens.total).toEqual({ state: 'estimated', value: 3 * ATTEMPT_TOKENS.total, reason: null, lowerBound: null })
  })

  it('reads token categories from the runs that executed work only, never from a restarted empty run', () => {
    const c = rowOf(world.summary, world.sizedC.epicId)
    expect(c.runIds).toHaveLength(2)
    expect(c.measuredRunIds).toEqual([world.sizedC.runId])
    expect([c.tokens.input, c.tokens.cachedInput, c.tokens.output, c.tokens.reasoning]).toEqual([
      observed(4 * ATTEMPT_TOKENS.input),
      observed(4 * ATTEMPT_TOKENS.cachedInput),
      observed(4 * ATTEMPT_TOKENS.output),
      observed(4 * ATTEMPT_TOKENS.reasoning)
    ])
  })
})

describe('getMetricsSummary totals and distribution (DM-265 c2)', () => {
  it('recomputes totals from the raw measures of the epics that executed work, leaving planned-only epics out', () => {
    const { p, sizedA, sizedB, sizedC, plannedOnly, unplanned } = world
    const summary = getMetricsSummary(p.desktop.ctx(), { epicIds: [sizedA.epicId, sizedB.epicId, sizedC.epicId, plannedOnly, unplanned] })
    expect(summary.epics).toHaveLength(5)
    expect(summary.totals.epics).toBe(3)
    expect(summary.totals.measuredEpicIds).toEqual([sizedA.epicId, sizedB.epicId, sizedC.epicId])
    expect(summary.totals.tokens.total).toEqual(observed(10 * ATTEMPT_TOKENS.total))
    expect(summary.totals.tokens.input).toEqual(observed(10 * ATTEMPT_TOKENS.input))
    expect(summary.totals.time.activeMs).toEqual(observed(10 * ATTEMPT_ACTIVE_MS))
    expect(summary.totals.coverage.attempts).toBe(10)
  })

  it('takes the corrective share as summed corrective over summed classified effort, never a mean of the epics shares', () => {
    const { p, sizedB, sizedC } = world
    const summary = getMetricsSummary(p.desktop.ctx(), { epicIds: [sizedB.epicId, sizedC.epicId] })
    // Sized B: 300 s corrective of 1800 s classified (1/6); Sized C: none of 2400 s. A mean of shares would give 1/12.
    expect(rowOf(summary, sizedB.epicId).correctiveShare).toEqual(observed(300_000 / 1_800_000))
    expect(summary.totals.correctiveShare).toEqual(observed(300_000 / 4_200_000))
  })

  it('keeps an estimated part estimated in the totals', () => {
    const { p, sizedA, liveEstimated } = world
    const summary = getMetricsSummary(p.desktop.ctx(), { epicIds: [sizedA.epicId, liveEstimated.epicId] })
    expect(summary.totals.tokens.total).toEqual({ state: 'estimated', value: 6 * ATTEMPT_TOKENS.total, reason: null, lowerBound: null })
  })

  it('counts final, provisional and ungraded grades separately, and failed and running rows by status', () => {
    expect(world.summary.distribution).toEqual({
      // Final: Sized A, B, C and Unsized; provisional: Estimated (and Failed, capped); ungraded: Partial, Planned only,
      // Never planned (and Running, in progress).
      byStatus: { final: 4, provisional: 1, ungraded: 3, in_progress: 1, failed: 1 },
      byGradeStatus: { final: 4, provisional: 2, ungraded: 4 }
    })
    expect(world.summary.coverage).toMatchObject({ epics: 10, gradedEpics: 6, ungradedEpics: 4 })
  })

  it('gives totals raw measures only: no score or letter of the epics is averaged into them', () => {
    expect(Object.keys(world.summary.totals).sort()).toEqual(['correctiveShare', 'coverage', 'epics', 'measuredEpicIds', 'time', 'tokens'])
  })

  it('leaves out epics created after the cutoff (`until`), and reads an idle epic there as it reads now', () => {
    const { p, sizedA, afterA, summary } = world
    const earlier = getMetricsSummary(p.desktop.ctx(), { until: afterA })
    expect(earlier.window.cutoff).toBe(afterA)
    expect(earlier.epics.map((row) => row.epicId)).toEqual([sizedA.epicId])
    expect(earlier.totals.measuredEpicIds).toEqual([sizedA.epicId])
    const now = rowOf(summary, sizedA.epicId)
    expect(earlier.epics[0]?.tokens).toEqual(now.tokens)
    expect(earlier.epics[0]?.grade.score).toBe(now.grade.score)
  })
})

describe('getMetricsSummary window start (`since`)', () => {
  it('keeps only epics a run of which ended (or still runs) since the start, and their sprints that ended since', () => {
    const { p, sizedA, sizedB, running, afterA } = world
    const summary = getMetricsSummary(p.desktop.ctx(), { since: afterA })
    expect(summary.window.since).toBe(afterA)
    expect(summary.epics.map((row) => row.title)).toEqual(['Sized B', 'Sized C', 'Estimated', 'Unsized', 'Partial', 'Failed', 'Running'])
    expect(summary.trend.map((entry) => entry.runId)).not.toContain(sizedA.runId)
    expect(entryOf(summary, sizedB.runId).comparison.reasons).toEqual(['first_entry'])
    expect(entryOf(summary, running.runId).window.closed).toBe(false)
  })

  it('refuses a window that starts after its cutoff as invalid_input', () => {
    const { p, afterA, summary } = world
    expect(() => getMetricsSummary(p.desktop.ctx(), { since: summary.window.cutoff, until: afterA })).toThrow(
      expect.objectContaining({ code: 'invalid_input', details: { since: summary.window.cutoff, cutoff: afterA } })
    )
  })
})

describe('getMetricsSummary unknown measures (DM-265 c3)', () => {
  it('leaves usage and time of an epic with an unreported attempt null, with the reported part and the coverage', () => {
    const row = rowOf(world.summary, world.partial.epicId)
    expect(row.tokens.total).toEqual(unknown('partial_telemetry', 2 * ATTEMPT_TOKENS.total))
    expect(row.time.activeMs).toEqual(unknown('partial_telemetry', 2 * ATTEMPT_ACTIVE_MS))
    expect(row.coverage).toMatchObject({ attempts: 3, unreportedTokenAttempts: 1, unreportedTimeAttempts: 1 })
    expect(row.coverage.unavailable).toContainEqual({ field: 'tokens.total', reason: 'partial_telemetry' })
    expect(world.summary.coverage.unavailable).toContainEqual({ epicId: row.epicId, field: 'time.activeMs', reason: 'partial_telemetry' })
  })

  it('reads an epic with no saved plan as ungraded, every measure null with why', () => {
    const row = rowOf(world.summary, world.unplanned)
    const none = unknown('the epic has no saved plan')
    expect(row.grade).toMatchObject({ status: 'ungraded', gradeStatus: 'ungraded', score: null, letter: null, inputHash: null })
    expect([row.tokens.total, row.tokens.input, row.time.elapsedMs, row.time.activeMs, row.time.effortMs, row.correctiveShare]).toEqual([none, none, none, none, none, none])
  })

  it('reads totals over epics that executed nothing as null with why, the corrective share naming the effort it lacks', () => {
    const { p, plannedOnly, unplanned } = world
    const summary = getMetricsSummary(p.desktop.ctx(), { epicIds: [plannedOnly, unplanned] })
    expect(summary.totals.epics).toBe(0)
    expect(summary.totals.tokens.total).toEqual(unknown('no epic executed work'))
    expect(summary.totals.time.activeMs).toEqual(unknown('no epic executed work'))
    expect(summary.totals.correctiveShare).toEqual(unknown('corrective effort unknown: no epic executed work'))
  })
})

describe('getMetricsSummary token categories at a cutoff (DM-265 c3)', () => {
  it('gives each token category missing at a cutoff its run has records after, and the reported numbers when it has none', async () => {
    const p = await project('Categories')
    try {
      const epic = await reportedEpic(p, { title: 'Cut', tickets: ['measured'], accept: true, shape: SMALL })
      const cutoff = p.harness.clock.nowIso()
      const categories = (summary: MetricsSummaryView): SummaryMeasure[] => {
        const { input, cachedInput, output, reasoning } = rowOf(summary, epic.epicId).tokens
        return [input, cachedInput, output, reasoning]
      }
      const before = categories(getMetricsSummary(p.desktop.ctx(), { until: cutoff }))
      p.harness.clock.advanceSeconds(60)
      await p.orchestrator.recordRunMetrics({
        runId: epic.runId,
        overhead: 'orchestration',
        reports: [{ metric: 'tokens_input', unit: 'tokens', source: { kind: 'host', actor: 'relay' }, measurement: { state: 'observed', value: 1_000 }, accumulation: 'delta', eventId: 'late-turn', observedAt: p.harness.clock.nowIso() }]
      })
      const after = categories(getMetricsSummary(p.desktop.ctx(), { until: cutoff }))
      expect(before).toEqual([observed(2 * ATTEMPT_TOKENS.input), observed(2 * ATTEMPT_TOKENS.cachedInput), observed(2 * ATTEMPT_TOKENS.output), observed(2 * ATTEMPT_TOKENS.reasoning)])
      const cut = unknown('records stored after the cutoff: token categories are read as stored now and cannot be cut at it')
      expect(after).toEqual([cut, cut, cut, cut])
    } finally {
      p.harness.cleanup()
    }
  })
})

describe('getMetricsSummary on a legacy repository (DM-265 c3)', () => {
  it('reads a legacy repository (no usage observed, a pre-scorecard report) with every epic ungraded, never zeros', async () => {
    const p = await project('Legacy')
    try {
      const ran = await deliverEpic(p, { title: 'Ran unmeasured', tickets: ['unmeasured', 'unmeasured'], accept: true, acceptance: 'unmeasured' })
      const revision = await report(p, ran, 'Done before scorecards existed.')
      p.desktop.ctx().db.run('UPDATE sprint_reports SET scorecard_json = NULL WHERE id = ?', revision.id)
      await p.orchestrator.cancelRun({ runId: ran.runId, reason: 'closing the run' })
      await p.orchestrator.createEpic({ title: 'Never planned', intent: 'Created only.', successCriteria: ['Exists'] })
      await plan(p, 'Planned, never ran', 1, undefined)
      const sources = p.desktop.ctx().db.all<{ kind: string }>('SELECT DISTINCT source_kind AS kind FROM metric_observations')
      expect(sources.map((row) => row.kind)).not.toContain('host')
      const summary = getMetricsSummary(p.desktop.ctx(), {})
      expect(summary.epics).toHaveLength(3)
      expect(summary.epics.map((row) => [row.grade.gradeStatus, row.grade.score, row.grade.letter])).toEqual([
        ['ungraded', null, null],
        ['ungraded', null, null],
        ['ungraded', null, null]
      ])
      expect(summary.distribution.byGradeStatus).toEqual({ final: 0, provisional: 0, ungraded: 3 })
      const measures = summary.epics.flatMap((row) => [row.tokens.total, row.tokens.input, row.time.activeMs, row.time.effortMs, row.correctiveShare])
      expect(measures.filter((measure) => measure.value !== null || measure.reason === null)).toEqual([])
      expect([summary.totals.tokens.total.value, summary.totals.time.activeMs.value, summary.totals.correctiveShare.value]).toEqual([null, null, null])
      expect(entryOf(summary, ran.runId)).toMatchObject({ source: 'legacy_report', grade: null })
      expect(summary.coverage.unavailable.filter((field) => field.field === 'grade')).toHaveLength(3)
    } finally {
      p.harness.cleanup()
    }
  }, 30_000)
})

/** Claims and submits one ticket of the run with every criterion claimed met; returns the attempt id. */
async function submitted(p: Project, run: { runId: string; bundle: PlanBundle }, ticketId: string): Promise<string> {
  const { harness, orchestrator } = p
  const claim = await orchestrator.claimTicket({ runId: run.runId, ticketId, worker: { label: 'test-worker' } })
  harness.clock.advanceSeconds(600)
  const ticket = run.bundle.tickets.find((entry) => entry.id === ticketId)
  await orchestrator.submitAttempt({
    attemptId: claim.attempt.id,
    claimToken: claim.packet.claimToken ?? '',
    outputs: { summary: 'Delivered.', commits: ['abcdef1'], changedFiles: ['src/demo.ts'] },
    evidence: {
      checks: [{ name: 'unit tests', status: 'passed', detail: 'npx vitest run' }],
      criteria: (ticket?.acceptanceCriteria ?? []).map((criterion) => ({ criterionId: criterion.id, met: true, note: 'shown' })),
      notes: ''
    }
  })
  harness.clock.advanceSeconds(60)
  return claim.attempt.id
}

/**
 * The shape of this repository's own records before scorecards: a run still going, one ticket accepted before
 * reviewers' criterion results were kept, one rejected until it used every try, the rest never dispatched.
 */
async function legacyInProgress(p: Project): Promise<{ epicId: string; runId: string; ids: { node: string; legacy: string; rejected: string; neverRun: string } }> {
  const { epicId, bundle } = await plan(p, 'Legacy in progress', 3, undefined)
  const run = { runId: (await p.orchestrator.startRun({ epicId })).id, bundle }
  const [legacy = '', rejected = '', neverRun = ''] = bundle.tickets.filter((ticket) => ticket.kind !== 'acceptance').map((ticket) => ticket.id)
  const accepted = await submitted(p, run, legacy)
  await p.orchestrator.acceptAttempt({ attemptId: accepted, notes: 'reviewed' })
  // An acceptance recorded before `decision.criteria` existed.
  p.desktop.ctx().db.run("UPDATE attempts SET decision_json = json_remove(decision_json, '$.criteria') WHERE id = ?", accepted)
  for (let n = 0; n < 3; n += 1) {
    await p.orchestrator.rejectAttempt({ attemptId: await submitted(p, run, rejected), reasons: ['c1 not shown'] })
    p.harness.clock.advanceSeconds(60)
  }
  const node = bundle.tickets.find((ticket) => ticket.kind === 'acceptance')?.id ?? ''
  return { epicId, runId: run.runId, ids: { node, legacy, rejected, neverRun } }
}

describe('getMetricsSummary on an in-progress legacy epic read from Git', () => {
  it('is ungraded: legacy acceptances, a ticket out of tries by its records, tickets never dispatched; never a confirmed failure', async () => {
    const p = await project('Legacy in progress')
    try {
      const { epicId, runId, ids } = await legacyInProgress(p)
      const ctx = p.desktop.ctx()
      // On the machine that ran the run, no retry grant was made: the rejected ticket is a confirmed failure.
      expect(rowOf(getMetricsSummary(ctx, {}), epicId).grade).toMatchObject({ letter: 'F', gradeStatus: 'provisional' })

      // The same records read from Git on another machine: the run is owned elsewhere and its grants are not carried.
      ctx.db.run('UPDATE runs SET owner_machine_id = ? WHERE id = ?', 'mc_000000000000000000000000ff', runId)
      expect(rowOf(getMetricsSummary(ctx, {}), epicId).grade).toMatchObject({ gradeStatus: 'ungraded', letter: null, score: null })
      const states = getEpicGrade(ctx, { epicId }).outcomes.map((outcome) => [outcome.ticketId, outcome.state, outcome.reason, outcome.counted])
      expect(states).toEqual([
        [ids.node, 'missing', 'no_attempt', true],
        [ids.legacy, 'missing', 'legacy_review_basis_unknown', true],
        [ids.rejected, 'missing', 'retry_grants_unknown', true],
        [ids.neverRun, 'missing', 'no_attempt', false]
      ])
    } finally {
      p.harness.cleanup()
    }
  }, 30_000)
})

/** A one-ticket epic (one try) whose ticket is rejected on that try under `onTicketFailure`. */
async function outOfTriesUnder(p: Project, onTicketFailure: 'fail_run' | 'pause_run'): Promise<{ epicId: string; runId: string; ticketId: string; key: string }> {
  const { epicId, bundle } = await plan(p, `Out of tries (${onTicketFailure})`, 1, { policies: { retryLimit: 1, onTicketFailure } })
  const run = { runId: (await p.orchestrator.startRun({ epicId })).id, bundle }
  const ticket = bundle.tickets.find((entry) => entry.kind !== 'acceptance')
  if (ticket === undefined) throw new Error('No work ticket')
  await p.orchestrator.rejectAttempt({ attemptId: await submitted(p, run, ticket.id), reasons: ['c1 not shown'] })
  p.harness.clock.advanceSeconds(60)
  return { epicId, runId: run.runId, ticketId: ticket.id, key: ticket.key }
}

/** The run's records as another machine holds them from Git: owned elsewhere (or, with `owner`, by that machine). */
const ownedBy = (p: Project, runId: string, owner = 'mc_000000000000000000000000ff'): void => {
  p.desktop.ctx().db.run('UPDATE runs SET owner_machine_id = ? WHERE id = ?', owner, runId)
}

function readOf(p: Project, epicId: string, ticketId: string): { verdict: string; grade: MetricsSummaryEpicRow['grade'] } {
  const ctx = p.desktop.ctx()
  const outcome = getEpicGrade(ctx, { epicId }).outcomes.find((entry) => entry.ticketId === ticketId)
  return { verdict: `${outcome?.state}/${outcome?.reason}`, grade: rowOf(getMetricsSummary(ctx, {}), epicId).grade }
}

const runOf = (p: Project, runId: string) => p.desktop.ctx().db.get<{ state: string; pause_reason: string | null }>('SELECT state, pause_reason FROM runs WHERE id = ?', runId)

describe('a ticket out of tries read on a machine that does not own its run', () => {
  it('is a confirmed failure when the run ended failed by fail_run on that ticket (no grant can follow)', async () => {
    const p = await project('Fail run')
    try {
      const { epicId, runId, ticketId, key } = await outOfTriesUnder(p, 'fail_run')
      expect(runOf(p, runId)).toEqual({ state: 'failed', pause_reason: `ticket_failed:${key}` })
      ownedBy(p, runId)
      const read = readOf(p, epicId, ticketId)
      expect(read.verdict).toBe('failed/confirmed_failure')
      expect(read.grade).toMatchObject({ letter: 'F', gradeStatus: 'provisional' })
    } finally {
      p.harness.cleanup()
    }
  }, 30_000)

  it('stays unconfirmed when pause_run paused the run on it, paused or then canceled (a grant may follow a pause)', async () => {
    const p = await project('Pause run')
    try {
      const { epicId, runId, ticketId, key } = await outOfTriesUnder(p, 'pause_run')
      const owner = p.desktop.ctx().machineId
      expect(runOf(p, runId)).toEqual({ state: 'paused', pause_reason: `ticket_failed:${key}` })
      ownedBy(p, runId)
      expect(readOf(p, epicId, ticketId)).toMatchObject({ verdict: 'missing/retry_grants_unknown', grade: { gradeStatus: 'ungraded', letter: null } })
      ownedBy(p, runId, owner)
      await p.orchestrator.cancelRun({ runId, reason: 'closing the run' })
      expect(runOf(p, runId)).toEqual({ state: 'canceled', pause_reason: `ticket_failed:${key}` })
      ownedBy(p, runId)
      expect(readOf(p, epicId, ticketId)).toMatchObject({ verdict: 'missing/retry_grants_unknown', grade: { gradeStatus: 'ungraded', letter: null } })
    } finally {
      p.harness.cleanup()
    }
  }, 30_000)
})

describe('getMetricsSummary sprint trend (DM-265 c4)', () => {
  it('orders entries by end time with open windows last, each run named by its number', () => {
    const { summary, sizedA, sizedB, sizedC, liveEstimated, liveUnsized, partial, failed, running } = world
    expect(summary.trend.map((entry) => [entry.runId, entry.runNumber])).toEqual([
      [sizedA.runId, 1],
      [sizedB.runId, 1],
      [sizedC.runId, 2],
      [liveEstimated.runId, 1],
      [liveUnsized.runId, 1],
      [partial.runId, 1],
      [failed.runId, 1],
      [running.runId, 1]
    ])
    expect(summary.trend.map((entry) => entry.window.closed)).toEqual([true, true, true, true, true, true, true, false])
  })

  it('compares two epics sprints of the same policy and the same sized cohort, naming the epic compared with', () => {
    const { summary, sizedA, sizedB } = world
    const a = entryOf(summary, sizedA.runId)
    const b = entryOf(summary, sizedB.runId)
    expect(a.comparison).toEqual({ previous: null, comparable: false, reasons: ['first_entry'], scoreDelta: null })
    expect(b.cohortTickets).toEqual([{ key: 'implementation/small/multi_step', tickets: 2 }])
    expect(b.comparison.previous).toEqual({ epicId: sizedA.epicId, runId: sizedA.runId, runNumber: 1, sprintId: sizedA.sprintId })
    expect(b.comparison.comparable).toBe(true)
    expect(b.comparison.reasons).toEqual([])
    expect(b.comparison.scoreDelta).toBeCloseTo(-4.166667, 6)
  })

  it('does not compare cohorts of the same keys with other ticket counts', () => {
    const c = entryOf(world.summary, world.sizedC.runId)
    expect(c.cohort).toEqual(['implementation/small/multi_step'])
    expect(c.cohortTickets).toEqual([{ key: 'implementation/small/multi_step', tickets: 3 }])
    expect(c.comparison).toMatchObject({ comparable: false, reasons: ['cohort_changed', 'cross_epic'], scoreDelta: null })
  })
})

describe('getMetricsSummary trend cohorts nobody sized (DM-265 c4)', () => {
  it('never compares unsized cohorts: two unrelated epics of scored, closed, unsized sprints are not comparable', () => {
    const { summary, liveEstimated, liveUnsized } = world
    const estimated = entryOf(summary, liveEstimated.runId)
    const unsized = entryOf(summary, liveUnsized.runId)
    expect([estimated.grade?.score, unsized.grade?.score].every((score) => typeof score === 'number')).toBe(true)
    expect(unsized.cohortTickets).toEqual([{ key: 'unsized', tickets: 2 }])
    expect(unsized.comparison).toEqual({
      previous: { epicId: liveEstimated.epicId, runId: liveEstimated.runId, runNumber: 1, sprintId: liveEstimated.sprintId },
      comparable: false,
      reasons: ['cohort_unknown', 'cross_epic'],
      scoreDelta: null
    })
    expect(estimated.comparison.reasons).toEqual(['cohort_changed', 'cohort_unknown', 'window_basis_changed', 'cross_epic'])
  })

  it('flags an unscored sprint not_scored and a running one window_open', () => {
    const { summary, failed, partial, running } = world
    expect(entryOf(summary, partial.runId).comparison.reasons).toEqual(['cohort_unknown', 'not_scored', 'cross_epic'])
    expect(entryOf(summary, failed.runId).comparison.reasons).toEqual(['cohort_changed', 'cohort_unknown', 'not_scored', 'cross_epic'])
    expect(entryOf(summary, running.runId).comparison.reasons).toEqual(['cohort_unknown', 'window_open', 'not_scored', 'cross_epic'])
  })

  it('is comparable exactly when a score delta is given', () => {
    const verdicts = world.summary.trend.map((entry) => [entry.comparison.comparable, typeof entry.comparison.scoreDelta === 'number'])
    expect(verdicts.filter(([comparable, delta]) => comparable !== delta)).toEqual([])
    expect(verdicts.filter(([comparable]) => comparable)).toHaveLength(1)
  })
})

describe('getMetricsSummary trend across policies (DM-265 c4)', () => {
  it('flags a sprint frozen under another policy policy_changed, even with the same cohort', async () => {
    const p = await project('Policies')
    try {
      const first = await reportedEpic(p, { title: 'First', tickets: ['measured'], accept: true, shape: SMALL })
      const second = await reportedEpic(p, { title: 'Second', tickets: ['measured'], accept: true, shape: SMALL })
      const { db } = p.desktop.ctx()
      const stored = db.get<{ id: string; scorecard_json: string }>('SELECT id, scorecard_json FROM sprint_reports WHERE run_id = ?', second.runId)
      const snapshot = JSON.parse(stored?.scorecard_json ?? '{}') as { policy: unknown }
      db.run('UPDATE sprint_reports SET scorecard_json = ? WHERE id = ?', JSON.stringify({ ...snapshot, policy: policyRef(SPACE_POLICY_V1) }), stored?.id ?? '')
      const summary = getMetricsSummary(p.desktop.ctx(), {})
      expect(entryOf(summary, second.runId).comparison).toMatchObject({ comparable: false, reasons: ['policy_changed', 'cross_epic'], scoreDelta: null })
      expect(entryOf(summary, first.runId).comparison.reasons).toEqual(['first_entry'])
    } finally {
      p.harness.cleanup()
    }
  }, 30_000)
})

describe('getMetricsSummary trend cohorts with no work ticket (DM-265 c4)', () => {
  it('never compares sprints of overhead tickets only: their work cohort is empty, so unknown', async () => {
    const p = await project('Overhead')
    try {
      // Every ticket overhead (sized administrative work and a sized acceptance node): nothing is left for the cohort.
      const shape = { ...SMALL, workTags: ['administrative'] }
      const first = await reportedEpic(p, { title: 'First', tickets: ['measured'], accept: true, shape })
      const second = await reportedEpic(p, { title: 'Second', tickets: ['measured'], accept: true, shape })
      const summary = getMetricsSummary(p.desktop.ctx(), {})
      expect(entryOf(summary, first.runId).cohortTickets).toEqual([])
      const entry = entryOf(summary, second.runId)
      expect(entry.cohortTickets).toEqual([])
      // Both scored, same policy, same (empty) cohort, closed report windows: only the empty cohort keeps them apart.
      expect(entry.comparison).toEqual({ previous: expect.objectContaining({ epicId: first.epicId }), comparable: false, reasons: ['cohort_unknown', 'cross_epic'], scoreDelta: null })
    } finally {
      p.harness.cleanup()
    }
  }, 30_000)
})

describe('getMetricsSummary trend cohorts of work tickets (DM-265 c4)', () => {
  it('leaves the unsized acceptance node out of the cohort, so sized work tickets of two epics compare', async () => {
    const p = await project('Work cohorts')
    try {
      const first = await reportedEpic(p, { title: 'First', tickets: ['measured', 'measured'], accept: true, shape: { work: 'small' } })
      const second = await reportedEpic(p, { title: 'Second', tickets: ['measured', 'measured'], accept: true, shape: { work: 'small' } })
      const entry = entryOf(getMetricsSummary(p.desktop.ctx(), {}), second.runId)
      expect(entry.cohortTickets).toEqual([{ key: 'implementation/small/multi_step', tickets: 2 }])
      expect(entry.comparison).toMatchObject({ previous: { epicId: first.epicId, runId: first.runId }, comparable: true, reasons: [] })
      expect(entry.comparison.scoreDelta).toBe(0)
    } finally {
      p.harness.cleanup()
    }
  }, 30_000)

  it('compares two sprints of one epic with the same policy and cohort, and names no other epic when the cohort changes', async () => {
    const p = await project('Sprints')
    try {
      const { epicId, bundle } = await plan(p, 'Three sprints', [2, 2, 3], { work: 'small', withoutAcceptanceNodes: true })
      const run = await p.orchestrator.startRun({ epicId })
      const sprintIds = bundle.sprints.map((sprint) => sprint.id)
      const retro = { wentWell: ['The tickets landed'] }
      for (const [n, sprintId] of sprintIds.entries()) {
        const delivered = await deliverSprint(p, { runId: run.id, bundle }, sprintId, { tickets: ['measured', 'measured', 'measured'] satisfies UsageKind[], accept: true })
        expect(delivered.ticketIds).toHaveLength(n === 2 ? 3 : 2)
        const report = await p.orchestrator.submitSprintReport({ runId: run.id, sprintId, report: { summary: `Sprint ${n + 1} is done.`, retro } })
        if (n < 2) await p.desktop.approveAndAdvance({ runId: run.id, reportId: report.id })
      }
      await p.orchestrator.cancelRun({ runId: run.id, reason: 'closing the run' })
      const trend = getMetricsSummary(p.desktop.ctx(), {}).trend
      expect(trend.map((entry) => entry.sprintId)).toEqual(sprintIds)
      expect(trend[1]?.comparison).toMatchObject({ previous: { epicId, runId: run.id, runNumber: 1, sprintId: sprintIds[0] }, comparable: true, reasons: [] })
      expect(trend[2]?.comparison).toMatchObject({ previous: { epicId, sprintId: sprintIds[1] }, comparable: false, reasons: ['cohort_changed'], scoreDelta: null })
    } finally {
      p.harness.cleanup()
    }
  }, 30_000)
})

describe('getMetricsSummary gaps', () => {
  it('lists the ten lowest components project-wide, lowest first', () => {
    const { summary } = world
    const scores = summary.gaps.lowestComponents.map((gap) => gap.score)
    expect(scores).toHaveLength(10)
    expect(scores).toEqual([...scores].sort((x, y) => x - y))
  })

  it('never lists a component at a full score as a gap', () => {
    const { p, sizedA } = world
    const components = getEpicGrade(p.desktop.ctx(), { epicId: sizedA.epicId }).grade.components.filter((component) => component.score !== null)
    const below = components
      .filter((component) => (component.score ?? 100) < 100)
      .sort((x, y) => (x.score ?? 0) - (y.score ?? 0))
      .map((component) => [component.component, component.score])
    expect(components.length).toBeGreaterThan(below.length)
    const summary = getMetricsSummary(p.desktop.ctx(), { epicIds: [sizedA.epicId] })
    expect(summary.gaps.lowestComponents.map((gap) => [gap.component, gap.score])).toEqual(below)
  })

  it('names a confirmed failure by its run number and its ticket', () => {
    const { summary, failed } = world
    const ticketId = failed.ticketIds[0] ?? ''
    expect(summary.gaps.failures).toEqual([
      {
        epicId: failed.epicId,
        runId: failed.runId,
        runNumber: 1,
        ticketId,
        ticket: named(failed.bundle, ticketId),
        attemptId: failed.lastAttemptId,
        reason: 'confirmed_failure',
        evidence: [
          { kind: 'ticket', id: ticketId, detail: null },
          { kind: 'attempt', id: failed.lastAttemptId, detail: null }
        ]
      }
    ])
  })
})

describe('getMetricsSummary gap names', () => {
  it('names every ticket a component gap cites by key and title', () => {
    const { summary, sizedA } = world
    const gap = summary.gaps.lowestComponents.find((entry) => entry.epicId === sizedA.epicId)
    expect(gap?.tickets).toEqual(gap?.ticketIds.map((ticketId) => named(sizedA.bundle, ticketId)))
    expect(gap?.ticketIds).toHaveLength(3)
  })

  it('names the ticket rework was spent on by key and title', () => {
    const { summary, sizedB } = world
    const ticketId = sizedB.ticketIds[0] ?? ''
    expect(summary.gaps.rework).toEqual([expect.objectContaining({ epicId: sizedB.epicId, cause: 'implementation', ms: 300_000, ticketIds: [ticketId], tickets: [named(sizedB.bundle, ticketId)] })])
  })
})

describe('getMetricsSummary rework by cause', () => {
  it('lists each cause of rework by effort, most first, a classification that names no cause as unstated, an estimated one keeping the share estimated', async () => {
    const p = await project('Rework')
    try {
      const epic = await reportedEpic(p, { title: 'Rework', tickets: ['corrective', 'measured'], accept: true })
      const corrective = (eventId: string, value: number, cause?: 'requirement') => ({
        metric: 'corrective_effort_ms' as const,
        unit: 'milliseconds' as const,
        source: { kind: 'agent' as const, actor: 'omp:reviewer' },
        measurement: cause === undefined ? { state: 'observed' as const, value } : { state: 'estimated' as const, value, method: 'reviewer estimate' },
        accumulation: 'event' as const,
        eventId,
        observedAt: p.harness.clock.nowIso(),
        attributes: { classification: 'corrective' },
        ...(cause === undefined ? {} : { cause })
      })
      await p.orchestrator.recordAttemptMetrics({ attemptId: epic.attemptIds[1] ?? '', reports: [corrective('extra-requirement', 450_000, 'requirement'), corrective('extra-unstated', 100_000)] })
      const summary = getMetricsSummary(p.desktop.ctx(), {})
      expect(summary.gaps.rework.map((gap) => [gap.cause, gap.ms, gap.ticketIds])).toEqual([
        ['requirement', 450_000, [epic.ticketIds[1]]],
        ['implementation', 300_000, [epic.ticketIds[0]]],
        ['unstated', 100_000, [epic.ticketIds[1]]]
      ])
      expect(rowOf(summary, epic.epicId).correctiveShare.state).toBe('estimated')
    } finally {
      p.harness.cleanup()
    }
  })
})

describe('getMetricsSummary an epic whose run never started', () => {
  it('reads a queued run as no window: the elapsed time unknown, nothing executed, nothing added to the totals', async () => {
    const p = await project('Queued')
    try {
      const { epicId } = await plan(p, 'Queued', 1, undefined)
      const queued = await p.desktop.queueRun({ epicId })
      const summary = getMetricsSummary(p.desktop.ctx(), {})
      const row = rowOf(summary, epicId)
      expect(row.runIds).toEqual([queued.id])
      expect(row.time.elapsedMs).toEqual(unknown('the run has no window'))
      expect(summary.totals.measuredEpicIds).toEqual([])
    } finally {
      p.harness.cleanup()
    }
  })
})

describe('getMetricsSummary gap names from older revisions', () => {
  it('names a ticket the saved plan no longer holds from the revision its run was pinned to', async () => {
    const p = await project('Removed')
    try {
      const epic = await reportedEpic(p, { title: 'Reworked', tickets: ['corrective', 'measured'], accept: true })
      const ticketId = epic.ticketIds[0] ?? ''
      const nodes = epic.bundle.tickets.filter((ticket) => ticket.kind === 'acceptance')
      const ops = [
        ...nodes.map((node) => ({ op: 'update_ticket' as const, ticket: node.id, patch: { acceptanceCriteria: [{ text: 'The rest is verified', covers: epic.ticketIds[1] ?? '' }] } })),
        { op: 'remove_ticket' as const, ticket: ticketId }
      ]
      const revision = (await p.orchestrator.updatePlanDraft({ epicId: epic.epicId, ops })).draftRevision
      expect((await p.orchestrator.savePlan({ epicId: epic.epicId, expectedDraftRevision: revision })).status).toBe('saved')
      const summary = getMetricsSummary(p.desktop.ctx(), {})
      expect(summary.gaps.rework.map((gap) => gap.tickets)).toEqual([[{ ...named(epic.bundle, ticketId), removedAfterRevision: 1 }]])
    } finally {
      p.harness.cleanup()
    }
  }, 30_000)
})
