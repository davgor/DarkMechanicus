// DM-273: grades under an unregistered policy hash, estimated effort, a partial roll-up and weighted components.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contentHash } from '../canonical'
import type { RollupBaseline, SpaceComponent, SpaceComponentResult, SpaceGrade, SpaceGradeInput } from '../../shared/domain/space'
import { gradeSpace, SPACE_POLICY_V1, SPACE_POLICY_V2, spacePolicyByHash } from './rubric'

const COMPLETE: { input: SpaceGradeInput } = JSON.parse(readFileSync(new URL('./fixtures/rubric/complete.json', import.meta.url), 'utf8'))
const input = (): SpaceGradeInput => structuredClone(COMPLETE.input)
const SPRINT = 'sp_01m452vt120000000000000001'
const tk = (n: number): string => `tk_01m453gpad000000000000000${n}`

function component(grade: SpaceGrade, name: SpaceComponent): SpaceComponentResult {
  const found = grade.components.find((item) => item.component === name)
  if (found === undefined) throw new Error(`no component ${name}`)
  return found
}

/** A sprint's token roll-up of ticket 1's budget that leaves executed ticket 2 uncovered. */
const partialRollup: RollupBaseline = {
  baselineId: 'bl_01m7g000000000000000000070',
  kind: 'rollup',
  metric: 'tokens',
  unit: 'tokens',
  value: 200_000,
  version: 1,
  frozenAt: '2026-10-31T12:00:00.000Z',
  members: [{ runId: 'rn_01m7gdve7p0000000000000001', ticketId: tk(1), baselineId: 'bl_01m7g000000000000000000001', kind: 'budget', value: 200_000, frozenAt: '2026-10-31T12:00:00.000Z', dispatchedAt: '2026-11-01T10:00:00.000Z' }],
  uncovered: [{ runId: 'rn_01m7gdve7p0000000000000001', ticketId: tk(2) }]
}

/** The complete example graded at its sprint, K compared against `partialRollup` with a K actual in `state`. */
function sprintGrade(actual: SpaceGradeInput['components']['K']['actual']): SpaceGrade {
  const value = input()
  value.subject = { level: 'sprint', id: SPRINT }
  value.components.S.ticketRating = null
  value.components.K = { ...value.components.K, actual, baseline: { state: 'selected', baseline: partialRollup, rejected: [] } }
  return gradeSpace(value, SPACE_POLICY_V1)
}

describe('DM-273: policies by content hash', () => {
  it('finds each registered policy by its hash and no policy for an unknown hash', () => {
    expect(spacePolicyByHash(contentHash(SPACE_POLICY_V2))).toBe(SPACE_POLICY_V2)
    expect(spacePolicyByHash(contentHash(SPACE_POLICY_V1))).toBe(SPACE_POLICY_V1)
    expect(spacePolicyByHash(`sha256:${'0'.repeat(64)}`)).toBeNull()
  })
})

describe('DM-273: E from estimated effort', () => {
  it('scores estimated corrective effort as estimated and says so', () => {
    const value = input()
    value.components.E.correctiveMs = { state: 'estimated', value: 900_000, method: 'worker estimate' }
    const E = component(gradeSpace(value, SPACE_POLICY_V1), 'E')
    expect(E.state).toBe('estimated')
    expect(E.score).toBe(component(gradeSpace(input(), SPACE_POLICY_V1), 'E').score)
    expect(E.explanation.normalization).toContain('ms classified; estimated; retries are shown, never scored')
  })
})

describe('DM-273: a roll-up that leaves executed work uncovered', () => {
  it('is refused against an observed actual, naming the uncovered tickets', () => {
    const K = component(sprintGrade({ state: 'observed', value: 150_000 }), 'K')
    expect(K.state).toBe('missing')
    expect(K.diagnostics).toMatchObject({ refusedBaselineId: partialRollup.baselineId, refusedReason: 'incomplete_rollup' })
    expect(K.explanation.normalization).toContain(`the grader refused ${partialRollup.baselineId}: incomplete_rollup; executed work ticket(s) without a baseline: ${tk(2)}`)
  })

  it('is compared with an estimated actual that leaves those tickets out', () => {
    const K = component(sprintGrade({ state: 'estimated', value: 150_000, method: 'covered tickets only' }), 'K')
    expect(K.state).toBe('estimated')
    expect(K.score).not.toBeNull()
    expect(K.explanation.normalization).toContain(`partial: 1 executed work ticket(s) without a baseline are left out (${tk(2)})`)
  })
})

describe('DM-273: the composite names a weight other than 1', () => {
  it('writes each weighted term with its weight', () => {
    const policy = structuredClone(SPACE_POLICY_V1)
    policy.components = policy.components.map((entry) => (entry.component === 'S' ? { ...entry, weight: 2 } : entry))
    const grade = gradeSpace(input(), policy)
    expect(grade.explanation.composite).toContain(`2 × S ${component(grade, 'S').score}`)
    expect(grade.explanation.composite).toContain(`P ${component(grade, 'P').score}`)
  })
})
