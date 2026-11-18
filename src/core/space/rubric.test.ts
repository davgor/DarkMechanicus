import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Baseline, SpaceGrade, SpaceGradeInput } from '../../shared/domain/space'
import { DomainError } from '../errors'
import { parseGrade } from './contract'
import { displayScore, gradeSpace, letterFor, SPACE_POLICY_V1 } from './rubric'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const readJson = <T>(name: string): T => JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as T
const RUBRIC_EXAMPLES = ['complete', 'sparse', 'too-sparse', 'failure', 'unverified'] as const
type Example = (typeof RUBRIC_EXAMPLES)[number]
const fixture = (name: Example) => readJson<{ input: SpaceGradeInput; expected: SpaceGrade }>(`rubric/${name}.json`)
const input = (name: Example): SpaceGradeInput => fixture(name).input
const candidates = () => readJson<{ candidates: Baseline[] }>('baselines.json').candidates
const component = (grade: SpaceGrade, letter: string) => grade.components.find((c) => c.component === letter)!
const scores = (grade: SpaceGrade) => Object.fromEntries(grade.components.map((c) => [c.component, c.score]))
const weights = (grade: SpaceGrade) => Object.fromEntries(grade.components.map((c) => [c.component, c.effectiveWeight]))
const selected = (baseline: Baseline) => ({ state: 'selected' as const, baseline, rejected: [] })

/** A comparable token cohort of a single sample: below policy v1's minimum of five. */
const ONE_SAMPLE_COHORT: Baseline = {
  baselineId: 'bl_01m7g000000000000000000084',
  kind: 'cohort',
  metric: 'tokens',
  unit: 'tokens',
  cohort: { workType: 'architecture', size: 'medium', risk: 'multi_step' },
  statistic: 'median',
  value: 200_000,
  sampleSize: 1,
  spread: null,
  memberTicketIds: [],
  version: 1,
  frozenAt: '2026-10-15T00:00:00.000Z'
}

function thrownCode(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error)
  }
  return 'accepted'
}

describe('DM-169 c2: policy v1 weights and bands', () => {
  it('has seven components S P A C E T K with base weight 1 each and bands A90 B80 C70 D60 F0', () => {
    expect(SPACE_POLICY_V1.components.map((c) => `${c.component}${c.weight}`).join(' ')).toBe('S1 P1 A1 C1 E1 T1 K1')
    expect(SPACE_POLICY_V1.bands.map((b) => `${b.letter}${b.min}`).join(' ')).toBe('A90 B80 C70 D60 F0')
  })

  it.each([
    [89.999999, 'B'],
    [90, 'A'],
    [79.999999, 'C'],
    [80, 'B'],
    [69.999999, 'D'],
    [70, 'C'],
    [59.999999, 'F'],
    [60, 'D'],
    [0, 'F'],
    [100, 'A']
  ])('letterFor(%d) is %s at canonical precision', (points, letter) => {
    expect(letterFor(points)).toBe(letter)
  })

  it('refuses scores outside 0-100 points and non-finite display input', () => {
    expect(thrownCode(() => letterFor(90_000_000))).not.toBe('accepted')
    expect(thrownCode(() => letterFor(-0.5))).not.toBe('accepted')
    expect(thrownCode(() => displayScore(Number.NaN))).not.toBe('accepted')
  })

  it.each([
    [95, '95.0', 'A'],
    [89.99, '89.9', 'B'],
    [89.96, '89.9', 'B'],
    [90, '90.0', 'A'],
    [59.999999, '59.9', 'F']
  ])('display rounds %d down to "%s" after banding (%s), never across a band', (points, shown, letter) => {
    expect(displayScore(points)).toBe(shown)
    expect(letterFor(points)).toBe(letter)
  })
})

describe('DM-169 c2: worked examples regrade byte for byte', () => {
  it.each(RUBRIC_EXAMPLES)('%s: gradeSpace(input, v1) serializes to the checked-in expected grade', (name) => {
    const { input: value, expected } = fixture(name)
    expect(JSON.stringify(gradeSpace(value, SPACE_POLICY_V1))).toBe(JSON.stringify(expected))
  })

  it('complete: (75+95+100+75+70+90+92.5)/7 = 85.357143, shown "85.3", B final with equal 1/7 weights', () => {
    const grade = gradeSpace(input('complete'))
    expect(scores(grade)).toEqual({ S: 75, P: 95, A: 100, C: 75, E: 70, T: 90, K: 92.5 })
    expect([grade.score, grade.displayScore, grade.letter, grade.status]).toEqual([85.357143, '85.3', 'B', 'final'])
    for (const c of grade.components) {
      expect(c.baseWeight).toBe(1 / 7)
      expect(c.effectiveWeight).toBe(1 / 7)
    }
  })

  it('failure: uncapped 475/6 = 79.166667 is capped to 59, shown "59.0" F', () => {
    const grade = gradeSpace(input('failure'))
    expect([grade.uncappedScore, grade.score, grade.displayScore, grade.letter]).toEqual([79.166667, 59, '59.0', 'F'])
  })

  it('activity volume is diagnostic: 50x the commits and lines leaves the score unchanged', () => {
    const busy = input('complete')
    busy.components.A.activity = { attempts: 100, commits: 300, changedLines: 21_000 }
    expect(gradeSpace(busy).score).toBe(85.357143)
  })

  it('the grader never emits a grade its own schema refuses, even at extreme ratios', () => {
    const extreme = input('complete')
    if (extreme.components.K.baseline.state === 'selected') extreme.components.K.baseline.baseline.value = 1
    extreme.components.K.actual = { state: 'observed', value: 1e15 }
    const grade = gradeSpace(extreme)
    expect(parseGrade(grade)).toEqual(grade)
    expect(component(grade, 'K').score).toBe(0)
  })

  it('a selected baseline of value 0 is refused rather than producing an infinite ratio', () => {
    const zero = input('complete')
    if (zero.components.K.baseline.state === 'selected') zero.components.K.baseline.baseline.value = 0
    expect(thrownCode(() => gradeSpace(zero))).toBe('invalid_input')
  })
})

