// DM-176 (pinned by DM-269): corrective share, resource actuals against frozen baselines, and missing or limited states.
import { describe, expect, it } from 'vitest'
import type { ResourceActualView } from '../../shared/domain/efficiency'
import type { BudgetBaseline, CohortKey } from '../../shared/domain/space'
import { at, efficiency, grade, KEY, MIN, RunBuilder, sp, ticketOf, tk, tokenCell } from '../../test/efficiencyRuns'
import { buildCohort, type CohortSample, runScopes, ticketBaseline } from './efficiency'
import { projectTiming } from './timing'
import { iso } from './timingIntervals'

/** One ticket of `KEY` in sprint 1, ready at 0, read at 300 minutes. */
function oneTicket(): RunBuilder {
  return new RunBuilder(300).start(0).ticket(1, 1, KEY, 0)
}

/** One accepted attempt 0-60 with a 60-minute worker span. */
function accepted(run: RunBuilder): RunBuilder {
  run.attempt(1, 1, 1, { claim: 0, submit: 60, decided: 70 })
  run.span({ attempt: 1, ticket: 1 }, 0, 60)
  return run
}

/** A rejected attempt, then an accepted one; worker and reviewer spans per attempt (60 + 10 + 30 + 10 minutes). */
function retried(): RunBuilder {
  const run = oneTicket()
  run.attempt(1, 1, 1, { claim: 0, submit: 60, decided: 70, decision: 'rejected' })
  run.attempt(2, 1, 2, { claim: 80, submit: 110, decided: 120 })
  run.span({ attempt: 1, ticket: 1 }, 0, 60)
  run.span({ attempt: 1, ticket: 1 }, 60, 70, { role: 'reviewer', actor: 'reviewer-host' })
  run.span({ attempt: 2, ticket: 1 }, 80, 110)
  run.span({ attempt: 2, ticket: 1 }, 110, 120, { role: 'reviewer', actor: 'reviewer-host' })
  return run
}

/** Two attempts with review, verification, nested helpers, duplicate reports and run/sprint overhead; budgets pinned and raised. */
function overheadRun(): { run: RunBuilder; pinnedT: string; raisedT: string; pinnedK: string } {
  const run = oneTicket()
  run.attempt(1, 1, 1, { claim: 10, submit: 70, decided: 80, decision: 'rejected' })
  run.attempt(2, 1, 2, { claim: 90, submit: 120, decided: 135 })
  run.span({ attempt: 1, ticket: 1 }, 10, 70, { delta: true })
  run.span({ attempt: 1, ticket: 1 }, 10, 70, { source: 'agent' })
  run.span({ attempt: 2, ticket: 1 }, 90, 120, { usage: { coverage: 'inclusive', parentActor: null } })
  run.span({ attempt: 2, ticket: 1 }, 95, 105, { actor: 'helper-2', usage: { coverage: 'self', parentActor: 'worker-2' } })
  run.span({ attempt: 1, ticket: 1 }, 70, 80, { role: 'reviewer', actor: 'reviewer-host', handle: 'reviewer' })
  run.span({ attempt: 2, ticket: 1 }, 120, 135, { role: 'reviewer', actor: 'reviewer-host', handle: 'reviewer' })
  run.span({ attempt: 2, ticket: 1 }, 120, 130, { role: 'other', actor: 'verifier-host', handle: 'verifier' })
  run.span({}, 0, 140, { role: 'orchestrator' })
  run.tokens({ attempt: 1, ticket: 1 }, 100_000, 70)
  run.tokens({ attempt: 1, ticket: 1 }, 100_000, 70, { source: 'agent' })
  run.tokens({ attempt: 2, ticket: 1 }, 60_000, 120, { usage: { coverage: 'inclusive', parentActor: null } })
  run.tokens({ attempt: 2, ticket: 1 }, 20_000, 120, { actor: 'helper-2', usage: { coverage: 'self', parentActor: 'worker-2' } })
  run.tokens({ attempt: 2, ticket: 1 }, 15_000, 135, { actor: 'reviewer-host' })
  run.tokens({ sprint: 1 }, 5_000, 136, { overhead: 'review', actor: 'sprint-reviewer' })
  run.tokens({}, 500_000, 140, { overhead: 'orchestration' })
  const pinnedT = run.budget(1, 'active_ms', { value: 120 * MIN, frozen: -60, version: 1, pinned: true })
  const raisedT = run.budget(1, 'active_ms', { value: 400 * MIN, frozen: 30, version: 2, pinned: false })
  const pinnedK = run.budget(1, 'tokens', { value: 200_000, frozen: -60, version: 1, pinned: true })
  return { run, pinnedT, raisedT, pinnedK }
}

