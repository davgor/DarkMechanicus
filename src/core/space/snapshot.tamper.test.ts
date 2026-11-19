// DM-273: a re-sealed golden scorecard edited in its identity, pools or policy is refused with the problem named.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import { contentHash } from '../canonical'
import { DomainError } from '../errors'
import { derivedStableId } from '../ids'
import { parseScorecardSnapshot, readScorecard, snapshotHashOf } from './snapshot'

const GOLDEN: ScorecardSnapshot = JSON.parse(readFileSync(new URL('./fixtures/snapshots/policy-v1.json', import.meta.url), 'utf8'))
const OTHER_ASSESSMENT = derivedStableId('assessment', 'another snapshot')

/** The golden snapshot with `edit` applied and sealed again, so only the edit itself can be refused. */
function resealed(edit: (snapshot: ScorecardSnapshot) => void): ScorecardSnapshot {
  const snapshot = structuredClone(GOLDEN)
  edit(snapshot)
  return { ...snapshot, snapshotHash: snapshotHashOf(snapshot) }
}

/** The message a refused import throws, or 'accepted'. */
function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof DomainError ? `${error.code}: ${error.message}` : String(error)
  }
  return 'accepted'
}

const firstInputKey = (snapshot: ScorecardSnapshot): string => snapshot.tickets[0]!.inputs.S

describe('DM-273: the snapshot identity is derived, never stated', () => {
  it.each([
    ['another snapshot id', (s: ScorecardSnapshot) => void (s.snapshotId = OTHER_ASSESSMENT), "the snapshot id is not its report revision's"],
    ['a sprint grade of another sprint', (s: ScorecardSnapshot) => void (s.sprint.subject = { level: 'sprint', id: 'sp_01m452vt12000000000000zzzz' }), 'a sprint, run or epic grade names another subject than the snapshot'],
    ['a ticket graded twice', (s: ScorecardSnapshot) => void s.tickets.push(structuredClone(s.tickets[0]!)), 'the ticket grades are not distinct tickets'],
    ['a ticket grade of a sprint', (s: ScorecardSnapshot) => void (s.tickets[0]!.subject = { level: 'sprint', id: s.sprintId }), 'the ticket grades are not distinct tickets'],
    ['a ticket grade naming no ticket id', (s: ScorecardSnapshot) => void (s.tickets[0]!.subject = { level: 'ticket', id: 'ticket-one' }), 'a ticket grade names no ticket id'],
    ['an assessment id of another snapshot', (s: ScorecardSnapshot) => void (s.tickets[0]!.assessmentId = OTHER_ASSESSMENT), 'an assessment id is not derived from the snapshot and its subject']
  ])('%s is refused', (_label, edit, problem) => {
    expect(refusal(() => parseScorecardSnapshot(resealed(edit)))).toBe(`invalid_input: Invalid scorecard snapshot: ${problem}`)
  })
})

describe('DM-273: the pools hold exactly what the grades name, each under its own hash', () => {
  it.each([
    ['an input stored under another hash', (s: ScorecardSnapshot) => void (s.inputs[`sha256:${'1'.repeat(64)}`] = s.inputs[firstInputKey(s)]!), 'an input is stored under another hash than its own'],
    ['an input a grade names removed', (s: ScorecardSnapshot) => void delete s.inputs[firstInputKey(s)], 'a grade names an input the snapshot does not hold'],
    [
      'an input no grade names',
      (s: ScorecardSnapshot) => {
        const unused = { ...structuredClone(s.inputs[firstInputKey(s)]!), unusedMarker: true }
        s.inputs[contentHash(unused)] = unused as (typeof s.inputs)[string]
      },
      'the snapshot holds an input no grade names'
    ]
  ])('%s is refused', (_label, edit, problem) => {
    expect(refusal(() => parseScorecardSnapshot(resealed(edit)))).toBe(`invalid_input: Invalid scorecard snapshot: ${problem}`)
  })
})

describe('DM-273: a snapshot names a policy this build grades under', () => {
  it('a policy version other than the hash it names is refused at import', () => {
    const message = refusal(() => parseScorecardSnapshot(resealed((s) => void (s.policy.version = 9))))
    expect(message).toBe(`invalid_input: Invalid scorecard snapshot at policy: Policy ${GOLDEN.policy.policyId} v9 (${GOLDEN.policy.hash}) is not one this build grades under`)
  })

  it('reading a snapshot of an unknown policy hash, or one missing an aggregate detail, fails', () => {
    const unknown = `sha256:${'2'.repeat(64)}`
    expect(refusal(() => readScorecard({ ...GOLDEN, policy: { ...GOLDEN.policy, hash: unknown } }))).toBe(`invalid_input: Policy ${unknown} is not one this build grades under.`)
    expect(refusal(() => readScorecard({ ...GOLDEN, sprint: { ...GOLDEN.sprint, detail: unknown } }))).toBe('invalid_input: A frozen aggregate names a missing detail.')
  })
})
