// DM-176 (pinned by DM-269): the checked-in cause and cohort fixtures, and cohorts frozen at the subject's dispatch.
import { describe, expect, it } from 'vitest'
import type { CohortView, RunEfficiencyView, TicketEfficiencyView } from '../../shared/domain/efficiency'
import { at, atm, efficiency, type EfficiencyFixture, grade, KEY, loadEfficiencyFixtures, MIN, RunBuilder, ticketOf, tk } from '../../test/efficiencyRuns'
import type { CohortRunInput } from './efficiency'

const fixtures = new Map(loadEfficiencyFixtures().map((fixture) => [fixture.name, fixture]))

function fixture(name: string): EfficiencyFixture {
  const found = fixtures.get(name)
  if (found === undefined) throw new Error(`no fixture ${name}`)
  return found
}

/** The fixture read at each of its cutoffs (default: its own). */
function readsOf(name: string): RunEfficiencyView[] {
  const { input, cutoffs } = fixture(name)
  return (cutoffs ?? [input.timing.asOf]).map((asOf) => efficiency({ ...input, timing: { ...input.timing, asOf } }))
}

const ticket = (view: RunEfficiencyView, n: number): TicketEfficiencyView => ticketOf(view, n)

describe('research and complexity against avoidable repair (c4, research-vs-repair)', () => {
  const [view] = readsOf('research-vs-repair')
  if (view === undefined) throw new Error('no read')

  it('scores research and planned tests as productive and repair of a rejected result as corrective', () => {
    expect(ticket(view, 1).classification.denominator.effortMs).toBe(100 * MIN)
    expect(ticket(view, 1).classification.productiveByWork.research).toBe(60 * MIN)
    expect(ticket(view, 1).classification.correctiveByCause).toEqual({ tooling: 5 * MIN })
    expect(grade(ticket(view, 1)).E.score).toBe(92.5)
    expect(ticket(view, 2).classification.denominator.effortMs).toBe(100 * MIN)
    expect(ticket(view, 2).classification.correctiveByCause).toEqual({ implementation: 45 * MIN, requirement: 15 * MIN })
    expect(grade(ticket(view, 2)).E.score).toBe(10)
  })

  it('shows the retry as a diagnostic only, and leaves T and K alike for the same resources', () => {
    expect(grade(ticket(view, 1)).E.diagnostics.retries).toBe(0)
    expect(grade(ticket(view, 2)).E.diagnostics.retries).toBe(1)
    for (const n of [1, 2]) {
      expect(grade(ticket(view, n)).T.score).toBe(100)
      expect(grade(ticket(view, n)).K.score).toBe(100)
    }
  })
})

describe('waiting on a person (c4, approval-wait)', () => {
  const [view] = readsOf('approval-wait')
  if (view === undefined) throw new Error('no read')

  it('shows approval waits as waits, never as active compute', () => {
    expect(ticket(view, 1).T.actual).toEqual({ state: 'observed', value: 60 * MIN })
    expect(ticket(view, 2).T.actual).toEqual({ state: 'observed', value: 60 * MIN })
    expect(ticket(view, 2).time.excludedWaitsMs?.human_approval).toBe(210 * MIN)
    expect(view.sprints[0]?.time.excludedWaitsMs?.human_approval).toBe(510 * MIN)
    expect(view.sprints[0]?.T.actual).toEqual({ state: 'observed', value: 120 * MIN })
  })

  it('scores the ticket that waited the same as the one that did not', () => {
    expect(grade(ticket(view, 1)).T.score).toBe(100)
    expect(grade(ticket(view, 2)).T.score).toBe(100)
    expect(grade(ticket(view, 2)).K.score).toBe(100)
  })
})

