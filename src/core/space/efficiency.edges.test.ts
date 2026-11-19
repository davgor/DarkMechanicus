// DM-273: E, T and K read from unusual records: re-deliveries, malformed classifications, estimated and unavailable
// activity, unsettled token streams, records of unclaimed attempts and sprint ids of older plan revisions.
import { describe, expect, it } from 'vitest'
import type { ResourceActualView } from '../../shared/domain/efficiency'
import type { BudgetBaseline, CohortKey } from '../../shared/domain/space'
import { at, atm, efficiency, KEY, MIN, RunBuilder, sp, ticketOf, tk } from '../../test/efficiencyRuns'
import { buildCohort, type CohortSample, ticketBaseline } from './efficiency'

/** One ticket of `KEY` in sprint 1 with one accepted attempt 0-60 and a 60-minute worker span, read at 300 minutes. */
function acceptedRun(): RunBuilder {
  const run = new RunBuilder(300).start(0).ticket(1, 1, KEY, 0)
  run.attempt(1, 1, 1, { claim: 0, submit: 60, decided: 70 })
  return run
}

/** `acceptedRun` with its worker span reported. */
function spannedRun(): RunBuilder {
  const run = acceptedRun()
  run.span({ attempt: 1, ticket: 1 }, 0, 60)
  return run
}

const ticket1 = (run: RunBuilder) => ticketOf(efficiency(run.input()), 1)
const anomalyKinds = (run: RunBuilder) => efficiency(run.input()).anomalies.map((anomaly) => `${anomaly.kind}:${anomaly.detail}`)

describe('DM-273: re-deliveries and malformed classification records', () => {
  it('a second identical delivery is listed as a duplicate event and counted once', () => {
    const run = spannedRun()
    const id = run.classify({ attempt: 1, ticket: 1 }, 20, { as: 'corrective', at: 60, cause: 'implementation' })
    run.observations.push({ ...structuredClone(run.observation(id)), recordedAt: at(61) })
    expect(efficiency(run.input()).anomalies).toEqual([{ kind: 'duplicate_event', subject: id, detail: 'delivered again' }])
    expect(ticket1(run).classification.correctiveMs).toBe(20 * MIN)
  })

  it('a delta classification and an unknown classification are listed and left unclassified', () => {
    const run = spannedRun()
    const delta = run.classify({ attempt: 1, ticket: 1 }, 20, { as: 'corrective', at: 60 })
    run.observation(delta).accumulation = 'delta'
    run.classify({ attempt: 1, ticket: 1 }, 10, { as: 'maintenance', at: 60 })
    // Each scope (ticket, sprint, run) reads the records, so each lists them.
    expect(anomalyKinds(run)).toHaveLength(6)
    expect([...new Set(anomalyKinds(run))]).toEqual([
      'not_an_event:a delta corrective_effort_ms is not one classified piece of effort',
      'unknown_classification:classification maintenance; counted as unclassified'
    ])
    expect(ticket1(run).classification).toMatchObject({ correctiveMs: 0, productiveMs: 0, unclassifiedMs: 60 * MIN, observationIds: [] })
  })

  it('a corrective record with no cause is shown as unstated, and an estimated one makes the class estimated', () => {
    const run = spannedRun()
    const estimated = run.classify({ attempt: 1, ticket: 1 }, 15, { as: 'corrective', at: 60 })
    run.observation(estimated).measurement = { state: 'estimated', value: 15 * MIN, method: 'worker estimate' }
    const view = ticket1(run)
    expect(view.classification.correctiveByCause).toEqual({ unstated: 15 * MIN })
    expect(view.E.correctiveMs).toEqual({ state: 'estimated', value: 15 * MIN, method: 'sum of classifications including estimated ones' })
  })
})

describe('DM-273: T reads estimated, unavailable and unreported activity', () => {
  it('an estimated span makes T and the unclassified effort estimated', () => {
    const run = acceptedRun()
    const span = run.span({ attempt: 1, ticket: 1 }, 0, 60)
    run.observation(span).measurement = { state: 'estimated', value: 60 * MIN, method: 'transcript gaps' }
    run.classify({ attempt: 1, ticket: 1 }, 20, { as: 'productive', at: 60, work: 'research' })
    const view = ticket1(run)
    expect(view.T.actual).toEqual({ state: 'estimated', value: 60 * MIN, method: 'effort includes estimated activity spans' })
    expect(view.E.unclassifiedMs).toEqual({ state: 'estimated', value: 40 * MIN, method: 'observed effort includes estimated spans' })
  })

  it('a span only a host that cannot report it knows of leaves T missing as host_unavailable', () => {
    const run = acceptedRun()
    run.span({ attempt: 1, ticket: 1 }, 0, 60, { missing: 'host_unavailable' })
    const view = ticket1(run)
    expect(view.T.actual).toEqual({ state: 'missing', reason: 'host_unavailable' })
    expect(view.time.gaps.map((gap) => `${gap.kind}:${gap.reason}`)).toEqual(['missing_span:host_unavailable'])
  })

  it('an accepted attempt that reported no activity leaves T not reported and lists it', () => {
    const view = ticket1(acceptedRun())
    expect(view.T.actual).toEqual({ state: 'missing', reason: 'not_reported' })
    expect(view.T.unreportedAttempts).toBe(1)
    expect(view.time.unreportedAttemptIds).toEqual([atm(1)])
  })
})

