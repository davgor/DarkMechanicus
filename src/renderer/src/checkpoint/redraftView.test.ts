import { describe, expect, it } from 'vitest'
import { draftPlan, runView } from '../epic/__mocks__/fixtures'
import { STALE_DRAFT_NOTE } from '../epic/validationView'
import type { PlanView, RunView } from '../../../shared/domain/views'
import { redraftPanel, redraftRefusal, refusalNotice } from './redraftView'

/** The panel for the checkpoint of sprint 2, the sprint the sample run is in. */
function panelFor(draft: PlanView | null, run: RunView): ReturnType<typeof redraftPanel> {
  return redraftPanel(draft, run, 'sp_2')
}

describe('redraft panel', () => {
  it('shows the draft changes against the revision the run executes and says what approving does', () => {
    const panel = panelFor(draftPlan(), runView())
    expect(panel).toEqual({
      heading: 'REDRAFT · CHANGES AGAINST REV 4',
      draftRevision: 7,
      rows: [
        { symbol: '+', tone: 'added', label: 'DM-305 Plan list view', text: 'added to Sprint 3' },
        { symbol: '~', tone: 'edited', label: 'DM-302', text: 'acceptance criteria edited (2 lines)' },
        { symbol: '~', tone: 'edited', label: 'Sprint 3', text: 'concurrency cap 2 → 3' },
        { symbol: '−', tone: 'removed', label: 'DM-202', text: 'no longer requires DM-102' }
      ],
      approves: 'Approving saves this draft as rev 5, adopts it into Run #2, approves this report and advances.',
      gateDetail: 'Approve retro & redraft saves this draft as rev 5 and adopts it into Run #2.',
      clearsRequired: false,
      warning: null,
      blocked: null
    })
  })

  it('has no panel without a draft, a draft with no changes, or a draft without a revision', () => {
    expect(panelFor(null, runView())).toBe(null)
    expect(panelFor(draftPlan({ changes: [] }), runView())).toBe(null)
    expect(panelFor(draftPlan({ draftRevision: null }), runView())).toBe(null)
  })

  it('says so when the draft builds on a revision the run has not adopted', () => {
    const panel = panelFor(draftPlan(), runView({ revisionId: 'rv_3', revisionNumber: 3 }))
    expect(panel?.heading).toBe('REDRAFT · CHANGES SINCE REV 4')
    expect(panel?.warning).toBe('Run #2 executes rev 3; this draft builds on rev 4, which the run has not adopted. Approving saves and adopts the draft as rev 5.')
    expect(panel?.blocked).toBe(null)
  })

  it('blocks approving a stale draft and gives the reason', () => {
    const panel = panelFor(draftPlan({ stale: true }), runView())
    expect(panel?.blocked).toBe(STALE_DRAFT_NOTE)
  })

  it('counts from a first revision when the draft has no base', () => {
    const panel = panelFor(draftPlan({ baseRevisionId: null, baseRevisionNumber: null }), runView({ revisionId: 'rv_1', revisionNumber: 1 }))
    expect(panel?.heading).toBe('REDRAFT · CHANGES · FIRST REVISION')
    expect(panel?.approves).toBe('Approving saves this draft as rev 1, adopts it into Run #2, approves this report and advances.')
  })
})

describe('refusal of approve with redraft', () => {
  const STEP_FAILURE = {
    message: 'Approve with redraft stopped at step 2 of 5 (adopt): Run #2 has an open attempt. The draft is saved as revision 5, but Run #2 still executes revision 4: adoption is still needed. Nothing was approved or advanced.',
    details: { step: 'adopt', stepNumber: 2, savedRevisionId: 'rv_5', savedRevisionNumber: 5, adoptionNeeded: true }
  }

  it('reads the step, the saved revision and whether adoption is still needed from the error details', () => {
    expect(redraftRefusal(STEP_FAILURE)).toEqual({
      message: STEP_FAILURE.message,
      step: 'adopt',
      stepNumber: 2,
      savedRevisionNumber: 5,
      adoptionNeeded: true
    })
  })

  it('tells the person the draft was saved but adoption is still needed', () => {
    expect(refusalNotice(redraftRefusal(STEP_FAILURE))).toEqual({
      lead: 'Approve retro & redraft stopped at step 2 of 5: adopting the revision.',
      message: STEP_FAILURE.message,
      adoption:
        'The draft was saved as rev 5, but adoption is still needed: the run still executes its earlier revision. Adopt rev 5 from the run bar, then approve. Nothing was approved or advanced.'
    })
  })

  it('says nothing about adoption when the refusal came before the save or left nothing to adopt', () => {
    const early = redraftRefusal({
      message: 'Approve with redraft stopped at step 1 of 5 (save): The draft changed.',
      details: { step: 'save', stepNumber: 1, savedRevisionId: null, savedRevisionNumber: null, adoptionNeeded: false }
    })
    expect(refusalNotice(early)).toEqual({
      lead: 'Approve retro & redraft stopped at step 1 of 5: saving the draft.',
      message: 'Approve with redraft stopped at step 1 of 5 (save): The draft changed.',
      adoption: null
    })
  })

})