const zeroBudget: BudgetBaseline = {
  baselineId: 'bl_01m7gb00000000000000000999',
  kind: 'budget',
  metric: 'active_ms',
  unit: 'milliseconds',
  ticketId: tk(1),
  revisionId: 'rv_01m65yene3p1dwngx9apev01pn',
  version: 1,
  value: 0,
  frozenAt: at(-60)
}
const noCohort = buildCohort([], { ticketId: tk(1), key: KEY, dispatchedAt: at(0) }, 'active_ms')

/** A thread still working after acceptance: the tokens so far, then a `partial_coverage` gap; `settle` adds a later read. */
function unsettled(settle: boolean): RunBuilder {
  const run = accepted(oneTicket())
  run.classify({ attempt: 1, ticket: 1 }, 60, { as: 'productive', at: 60 })
  run.budget(1, 'active_ms', { value: 120 * MIN, frozen: -60, version: 1, pinned: true })
  run.budget(1, 'tokens', { value: 200_000, frozen: -60, version: 1, pinned: true })
  run.tokens({ attempt: 1, ticket: 1 }, 40_000, 65, { sequence: 3 })
  run.tokens({ attempt: 1, ticket: 1 }, null, 65, { sequence: 4, missing: 'partial_coverage' })
  if (settle) run.tokens({ attempt: 1, ticket: 1 }, 41_000, 90, { sequence: 5 })
  return run
}

/** One accepted attempt 0-120 with a host worker span over all of it and a pinned 120-minute T budget. */
function hosted(agent: (run: RunBuilder) => void): RunBuilder {
  const run = oneTicket()
  run.attempt(1, 1, 1, { claim: 0, submit: 120, decided: 130 })
  run.tokens({ attempt: 1, ticket: 1 }, 100_000, 120)
  run.budget(1, 'active_ms', { value: 120 * MIN, frozen: -60, version: 1, pinned: true })
  run.span({ attempt: 1, ticket: 1 }, 0, 120, { source: 'host', actor: 'claude_code:s1/w' })
  agent(run)
  return run
}