describe('DM-169 c3: missing verification is Ungraded and a confirmed failure caps at F', () => {
  it('missing required verification is ungraded with no score or letter, even with every other factor at 100', () => {
    const grade = gradeSpace(input('unverified'))
    expect([grade.status, grade.score, grade.letter]).toEqual(['ungraded', null, null])
    expect(grade.statusReasons).toContain('verification_missing')
  })

  it('pending verification is ungraded (verification_pending)', () => {
    const pending = input('unverified')
    pending.components.P.verification = { state: 'pending', evidence: [] }
    const grade = gradeSpace(pending)
    expect([grade.status, grade.letter]).toEqual(['ungraded', null])
    expect(grade.statusReasons).toContain('verification_pending')
  })

  it('a confirmed failure caps at F even when every other component scores 100', () => {
    const perfect = input('failure')
    perfect.components.S.ticketRating = { observationId: 'mo_01m7gf00000000000000000030', source: 'human', value: 5 }
    perfect.components.A.delivered = 4
    const grade = gradeSpace(perfect)
    expect([grade.outcome, grade.score, grade.letter]).toEqual(['failed', 59, 'F'])
    expect(grade.caps.map((cap) => cap.kind)).toEqual(['mandatory_failure'])
    expect(grade.uncappedScore).toBeGreaterThan(59)
  })

  it('a confirmed failure on sparse data is a provisional F, never ungraded', () => {
    const sparse = input('too-sparse')
    sparse.components.P.verification = { state: 'failed', evidence: [{ kind: 'check', id: 'at_01m7ge55kx0000000000000002', detail: 'npm test' }] }
    const grade = gradeSpace(sparse)
    expect([grade.status, grade.letter]).toEqual(['provisional', 'F'])
  })
})

describe('DM-169 c3: incomplete other factors are Provisional or Ungraded, never imputed success', () => {
  it('sparse: missing E T K score null with weight 0, scored ones 1/4, coverage 4/7, provisional at 79.166667', () => {
    const grade = gradeSpace(input('sparse'))
    expect(scores(grade)).toEqual({ S: 50, P: 100, A: 66.666667, C: 100, E: null, T: null, K: null })
    expect(weights(grade)).toEqual({ S: 0.25, P: 0.25, A: 0.25, C: 0.25, E: 0, T: 0, K: 0 })
    expect([grade.status, grade.score, grade.coverage]).toEqual(['provisional', 79.166667, 4 / 7])
    expect(grade.statusReasons).toContain('required_component_missing')
  })

  it('one scored component of seven is ungraded (insufficient_coverage)', () => {
    const grade = gradeSpace(input('too-sparse'))
    expect([grade.status, grade.score, grade.scoredComponents]).toEqual(['ungraded', null, 1])
    expect(grade.statusReasons).toContain('insufficient_coverage')
  })

  it('an estimated token total keeps the grade provisional and K labeled estimated', () => {
    const estimated = input('complete')
    estimated.components.K.actual = { state: 'estimated', value: 230_000, method: 'characters divided by 4' }
    const grade = gradeSpace(estimated)
    expect(grade.status).toBe('provisional')
    expect(grade.statusReasons).toContain('estimated_input')
    expect(component(grade, 'K').state).toBe('estimated')
  })

  it('S is optional: without a rating the grade stays final with S at weight 0 and the others at 1/6', () => {
    const unrated = input('complete')
    unrated.components.S = { ticketRating: null, sprintRating: null }
    const grade = gradeSpace(unrated)
    expect(grade.status).toBe('final')
    expect(weights(grade)).toEqual({ S: 0, P: 1 / 6, A: 1 / 6, C: 1 / 6, E: 1 / 6, T: 1 / 6, K: 1 / 6 })
  })

  it('an unshared sprint rating is not inherited by the ticket', () => {
    const unshared = input('sparse')
    unshared.components.S.sprintRating!.sharedWithTickets = false
    expect(component(gradeSpace(unshared), 'S').missingReason).toBe('no_rating')
  })

  it('the sprint rating scores S directly at sprint level and is labeled inherited at run level', () => {
    const sprint = input('sparse')
    sprint.subject = { level: 'sprint', id: 'sp_01m452vt120000000000000001' }
    expect(component(gradeSpace(sprint), 'S')).toMatchObject({ score: 50, inherited: false })
    const run = input('sparse')
    run.subject = { level: 'run', id: 'rn_01m7gdve7p0000000000000001' }
    expect(component(gradeSpace(run), 'S')).toMatchObject({ score: 50, inherited: true })
  })

  it('zero committed scope is missing (zero_scope), never 100', () => {
    const zero = input('complete')
    zero.components.A = { ...zero.components.A, committed: 0, delivered: 0 }
    const grade = gradeSpace(zero)
    expect(component(grade, 'A')).toMatchObject({ score: null, missingReason: 'zero_scope' })
    expect(grade.status).toBe('provisional')
  })
})

