import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Baseline, BaselineSelection, BaselineSubject, BudgetBaseline, CohortBaseline, RollupBaseline } from '../../shared/domain/space'
import { baselineDefect, compareCandidates, selectBaseline } from './baselines'
import { SPACE_POLICY_V1 } from './rubric'

const FIXTURE = fileURLToPath(new URL('./fixtures/baselines.json', import.meta.url))
const fixture = () =>
  JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    candidates: Baseline[]
    subjects: { name: string; subject: BaselineSubject; expect: { state: 'selected' | 'missing'; baselineId: string | null } }[]
  }
const candidates = () => fixture().candidates
const subject = (index: number): BaselineSubject => fixture().subjects[index]!.subject
const DISPATCH = '2026-11-01T10:00:00.000Z'
const bl = (n: number) => `bl_01m7g0000000000000000000${String(n).padStart(2, '0')}`
const reasons = (selection: BaselineSelection) => Object.fromEntries(selection.rejected.map((r) => [r.baselineId, r.reason]))
const chosen = (selection: BaselineSelection) => (selection.state === 'selected' ? selection.baseline.baselineId : null)

const budget = (patch: Partial<BudgetBaseline>): BudgetBaseline => ({
  baselineId: bl(99),
  kind: 'budget',
  metric: 'tokens',
  unit: 'tokens',
  ticketId: 'tk_01m453gpad0000000000000001',
  revisionId: 'rv_01m65yene30000000000000003',
  version: 3,
  value: 1_000_000,
  frozenAt: '2026-11-01T12:00:00.000Z',
  ...patch
})
const cohort = (id: string, frozenAt: string, version: number, sampleSize: number): CohortBaseline => ({
  baselineId: id,
  kind: 'cohort',
  metric: 'tokens',
  unit: 'tokens',
  cohort: { workType: 'architecture', size: 'medium', risk: 'multi_step' },
  statistic: 'median',
  value: 100_000,
  sampleSize,
  spread: null,
  memberTicketIds: [],
  version,
  frozenAt
})
const rollup = (memberFrozenAt: string, memberDispatchedAt: string): RollupBaseline => ({
  baselineId: bl(70),
  kind: 'rollup',
  metric: 'tokens',
  unit: 'tokens',
  value: 200_000,
  version: 1,
  frozenAt: '2026-10-31T12:00:00.000Z',
  members: [
    {
      runId: 'rn_01m7gdve7p0000000000000001',
      ticketId: 'tk_01m453gpad0000000000000001',
      baselineId: bl(1),
      kind: 'budget',
      value: 200_000,
      frozenAt: memberFrozenAt,
      dispatchedAt: memberDispatchedAt
    }
  ],
  uncovered: []
})

describe('DM-169 c4: fixture subjects choose the expected baseline', () => {
  it('a frozen pre-dispatch budget beats every cohort; the budget saved after dispatch is refused', () => {
    const selection = selectBaseline(candidates(), subject(0), SPACE_POLICY_V1)
    expect(chosen(selection)).toBe(bl(1))
    expect(reasons(selection)).toEqual({
      [bl(2)]: 'frozen_after_dispatch',
      [bl(3)]: 'metric_mismatch',
      [bl(4)]: 'superseded',
      [bl(5)]: 'cohort_mismatch',
      [bl(6)]: 'metric_mismatch',
      [bl(7)]: 'other_ticket',
      [bl(8)]: 'superseded'
    })
  })

  it('the time budget of the same ticket serves active_ms', () => {
    expect(chosen(selectBaseline(candidates(), subject(1), SPACE_POLICY_V1))).toBe(bl(3))
  })

  it('without a budget the latest frozen comparable cohort applies; a cohort containing the subject is refused', () => {
    const selection = selectBaseline(candidates(), subject(2), SPACE_POLICY_V1)
    expect(chosen(selection)).toBe(bl(4))
    expect(reasons(selection)[bl(8)]).toBe('contains_subject')
  })

  it('a zero budget is refused (zero_value) and the matching implementation cohort applies', () => {
    const selection = selectBaseline(candidates(), subject(3), SPACE_POLICY_V1)
    expect(chosen(selection)).toBe(bl(5))
    expect(reasons(selection)[bl(7)]).toBe('zero_value')
  })

  it('with only a too-small cohort and another ticket budget the baseline is missing, never zero', () => {
    const selection = selectBaseline(candidates(), subject(4), SPACE_POLICY_V1)
    expect(selection).toMatchObject({ state: 'missing', reason: 'no_eligible_baseline' })
    expect(selection).not.toHaveProperty('baseline')
    expect(reasons(selection)[bl(6)]).toBe('sample_too_small')
    expect(reasons(selection)[bl(3)]).toBe('other_ticket')
  })
})