describe('corrective share: denominator and causes (c1)', () => {
  it('divides classified corrective effort by the observed effort of every actor, with its coverage', () => {
    const run = retried()
    run.classify({ attempt: 1, ticket: 1 }, 45, { as: 'productive', at: 60, work: 'research' })
    run.classify({ attempt: 1, ticket: 1 }, 15, { as: 'productive', at: 60, work: 'planned_test' })
    run.classify({ attempt: 1, ticket: 1 }, 10, { as: 'productive', at: 70, work: 'review' })
    run.classify({ attempt: 2, ticket: 1 }, 30, { as: 'corrective', at: 110, cause: 'implementation' })
    run.classify({ attempt: 2, ticket: 1 }, 10, { as: 'corrective', at: 120, cause: 'implementation' })
    const ticket = ticketOf(efficiency(run.input()), 1)
    const { classification } = ticket
    expect(classification.denominator.effortMs).toBe(110 * MIN)
    expect(classification.denominator.overheadMs).toBe(20 * MIN)
    expect(classification.denominator.coverage).toMatchObject({ covered: 2, of: 2 })
    expect(classification.correctiveMs).toBe(40 * MIN)
    expect(classification.correctiveByCause).toEqual({ implementation: 40 * MIN })
    expect(classification.productiveMs).toBe(70 * MIN)
    expect(classification.productiveByWork).toEqual({ research: 45 * MIN, planned_test: 15 * MIN, review: 10 * MIN })
    expect(classification.unclassifiedMs).toBe(0)
    expect(classification.classificationCoverage).toBe(1)
    const E = grade(ticket).E
    expect(E.score).toBe(45.454545)
    expect(E.diagnostics.retries).toBe(1)
    expect(E.inputs).not.toHaveProperty('retries')
  })

  it('keeps a rejected attempt of research as productive: the retry itself is not corrective effort', () => {
    const run = retried()
    run.classify({ attempt: 1, ticket: 1 }, 70, { as: 'productive', at: 70, work: 'research' })
    run.classify({ attempt: 2, ticket: 1 }, 40, { as: 'productive', at: 120 })
    const ticket = ticketOf(efficiency(run.input()), 1)
    expect(ticket.classification.retries.attempts.map((a) => [a.number, a.outcome, a.effortMs])).toEqual([
      [1, 'rejected', 70 * MIN],
      [2, 'accepted', 40 * MIN]
    ])
    expect(ticket.classification.correctiveMs).toBe(0)
    expect(grade(ticket).E.score).toBe(100)
  })

  it('reports nothing classified as missing, with the retry count only as a diagnostic, never as time wasted', () => {
    const ticket = ticketOf(efficiency(retried().input()), 1)
    const E = grade(ticket).E
    expect(E.score).toBeNull()
    expect(E.missingReason).toBe('zero_observation')
    expect(E.diagnostics.retries).toBe(1)
    expect(ticket.classification.correctiveMs).toBe(0)
    expect(ticket.E.correctiveMs).toEqual({ state: 'observed', value: 0 })
  })
})

describe('corrective share: partial and unknown classification (c1)', () => {
  it('refuses a share under the classification coverage threshold', () => {
    const run = accepted(oneTicket())
    run.classify({ attempt: 1, ticket: 1 }, 30, { as: 'productive', at: 60 })
    const E = grade(ticketOf(efficiency(run.input()), 1)).E
    expect(E.score).toBeNull()
    expect(E.missingReason).toBe('insufficient_classification')
    expect(E.inputs.classificationCoverage).toBe(0.5)
  })

  it('lists classification above the observed effort and keeps E missing', () => {
    const run = accepted(oneTicket())
    run.classify({ attempt: 1, ticket: 1 }, 50, { as: 'productive', at: 60 })
    run.classify({ attempt: 1, ticket: 1 }, 30, { as: 'corrective', at: 60, cause: 'context' })
    const view = efficiency(run.input())
    const ticket = ticketOf(view, 1)
    expect(ticket.E.unclassifiedMs).toEqual({ state: 'missing', reason: 'partial_coverage' })
    expect(grade(ticket).E.missingReason).toBe('partial_coverage')
    expect(view.anomalies.filter((a) => a.kind === 'over_classified').map((a) => [a.subject, a.detail])).toEqual([
      [tk(1), '4800000 ms classified of 3600000 ms observed effort'],
      [sp(1), '4800000 ms classified of 3600000 ms observed effort'],
      ['run', '4800000 ms classified of 3600000 ms observed effort']
    ])
  })

  it('reads a corrective record without its value as unknown, never as zero', () => {
    const run = accepted(oneTicket())
    run.classify({ attempt: 1, ticket: 1 }, 55, { as: 'productive', at: 60 })
    run.classify({ attempt: 1, ticket: 1 }, null, { as: 'corrective', at: 60, cause: 'tooling', missing: 'not_reported' })
    const view = efficiency(run.input())
    const ticket = ticketOf(view, 1)
    expect(ticket.E.correctiveMs).toEqual({ state: 'missing', reason: 'not_reported' })
    expect(grade(ticket).E.missingReason).toBe('not_reported')
    expect(view.run.E.correctiveMs.state).toBe('missing')
  })

  it('sums the run denominator over every ticket', () => {
    const run = new RunBuilder(300).start(0).ticket(1, 1, KEY, 0).ticket(2, 1, KEY, 0)
    accepted(run)
    run.attempt(2, 2, 1, { claim: 0, submit: 40, decided: 50 })
    run.span({ attempt: 2, ticket: 2 }, 0, 40)
    run.classify({ attempt: 1, ticket: 1 }, 50, { as: 'productive', at: 60 })
    run.classify({ attempt: 1, ticket: 1 }, 10, { as: 'corrective', at: 60, cause: 'verification' })
    run.classify({ attempt: 2, ticket: 2 }, 40, { as: 'corrective', at: 40, cause: 'integration' })
    const classification = efficiency(run.input()).run.classification
    expect(classification.denominator.effortMs).toBe(100 * MIN)
    expect(classification.correctiveMs).toBe(50 * MIN)
    expect(classification.correctiveByCause).toEqual({ verification: 10 * MIN, integration: 40 * MIN })
    expect(classification.productiveMs).toBe(50 * MIN)
  })
})

