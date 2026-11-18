// DM-273: the P input from facts built directly: used tries against grants, reconciled leases, decisions without a
// recorded decider, and defects charged to another outcome or found before acceptance.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MetricObservation } from '../../shared/domain/space'
import { resolveDefects } from './defects'
import { ticketPerformance, type VerificationAttempt, type VerificationFacts } from './verification'

const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8'))
/** One accepted, reviewer-checked attempt of ticket 1 (decided 10:20 on 2026-11-01), read on 2026-11-05. */
const PERFORMANCE_FIXTURE = readJson('performance/unrelated-defect.json') as { facts: VerificationFacts }
const ACCEPTED = PERFORMANCE_FIXTURE.facts
const LEDGER = readJson('observations.json') as { observations: MetricObservation[] }
const REPORT = LEDGER.observations.find((record) => record.metric === 'escaped_defect')!

/** The accepted facts with their one attempt patched. */
function factsWith(attempt: Partial<VerificationAttempt>, more: Partial<VerificationFacts> = {}): VerificationFacts {
  return { ...structuredClone(ACCEPTED), attempts: [{ ...structuredClone(ACCEPTED.attempts[0]!), ...attempt }], ...more }
}

/** Attempt 1 failed at 10:08 with one try allowed. */
const failedOnce = (more: Partial<VerificationFacts>): VerificationFacts =>
  factsWith({ state: 'failed', decidedAt: null, decision: null, endedAt: '2026-11-01T10:08:00.000Z', retryLimit: 1 }, more)

const verdict = (facts: VerificationFacts): string => {
  const { verification } = ticketPerformance(facts, [])
  return `${verification.state}/${verification.reason}`
}

describe('DM-273: a ticket with no accepted attempt has used its tries only against the grants made by the cutoff', () => {
  it.each([
    ['no grant', [], 'failed/confirmed_failure'],
    ['a grant with no logged time', [null], 'pending/awaiting_retry'],
    ['a grant after the cutoff', ['2026-11-06T00:00:00.000Z'], 'failed/confirmed_failure'],
    ['a grant before the cutoff', ['2026-11-02T00:00:00.000Z'], 'pending/awaiting_retry']
  ])('one failed attempt of one try, with %s', (_label, grants, expected) => {
    expect(verdict(failedOnce({ retryGrants: grants }))).toBe(expected)
  })

  it('an expired lease counts as a used try once it was reconciled by the cutoff', () => {
    const expired = { state: 'lease_expired' as const, decidedAt: null, decision: null, submittedAt: null, endedAt: '2026-11-01T10:30:00.000Z', retryLimit: 1 }
    expect(verdict(factsWith({ ...expired, reconciledAt: '2026-11-01T11:00:00.000Z' }))).toBe('failed/confirmed_failure')
    expect(verdict(factsWith({ ...expired, reconciledAt: '2026-11-06T00:00:00.000Z' }))).toBe('pending/in_progress')
  })
})

describe('a ticket that used every try its tracked records show, read where the retry grants are not known', () => {
  // Retry grants are machine-local (never in the tracked run record), so only the machine that ran the run can tell
  // that no grant gave the ticket another try.
  it.each([
    ['while its run goes on', null],
    ['after its run ended', { at: '2026-11-02T00:00:00.000Z', state: 'canceled' as const }]
  ])('is missing (retry_grants_unknown) %s, never a confirmed failure', (_label, runEnded) => {
    expect(verdict(failedOnce({ grantsKnown: false, runEnded }))).toBe('missing/retry_grants_unknown')
  })

  it('stays a confirmed failure where the grants are known', () => {
    expect(verdict(failedOnce({ grantsKnown: true }))).toBe('failed/confirmed_failure')
  })

  it('a reviewer-checked failure on an accepted attempt stays confirmed wherever it is read', () => {
    const failing = readJson('performance/fast-cheap-failing.json') as { facts: VerificationFacts }
    expect(verdict({ ...failing.facts, grantsKnown: false })).toBe('failed/confirmed_failure')
  })

  it('a ticket with tries left reads as before', () => {
    expect(verdict(failedOnce({ grantsKnown: false, retryGrants: ['2026-11-02T00:00:00.000Z'] }))).toBe('pending/awaiting_retry')
  })
})

describe('DM-273: an accepted attempt decided without a recorded decision', () => {
  it('names no decider and reads as a legacy review', () => {
    const { verification } = ticketPerformance(factsWith({ decision: null }), [])
    expect([verification.state, verification.reason, verification.decidedAt, verification.decidedBy]).toEqual(['missing', 'legacy_review_basis_unknown', '2026-11-01T10:20:00.000Z', null])
  })
})

describe('DM-273: an attributed defect is charged only to the accepted outcome it escaped, after its acceptance', () => {
  const charge = (report: MetricObservation): string[] => ticketPerformance(ACCEPTED, resolveDefects([report], ACCEPTED.cutoff).defects).regressions.map((item) => item.charge)

  it('charges a defect of the accepted attempt reported after acceptance', () => {
    expect(charge(REPORT)).toEqual(['charged'])
  })

  it('does not charge one stored before the acceptance', () => {
    expect(charge({ ...REPORT, observedAt: '2026-11-01T10:10:00.000Z', recordedAt: '2026-11-01T10:10:00.000Z' })).toEqual(['before_acceptance'])
  })

  it('does not charge one whose origin is another attempt', () => {
    const evidence = REPORT.evidence.map((ref) => (ref.kind === 'attempt' ? { ...ref, id: 'at_01m7ge55kx0000000000000009' } : ref))
    expect(charge({ ...REPORT, evidence })).toEqual(['other_outcome'])
  })
})
