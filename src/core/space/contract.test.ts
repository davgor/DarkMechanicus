import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Baseline, BaselineSubject, MetricObservation, SpaceGrade, SpaceGradeInput } from '../../shared/domain/space'
import { DomainError } from '../errors'
import { isIsoTime, parseBaseline, parseBaselineSubject, parseGrade, parseGradeInput, parseObservation, parseSpacePolicy } from './contract'
import { SPACE_POLICY_V1 } from './rubric'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const readJson = <T>(name: string): T => JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8')) as T
const RUBRIC_EXAMPLES = ['complete', 'sparse', 'too-sparse', 'failure', 'unverified'] as const
const rubric = (name: (typeof RUBRIC_EXAMPLES)[number]) => readJson<{ input: SpaceGradeInput; expected: SpaceGrade }>(`rubric/${name}.json`)
const observations = () => readJson<{ observations: MetricObservation[] }>('observations.json').observations
const baselines = () => readJson<{ candidates: Baseline[]; subjects: { subject: BaselineSubject }[] }>('baselines.json')

/** The error a refused parse throws: always a DomainError coded invalid_input. */
function refusal(parse: () => unknown): string {
  try {
    parse()
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    return (error as DomainError).code
  }
  return 'accepted'
}

describe('DM-169 c1: checked-in fixtures parse against the contracts', () => {
  it('every observation fixture parses to itself and the set covers observed, estimated and missing', () => {
    const records = observations()
    for (const record of records) {
      expect(parseObservation(record)).toEqual(record)
      expect(record.observationId).toMatch(/^mo_[0-9a-z]{26}$/)
    }
    expect(new Set(records.map((record) => record.measurement.state))).toEqual(new Set(['observed', 'estimated', 'missing']))
  })

  it('every baseline candidate and subject parses to itself', () => {
    const { candidates, subjects } = baselines()
    for (const candidate of candidates) expect(parseBaseline(candidate)).toEqual(candidate)
    for (const { subject } of subjects) expect(parseBaselineSubject(subject)).toEqual(subject)
  })

  it('policy-v1.json is the registered policy v1', () => {
    expect(parseSpacePolicy(readJson('policy-v1.json'))).toEqual(SPACE_POLICY_V1)
  })

  it.each(RUBRIC_EXAMPLES)('rubric/%s.json input and expected grade parse unchanged', (name) => {
    const fixture = rubric(name)
    expect(parseGradeInput(fixture.input)).toEqual(fixture.input)
    expect(parseGrade(fixture.expected)).toEqual(fixture.expected)
  })
})

describe('DM-169 c1: malformed observations are refused', () => {
  const rating = () => structuredClone(observations().find((record) => record.metric === 'human_rating')!)
  const tokens = () => structuredClone(observations().find((record) => record.metric === 'tokens_input')!)

  it.each([
    ['an agent-sourced human rating', () => ({ ...rating(), source: { kind: 'agent', actor: 'worker' } })],
    ['a rating of 6', () => ({ ...rating(), measurement: { state: 'observed', value: 6 } })],
    ['negative tokens', () => ({ ...tokens(), measurement: { state: 'observed', value: -5 } })],
    ['non-finite tokens', () => ({ ...tokens(), measurement: { state: 'observed', value: Number.POSITIVE_INFINITY } })],
    ['a token count in milliseconds', () => ({ ...tokens(), unit: 'milliseconds' })],
    ['a missing value that carries a number', () => ({ ...tokens(), measurement: { state: 'missing', reason: 'not_reported', value: 0 } })],
    ['an estimate without its method', () => ({ ...tokens(), measurement: { state: 'estimated', value: 10 } })],
    ['a cumulative report without a sequence', () => ({ ...tokens(), sequence: null })],
    ['an attempt scope without its attempt id', () => ({ ...tokens(), scope: { ...tokens().scope, attemptId: null } })],
    ['a ticket id where an observation id belongs', () => ({ ...tokens(), observationId: 'tk_01m453gpad0000000000000001' })]
  ])('%s', (_label, build) => {
    expect(refusal(() => parseObservation(build()))).toBe('invalid_input')
  })

  it('a missing measurement parses without a value (unknown is never zero)', () => {
    const missing = observations().find((record) => record.measurement.state === 'missing')!
    expect(parseObservation(missing).measurement).not.toHaveProperty('value')
  })
})