describe('time and token actuals against the frozen baseline (c2)', () => {
  it('counts every actor of the ticket once in T: workers, nested helper, review and verification', () => {
    const ticket = ticketOf(efficiency(overheadRun().run.input()), 1)
    expect(ticket.T.actual).toEqual({ state: 'observed', value: 125 * MIN })
    expect(ticket.time.overheadValue).toBe(35 * MIN)
    expect(ticket.classification.retries.attempts[0]?.effortMs).toBe(70 * MIN)
  })

  it('scores T against the budget frozen before dispatch and refuses one raised mid-run', () => {
    const { run, pinnedT, raisedT } = overheadRun()
    const ticket = ticketOf(efficiency(run.input()), 1)
    const T = grade(ticket).T
    expect(T.inputs.baselineId).toBe(pinnedT)
    expect(T.inputs.ratio).toBe(1.041667)
    expect(T.score).toBe(97.916667)
    expect(ticket.T.baseline.rejected).toContainEqual({ baselineId: raisedT, reason: 'frozen_after_dispatch' })
  })

  it('counts each token delivery once in K: the agent copy, the inclusive parent and the review', () => {
    const { run, pinnedK } = overheadRun()
    const ticket = ticketOf(efficiency(run.input()), 1)
    expect(ticket.K.actual).toEqual({ state: 'observed', value: 175_000 })
    const K = grade(ticket).K
    expect(K.inputs.baselineId).toBe(pinnedK)
    expect(K.score).toBe(100)
  })

  it('charges sprint and run overhead once, at its own scope, never to the ticket', () => {
    const view = efficiency(overheadRun().run.input())
    const [sprint] = view.sprints
    expect(sprint?.K.actual).toEqual({ state: 'observed', value: 180_000 })
    expect(view.run.T.actual).toEqual({ state: 'observed', value: 265 * MIN })
    expect(view.run.K.actual).toEqual({ state: 'observed', value: 680_000 })
    expect(view.run.T.baseline.state).toBe('missing')
    expect(sprint?.T.baseline.state).toBe('missing')
  })
})

