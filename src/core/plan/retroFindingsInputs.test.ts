import { describe, expect, it } from 'vitest'
import type { SpaceComponent, SpaceGradeInput } from '../../shared/domain/space'
import type { FrozenGrade, ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import type { RetroFinding, RetroFindingsView } from '../../shared/domain/retroFindings'
import { tid } from '../../test/bundles'
import { frozenSnapshot, measuredSprint, MIN } from '../../test/experimentWorld'
import { deriveRetroFindings } from './retroFindings'

type Inputs = SpaceGradeInput['components']

/** The sealed scorecard of the measured sprint (DM-1..DM-6, see `measuredSprint`), as a copy a test may change. */
function measured(): ScorecardSnapshot {
  const { w, report } = measuredSprint()
  return structuredClone(frozenSnapshot(w, report.id))
}

function gradeOf(snapshot: ScorecardSnapshot, n: number | 'sprint'): FrozenGrade {
  return n === 'sprint' ? snapshot.sprint : (snapshot.tickets.find((grade) => grade.subject.id === tid(n)) ?? snapshot.sprint)
}

/** Ticket `n` (or the sprint) of the snapshot reads its stored `component` input with `patch` merged in. */
function withInput<C extends SpaceComponent>(snapshot: ScorecardSnapshot, n: number | 'sprint', component: C, patch: Partial<Inputs[C]>): ScorecardSnapshot {
  const grade = gradeOf(snapshot, n)
  const key = `patched:${component}:${grade.subject.id}`
  snapshot.inputs[key] = { ...(snapshot.inputs[grade.inputs[component]] as Inputs[C]), ...patch }
  grade.inputs[component] = key
  return snapshot
}

/** Ticket `n`'s frozen result gives `component` the score `score`, with no missing reason. */
function withScore(snapshot: ScorecardSnapshot, n: number, component: SpaceComponent, score: number | null): ScorecardSnapshot {
  const grade = gradeOf(snapshot, n)
  grade.result.components = grade.result.components.map((item) => (item.component === component ? { ...item, score, missingReason: null } : item))
  return snapshot
}

const find = (view: RetroFindingsView, id: string): RetroFinding | undefined => view.findings.find((item) => item.id === id)
const OBSERVATION = 'mo_0000000000000000000000000r'

describe('DM-273: verification findings read from the frozen P input', () => {
  it('charges the attributed regressions of a verified ticket, leaving unassigned ones out', () => {
    const snapshot = withInput(measured(), 1, 'P', {
      regressions: [
        { observationId: OBSERVATION, severity: 'high', attribution: 'attributed' },
        { observationId: 'mo_0000000000000000000000000s', severity: 'low', attribution: 'unassigned' }
      ]
    })
    const finding = find(deriveRetroFindings(snapshot), `failed_verification:ticket:${tid(1)}`)
    expect(finding?.statement).toBe(`Ticket ${tid(1)}: 1 attributed regression charged by the cutoff.`)
    expect(finding?.severity).toBe(0.25)
    expect(finding?.magnitude).toMatchObject({ measure: 'P.regressions', value: 1, reference: null, ratio: null })
    expect(finding?.hypotheses).toEqual([{ concern: 'code_defect', hypothesis: 'Hypothesis: the change introduced the attributed regressions it is charged with.' }])
    expect(finding?.origins.observationIds).toEqual([OBSERVATION])
    expect(finding?.proposal).toMatchObject({ baseline: { measure: 'P.regressions', value: 1, state: 'observed' }, direction: 'decrease' })
  })

  it('reads a failure cited by checks alone as the change, and adds its regressions to the magnitude', () => {
    const attemptId = 'at_0000000000000000000000000a'
    const snapshot = withInput(measured(), 6, 'P', {
      verification: { state: 'failed', evidence: [{ kind: 'check', id: attemptId, detail: null }] },
      regressions: [
        { observationId: OBSERVATION, severity: 'high', attribution: 'attributed' },
        { observationId: 'mo_0000000000000000000000000s', severity: 'low', attribution: 'attributed' }
      ]
    })
    const finding = find(deriveRetroFindings(snapshot), `failed_verification:ticket:${tid(6)}`)
    expect(finding?.statement).toBe(`Ticket ${tid(6)}: required verification failed (1 cited record): verification failed (P 0 of 100); 2 attributed regressions.`)
    expect(finding?.hypotheses.map((item) => item.concern)).toEqual(['code_defect'])
    expect(finding?.origins.checks).toEqual([{ attemptId, name: '' }])
  })

  it('names a criterion cited without a detail by its ticket alone', () => {
    const snapshot = withInput(measured(), 6, 'P', { verification: { state: 'failed', evidence: [{ kind: 'criterion', id: tid(6), detail: null }] } })
    const finding = find(deriveRetroFindings(snapshot), `failed_verification:ticket:${tid(6)}`)
    expect(finding?.origins.criteria).toEqual([{ ticketId: tid(6), criterionId: '' }])
    expect(finding?.hypotheses.map((item) => item.concern)).toEqual(['code_defect', 'plan_context'])
  })

  it('marks a failed verification a person rated highly as contradicted', () => {
    const view = deriveRetroFindings(withScore(measured(), 6, 'S', 90))
    const detail = `S rates ${tid(6)} 90 of 100 while its verification failed.`
    expect(view.contradictions).toContainEqual({ subject: { level: 'ticket', id: tid(6) }, findingIds: [`failed_verification:ticket:${tid(6)}`], detail })
    expect(find(view, `failed_verification:ticket:${tid(6)}`)).toMatchObject({ contradictedBy: [detail], proposal: null, withheld: 'contradictory_signals' })
  })
})

describe('DM-273: coordination and overrun findings read from the frozen C, E and T inputs', () => {
  it('reads coordination defects alone, without handoff checks or a C score, as tooling to fix in Dark Mechanicus', () => {
    const snapshot = withScore(withInput(measured(), 1, 'C', { handoffChecks: null, coordinationDefects: 2 }), 1, 'C', null)
    const finding = find(deriveRetroFindings(snapshot), `coordination_problem:ticket:${tid(1)}`)
    expect(finding?.statement).toBe(`Ticket ${tid(1)}: 2 coordination defects recorded.`)
    expect(finding?.magnitude).toMatchObject({ measure: 'C.coordination_defects', value: 2 })
    expect(finding?.severity).toBe(0.5)
    expect(finding?.concern).toBe('orchestration_tooling')
    expect(finding?.proposal).toMatchObject({ destination: 'darkmechanicus_source', baseline: { measure: 'C.coordination_defects', value: 2 } })
  })

  it('keeps rework open as a hypothesis when effort was not classified, and shows an estimated time as estimated', () => {
    const unclassified = withInput(measured(), 3, 'E', { correctiveMs: { state: 'missing', reason: 'not_reported' } })
    const estimated = withInput(unclassified, 3, 'T', { actual: { state: 'estimated', value: 50 * MIN, method: 'span_gap_fill' } })
    const finding = find(deriveRetroFindings(estimated), `budget_overrun:ticket:${tid(3)}:T`)
    expect(finding?.hypotheses.map((item) => item.concern)).toEqual(['plan_context', 'unavailable_evidence'])
    expect(finding?.magnitude.state).toBe('estimated')
    expect(finding?.withheld).toBe('multiple_candidate_causes')
  })

  it('withholds the outline of an overrun whose T score the grade does not hold', () => {
    const finding = find(deriveRetroFindings(withScore(measured(), 3, 'T', null)), `budget_overrun:ticket:${tid(3)}:T`)
    expect(finding?.concern).toBe('plan_context')
    expect(finding?.proposal).toBeNull()
    expect(finding?.withheld).toBe('no_baseline')
  })

  it('says productive and unclassified effort were not measured beside concentrated corrective effort', () => {
    const missing = { state: 'missing', reason: 'not_reported' } as const
    const snapshot = withInput(measured(), 2, 'E', { productiveMs: missing, unclassifiedMs: missing })
    const finding = find(deriveRetroFindings(snapshot), `corrective_concentration:ticket:${tid(2)}`)
    expect(finding?.statement).toContain('25 min of corrective effort, 67.6% of the sprint\'s 37 min and 100% of its own recorded effort (productive not measured, unclassified not measured;')
    expect(finding?.severity).toBe(1)
  })
})

describe('DM-273: the delivery gap read from the frozen sprint A input and outcomes', () => {
  it('counts items added after dispatch in the statement and as a hypothesis', () => {
    const gap = deriveRetroFindings(withInput(measured(), 'sprint', 'A', { added: 2 })).findings.find((item) => item.kind === 'delivery_gap')
    expect(gap?.statement).toContain('delivered 4 of 6 committed items (2 short, 33.3%); 2 added after dispatch. Not delivered:')
    expect(gap?.hypotheses.some((item) => item.hypothesis.endsWith(`(${tid(5)} no_attempt, 2 items added after dispatch).`))).toBe(true)
  })

  it('finds no delivery gap without a frozen committed scope', () => {
    const view = deriveRetroFindings(withInput(measured(), 'sprint', 'A', { committed: null }))
    expect(view.findings.some((item) => item.kind === 'delivery_gap')).toBe(false)
    expect(view.findings.some((item) => item.kind === 'failed_verification')).toBe(true)
  })

  it('lists no undelivered tickets or unreported attempts when the sprint detail is not in the snapshot', () => {
    const snapshot = measured()
    snapshot.sprint.detail = 'sha256:absent'
    const view = deriveRetroFindings(snapshot)
    expect(view.findings.find((item) => item.kind === 'delivery_gap')?.statement).toBe(`Sprint ${snapshot.sprintId}: delivered 4 of 6 committed items (2 short, 33.3%).`)
    expect(find(view, `missing_instrumentation:sprint:${snapshot.sprintId}:T`)?.statement).toBe(`Sprint ${snapshot.sprintId}: Execution-time efficiency (T) has no value for 1 of 5 tickets (not_reported).`)
  })
})

/** The sprint's frozen outcome of ticket `n` reads `patch` merged in. */
function withOutcome(snapshot: ScorecardSnapshot, n: number, patch: { ticketId?: string; reason?: 'reviewed' }): ScorecardSnapshot {
  const detail = snapshot.details[snapshot.sprint.detail]
  if (detail !== undefined) detail.outcomes = detail.outcomes.map((outcome) => (outcome.ticketId === tid(n) ? { ...outcome, ...patch } : outcome))
  return snapshot
}

describe('DM-273: what undelivered outcomes point to', () => {
  it('gives an undelivered outcome resting on a review no hypothesis of its own', () => {
    const gap = deriveRetroFindings(withOutcome(measured(), 5, { reason: 'reviewed' })).findings.find((item) => item.kind === 'delivery_gap')
    expect(gap?.statement).toContain(`${tid(5)} (missing, reviewed)`)
    expect(gap?.hypotheses.map((item) => item.hypothesis).filter((text) => text.includes(tid(5)))).toEqual([])
    expect(gap?.hypotheses.map((item) => item.concern)).toEqual(['code_defect', 'plan_context'])
  })

  it('keeps both readings of a confirmed failure whose ticket the snapshot does not grade', () => {
    const snapshot = withInput(measured(), 6, 'P', { verification: { state: 'failed', evidence: [{ kind: 'check', id: 'at_0000000000000000000000000a', detail: 'typecheck' }] } })
    const graded = deriveRetroFindings(snapshot).findings.find((item) => item.kind === 'delivery_gap')
    expect(graded?.hypotheses.filter((item) => item.hypothesis.includes(`${tid(6)} confirmed_failure`)).map((item) => item.concern)).toEqual(['code_defect'])
    const ungraded = deriveRetroFindings(withOutcome(snapshot, 6, { ticketId: tid(9) })).findings.find((item) => item.kind === 'delivery_gap')
    expect(ungraded?.hypotheses.filter((item) => item.hypothesis.includes(`${tid(9)} confirmed_failure`)).map((item) => item.concern)).toEqual(['code_defect', 'plan_context'])
  })

  it('names a ticket by its key when the plan gives no title, and by its id when it gives no key', () => {
    const names = (ticketId: string) => (ticketId === tid(2) ? { key: 'DM-2', title: '' } : ticketId === tid(3) ? { key: '', title: 'Ticket 3' } : null)
    const view = deriveRetroFindings(measured(), { names })
    expect(find(view, `coordination_problem:ticket:${tid(2)}`)?.statement).toBe('Ticket DM-2: 1 submission rejected (C 50 of 100).')
    expect(find(view, `budget_overrun:ticket:${tid(3)}:T`)?.statement).toMatch(new RegExp(`^Ticket ${tid(3)}: active time 50 min`))
  })
})

describe('DM-273: handoff checks, an unscored P and sparse data', () => {
  it('reads failed handoff checks alone as the share of checks that failed', () => {
    const snapshot = withInput(measured(), 1, 'C', { handoffChecks: { passed: 2, failed: 1 } })
    const finding = find(deriveRetroFindings(snapshot), `coordination_problem:ticket:${tid(1)}`)
    expect(finding?.statement).toBe(`Ticket ${tid(1)}: 1 of 3 handoff checks failed (C 100 of 100).`)
    expect(finding?.magnitude).toMatchObject({ measure: 'C.failed_checks', value: 1, reference: 3, ratio: 0.333333 })
  })

  it('shows a failed verification without a P score as 0 of 100', () => {
    const finding = find(deriveRetroFindings(withScore(measured(), 6, 'P', null)), `failed_verification:ticket:${tid(6)}`)
    expect(finding?.magnitude).toMatchObject({ measure: 'P.score', value: 0, ratio: 0 })
  })

  it('outlines nothing but instrumentation when too few tickets were graded', () => {
    const snapshot = measured()
    snapshot.tickets = snapshot.tickets.map((grade) => ({ ...grade, result: { ...grade.result, coverage: 0.25 } }))
    const view = deriveRetroFindings(snapshot)
    expect(view.status).toBe('insufficient_data')
    expect(find(view, `budget_overrun:ticket:${tid(3)}:T`)).toMatchObject({ concern: 'plan_context', proposal: null, withheld: 'sparse_data' })
    expect(view.findings.filter((item) => item.proposal !== null).map((item) => item.kind)).toEqual(['missing_instrumentation', 'missing_instrumentation', 'missing_instrumentation'])
    expect(view.notes.some((note) => note.startsWith('Too little of the sprint was measured to size a change'))).toBe(true)
  })
})