describe('DM-169 c4: editing a budget cannot improve an executing assessment', () => {
  it('a raised budget frozen after dispatch is refused; the v1 budget still applies', () => {
    const selection = selectBaseline([...candidates(), budget({})], subject(0), SPACE_POLICY_V1)
    expect(chosen(selection)).toBe(bl(1))
    expect(reasons(selection)[bl(99)]).toBe('frozen_after_dispatch')
  })

  it('the edited budget applies prospectively to a dispatch after it was frozen', () => {
    const later = selectBaseline([...candidates(), budget({})], { ...subject(0), dispatchedAt: '2026-11-02T09:00:00.000Z' }, SPACE_POLICY_V1)
    expect(chosen(later)).toBe(bl(99))
  })

  it('a budget frozen exactly at dispatch is not pre-dispatch; one millisecond earlier is', () => {
    expect(reasons(selectBaseline([budget({ frozenAt: DISPATCH })], subject(0), SPACE_POLICY_V1))[bl(99)]).toBe('frozen_after_dispatch')
    expect(chosen(selectBaseline([budget({ frozenAt: '2026-11-01T09:59:59.999Z' })], subject(0), SPACE_POLICY_V1))).toBe(bl(99))
  })
})

describe('DM-169 c4: unparseable or non-ISO times fail closed', () => {
  it.each(['not-a-date', '', '9999', '2026-11-02'])('dispatchedAt %j selects nothing and refuses every budget as invalid_time', (bad) => {
    const selection = selectBaseline(candidates(), { ...subject(0), dispatchedAt: bad }, SPACE_POLICY_V1)
    expect(selection.state).toBe('missing')
    expect(reasons(selection)[bl(1)]).toBe('invalid_time')
    expect(reasons(selection)[bl(2)]).toBe('invalid_time')
  })

  it.each(['yesterday', '9999'])('a candidate frozen at %j is refused as invalid_time', (bad) => {
    const selection = selectBaseline([{ ...candidates()[0]!, frozenAt: bad }], subject(0), SPACE_POLICY_V1)
    expect(selection.state).toBe('missing')
    expect(reasons(selection)[bl(1)]).toBe('invalid_time')
  })
})