describe('refusal of approve with redraft (2)', () => {
  it('names each of the five steps', () => {
    const leads = ['save', 'adopt', 'recompute', 'approve', 'advance'].map(
      (step, index) =>
        refusalNotice(redraftRefusal({ message: 'x', details: { step, stepNumber: index + 1, adoptionNeeded: false } })).lead
    )
    expect(leads).toEqual([
      'Approve retro & redraft stopped at step 1 of 5: saving the draft.',
      'Approve retro & redraft stopped at step 2 of 5: adopting the revision.',
      'Approve retro & redraft stopped at step 3 of 5: re-checking the gates.',
      'Approve retro & redraft stopped at step 4 of 5: approving the report.',
      'Approve retro & redraft stopped at step 5 of 5: advancing the sprint.'
    ])
  })

  it('words an adoption that is needed without a revision number', () => {
    const refusal = redraftRefusal({ message: 'x', details: { step: 'approve', stepNumber: 4, adoptionNeeded: true } })
    expect(refusal.savedRevisionNumber).toBe(null)
    expect(refusalNotice(refusal).adoption).toBe(
      'The draft was saved, but adoption is still needed: the run still executes its earlier revision. Adopt the saved revision from the run bar, then approve. Nothing was approved or advanced.'
    )
  })

  it('keeps just the message of a failure that is not a step refusal, and ignores malformed details', () => {
    const plain = redraftRefusal({ message: 'The desktop could not reach the core.' })
    expect(plain).toEqual({ message: 'The desktop could not reach the core.', step: null, stepNumber: null, savedRevisionNumber: null, adoptionNeeded: false })
    expect(refusalNotice(plain)).toEqual({
      lead: "Approve retro & redraft didn't go through.",
      message: 'The desktop could not reach the core.',
      adoption: null
    })
    const odd = redraftRefusal({ message: 'm', details: { step: 'dance', stepNumber: '2', savedRevisionNumber: 'five', adoptionNeeded: 'yes' } })
    expect(odd).toEqual({ message: 'm', step: null, stepNumber: null, savedRevisionNumber: null, adoptionNeeded: false })
  })
})

/** The sample draft with these tickets moved from sprint 2 to sprint 3. */
function draftMoving(moved: string[], patch: (tickets: PlanView['bundle']['tickets']) => PlanView['bundle']['tickets'] = (tickets) => tickets): PlanView {
  const base = draftPlan()
  const sprints = base.bundle.sprints.map((item) => {
    if (item.id === 'sp_2') return { ...item, ticketIds: item.ticketIds.filter((id) => !moved.includes(id)) }
    return item.id === 'sp_3' ? { ...item, ticketIds: [...item.ticketIds, ...moved] } : item
  })
  return draftPlan({ bundle: { ...base.bundle, sprints, tickets: patch(base.bundle.tickets) } })
}

/** DM-201 is submitted, DM-202 running and DM-204 ready; DM-203 is accepted. */
const UNFINISHED = ['tk_201', 'tk_202', 'tk_204']

describe('redraft panel and the sprint required tickets', () => {
  it('clears the required-tickets gate when the draft moves all the unfinished required work out of the sprint', () => {
    expect(panelFor(draftMoving(UNFINISHED), runView())?.clearsRequired).toBe(true)
  })

  it('does not while some of it is still in the sprint', () => {
    expect(panelFor(draftMoving(['tk_201', 'tk_202']), runView())?.clearsRequired).toBe(false)
    expect(panelFor(draftPlan(), runView())?.clearsRequired).toBe(false)
  })

  it('does not count optional work, which the gate does not ask for', () => {
    const optional = (tickets: PlanView['bundle']['tickets']): PlanView['bundle']['tickets'] =>
      tickets.map((item) => (item.id === 'tk_204' ? { ...item, optional: true } : item))
    expect(panelFor(draftMoving(['tk_201', 'tk_202'], optional), runView())?.clearsRequired).toBe(true)
  })

  it('reads only the sprint it is asked about, and a sprint with no unfinished work in the run holds nothing back', () => {
    expect(redraftPanel(draftMoving(UNFINISHED), runView(), 'sp_3')?.clearsRequired).toBe(false)
    expect(redraftPanel(draftPlan(), runView(), 'sp_1')?.clearsRequired).toBe(true)
  })
})