describe('missing baselines and zero observations (c3)', () => {
  it('gives no baseline at all as no_eligible_baseline, never a score', () => {
    const run = accepted(oneTicket())
    run.tokens({ attempt: 1, ticket: 1 }, 100_000, 60)
    const graded = grade(ticketOf(efficiency(run.input()), 1))
    expect(graded.T).toMatchObject({ score: null, state: 'missing', missingReason: 'no_eligible_baseline' })
    expect(graded.K).toMatchObject({ score: null, state: 'missing', missingReason: 'no_eligible_baseline' })
  })

  it('refuses a zero budget instead of dividing by it', () => {
    const selection = ticketBaseline('active_ms', { ticketId: tk(1), key: KEY, dispatchedAt: at(0) }, { budgets: { pinned: zeroBudget, others: [] }, cohort: noCohort }, { minCohortSampleSize: 5 })
    expect(selection).toMatchObject({ state: 'missing', rejected: [{ baselineId: zeroBudget.baselineId, reason: 'zero_value' }] })
  })

  it('applies no baseline to a ticket never dispatched', () => {
    const selection = ticketBaseline('active_ms', { ticketId: tk(1), key: KEY, dispatchedAt: null }, { budgets: { pinned: { ...zeroBudget, value: 5 }, others: [] }, cohort: noCohort }, { minCohortSampleSize: 5 })
    expect(selection).toMatchObject({ state: 'missing', rejected: [{ reason: 'invalid_time' }] })
  })

  it('gives zero observed tokens against a budget zero_observation, not an A', () => {
    const run = accepted(oneTicket())
    run.tokens({ attempt: 1, ticket: 1 }, 0, 60)
    run.budget(1, 'tokens', { value: 50_000, frozen: -60, version: 1, pinned: true })
    expect(grade(ticketOf(efficiency(run.input()), 1)).K).toMatchObject({ score: null, missingReason: 'zero_observation' })
  })

  it('leaves T, K and E unscored for an attempt that reported nothing', () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 60, decided: 70 })
    run.budget(1, 'active_ms', { value: 60 * MIN, frozen: -60, version: 1, pinned: true })
    run.budget(1, 'tokens', { value: 50_000, frozen: -60, version: 1, pinned: true })
    const graded = grade(ticketOf(efficiency(run.input()), 1))
    expect([graded.T.score, graded.K.score, graded.E.score]).toEqual([null, null, null])
    expect([graded.T.state, graded.K.state, graded.E.state]).toEqual(['missing', 'missing', 'missing'])
  })
})

describe('partial telemetry and unsettled streams (c3)', () => {
  it('gives partial_telemetry when one of two attempts reported nothing', () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 30, decided: 40, decision: 'rejected' })
    run.attempt(2, 1, 2, { claim: 50, submit: 110, decided: 120 })
    run.span({ attempt: 2, ticket: 1 }, 50, 110)
    run.tokens({ attempt: 2, ticket: 1 }, 100_000, 110)
    run.budget(1, 'active_ms', { value: 60 * MIN, frozen: -60, version: 1, pinned: true })
    run.budget(1, 'tokens', { value: 200_000, frozen: -60, version: 1, pinned: true })
    run.classify({ attempt: 2, ticket: 1 }, 60, { as: 'productive', at: 110 })
    const ticket = ticketOf(efficiency(run.input()), 1)
    const graded = grade(ticket)
    expect(ticket.T.unreportedAttempts).toBe(1)
    expect(graded.T.missingReason).toBe('partial_telemetry')
    expect(graded.K.missingReason).toBe('partial_telemetry')
    expect(graded.E.missingReason).toBe('partial_coverage')
  })

  describe('a thread still working (an unsettled token stream)', () => {
    it('keeps T, K and E missing at every scope', () => {
      const view = efficiency(unsettled(false).input())
      const graded = grade(ticketOf(view, 1))
      expect([graded.T.score, graded.K.score, graded.E.score]).toEqual([null, null, null])
      expect(ticketOf(view, 1).time.gaps.map((gap) => gap.kind)).toEqual(['unsettled_stream'])
      expect(view.sprints.map((sprint) => sprint.T.actual.state)).toEqual(['missing'])
      expect(view.run.T.actual.state).toBe('missing')
      expect(view.run.K.actual.state).toBe('missing')
    })

    it('completes once a later settled read arrives', () => {
      const graded = grade(ticketOf(efficiency(unsettled(true).input()), 1))
      expect([graded.T.score, graded.K.score, graded.E.score]).toEqual([100, 100, 100])
    })
  })

  it('keeps T missing for an activity record without its value', () => {
    const run = accepted(oneTicket())
    run.budget(1, 'active_ms', { value: 120 * MIN, frozen: -60, version: 1, pinned: true })
    run.span({ attempt: 1, ticket: 1 }, 60, 65, { source: 'agent', missing: 'not_reported', actor: 'helper' })
    const ticket = ticketOf(efficiency(run.input()), 1)
    expect(ticket.time.gaps.map((gap) => [gap.kind, gap.reason])).toEqual([['missing_span', 'not_reported']])
    expect(grade(ticket).T.score).toBeNull()
  })
})