describe('DM-273: K reads token streams that are unsettled, partial or unavailable', () => {
  it('a token delta still growing is an unsettled stream; one never reported is not', () => {
    const run = spannedRun()
    const growing = run.tokens({ attempt: 1, ticket: 1 }, null, 60, { missing: 'partial_coverage', actor: 'worker-a' })
    const silent = run.tokens({ attempt: 1, ticket: 1 }, null, 60, { missing: 'not_reported', actor: 'worker-b' })
    for (const id of [growing, silent]) Object.assign(run.observation(id), { accumulation: 'delta', sequence: null })
    expect(ticket1(run).tokens.gaps).toEqual([{ kind: 'unsettled_stream', observationId: growing, metric: 'tokens_total', actor: 'worker-a', attemptId: atm(1), reason: 'partial_coverage' }])
  })

  it('a host report at the same position replaces the agent report of it, settling the stream', () => {
    const run = spannedRun()
    run.tokens({ attempt: 1, ticket: 1 }, null, 60, { sequence: 4, source: 'agent', missing: 'partial_coverage' })
    run.tokens({ attempt: 1, ticket: 1 }, 30_000, 61, { sequence: 4 })
    expect(ticket1(run).tokens.gaps).toEqual([])
  })

  it('a report with no sequence stands behind any numbered report of its stream', () => {
    const run = spannedRun()
    const unnumbered = run.tokens({ attempt: 1, ticket: 1 }, 10_000, 30)
    run.observation(unnumbered).sequence = null
    const growing = run.tokens({ attempt: 1, ticket: 1 }, null, 60, { sequence: 1, missing: 'partial_coverage' })
    expect(ticket1(run).tokens.gaps.map((gap) => gap.observationId)).toEqual([growing])
  })

  it('a stream whose latest report is missing after a number leaves K missing as partial coverage', () => {
    const run = spannedRun()
    run.tokens({ attempt: 1, ticket: 1 }, 30_000, 30, { sequence: 1 })
    run.tokens({ attempt: 1, ticket: 1 }, null, 60, { sequence: 2, missing: 'not_reported' })
    expect(ticket1(run).K.actual).toEqual({ state: 'missing', reason: 'partial_coverage' })
  })

  it('an attempt only a host that cannot report it knows of: host_unavailable alone, partial coverage beside overhead', () => {
    const run = spannedRun()
    run.tokens({ attempt: 1, ticket: 1 }, null, 60, { missing: 'host_unavailable' })
    expect(ticket1(run).K.actual).toEqual({ state: 'missing', reason: 'host_unavailable' })
    run.tokens({ ticket: 1 }, 5_000, 65)
    expect(ticket1(run).K.actual).toEqual({ state: 'missing', reason: 'partial_coverage' })
  })
})

describe('DM-273: records are placed by their counted attempt, else the sprint they name', () => {
  it('a record of an attempt with no claim in the run is listed as unattributed and counted in the ticket it names', () => {
    const run = spannedRun()
    const stray = run.tokens({ attempt: 9, ticket: 1 }, 7_000, 60)
    expect(anomalyKinds(run)).toEqual([`unattributed:scoped to attempt ${atm(9)}, which has no claim counted in this run`])
    expect(efficiency(run.input()).anomalies[0]?.subject).toBe(stray)
    expect(ticket1(run).tokens.reportedValue).toBe(7_000)
  })

  it('a sprint id of an older plan revision counts in its current sprint, or in no sprint when it has no counterpart', () => {
    const run = spannedRun()
    run.tokens({ sprint: 5 }, 4_000, 60, { overhead: 'review' })
    run.tokens({ sprint: 6 }, 9_000, 60, { overhead: 'review', actor: 'retired-reviewer' })
    const input = run.input()
    const view = efficiency({ ...input, timing: { ...input.timing, sprintAliases: { [sp(5)]: sp(1), [sp(6)]: null } } })
    expect(view.sprints.map((sprint) => [sprint.scope.level === 'sprint' ? sprint.scope.sprintId : null, sprint.tokens.reportedValue])).toEqual([[sp(1), 4_000]])
    expect(view.run.tokens.reportedValue).toBe(13_000)
  })
})