describe('DM-169 c4: cohort eligibility and ordering', () => {
  it('orders budget first, then the latest frozen version, then the larger sample, then the lower id', () => {
    const older = cohort(bl(81), '2026-10-01T00:00:00.000Z', 1, 40)
    const newer = cohort(bl(82), '2026-10-15T00:00:00.000Z', 2, 6)
    const sameTimeBigger = cohort(bl(84), '2026-10-15T00:00:00.000Z', 2, 9)
    const sameAll = cohort(bl(83), '2026-10-15T00:00:00.000Z', 2, 9)
    const sameVersionLower = cohort(bl(85), '2026-10-15T00:00:00.000Z', 1, 50)
    const ordered = [older, newer, sameVersionLower, sameTimeBigger, sameAll, candidates()[0]!].sort(compareCandidates)
    expect(ordered.map((b) => b.baselineId)).toEqual([bl(1), bl(83), bl(84), bl(82), bl(85), bl(81)])
  })

  it('candidates equal in everything but id order by id either way, and one compared with itself is a tie', () => {
    const lower = cohort(bl(83), '2026-10-15T00:00:00.000Z', 2, 9)
    const higher = cohort(bl(84), '2026-10-15T00:00:00.000Z', 2, 9)
    expect(compareCandidates(lower, higher)).toBe(-1)
    expect(compareCandidates(higher, lower)).toBe(1)
    expect(compareCandidates(higher, { ...higher })).toBe(0)
  })

  it('lists every refused and superseded candidate in id order, whatever order they came in', () => {
    const offered = [cohort(bl(86), '2026-10-15T00:00:00.000Z', 1, 4), cohort(bl(84), '2026-10-15T00:00:00.000Z', 1, 4), cohort(bl(85), '2026-10-01T00:00:00.000Z', 1, 8), cohort(bl(83), '2026-10-15T00:00:00.000Z', 1, 8)]
    const selection = selectBaseline(offered, { ...subject(0), ticketId: 'tk_01m453gpad0000000000000009' }, SPACE_POLICY_V1)
    expect(chosen(selection)).toBe(bl(83))
    expect(selection.rejected).toEqual([
      { baselineId: bl(84), reason: 'sample_too_small' },
      { baselineId: bl(85), reason: 'superseded' },
      { baselineId: bl(86), reason: 'sample_too_small' }
    ])
  })

  it('a cohort below the policy minimum of five samples is refused; five is enough', () => {
    const other = { ...subject(0), ticketId: 'tk_01m453gpad0000000000000009' }
    expect(reasons(selectBaseline([cohort(bl(83), '2026-10-15T00:00:00.000Z', 1, 4)], other, SPACE_POLICY_V1))[bl(83)]).toBe('sample_too_small')
    expect(chosen(selectBaseline([cohort(bl(83), '2026-10-15T00:00:00.000Z', 1, 5)], other, SPACE_POLICY_V1))).toBe(bl(83))
  })

  it.each([
    ['workType', { workType: 'implementation', size: 'medium', risk: 'multi_step' }],
    ['size', { workType: 'architecture', size: 'large', risk: 'multi_step' }],
    ['risk', { workType: 'architecture', size: 'medium', risk: 'simple' }]
  ])('a cohort of another %s is cohort_mismatch', (_field, key) => {
    const other = { ...subject(0), ticketId: 'tk_01m453gpad0000000000000009', cohort: key } as BaselineSubject
    expect(reasons(selectBaseline([cohort(bl(83), '2026-10-15T00:00:00.000Z', 1, 8)], other, SPACE_POLICY_V1))[bl(83)]).toBe('cohort_mismatch')
  })
})

describe('DM-169 c4: level and roll-up checks', () => {
  const runUse = (dispatchedAt: string | null) => ({ metric: 'tokens' as const, ticketId: null, dispatchedAt })

  it('a roll-up serves only a run, sprint or epic; a budget only a ticket', () => {
    const valid = rollup('2026-10-31T12:00:00.000Z', DISPATCH)
    expect(baselineDefect(valid, runUse(DISPATCH), SPACE_POLICY_V1)).toBeNull()
    expect(baselineDefect(valid, { metric: 'tokens', ticketId: 'tk_01m453gpad0000000000000001', dispatchedAt: DISPATCH }, SPACE_POLICY_V1)).toBe('level_mismatch')
    expect(baselineDefect(candidates()[0]!, runUse(DISPATCH), SPACE_POLICY_V1)).toBe('level_mismatch')
  })

  it('a roll-up member frozen at or after its own dispatch is refused', () => {
    expect(baselineDefect(rollup(DISPATCH, DISPATCH), runUse(DISPATCH), SPACE_POLICY_V1)).toBe('frozen_after_dispatch')
  })

  it('a roll-up member dispatched before the scope began, or a scope without a valid dispatch, is invalid_time', () => {
    const early = rollup('2026-10-30T12:00:00.000Z', '2026-10-31T13:00:00.000Z')
    expect(baselineDefect(early, runUse(DISPATCH), SPACE_POLICY_V1)).toBe('invalid_time')
    expect(baselineDefect(rollup('2026-10-31T12:00:00.000Z', DISPATCH), runUse(null), SPACE_POLICY_V1)).toBe('invalid_time')
    expect(baselineDefect(rollup('2026-10-31T12:00:00.000Z', DISPATCH), runUse('9999'), SPACE_POLICY_V1)).toBe('invalid_time')
  })

  it('a roll-up without members or with a zero member is zero_value', () => {
    expect(baselineDefect({ ...rollup('2026-10-31T12:00:00.000Z', DISPATCH), members: [] }, runUse(DISPATCH), SPACE_POLICY_V1)).toBe('zero_value')
    const zeroMember = rollup('2026-10-31T12:00:00.000Z', DISPATCH)
    zeroMember.members[0]!.value = 0
    expect(baselineDefect(zeroMember, runUse(DISPATCH), SPACE_POLICY_V1)).toBe('zero_value')
  })
})