describe('retrospective baseline inflation (c4, cohort-inflation)', () => {
  const reads = readsOf('cohort-inflation')

  it('is read at three cutoffs after the subject was accepted', () => {
    expect(reads.map((view) => view.cutoff)).toEqual(['2026-11-01T17:15:00.000Z', '2026-11-01T19:00:00.000Z', '2026-11-02T00:00:00.000Z'])
  })

  it.each([0, 1, 2])('builds the same cohort from records stored before the dispatch (read %i)', (index) => {
    const view = reads[index]
    if (view === undefined) throw new Error('no read')
    const subject = ticket(view, 1)
    expect(subject.dispatchedAt).toBe('2026-11-01T15:40:00.000Z')
    expect(subject.cohorts.T.baseline).toMatchObject({
      baselineId: 'bl_mtzz7r4e53t8vzha7j2nv4vke4',
      value: 65 * MIN,
      sampleSize: 6,
      spread: { p25: 52.5 * MIN, p75: 77.5 * MIN },
      memberTicketIds: [2, 3, 4, 5, 6, 7].map(tk),
      frozenAt: '2026-11-01T14:05:00.000Z'
    })
    expect(subject.cohorts.T.outlierTicketIds).toEqual([tk(7)])
    expect(subject.cohorts.T.excluded.map((e) => [e.ticketId, e.reason])).toEqual([
      [tk(8), 'not_observed'],
      [tk(9), 'cohort_mismatch']
    ])
    expect(subject.cohorts.K.baseline).toMatchObject({ baselineId: 'bl_tyy1rdrxacz2v7gzzad5vhhgfc', value: 65_000 })
  })

  it.each([0, 1, 2])('refuses the budget raised after dispatch and keeps the scores (read %i)', (index) => {
    const view = reads[index]
    if (view === undefined) throw new Error('no read')
    const subject = ticket(view, 1)
    const graded = grade(subject)
    expect(graded.T.inputs).toMatchObject({ baselineKind: 'cohort', ratio: 1.2 })
    expect(graded.T.score).toBe(90)
    expect(graded.K.inputs).toMatchObject({ baselineKind: 'budget', baselineValue: 60_000 })
    expect(graded.K.score).toBe(90)
    expect(subject.K.baseline.rejected).toEqual([
      { baselineId: 'bl_01m7gb00000000000000000121', reason: 'frozen_after_dispatch' },
      { baselineId: 'bl_tyy1rdrxacz2v7gzzad5vhhgfc', reason: 'superseded' }
    ])
  })
})

/** n prior tickets (10, 20, ... minutes; 1,000 tokens a minute) accepted early; subject ticket 1 dispatched at 500. */
function priors(n = 6): RunBuilder {
  const run = new RunBuilder(3000).start(0)
  for (let i = 2; i < 2 + n; i += 1) run.ticket(i, 1, KEY, 0)
  run.ticket(1, 1, KEY, 0)
  for (let i = 2; i < 2 + n; i += 1) {
    const active = (i - 1) * 10
    run.attempt(i, i, 1, { claim: 0, submit: active, decided: active + 5 })
    run.span({ attempt: i, ticket: i }, 0, active)
    run.tokens({ attempt: i, ticket: i }, active * 1000, active)
  }
  run.attempt(30, 1, 1, { claim: 500, submit: 560, decided: 570 })
  run.span({ attempt: 30, ticket: 1 }, 500, 560)
  run.tokens({ attempt: 30, ticket: 1 }, 60_000, 560)
  return run
}

const cohortsAt = (run: RunBuilder, cutoff: number): { T: CohortView; K: CohortView } => ticketOf(efficiency(run.input([], cutoff)), 1).cohorts
const reference = cohortsAt(priors(), 600)

const RUN2 = 'rn_01m7gdve7p0000000000000002'

/** Six accepted tickets (12-17) of another run, read at `cutoff`; `late` adds records stored after the subject's dispatch. */
function otherRun(late: boolean, cutoff: number): CohortRunInput {
  const other = new RunBuilder(3000).start(0)
  for (let i = 12; i < 18; i += 1) {
    const active = (i - 11) * 10
    other.ticket(i, 1, KEY, 0)
    other.attempt(i, i, 1, { claim: 0, submit: active, decided: active + 5 })
    other.span({ attempt: i, ticket: i }, 0, active)
    other.tokens({ attempt: i, ticket: i }, active * 1000, active)
  }
  if (late) {
    other.tokens({ attempt: 12, ticket: 12 }, 999_000, 1000, { sequence: 9 })
    other.span({}, 0, 900, { role: 'orchestrator', source: 'agent', actor: 'orch', recorded: 1000 })
    other.attemptEvent('attempt_superseded', 13, 900)
  }
  return other.cohortRun(cutoff, RUN2)
}