describe('unended spans, open attempts and estimates (c3)', () => {
  it('does not let a conflicting re-delivery hide an unended span in a later sprint', () => {
    const run = new RunBuilder(300).start(0).ticket(1, 1, KEY, 0).ticket(2, 2, KEY)
    run.attempt(1, 1, 1, { claim: 0, submit: 30, decided: 40 })
    run.span({ attempt: 1, ticket: 1 }, 0, 30)
    run.tokens({ attempt: 1, ticket: 1 }, 10_000, 30)
    run.activate(2, 50)
    run.attempt(2, 2, 1, { claim: 60, submit: 90, decided: 100 })
    run.span({ attempt: 2, ticket: 2 }, 60, 90)
    run.span({ attempt: 2, ticket: 2 }, 90, 95)
    run.budget(2, 'active_ms', { value: 60 * MIN, frozen: -60, version: 1, pinned: true })
    run.tokens({ attempt: 2, ticket: 2 }, 30_000, 95, { sequence: 3 })
    const gapId = run.tokens({ attempt: 2, ticket: 2 }, null, 95, { sequence: 4, missing: 'partial_coverage' })
    const first = run.observation(gapId)
    run.observations.push({ ...first, sequence: 8, measurement: { state: 'observed', value: 31_000 }, recordedAt: at(96) })
    const view = efficiency(run.input())
    expect(view.anomalies).toContainEqual(expect.objectContaining({ kind: 'conflicting_delivery', subject: gapId }))
    expect(grade(ticketOf(view, 2)).T.score).toBeNull()
    const sprintActual = (n: number) => view.sprints.find((s) => s.scope.level === 'sprint' && s.scope.sprintId === sp(n))?.T.actual
    expect(sprintActual(2)?.state).toBe('missing')
    expect(sprintActual(1)).toEqual({ state: 'observed', value: 30 * MIN })
    expect(view.run.T.actual.state).toBe('missing')
  })

  it('reads an attempt still open at the cutoff as a lower bound: missing', () => {
    const run = oneTicket()
    run.claim(1, 1, 1, 0)
    run.span({ attempt: 1, ticket: 1 }, 0, 60)
    run.tokens({ attempt: 1, ticket: 1 }, 10_000, 60)
    run.classify({ attempt: 1, ticket: 1 }, 60, { as: 'productive', at: 60 })
    const ticket = ticketOf(efficiency(run.input()), 1)
    expect(ticket.T.actual).toEqual({ state: 'missing', reason: 'partial_coverage' })
    expect(ticket.K.actual.state).toBe('missing')
    expect(ticket.time.openAttemptIds).toHaveLength(1)
    expect(ticket.E.unclassifiedMs).toEqual({ state: 'missing', reason: 'partial_coverage' })
  })

  it('grades an estimated token actual as estimated, never observed', () => {
    const run = accepted(oneTicket())
    run.tokens({ attempt: 1, ticket: 1 }, 90_000, 60, { estimated: true })
    run.budget(1, 'tokens', { value: 100_000, frozen: -60, version: 1, pinned: true })
    expect(grade(ticketOf(efficiency(run.input()), 1)).K.state).toBe('estimated')
  })
})