describe('DM-169 c4: the grader treats zero and partial telemetry as missing', () => {
  it('an observed zero token total is missing (zero_observation), not 100', () => {
    const zero = input('complete')
    zero.components.K.actual = { state: 'observed', value: 0 }
    expect(component(gradeSpace(zero), 'K')).toMatchObject({ score: null, missingReason: 'zero_observation' })
  })

  it('an attempt that ran without reporting makes T partial_telemetry', () => {
    const partial = input('complete')
    partial.components.T.unreportedAttempts = 1
    expect(component(gradeSpace(partial), 'T')).toMatchObject({ score: null, missingReason: 'partial_telemetry' })
  })
})

describe('DM-169 c4: the grader rechecks the baseline it is handed', () => {
  it('a budget of the wrong metric is refused for T and for K', () => {
    const [tokens, , activeMs] = candidates()
    const tokensForT = input('complete')
    tokensForT.components.T.baseline = selected(tokens!)
    expect(thrownCode(() => gradeSpace(tokensForT))).toBe('invalid_input')
    const timeForK = input('complete')
    timeForK.components.K.baseline = selected(activeMs!)
    expect(thrownCode(() => gradeSpace(timeForK))).toBe('invalid_input')
  })

  it('a mid-run budget handed in as selected is refused against the recorded dispatch time', () => {
    const midRun = input('complete')
    const raised = candidates()[1]!
    midRun.components.K.baseline = selected(raised)
    const grade = gradeSpace(midRun)
    expect(component(grade, 'K')).toMatchObject({ score: null, missingReason: 'no_eligible_baseline' })
    expect(component(grade, 'K').diagnostics.refusedReason).toBe('frozen_after_dispatch')
    expect(grade.baselineIds).not.toContain(raised.baselineId)
    expect(grade.status).toBe('provisional')
  })

  it('a budget of another ticket is refused (other_ticket)', () => {
    const other = input('complete')
    other.components.K.baseline = selected({ ...candidates()[0]!, ticketId: 'tk_01m453gpad0000000000000002' } as Baseline)
    expect(component(gradeSpace(other), 'K').diagnostics.refusedReason).toBe('other_ticket')
  })

  it('a cohort of one sample is refused (sample_too_small) and the grade is provisional', () => {
    const tiny = input('complete')
    tiny.components.K.baseline = selected(ONE_SAMPLE_COHORT)
    const grade = gradeSpace(tiny)
    expect(component(grade, 'K').diagnostics.refusedReason).toBe('sample_too_small')
    expect(grade.status).toBe('provisional')
  })

  it('with no dispatch time neither T nor K may use a baseline (invalid_time)', () => {
    const undispatched = input('complete')
    undispatched.dispatchedAt = null
    const grade = gradeSpace(undispatched)
    expect(component(grade, 'T').diagnostics.refusedReason).toBe('invalid_time')
    expect(component(grade, 'K').diagnostics.refusedReason).toBe('invalid_time')
    expect(grade.baselineIds).toEqual([])
  })
})

describe('DM-169 c3: E needs at least 80% of effort classified, never imputed', () => {
  const efficiency = (productive: number, unclassified: number) => {
    const value = input('complete')
    value.components.E = {
      ...value.components.E,
      correctiveMs: { state: 'observed', value: 0 },
      productiveMs: { state: 'observed', value: productive },
      unclassifiedMs: { state: 'observed', value: unclassified }
    }
    return component(gradeSpace(value), 'E')
  }

  it('exactly 80% classified scores E (100 with no corrective effort)', () => {
    const e = efficiency(800_000, 200_000)
    expect(e).toMatchObject({ score: 100, missingReason: null })
    expect(e.inputs.classificationCoverage).toBe(0.8)
  })

  it('just under 80% classified leaves E missing (insufficient_classification) with weight 0', () => {
    const e = efficiency(799_999, 200_001)
    expect(e).toMatchObject({ score: null, missingReason: 'insufficient_classification', effectiveWeight: 0 })
  })

  it('no classified effort is missing (zero_observation), not 100', () => {
    expect(efficiency(0, 500_000)).toMatchObject({ score: null, missingReason: 'zero_observation' })
  })
})