describe('cohort frozen at the dispatch: late records of the run', () => {
  it('takes the six prior tickets as the reference cohort', () => {
    expect(reference.T.baseline).toMatchObject({ value: 35 * MIN, sampleSize: 6, memberTicketIds: [2, 3, 4, 5, 6, 7].map(tk) })
    expect(reference.K.baseline).toMatchObject({ value: 35_000, sampleSize: 6 })
  })

  it.each([
    ['a run-level orchestrator span stored after the dispatch', (run: RunBuilder) => run.span({}, 0, 900, { role: 'orchestrator', source: 'agent', actor: 'orch', recorded: 1000 })],
    ['a higher cumulative token report on a member', (run: RunBuilder) => run.tokens({ attempt: 2, ticket: 2 }, 999_000, 1000, { sequence: 9 })],
    ['an extra member span stored later', (run: RunBuilder) => run.span({ attempt: 3, ticket: 3 }, 0, 20, { actor: 'helper', recorded: 1000 })],
    ['a partial_coverage gap on a member', (run: RunBuilder) => run.tokens({ attempt: 4, ticket: 4 }, null, 1000, { sequence: 10, missing: 'partial_coverage' })],
    ['a refused member span', (run: RunBuilder) => run.span({ attempt: 5, ticket: 5 }, 0, 10, { actor: 'x', recorded: 1000, reported: 99 })],
    ['a member superseded after the dispatch', (run: RunBuilder) => run.attemptEvent('attempt_superseded', 2, 900)]
  ])('ignores %s at every later cutoff', (_label, late) => {
    const run = priors()
    late(run)
    expect(cohortsAt(run, 600)).toEqual(reference)
    expect(cohortsAt(run, 1500)).toEqual(reference)
  })

  it('leaves out a member superseded before the dispatch, even when it is accepted again later', () => {
    const run = priors()
    run.attemptEvent('attempt_superseded', 2, 400)
    const before = cohortsAt(run, 600)
    run.attempt(40, 2, 2, { claim: 700, submit: 710, decided: 720 })
    run.span({ attempt: 40, ticket: 2 }, 700, 710)
    run.tokens({ attempt: 40, ticket: 2 }, 5, 710)
    expect(before.T.baseline).toMatchObject({ value: 40 * MIN, sampleSize: 5, memberTicketIds: [3, 4, 5, 6, 7].map(tk) })
    expect(cohortsAt(run, 1500)).toEqual(before)
  })
})

describe('cohort frozen at the dispatch: other runs, clock skew and nesting', () => {
  it('ignores late records of another run that supplies members', () => {
    const subject = new RunBuilder(3000).start(0).ticket(1, 1, KEY, 0)
    subject.attempt(30, 1, 1, { claim: 500, submit: 560, decided: 570 })
    subject.span({ attempt: 30, ticket: 1 }, 500, 560)
    subject.tokens({ attempt: 30, ticket: 1 }, 60_000, 560)
    const read = (late: boolean, cutoff: number) => ticketOf(efficiency(subject.input([otherRun(late, cutoff)], cutoff)), 1).cohorts
    const quiet = read(false, 600)
    expect(quiet.T.baseline).toMatchObject({ value: 35 * MIN, sampleSize: 6, memberTicketIds: [12, 13, 14, 15, 16, 17].map(tk) })
    expect(quiet.T.members.every((member) => member.runId === RUN2)).toBe(true)
    expect(read(true, 600)).toEqual(quiet)
    expect(read(true, 1500)).toEqual(quiet)
  })

  it('measures a span stored before the dispatch but ending after it only up to the dispatch, at every cutoff', () => {
    const run = priors()
    run.span({ ticket: 2 }, 5, 510, { role: 'reviewer', source: 'agent', actor: 'rev', recorded: 499 })
    const early = cohortsAt(run, 600)
    run.span({}, 0, 900, { role: 'orchestrator', source: 'agent', actor: 'orch', recorded: 1000 })
    const late = cohortsAt(run, 1500)
    expect(early.T.members.find((member) => member.ticketId === tk(2))?.value).toBe(10 * MIN + 495 * MIN - 1)
    expect(early.T.baseline?.value).toBe(45 * MIN)
    expect(late).toEqual(early)
  })

  it('ignores a sub-agent span stored after the dispatch that a member\'s inclusive span would lose', () => {
    const run = priors()
    const parent = run.observations.find((o) => o.metric === 'active_ms' && o.scope.attemptId === atm(2))
    if (parent === undefined) throw new Error('no member span')
    parent.usage = { coverage: 'inclusive', parentActor: null }
    run.span({}, 0, 5, { actor: 'helper', usage: { coverage: 'self', parentActor: 'worker-2' }, recorded: 1000 })
    expect(cohortsAt(run, 600)).toEqual(reference)
    expect(cohortsAt(run, 1500)).toEqual(reference)
    expect(reference.T.members.find((member) => member.ticketId === tk(2))?.value).toBe(10 * MIN)
  })

  it('uses the subject\'s own dispatch, so a later ticket sees the subject as a member', () => {
    const run = priors()
    run.ticket(40, 1, KEY, 0)
    run.attempt(41, 40, 1, { claim: 800, submit: 810, decided: 820 })
    run.span({ attempt: 41, ticket: 40 }, 800, 810)
    const view = efficiency(run.input([], 900))
    expect(ticketOf(view, 1).cohorts.T.baseline?.memberTicketIds).toEqual([2, 3, 4, 5, 6, 7].map(tk))
    expect(ticketOf(view, 40).cohorts.T.baseline?.memberTicketIds).toEqual([1, 2, 3, 4, 5, 6, 7].map(tk))
    expect(ticketOf(view, 40).dispatchedAt).toBe(at(800))
  })
})