describe('cohort comparability (c3)', () => {
  describe('incomparable and small cohorts', () => {
    const sample = (n: number, value: number, key: CohortKey = KEY): CohortSample => {
      const view: ResourceActualView = { metric: 'active_ms', actual: { state: 'observed', value }, reportedValue: value, attempts: 1, unreportedAttemptIds: [], openAttemptIds: [], gaps: [], overheadValue: 0, excludedWaitsMs: null }
      return { ticketId: tk(n), runId: 'rn_01m7gdve7p0000000000000009', key, time: view, tokens: { ...view, metric: 'tokens' }, basisAt: at(-100) }
    }
    const subject = { ticketId: tk(1), key: KEY, dispatchedAt: at(0) }

    it('excludes tickets of another size as cohort_mismatch', () => {
      const cohort = buildCohort([10, 11, 12, 13, 14, 15].map((n) => sample(n, 60 * MIN, { ...KEY, size: 'large' })), subject, 'active_ms')
      expect(cohort.baseline).toBeNull()
      expect(cohort.excluded.map((e) => e.reason)).toEqual(Array(6).fill('cohort_mismatch'))
    })

    it('builds a cohort under five samples with its size shown, and selection refuses it', () => {
      const cohort = buildCohort([10, 11, 12].map((n) => sample(n, 60 * MIN)), subject, 'active_ms')
      expect(cohort.baseline?.sampleSize).toBe(3)
      const selection = ticketBaseline('active_ms', subject, { budgets: { pinned: null, others: [] }, cohort }, { minCohortSampleSize: 5 })
      expect(selection).toMatchObject({ state: 'missing', rejected: [{ reason: 'sample_too_small' }] })
    })

    it('selects a cohort of five as the baseline', () => {
      const cohort = buildCohort([10, 11, 12, 13, 14].map((n) => sample(n, (50 + n) * MIN)), subject, 'active_ms')
      const selection = ticketBaseline('active_ms', subject, { budgets: { pinned: null, others: [] }, cohort }, { minCohortSampleSize: 5 })
      expect(selection.state).toBe('selected')
      expect(cohort.baseline?.value).toBe(62 * MIN)
    })

    it('gives a ticket without a size no cohort key', () => {
      expect(buildCohort([sample(10, MIN)], { ...subject, key: null }, 'active_ms').missingReason).toBe('no_cohort_key')
    })
  })
})

describe('host telemetry over an agent self-report (DM-269 fix)', () => {
  it.each([
    ['an unplaced delta amount', (run: RunBuilder) => run.span({ attempt: 1, ticket: 1 }, 20, 120, { source: 'agent', delta: true, unplaced: true })],
    ['a span inconsistent with its value', (run: RunBuilder) => run.span({ attempt: 1, ticket: 1 }, 20, 120, { source: 'agent', reported: 90 })],
    ['a placed span', (run: RunBuilder) => run.span({ attempt: 1, ticket: 1 }, 20, 120, { source: 'agent' })]
  ])('does not count the agent report of a hosted attempt (%s) as a gap', (_label, agent) => {
    const view = efficiency(hosted(agent).input())
    const ticket = ticketOf(view, 1)
    expect(ticket.time.gaps).toEqual([])
    expect(ticket.T.actual).toEqual({ state: 'observed', value: 120 * MIN })
    expect(grade(ticket).T.score).toBe(100)
    expect(view.run.T.actual).toEqual({ state: 'observed', value: 120 * MIN })
    expect(view.anomalies.map((a) => a.kind)).toEqual(['duplicate_source'])
  })
})

