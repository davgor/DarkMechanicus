import { describe, expect, it } from 'vitest'
import type { BudgetVersionView, PlannedBudgetView } from '../../../shared/domain/metrics'
import { localTime } from '../scorecard/scorecardFormat'
import { basisOf, budgetSummary, budgetText, minutesToMs, parseBudget, sameText, versionText } from './budgetForm'

describe('DM-183 c3: budget estimates with units and provenance', () => {
  it('sets tokens in tokens and minutes as whole milliseconds, with the basis', () => {
    expect(parseBudget({ tokens: ' 50000 ', minutes: '2.5', basis: 'planner_estimate' })).toEqual({
      ok: true,
      budget: { tokens: 50_000, activeMs: 150_000, basis: 'planner_estimate' }
    })
  })

  it('leaves out an amount left blank and a basis not stated', () => {
    expect(parseBudget({ tokens: '', minutes: '3', basis: '' })).toEqual({ ok: true, budget: { activeMs: 180_000 } })
    expect(parseBudget({ tokens: '7', minutes: '  ', basis: '' })).toEqual({ ok: true, budget: { tokens: 7 } })
  })

  it('both amounts blank with no basis is no budget, never a filled-in one', () => {
    expect(parseBudget({ tokens: ' ', minutes: '', basis: '' })).toEqual({ ok: true, budget: null })
  })

  it('refuses a basis with both amounts blank', () => {
    expect(parseBudget({ tokens: '', minutes: '', basis: 'person_estimate' })).toEqual({
      ok: false,
      message: 'A basis needs an amount: enter tokens, minutes or both, or set the basis to Not stated.'
    })
  })

  it.each(['1e', '-', '1e-9', '1.5', '-3', '0', '1000000000001', '1e3'])('refuses tokens %j', (tokens) => {
    expect(parseBudget({ tokens, minutes: '', basis: '' })).toEqual({ ok: false, message: 'Tokens are a whole number from 1 to 1,000,000,000,000.' })
  })

  it('accepts the token bounds 1 and 10^12', () => {
    expect(parseBudget({ tokens: '1', minutes: '', basis: '' })).toEqual({ ok: true, budget: { tokens: 1 } })
    expect(parseBudget({ tokens: '1000000000000', minutes: '', basis: '' })).toEqual({ ok: true, budget: { tokens: 1_000_000_000_000 } })
  })
})

describe('DM-183 c3: strict minutes, basis choice and summaries', () => {
  it.each(['1e', '-', '1e-9', '1e2', '-1', '0', '0.000008', 'abc', '.'])('refuses minutes %j', (minutes) => {
    expect(parseBudget({ tokens: '', minutes, basis: '' })).toEqual({
      ok: false,
      message: 'Active time is a number of minutes, more than 0 and at most about 31 years (10¹² milliseconds).'
    })
  })

  it('reads minutes strictly: blank is undefined, refused text is null, digits with a point are milliseconds', () => {
    expect(minutesToMs('  ')).toBeUndefined()
    expect(minutesToMs('1e2')).toBeNull()
    expect(minutesToMs('-')).toBeNull()
    expect(minutesToMs('.5')).toBe(30_000)
    expect(minutesToMs('2.')).toBe(120_000)
    expect(minutesToMs('0.00001')).toBe(1)
  })

  it('picks only a known basis from a select value', () => {
    expect(basisOf('prior_tickets')).toBe('prior_tickets')
    expect(basisOf('agent_guess')).toBe('')
    expect(basisOf('')).toBe('')
  })

  it('summarises a budget in its units with its provenance', () => {
    expect(budgetSummary({ tokens: 1500, activeMs: 90_000, basis: 'person_estimate' })).toBe('1,500 tokens and 1 min 30 s active · A person’s estimate')
    expect(budgetSummary({ tokens: 20 })).toBe('20 tokens · basis not stated')
    expect(budgetSummary(undefined)).toBe('no budget')
    expect(budgetSummary(null)).toBe('no budget')
  })

  it('compares texts ignoring surrounding spaces but not the basis', () => {
    expect(sameText({ tokens: ' 5', minutes: '2 ', basis: '' }, { tokens: '5', minutes: '2', basis: '' })).toBe(true)
    expect(sameText({ tokens: '5', minutes: '', basis: '' }, { tokens: '5', minutes: '', basis: 'planner_estimate' })).toBe(false)
    expect(sameText({ tokens: '5', minutes: '', basis: '' }, { tokens: '6', minutes: '', basis: '' })).toBe(false)
    expect(sameText({ tokens: '5', minutes: '1', basis: '' }, { tokens: '5', minutes: '2', basis: '' })).toBe(false)
  })
})