describe('DM-169 c1: malformed baselines and subjects are refused', () => {
  it('a token budget measured in milliseconds is refused', () => {
    expect(refusal(() => parseBaseline({ ...baselines().candidates[0]!, unit: 'milliseconds' }))).toBe('invalid_input')
  })

  it.each(['not-a-date', '', undefined, '9999'])('a subject with dispatchedAt %j is refused', (bad) => {
    const subject = baselines().subjects[0]!.subject
    expect(refusal(() => parseBaselineSubject({ ...subject, dispatchedAt: bad }))).toBe('invalid_input')
  })

  it('isIsoTime accepts only offset ISO date-times', () => {
    expect(isIsoTime('2026-11-01T10:00:00.000Z')).toBe(true)
    expect(isIsoTime('2026-11-01T12:00:00+02:00')).toBe(true)
    expect(isIsoTime('9999')).toBe(false)
    expect(isIsoTime('2026-11-01')).toBe(false)
    expect(isIsoTime(null)).toBe(false)
  })
})

describe('DM-169 c1: malformed grade inputs, grades and policies are refused', () => {
  const graded = () => structuredClone(rubric('complete').expected)
  const input = () => structuredClone(rubric('complete').input)

  it.each([
    ['a sprint-level subject named by a ticket id', () => ({ ...input(), subject: { level: 'sprint', id: input().subject.id } })],
    ['a ticket rating on a sprint-level input', () => ({ ...input(), subject: { level: 'sprint', id: 'sp_01m452vt120000000000000001' } })],
    [
      'T selected against a tokens baseline',
      () => {
        const value = input()
        value.components.T.baseline = structuredClone(value.components.K.baseline)
        return value
      }
    ],
    [
      'a selected baseline of value 0',
      () => {
        const value = input()
        if (value.components.K.baseline.state === 'selected') value.components.K.baseline.baseline.value = 0
        return value
      }
    ]
  ])('grade input: %s', (_label, build) => {
    expect(refusal(() => parseGradeInput(build()))).toBe('invalid_input')
  })

  it.each([
    ['an ungraded grade that carries a letter', () => ({ ...rubric('unverified').expected, letter: 'A' })],
    ['a failed outcome lettered B', () => ({ ...rubric('failure').expected, letter: 'B' })],
    ['a failed outcome without its cap', () => ({ ...rubric('failure').expected, caps: [] })],
    [
      'a missing component with weight',
      () => {
        const failed = rubric('failure').expected
        return { ...failed, components: failed.components.map((c) => (c.component === 'S' ? { ...c, effectiveWeight: 0.1 } : c)) }
      }
    ],
    ['a graded record with uncappedScore null', () => ({ ...graded(), uncappedScore: null })],
    ['a final grade that names required_component_missing', () => ({ ...graded(), statusReasons: ['required_component_missing'] })],
    ['a provisional grade with no reason', () => ({ ...graded(), status: 'provisional' })],
    ['reasons out of contract order', () => ({ ...rubric('sparse').expected, statusReasons: ['estimated_input', 'required_component_missing'] })],
    ['a capped score above its uncapped score', () => ({ ...graded(), score: 90 })],
    ['an epic-level subject with a ticket id', () => ({ ...graded(), subject: { level: 'epic', id: graded().subject.id } })]
  ])('grade: %s', (_label, build) => {
    expect(refusal(() => parseGrade(build()))).toBe('invalid_input')
  })

  it('display precision above canonical precision is refused', () => {
    const policy = { ...structuredClone(SPACE_POLICY_V1), precision: { canonicalDecimals: 3, displayDecimals: 4, displayRounding: 'floor' } }
    expect(refusal(() => parseSpacePolicy(policy))).toBe('invalid_input')
  })
})
