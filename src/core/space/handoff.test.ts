/**
 * DM-174 c3: the handoff checks tell missing required evidence or a broken output contract from a purposeful
 * clarification (a criterion honestly reported unmet with a note).
 */
import { describe, expect, it } from 'vitest'
import type { AttemptEvidence, AttemptOutputs } from '../../shared/domain/views'
import { deriveHandoffChecks } from './handoff'

const TICKET = {
  acceptanceCriteria: [
    { id: 'c1', text: 'Parses input' },
    { id: 'c2', text: 'Writes output' }
  ],
  expectedArtifacts: [] as string[]
}

const OUTPUTS: AttemptOutputs = { summary: 'Did it', artifacts: [], commits: ['abc1234'], changedFiles: [], branch: 'work' }
const EVIDENCE: AttemptEvidence = {
  checks: [{ name: 'npm test', status: 'passed', detail: 'ok' }],
  criteria: [
    { criterionId: 'c1', met: true, note: 'parser done' },
    { criterionId: 'c2', met: true, note: 'writer done' }
  ],
  notes: ''
}

function missingOf(
  patch: { outputs?: Partial<AttemptOutputs>; evidence?: Partial<AttemptEvidence>; expectedArtifacts?: string[] },
  required: string[] = []
): Record<string, string[]> {
  const results = deriveHandoffChecks(
    { ...TICKET, expectedArtifacts: patch.expectedArtifacts ?? [] },
    { outputs: { ...OUTPUTS, ...patch.outputs }, evidence: { ...EVIDENCE, ...patch.evidence } },
    required
  )
  for (const result of results) expect(result.passed).toBe(result.missing.length === 0)
  return Object.fromEntries(results.map((result) => [result.check, result.missing]))
}

describe('deriveHandoffChecks (DM-174 c3)', () => {
  it('passes all three checks, in order, for a complete handoff', () => {
    const results = deriveHandoffChecks(TICKET, { outputs: OUTPUTS, evidence: EVIDENCE }, [])
    expect(results).toEqual([
      { check: 'criteria_evidence', passed: true, missing: [] },
      { check: 'verification_checks', passed: true, missing: [] },
      { check: 'outputs_contract', passed: true, missing: [] }
    ])
  })

  it('passes a criterion honestly reported unmet with a note: a purposeful clarification is not a failure', () => {
    const evidence = { criteria: [EVIDENCE.criteria[0], { criterionId: 'c2', met: false, note: 'Which format? Waiting for the owner’s answer' }] }
    expect(missingOf({ evidence: evidence as AttemptEvidence })).toEqual({ criteria_evidence: [], verification_checks: [], outputs_contract: [] })
  })

  it('fails criteria evidence for a criterion with no entry or a blank note, naming each', () => {
    expect(missingOf({ evidence: { criteria: [{ criterionId: 'c1', met: true, note: 'done' }] } }).criteria_evidence).toEqual(['c2'])
    expect(missingOf({ evidence: { criteria: [{ criterionId: 'c1', met: true, note: '  ' }, { criterionId: 'c2', met: true, note: 'x' }] } }).criteria_evidence).toEqual(['c1'])
    expect(missingOf({ evidence: { criteria: [{ criterionId: 'c9', met: true, note: 'other ticket' }] } }).criteria_evidence).toEqual(['c1', 'c2'])
  })

  it('fails verification when no check was reported at all', () => {
    expect(missingOf({ evidence: { checks: [] } }).verification_checks).toEqual(['any check'])
  })

  it('accepts a failed or skipped check as reported: the check measures the handoff, not the outcome', () => {
    expect(missingOf({ evidence: { checks: [{ name: 'npm test', status: 'failed', detail: '2 failures' }] } }).verification_checks).toEqual([])
  })

  it('matches required check names like the gate (trimmed, ignoring case) and names the ones missing', () => {
    const checks = [{ name: ' Lint ', status: 'passed' as const, detail: 'ok' }]
    expect(missingOf({ evidence: { checks } }, ['lint', 'Typecheck', 'build']).verification_checks).toEqual(['Typecheck', 'build'])
    expect(missingOf({ evidence: { checks: [] } }, ['lint']).verification_checks).toEqual(['lint'])
  })

  it('names each broken part of the output contract', () => {
    expect(missingOf({ outputs: { summary: '  ' } }).outputs_contract).toEqual(['summary'])
    expect(missingOf({ outputs: { commits: [], branch: null } }).outputs_contract).toEqual(['deliverables'])
    expect(missingOf({ outputs: { branch: '  ' } }).outputs_contract).toEqual(['branch'])
    expect(missingOf({ outputs: { commits: [], branch: null, changedFiles: ['a.ts'] } }).outputs_contract).toEqual([])
    expect(missingOf({ expectedArtifacts: ['Schema doc'] }).outputs_contract).toEqual(['artifacts'])
    expect(
      missingOf({ expectedArtifacts: ['Schema doc'], outputs: { commits: [], branch: null, artifacts: [{ label: 'Schema doc', location: 'docs/schema.md', hash: null, remoteOnly: false }] } })
        .outputs_contract
    ).toEqual([])
  })
})