describe('DM-183 c3 review fix: stored time budgets shown rounded, round-tripped exactly', () => {
  it('shows 100000 ms as 1.66667 minutes, not 1.6666666666666667', () => {
    expect(budgetText({ activeMs: 100_000 })).toEqual({ tokens: '', minutes: '1.66667', basis: '' })
  })

  it.each([1, 29, 100_000, 123_457, 59_999, 1_000_000_000_000])('an untouched %i ms sends back exactly the stored milliseconds', (activeMs) => {
    const text = budgetText({ tokens: 3, activeMs, basis: 'prior_tickets' })
    expect(parseBudget(text)).toEqual({ ok: true, budget: { tokens: 3, activeMs, basis: 'prior_tickets' } })
  })

  it('never shows 1–29 ms as 0 minutes', () => {
    expect(budgetText({ activeMs: 1 }).minutes).toBe('0.00002')
    expect(budgetText({ activeMs: 29 }).minutes).toBe('0.00048')
  })

  it('shows whole minutes without decimals and no budget as blank', () => {
    expect(budgetText({ tokens: 40, activeMs: 120_000, basis: 'planner_estimate' })).toEqual({ tokens: '40', minutes: '2', basis: 'planner_estimate' })
    expect(budgetText(undefined)).toEqual({ tokens: '', minutes: '', basis: '' })
  })
})

function version(overrides: Partial<BudgetVersionView>): BudgetVersionView {
  return {
    baselineId: 'bl_1',
    metric: 'tokens',
    unit: 'tokens',
    version: 1,
    value: 5000,
    basis: 'planner_estimate',
    revisionId: 'rv_1',
    revisionNumber: 3,
    frozenAt: '2026-03-01T10:00:00.000Z',
    status: 'pinned',
    ...overrides
  }
}

function planned(state: PlannedBudgetView['state']): PlannedBudgetView {
  return { metric: 'tokens', unit: 'tokens', state, applied: null, versions: [], draft: null }
}

describe('DM-183 c3: versions show the one frozen at dispatch and later ones only as prospective', () => {
  const at = localTime('2026-03-01T10:00:00.000Z')

  it('the pinned version of a dispatched ticket is the frozen one its grade uses', () => {
    expect(versionText(version({}), planned('frozen'))).toBe(`v1 · 5,000 tokens · The planner’s estimate · saved in revision 3 at ${at} · frozen at this run’s dispatch: the one its grade uses`)
  })

  it('a later version is prospective, never applied to a grade already read', () => {
    expect(versionText(version({ version: 2, status: 'prospective', basis: null }), planned('frozen'))).toBe(
      `v2 · 5,000 tokens · basis not stated · saved in revision 3 at ${at} · prospective: applies only to later dispatches, never to a grade already read`
    )
  })

  it('a superseded, a not yet dispatched and a cleared version say where they stand', () => {
    expect(versionText(version({ status: 'superseded' }), planned('frozen'))).toBe(`v1 · 5,000 tokens · The planner’s estimate · saved in revision 3 at ${at} · an earlier version`)
    expect(versionText(version({}), planned('planned'))).toBe(`v1 · 5,000 tokens · The planner’s estimate · saved in revision 3 at ${at} · applies when the ticket is dispatched`)
    expect(versionText(version({ value: null }), planned('none'))).toBe(`v1 · cleared · saved in revision 3 at ${at} · in effect, but sets no usable budget`)
  })

  it('a time version is shown as a duration', () => {
    expect(versionText(version({ unit: 'milliseconds', metric: 'active_ms', value: 90_000 }), planned('planned'))).toBe(
      `v1 · 1 min 30 s · The planner’s estimate · saved in revision 3 at ${at} · applies when the ticket is dispatched`
    )
  })
})
