// DM-177 (pinned by DM-269): the pure grade calculator on the rubric's checked-in worked examples.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contentHash } from '../canonical'
import { DomainError } from '../errors'
import type { SpaceComponent, SpaceComponentResult, SpaceGrade, SpaceGradeInput, SpacePolicy } from '../../shared/domain/space'
import { parseGrade } from './contract'
import { displayScore, gradeSpace, letterFor, SPACE_POLICY_V1, SPACE_POLICY_V2 } from './rubric'

interface RubricFixture {
  input: SpaceGradeInput
  expected: SpaceGrade
}

type Example = 'complete' | 'sparse' | 'too-sparse' | 'failure' | 'unverified'

const readFixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/rubric/${name}.json`, import.meta.url), 'utf8')) as T
const rubric = (name: Example): RubricFixture => readFixture<RubricFixture>(name)
const boundaryCases = (): (RubricFixture & { name: string })[] => readFixture<{ cases: (RubricFixture & { name: string })[] }>('boundaries').cases

/** A fresh copy of a worked example's input with `mutate` applied. */
function variant(name: Example, mutate: (input: SpaceGradeInput) => void = () => undefined): SpaceGradeInput {
  const input = structuredClone(rubric(name).input)
  mutate(input)
  return input
}

function component(grade: SpaceGrade, name: SpaceComponent): SpaceComponentResult {
  const found = grade.components.find((item) => item.component === name)
  if (found === undefined) throw new Error(`no component ${name}`)
  return found
}

/** The DomainError code `run` throws, or 'accepted' when it returns. */
function refusal(run: () => unknown): string {
  try {
    run()
    return 'accepted'
  } catch (error) {
    return error instanceof DomainError ? error.code : `not a DomainError: ${String(error)}`
  }
}

const weights = (grade: SpaceGrade): Record<string, number> => Object.fromEntries(grade.components.map((c) => [c.component, c.effectiveWeight]))

describe('DM-177 c1: exact band boundaries and display rounding', () => {
  it.each([
    [89.99, 'B', '89.9'],
    [90, 'A', '90.0'],
    [79.99, 'C', '79.9'],
    [80, 'B', '80.0'],
    [69.99, 'D', '69.9'],
    [70, 'C', '70.0'],
    [59.99, 'F', '59.9'],
    [60, 'D', '60.0']
  ])('letterFor/displayScore: %d is %s and shows "%s"', (points, letter, shown) => {
    expect(letterFor(points, SPACE_POLICY_V1)).toBe(letter)
    expect(displayScore(points, SPACE_POLICY_V1)).toBe(shown)
  })

  it('compares bands at 6 canonical decimals rounded half up, and displays one decimal rounded down', () => {
    expect(letterFor(89.9999995)).toBe('A')
    expect(letterFor(89.9999994)).toBe('B')
    expect(displayScore(89.999999)).toBe('89.9')
    expect(displayScore(89.9999995)).toBe('90.0')
    expect(() => letterFor(100.5)).toThrow(RangeError)
    expect(() => displayScore(-1)).toThrow(RangeError)
  })

  it.each([
    ['at-90', 90, 'A', '90.0'],
    ['below-90', 89.999999, 'B', '89.9'],
    ['at-80', 80, 'B', '80.0'],
    ['below-80', 79.999999, 'C', '79.9'],
    ['at-70', 70, 'C', '70.0'],
    ['below-70', 69.999999, 'D', '69.9'],
    ['at-60', 60, 'D', '60.0'],
    ['below-60', 59.999999, 'F', '59.9']
  ])('boundaries.json %s: a composite of real inputs grades %d %s "%s", final', (name, score, letter, shown) => {
    const entry = boundaryCases().find((item) => item.name === name)
    if (entry === undefined) throw new Error(`no case ${name}`)
    const graded = gradeSpace(entry.input, SPACE_POLICY_V1)
    expect(graded.score).toBe(score)
    expect(graded.letter).toBe(letter)
    expect(graded.displayScore).toBe(shown)
    expect(graded.status).toBe('final')
    expect(graded.explanation.rounding).toEqual({ canonicalDecimals: 6, canonical: 'half_up', displayDecimals: 1, display: 'floor' })
  })
})

describe('DM-177 c1: canonical rounding and seven equal base weights', () => {
  it('rounds component and composite scores half up at 6 decimals (sparse: A 2 of 3, composite 79.166667 C)', () => {
    const sparse = gradeSpace(rubric('sparse').input, SPACE_POLICY_V1)
    expect(component(sparse, 'A').score).toBe(66.666667)
    expect(sparse.score).toBe(79.166667)
    expect(sparse.displayScore).toBe('79.1')
    expect(sparse.letter).toBe('C')
  })

  it('weighs the seven components equally: complete.json is the plain mean 597.5 ÷ 7 = 85.357143 B', () => {
    expect(SPACE_POLICY_V2.components.map((c) => `${c.component}${c.weight}`).join(' ')).toBe('S1 P1 A1 C1 E1 T1 K1')
    const complete = gradeSpace(rubric('complete').input, SPACE_POLICY_V1)
    expect(complete.components.map((c) => c.baseWeight)).toEqual(Array(7).fill(1 / 7))
    expect(Object.values(weights(complete))).toEqual(Array(7).fill(1 / 7))
    expect(complete.score).toBe(85.357143)
    expect(complete.letter).toBe('B')
    expect(complete.explanation.composite).toBe('(S 75 + P 95 + A 100 + C 75 + E 70 + T 90 + K 92.5) ÷ 7 = 85.357143')
  })

  it('moves the composite by exactly 1/7 of a change in any one component (T 90 → 100 adds 1.428571)', () => {
    const faster = gradeSpace(
      variant('complete', (i) => (i.components.T.actual = { state: 'observed', value: 3_600_000 })),
      SPACE_POLICY_V1
    )
    expect(component(faster, 'T').score).toBe(100)
    expect(faster.score).toBe(86.785714)
  })
})

describe('DM-177 c1: invalid input is refused', () => {
  it.each<[string, (input: SpaceGradeInput) => void]>([
    ['a rating of 6', (i) => i.components.S.ticketRating !== null && (i.components.S.ticketRating.value = 6)],
    ['delivered above committed', (i) => (i.components.A.delivered = 5)],
    ['a NaN actual', (i) => (i.components.T.actual = { state: 'observed', value: Number.NaN })],
    ['a negative actual', (i) => (i.components.K.actual = { state: 'observed', value: -1 })],
    ['a cutoff that is not a time', (i) => (i.cutoff = 'yesterday')],
    ['a run id as a ticket subject', (i) => (i.subject = { level: 'ticket', id: 'rn_01m7gdve7p0000000000000001' })],
    ['a worker-supplied overall grade', (i) => Object.assign(i, { grade: { score: 100, letter: 'A' } })],
    ['a missing component', (i) => delete (i.components as Partial<SpaceGradeInput['components']>).E]
  ])('refuses %s with invalid_input', (_label, mutate) => {
    expect(refusal(() => gradeSpace(variant('complete', mutate)))).toBe('invalid_input')
  })

  it.each<[string, (policy: SpacePolicy) => SpacePolicy]>([
    ['weights one component 0', (p) => ({ ...p, components: p.components.map((c, i) => (i === 0 ? { ...c, weight: 0 } : c)) })],
    ['puts the failure ceiling outside F', (p) => ({ ...p, mandatoryFailureCeiling: 65 })],
    ['names a C rule the grader does not implement', (p) => ({ ...p, components: p.components.map((c) => (c.component === 'C' ? { ...c, rule: 'C.handoff-pass-rate.v9' } : c)) })]
  ])('refuses a policy that %s with invalid_input', (_label, change) => {
    expect(refusal(() => gradeSpace(rubric('complete').input, change(structuredClone(SPACE_POLICY_V2))))).toBe('invalid_input')
  })
})

describe('DM-177 c1: identical reproduction under the same sources and policy', () => {
  it.each<Example>(['complete', 'sparse', 'too-sparse', 'failure', 'unverified'])('%s.json regrades byte for byte to its checked-in expected grade', (name) => {
    const { input, expected } = rubric(name)
    expect(JSON.stringify(gradeSpace(structuredClone(input), SPACE_POLICY_V1))).toBe(JSON.stringify(expected))
  })

  it('hashes the input by content: key order is ignored, a changed source changes the hash', () => {
    const { input, expected } = rubric('complete')
    const reordered: SpaceGradeInput = { components: input.components, dispatchedAt: input.dispatchedAt, cutoff: input.cutoff, subject: input.subject }
    expect(gradeSpace(reordered, SPACE_POLICY_V1).inputHash).toBe(expected.inputHash)
    const later = variant('complete', (i) => (i.components.K.actual = { state: 'observed', value: 230_001 }))
    expect(gradeSpace(later, SPACE_POLICY_V1).inputHash).not.toBe(expected.inputHash)
  })

  it('names the policy by id, version and content hash, so the same version with other content is distinguishable', () => {
    const complete = gradeSpace(rubric('complete').input, SPACE_POLICY_V1)
    expect(complete.policy).toEqual({ policyId: 'dm-space', version: 1, hash: rubric('complete').expected.policy.hash })
    const tweaked = gradeSpace(rubric('complete').input, { ...structuredClone(SPACE_POLICY_V1), coordinationDefectPenalty: 20 })
    expect(tweaked.policy.version).toBe(1)
    expect(tweaked.policy.hash).not.toBe(complete.policy.hash)
    expect(complete.policy.hash).toBe(contentHash(readFixture<unknown>('../policy-v1')))
  })
})

describe('DM-177 c2: a confirmed mandatory failure caps the grade at F', () => {
  it('failure.json: P 0, uncapped 79.166667 kept visible, capped to 59 F with the cap explained', () => {
    const failure = gradeSpace(rubric('failure').input, SPACE_POLICY_V1)
    expect(component(failure, 'P').score).toBe(0)
    expect(failure.uncappedScore).toBe(79.166667)
    expect(failure.score).toBe(59)
    expect(failure.letter).toBe('F')
    expect(failure.outcome).toBe('failed')
    expect(failure.caps).toEqual([{ kind: 'mandatory_failure', ceiling: 59, letter: 'F', evidence: rubric('failure').input.components.P.verification.evidence }])
    expect(failure.explanation.cap).toBe('confirmed mandatory failure: min(79.166667, 59) = 59')
  })

  it('a failure at 1 ms, 1 token and a 5-star rating still grades 59 F (uncapped 82.142857)', () => {
    const cheapest = gradeSpace(
      variant('failure', (i) => {
        i.components.T.actual = { state: 'observed', value: 1 }
        i.components.K.actual = { state: 'observed', value: 1 }
        i.components.S.ticketRating = { observationId: 'mo_01m7gf00000000000000000099', source: 'human', value: 5 }
      })
    )
    expect(component(cheapest, 'T').score).toBe(100)
    expect(component(cheapest, 'K').score).toBe(100)
    expect(cheapest.uncappedScore).toBe(82.142857)
    expect(cheapest.score).toBe(59)
    expect(cheapest.letter).toBe('F')
  })

  it('a failure already below the ceiling keeps its lower score', () => {
    const low = gradeSpace(
      variant('failure', (i) => {
        i.components.A.delivered = 0
        i.components.C.handoffChecks = { passed: 0, failed: 1 }
      }),
      SPACE_POLICY_V1
    )
    expect(low.score).toBe(low.uncappedScore)
    expect(low.score).toBeLessThan(59)
    expect(low.letter).toBe('F')
  })
})

describe('DM-177 c2: missing required verification stays ungraded', () => {
  it.each(['missing', 'pending'] as const)('verification %s at 1 ms and 1 token is ungraded: no score, no letter', (state) => {
    const graded = gradeSpace(
      variant('unverified', (i) => {
        i.components.P.verification.state = state
        i.components.T.actual = { state: 'observed', value: 1 }
        i.components.K.actual = { state: 'observed', value: 1 }
      })
    )
    expect(component(graded, 'T').score).toBe(100)
    expect(component(graded, 'K').score).toBe(100)
    expect(graded.status).toBe('ungraded')
    expect(graded.score).toBeNull()
    expect(graded.letter).toBeNull()
    expect(graded.displayScore).toBeNull()
    expect(graded.statusReasons).toContain(`verification_${state}`)
  })
})

describe('DM-177 c3: sparse examples are provisional or ungraded', () => {
  it('sparse.json is provisional with E, T, K missing, S P A C weighted 1/4 each and coverage 4/7', () => {
    const sparse = gradeSpace(rubric('sparse').input, SPACE_POLICY_V1)
    expect(sparse.status).toBe('provisional')
    expect(sparse.statusReasons).toEqual(['required_component_missing'])
    expect(sparse.explanation.missing).toEqual([
      { component: 'E', reason: 'not_reported' },
      { component: 'T', reason: 'no_eligible_baseline' },
      { component: 'K', reason: 'host_unavailable' }
    ])
    expect(weights(sparse)).toEqual({ S: 0.25, P: 0.25, A: 0.25, C: 0.25, E: 0, T: 0, K: 0 })
    expect(sparse.coverage).toBe(4 / 7)
  })

  it('too-sparse.json (1 of 7 scored) is ungraded for insufficient coverage with six missing factors', () => {
    const tooSparse = gradeSpace(rubric('too-sparse').input, SPACE_POLICY_V1)
    expect(tooSparse.status).toBe('ungraded')
    expect(tooSparse.statusReasons).toContain('insufficient_coverage')
    expect(tooSparse.score).toBeNull()
    expect(tooSparse.letter).toBeNull()
    expect(tooSparse.coverage).toBe(1 / 7)
    expect(tooSparse.explanation.missing).toHaveLength(6)
  })
})

// complete.json scores S 75, P 95, A 100, C 75, E 70, T 90, K 92.5; the expected score is the mean of the other six.
describe('DM-177 c3: one unknown input on complete.json is missing, never 0 or 100', () => {
  interface UnknownCase {
    label: string
    name: SpaceComponent
    reason: string
    score: number
    mutate: (input: SpaceGradeInput) => void
  }
  it.each<UnknownCase>([
    { label: 'corrective effort not reported', name: 'E', reason: 'not_reported', score: 87.916667, mutate: (i) => (i.components.E.correctiveMs = { state: 'missing', reason: 'not_reported' }) },
    { label: 'active time of 0 ms', name: 'T', reason: 'zero_observation', score: 84.583333, mutate: (i) => (i.components.T.actual = { state: 'observed', value: 0 }) },
    { label: 'an attempt reported no tokens', name: 'K', reason: 'partial_telemetry', score: 84.166667, mutate: (i) => (i.components.K.unreportedAttempts = 1) },
    { label: 'a host thread still open', name: 'T', reason: 'partial_coverage', score: 84.583333, mutate: (i) => (i.components.T.actual = { state: 'missing', reason: 'partial_coverage' }) },
    { label: 'no eligible token baseline', name: 'K', reason: 'no_eligible_baseline', score: 84.166667, mutate: (i) => (i.components.K.baseline = { state: 'missing', reason: 'no_eligible_baseline', rejected: [] }) },
    { label: 'no frozen scope', name: 'A', reason: 'scope_not_frozen', score: 82.916667, mutate: (i) => (i.components.A.committed = null) },
    { label: 'zero committed scope', name: 'A', reason: 'zero_scope', score: 82.916667, mutate: (i) => ((i.components.A.committed = 0), (i.components.A.delivered = 0)) },
    { label: 'handoff checks unavailable', name: 'C', reason: 'not_reported', score: 87.083333, mutate: (i) => (i.components.C.handoffChecks = null) },
    { label: 'no handoff checked', name: 'C', reason: 'no_handoffs', score: 87.083333, mutate: (i) => (i.components.C.handoffChecks = { passed: 0, failed: 0 }) }
  ])('$label: $name missing ($reason) with weight 0, provisional at $score', ({ name, reason, score, mutate }) => {
    const graded = gradeSpace(variant('complete', mutate), SPACE_POLICY_V1)
    const missingOne = component(graded, name)
    expect(missingOne.state).toBe('missing')
    expect(missingOne.score).toBeNull()
    expect(missingOne.missingReason).toBe(reason)
    expect(missingOne.effectiveWeight).toBe(0)
    expect(graded.status).toBe('provisional')
    expect(graded.explanation.missing).toEqual([{ component: name, reason }])
    expect(graded.score).toBe(score)
  })
})

describe('DM-177 c3: estimated and optional inputs', () => {
  it('an estimated input keeps its score but makes the grade provisional', () => {
    const graded = gradeSpace(variant('complete', (i) => (i.components.T.actual = { state: 'estimated', value: 4_320_000, method: 'span sum' })), SPACE_POLICY_V1)
    expect(component(graded, 'T').state).toBe('estimated')
    expect(component(graded, 'T').score).toBe(90)
    expect(graded.status).toBe('provisional')
    expect(graded.statusReasons).toEqual(['estimated_input'])
  })

  it('S is optional: without a rating it weighs 0, the others 1/6, and the grade stays final', () => {
    const graded = gradeSpace(variant('complete', (i) => (i.components.S = { ticketRating: null, sprintRating: null })), SPACE_POLICY_V1)
    expect(graded.status).toBe('final')
    expect(weights(graded)).toEqual({ S: 0, P: 1 / 6, A: 1 / 6, C: 1 / 6, E: 1 / 6, T: 1 / 6, K: 1 / 6 })
    expect(graded.coverage).toBe(6 / 7)
    expect(graded.score).toBe(87.083333)
  })
})

describe('DM-177 c4: explanations carry evidence, cutoff, normalization, baseline and caps', () => {
  it('every component of complete.json names its rule, the cutoff, a numeric normalization and evidence ids', () => {
    const complete = gradeSpace(rubric('complete').input, SPACE_POLICY_V1)
    for (const c of complete.components) {
      expect(c.rule).toMatch(new RegExp(`^${c.component}\\.`))
      expect(c.explanation.cutoff).toBe(complete.cutoff)
      expect(c.explanation.normalization).toMatch(/\d/)
      expect(c.evidence.length).toBeGreaterThan(0)
    }
    expect(component(complete, 'A').explanation.normalization).toBe(
      '100 × 4 delivered ÷ 4 committed = 100; 1 added and 0 removed item(s), attempts, commits and changed lines are shown, never scored'
    )
    expect(complete.explanation.letter).toBe('85.357143 ≥ 80 → B')
  })

  it('the result cites every evidence id its components cite, and both baselines', () => {
    const complete = gradeSpace(rubric('complete').input, SPACE_POLICY_V1)
    const cited = new Set(complete.explanation.evidence.map((ref) => `${ref.kind}:${ref.id}`))
    for (const ref of complete.components.flatMap((c) => c.evidence)) expect(cited).toContain(`${ref.kind}:${ref.id}`)
    expect(complete.baselineIds).toHaveLength(2)
    for (const id of complete.baselineIds) expect(cited).toContain(`baseline:${id}`)
  })

  it('T names the budget it compared against, frozen before dispatch and not refused', () => {
    const complete = gradeSpace(rubric('complete').input, SPACE_POLICY_V1)
    expect(component(complete, 'T').explanation.baseline).toMatchObject({ baselineId: 'bl_01m7g000000000000000000003', kind: 'budget', value: 3_600_000, version: 1, frozenAt: '2026-10-31T12:00:00.000Z', refusedReason: null })
    expect(component(complete, 'K').explanation.baseline?.baselineId).toBe(complete.baselineIds[1])
  })

  it('only P carries the applied cap on failure.json', () => {
    const failure = gradeSpace(rubric('failure').input, SPACE_POLICY_V1)
    expect(failure.components.map((c) => `${c.component}:${c.explanation.caps.join()}`).join(' ')).toBe('S: P:mandatory_failure A: C: E: T: K:')
  })
})

describe('DM-177 c4: refused baselines are explained', () => {
  it('refuses a budget frozen after dispatch and a cohort containing the graded ticket, showing why', () => {
    const late = variant('complete', (i) => {
      if (i.components.K.baseline.state === 'selected') i.components.K.baseline.baseline.frozenAt = '2026-11-01T12:00:00.000Z'
    })
    const lateK = component(gradeSpace(late), 'K')
    expect(lateK.missingReason).toBe('no_eligible_baseline')
    expect(lateK.explanation.baseline?.refusedReason).toBe('frozen_after_dispatch')
    const cohort = rubric('sparse').input.components.K.baseline
    const own = variant('complete', (i) => {
      if (cohort.state === 'selected' && cohort.baseline.kind === 'cohort') {
        i.components.K.baseline = { state: 'selected', baseline: { ...cohort.baseline, memberTicketIds: [i.subject.id] }, rejected: [] }
      }
    })
    const ownK = component(gradeSpace(own), 'K')
    expect(ownK.missingReason).toBe('no_eligible_baseline')
    expect(ownK.explanation.baseline?.refusedReason).toBe('contains_subject')
  })
})

describe('DM-177 c4: activity volume alone never raises a grade', () => {
  it('100 attempts, 4,000 commits, 900,000 changed lines, 50 added items and 40 retries leave the grade unchanged', () => {
    const busy = gradeSpace(
      variant('complete', (i) => {
        i.components.A.activity = { attempts: 100, commits: 4_000, changedLines: 900_000 }
        i.components.A.added = 50
        i.components.E.retries = 40
      }),
      SPACE_POLICY_V1
    )
    expect(busy.score).toBe(85.357143)
    expect(busy.letter).toBe('B')
  })

  it('twice the active time and tokens for the same outcome lowers the grade', () => {
    const longer = gradeSpace(
      variant('complete', (i) => {
        i.components.T.actual = { state: 'observed', value: 8_640_000 }
        i.components.K.actual = { state: 'observed', value: 460_000 }
      }),
      SPACE_POLICY_V1
    )
    expect(longer.score).toBeLessThan(85.357143)
  })

  it('policy v2 counts a rejected submission’s passed checks as failed: an extra rejected submission lowers C instead of diluting it', () => {
    const extraRejected = variant('complete', (i) => {
      i.components.C.handoffChecks = { passed: 6, failed: 1 }
      i.components.C.rejected = { submissions: 1, passedChecks: 3 }
    })
    const v2 = gradeSpace(extraRejected, SPACE_POLICY_V2)
    expect(component(v2, 'C').score).toBe(42.857143)
    expect(component(v2, 'C').explanation.normalization).toContain('1 rejected submission(s): their 3 passed check(s) count failed')
    expect(v2.score).toBeLessThan(gradeSpace(rubric('complete').input, SPACE_POLICY_V2).score ?? 0)
    // Version 1 is kept for reproduction of old grades: it reads the same input as 6 of 7 passed.
    expect(component(gradeSpace(extraRejected, SPACE_POLICY_V1), 'C').score).toBe(85.714286)
  })

  it('a P explanation with 1,000 attributed regressions lists 12 terms then "… and 988 more", and parseGrade accepts the grade', () => {
    const regressions = Array.from({ length: 1_000 }, (_, n) => ({
      observationId: `mo_01m7gh${String(n).padStart(20, '0')}`,
      severity: 'low' as const,
      attribution: 'attributed' as const
    }))
    const graded = gradeSpace(variant('complete', (i) => (i.components.P.regressions = regressions)))
    expect(component(graded, 'P').explanation.normalization).toBe(`verified: 100 − (${Array(12).fill('low 5').join(' + ')} + … and 988 more) = 0 (-4900 clamped to 0–100)`)
    expect(parseGrade(graded)).toEqual(graded)
  })
})
