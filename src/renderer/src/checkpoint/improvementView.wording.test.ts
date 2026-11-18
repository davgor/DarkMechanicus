import { describe, expect, it } from 'vitest'
import type { CorrectionPlanView } from '../../../shared/domain/corrections'
import type { ProposalOutline } from '../../../shared/domain/retroFindings'
import { bundle, runView } from '../epic/__mocks__/fixtures'
import { experiment, finding, findings, improvementReport, planView, REPORT_ID, resultOf, workTicket } from '../__mocks__/improvementFixtures'
import { retroLookup } from './gateView'
import { assessmentView, editBasis, editDefaults, EMPTY_PLANNER, findingsView, plannerRequest, previewView, resultStands, resultView } from './improvementView'

const LOOKUP = retroLookup({ run: runView(), bundle: bundle() })
const XP_A = experiment('xp_a')

function outline(patch: Partial<ProposalOutline> = {}): ProposalOutline {
  return {
    concern: 'plan_context',
    destination: 'source_repository',
    source: XP_A.source,
    baseline: { measure: 'T.actual_ms', unit: 'milliseconds', value: 5_400_000, state: 'observed' },
    direction: 'decrease',
    guardrails: [
      { measure: 'A.delivered', unit: 'count', comparator: 'at_least', threshold: 4 },
      { measure: 'K.actual_tokens', unit: 'tokens', comparator: 'at_most', threshold: 90_000 }
    ],
    needs: ['sized proposed work'],
    ...patch
  }
}

describe('assessmentView: a sprint grade without a letter or score', () => {
  it('shows a dash for the letter and says there is no score', () => {
    const report = improvementReport([XP_A])
    const card = report.scorecard!
    const grades = card.grades.map((grade) => (grade.subject.level === 'sprint' ? { ...grade, letter: null, displayScore: null } : grade))
    const view = assessmentView({ ...report, scorecard: { ...card, grades } })
    expect(view.headline).toEqual({ letter: '—', score: 'No score', status: 'final', coverage: 'Coverage 75.0%' })
  })
})

describe('findingsView: findings of other grades, unknown tickets and proposals', () => {
  it('names a sprint finding by its grade level and keeps its statement as written', () => {
    const sprint = finding('f_sp', { subject: { level: 'sprint', id: 'sp_2' }, statement: 'sp_2 overran.', coverage: { grade: 0.5, items: null }, withheld: null })
    const [row] = findingsView(findings([sprint]), [], LOOKUP).rows
    expect(row?.subject).toBe('Sprint grade')
    expect(row?.subjectTicket).toBeNull()
    expect(row?.statement).toBe('sp_2 overran.')
    expect(row?.coverage).toBe('Grade coverage 50.0%')
    expect(row?.withheld).toBeNull()
  })

  it('names a ticket the plan does not hold by its id, statement unchanged', () => {
    const lost = finding('f_lost', { subject: { level: 'ticket', id: 'a lost ticket' }, statement: 'a lost ticket ran long.' })
    const [row] = findingsView(findings([lost]), [], LOOKUP).rows
    expect(row?.subject).toBe('Ticket grade · a lost ticket')
    expect(row?.statement).toBe('a lost ticket ran long.')
  })

  it('outlines a proposal with its baseline, both guardrail directions and what it still needs', () => {
    const [row] = findingsView(findings([finding('f1', { proposal: outline(), withheld: null })]), [], LOOKUP).rows
    expect(row?.proposal?.slice(1)).toEqual([
      'Read against T.actual_ms 5,400,000 milliseconds (observed)',
      'Guardrail A.delivered at least 4 count',
      'Guardrail K.actual_tokens at most 90,000 tokens',
      'Still needs: sized proposed work'
    ])
  })

  it('reads a proposal without a baseline as a discovery', () => {
    const [row] = findingsView(findings([finding('f1', { proposal: outline({ baseline: null, guardrails: [], needs: [] }), withheld: null })]), [], LOOKUP).rows
    expect(row?.proposal?.[1]).toBe('Read against nothing measured yet (a discovery)')
    expect(row?.proposal).toHaveLength(2)
  })

  it('names contradicting findings by their heading, an unknown one by its id, and lists contradictions by subject', () => {
    const first = finding('f1', { contradictedBy: ['f2', 'f_gone'] })
    const second = finding('f2', { rank: 2, kind: 'delivery_gap' })
    const view = findingsView(
      findings([first, second], { contradictions: [{ subject: { level: 'run', id: 'rn_2' }, findingIds: ['f1', 'f2'], detail: 'Time rose while delivery fell.' }] }),
      [],
      LOOKUP
    )
    expect(view.rows[0]?.contradictedBy).toEqual(['#2 Delivery gap', 'f_gone'])
    expect(view.contradictions).toEqual(['Run grade: Time rose while delivery fell.'])
  })
})