/** A token actual of `value` as a cohort sample reads it (observed, every attempt reported). */
function observedTokens(value: number): ResourceActualView {
  return { metric: 'tokens', actual: { state: 'observed', value }, reportedValue: value, attempts: 1, unreportedAttemptIds: [], openAttemptIds: [], gaps: [], overheadValue: null, excludedWaitsMs: null }
}

/** A prior ticket's sample of `value` tokens, its basis `basis` minutes in; keyed `KEY` unless stated. */
const sample = (ticket: number, runId: string, value: number, when: { basis: number; key?: CohortKey | null }): CohortSample => ({
  ticketId: tk(ticket),
  runId,
  key: when.key === undefined ? KEY : when.key,
  time: observedTokens(value),
  tokens: observedTokens(value),
  basisAt: at(when.basis)
})

describe('DM-273: a cohort takes each prior ticket once and excludes the subject, unkeyed and zero tickets', () => {
  it('lists the exclusions in ticket order and keeps the latest sample of a ticket accepted in several runs', () => {
    const samples = [
      sample(4, 'rn_c', 70, { basis: 20 }),
      sample(3, 'rn_a', 0, { basis: 5 }),
      sample(4, 'rn_a', 50, { basis: 10 }),
      sample(2, 'rn_a', 80, { basis: 5, key: null }),
      sample(4, 'rn_b', 90, { basis: 15 }),
      sample(1, 'rn_a', 100, { basis: 5 }),
      sample(4, 'rn_c', 70, { basis: 20 })
    ]
    const cohort = buildCohort(samples, { ticketId: tk(1), key: KEY, dispatchedAt: at(30) }, 'tokens')
    expect(cohort.excluded).toEqual([
      { ticketId: tk(1), runId: 'rn_a', reason: 'subject' },
      { ticketId: tk(2), runId: 'rn_a', reason: 'no_cohort_key' },
      { ticketId: tk(3), runId: 'rn_a', reason: 'zero_value' }
    ])
    expect(cohort.members.map((member) => [member.ticketId, member.runId, member.value])).toEqual([[tk(4), 'rn_c', 70]])
    expect(cohort.baseline).toMatchObject({ value: 70, sampleSize: 1, spread: null, frozenAt: at(20) })
  })
})

describe('DM-273: a ticket baseline lists every unpinned budget version in id order', () => {
  const budget = (n: number, frozen: number): BudgetBaseline => ({
    baselineId: `bl_01m7gb0000000000000000000${n}`,
    kind: 'budget',
    metric: 'tokens',
    unit: 'tokens',
    ticketId: tk(1),
    revisionId: 'rv_01m65yene3p1dwngx9apev01pn',
    version: n,
    value: 100_000,
    frozenAt: at(frozen)
  })

  it('a version frozen before dispatch is superseded and one frozen at or after it is refused', () => {
    const cohort = buildCohort([], { ticketId: tk(1), key: KEY, dispatchedAt: at(30) }, 'tokens')
    const selection = ticketBaseline('tokens', { ticketId: tk(1), key: KEY, dispatchedAt: at(30) }, { budgets: { pinned: null, others: [budget(3, 30), budget(1, -10), budget(2, 40)] }, cohort }, { minCohortSampleSize: 3 })
    expect(selection).toEqual({
      state: 'missing',
      reason: 'no_eligible_baseline',
      rejected: [
        { baselineId: budget(1, 0).baselineId, reason: 'superseded' },
        { baselineId: budget(2, 0).baselineId, reason: 'frozen_after_dispatch' },
        { baselineId: budget(3, 0).baselineId, reason: 'frozen_after_dispatch' }
      ]
    })
  })
})

describe('DM-273: a ticket the plan holds in no sprint', () => {
  it('counts its records in the ticket and the run, never in a sprint', () => {
    const run = new RunBuilder(300).start(0)
    run.tickets.push({ ticketId: tk(1), sprintId: null })
    run.events.push({ kind: 'attempt_claimed', at: at(0), attemptId: atm(1), ticketId: tk(1), sprintId: null, number: 1, carriedForward: false })
    run.tokens({ ticket: 1, sprint: 1 }, 3_000, 30)
    const view = efficiency(run.input())
    expect(ticketOf(view, 1).tokens.reportedValue).toBe(3_000)
    expect(view.sprints.map((sprint) => sprint.tokens.reportedValue)).toEqual([null])
    expect(view.run.tokens.reportedValue).toBe(3_000)
  })
})