describe('refused reports the host does not cover (DM-269 fix)', () => {
  it('still counts a refused agent report as a gap when the host covers another attempt', () => {
    const run = new RunBuilder(300).start(0).ticket(1, 1, KEY, 0).ticket(2, 1, KEY, 0)
    run.attempt(1, 1, 1, { claim: 0, submit: 120, decided: 130 })
    run.attempt(2, 2, 1, { claim: 0, submit: 120, decided: 130 })
    run.span({ attempt: 1, ticket: 1 }, 0, 120)
    run.span({ attempt: 2, ticket: 2 }, 0, 30, { source: 'agent' })
    const refused = run.span({ attempt: 2, ticket: 2 }, 30, 120, { source: 'agent', reported: 95 })
    const view = efficiency(run.input())
    expect(ticketOf(view, 2).time.gaps.map((gap) => [gap.kind, gap.observationId])).toEqual([['refused_span', refused]])
    expect(ticketOf(view, 2).T.actual).toEqual({ state: 'missing', reason: 'partial_coverage' })
    expect(view.anomalies).toContainEqual(expect.objectContaining({ kind: 'inconsistent_span', subject: refused }))
  })

  it('keeps a host amount it cannot place as a gap beside the agent span', () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 120, decided: 130 })
    const host = run.span({ attempt: 1, ticket: 1 }, 0, 120, { delta: true, actor: 'host:ci', unplaced: true })
    run.span({ attempt: 1, ticket: 1 }, 0, 30, { source: 'agent', actor: 'host:ci' })
    const ticket = ticketOf(efficiency(run.input()), 1)
    expect(ticket.time.gaps.map((gap) => [gap.kind, gap.observationId])).toEqual([['refused_span', host]])
    expect(ticket.T.actual.state).toBe('missing')
  })

  it('drops an agent run-level span of the same named actor, the host label missing', () => {
    const run = accepted(oneTicket())
    run.span({}, 0, 100, { delta: true, actor: 'claude_code:s1' })
    run.span({}, 0, 100, { source: 'agent', actor: 'claude_code:s1', role: 'orchestrator' })
    const view = efficiency(run.input())
    expect(view.run.T.actual).toEqual({ state: 'observed', value: 160 * MIN })
    expect(view.anomalies.map((a) => a.kind)).toEqual(['duplicate_source'])
  })

  it('never matches two run-level reports with no actor named', () => {
    const run = accepted(oneTicket())
    run.span({}, 0, 50, { delta: true, actor: null })
    run.span({}, 130, 160, { source: 'agent', role: 'reviewer', actor: null })
    const view = efficiency(run.input())
    expect(view.run.T.actual).toEqual({ state: 'observed', value: 140 * MIN })
    expect(view.anomalies).toEqual([])
  })
})

describe('fractional milliseconds (DM-172 review, fixed here)', () => {
  it('truncates a fractional time to an exact ISO millisecond', () => {
    expect(iso(Date.parse('2026-11-01T10:20:00.000Z') - 0.5)).toBe('2026-11-01T10:19:59.999Z')
  })

  it('places a fractional active_ms with no start on whole milliseconds', () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 60, decided: 70 })
    const id = run.span({ attempt: 1, ticket: 1 }, 0, 20)
    const fractional = { ...run.observation(id), measurement: { state: 'observed' as const, value: 600000.5 }, attributes: {} }
    const input = run.input()
    const timing = projectTiming({ ...input.timing, activity: [fractional] })
    const segments = timing.tickets[0]?.attempts[0]?.segments ?? []
    expect(segments.find((segment) => segment.class === 'active')).toMatchObject({ start: '2026-11-01T09:10:00.000Z', end: '2026-11-01T09:20:00.000Z' })
    expect(segments.every((segment) => !Number.isNaN(Date.parse(segment.start)) && !Number.isNaN(Date.parse(segment.end)))).toBe(true)
    const scopes = runScopes({ ...input.timing, activity: [fractional] }, [fractional], tokenCell)
    expect(scopes.timing.tickets[0]?.effort.total.ms).toBe(600_000)
  })
})