describe('plannerRequest: edits keyed by something other than a work item', () => {
  it('sends neither an edit under a malformed key nor a prerequisite that names no work item', () => {
    const against = editBasis(XP_A, 0, REPORT_ID)
    const state = { ...EMPTY_PLANNER, selected: ['xp_a'], edits: { 'not-a-ref': { title: 'Lost', against }, 'xp_a#0': { requires: ['DM-12 not a ref'], against } } }
    const request = plannerRequest(REPORT_ID, state, [XP_A])
    expect(request.input.edits).toEqual([{ experimentId: 'xp_a', index: 0, dependsOn: [] }])
    expect(request.held).toEqual([])
  })

  it('writes an edit of a work item the experiment does not have against an empty title and body', () => {
    expect(editBasis(XP_A, 7, REPORT_ID)).toEqual({ reportId: REPORT_ID, title: '', body: '' })
    expect(editDefaults(XP_A, 7, undefined)).toMatchObject({ title: '', body: '', criteria: '', requires: [], requiresTickets: '' })
  })
})

function withExperiment(plan: CorrectionPlanView, patch: Partial<CorrectionPlanView['experiments'][number]>): CorrectionPlanView {
  return { ...plan, experiments: plan.experiments.map((item) => ({ ...item, ...patch })) }
}

describe('previewView: other targets, tickets and validation', () => {
  it('names an open follow-up epic, a ticket body without context and an unsized Fireguard ticket', () => {
    const plan = planView(['xp_a'])
    const fireguard = workTicket('xp_a', 0, { ref: 'fireguard', role: 'fireguard', experimentId: null, workIndex: null, key: 'DM-312', size: null, body: 'Grade it.' })
    const view = previewView({ ...plan, target: { ...plan.target, kind: 'follow_up_epic', epicId: 'ep_f', epicTitle: 'Follow-up', sprintOrdinal: 2 }, tickets: [fireguard] })
    expect(view.target).toBe('The open follow-up epic "Follow-up" · Sprint 2 · goal: Corrective work')
    expect(view.tickets[0]).toMatchObject({ role: 'Fireguard', size: 'Unsized', body: 'Grade it.', work: null })
    expect(view.destination).toBe('This project')
  })

  it('says where work already sits in the draft, or in a saved revision whose number is unknown', () => {
    const existing = { key: 'k', payloadHash: 'p', epicId: 'ep_1', holder: 'draft' as const, revisionNumber: null, ticketIds: [], keys: ['DM-50'] }
    expect(previewView(withExperiment(planView(['xp_a']), { state: 'created', existing })).experiments[0]?.existing).toBe('DM-50 in the draft of epic ep_1')
    const saved = { ...existing, holder: 'revision' as const }
    expect(previewView(withExperiment(planView(['xp_a']), { state: 'created', existing: saved })).experiments[0]?.existing).toBe('DM-50 in the saved revision  of epic ep_1')
  })

  it('shows the restatement of blocked work as JSON, and the validation errors and warnings in words', () => {
    const restatement = {
      source: { subject: { level: 'ticket' as const, id: 'tk_202' } },
      issue: { summary: 'Slow', evidence: [] },
      hypothesis: 'h',
      destination: { kind: 'source_repository' as const },
      proposedWork: [{ title: 'Sized work', size: 'small' as const }],
      baseline: { measure: 'T.actual_ms' as const, unit: 'milliseconds' as const },
      expectedChange: XP_A.expectedChange,
      guardrails: [],
      window: XP_A.window
    }
    const plan = withExperiment(planView(['xp_a']), { state: 'blocked', restatement })
    const validation = { valid: false, errors: [{ code: 'e', message: 'A cycle.' }], warnings: [{ code: 'w', message: 'No size.' }] }
    const view = previewView({ ...plan, validation: { ...plan.validation, ...validation } })
    expect(JSON.parse(view.experiments[0]?.restatement ?? 'null')).toEqual(restatement)
    expect(view.validation).toEqual({ valid: false, errors: ['A cycle.'], warnings: ['No size.'] })
  })
})

describe('resultView and resultStands: a creation that names no epic', () => {
  const created = resultOf(planView(['xp_a']))
  const nowhere = { ...created, draftRevision: null, target: { ...created.target, epicId: null }, createdIn: [] }

  it('reads a result without an epic or draft revision', () => {
    expect(resultView(nowhere)).toMatchObject({
      heading: 'Created as draft work in "Checkout revamp". Nothing was saved, adopted, started or approved.',
      epicId: null,
      sameEpic: false
    })
  })

  it('keeps standing a result written outside this epic’s draft', () => {
    expect(resultStands({ reportId: REPORT_ID, view: nowhere }, REPORT_ID, 3)).toBe(true)
  })
})
