import { describe, expect, it } from 'vitest'
import {
  NOW,
  attempt,
  bundle,
  checkpointView,
  condition,
  draftPlan,
  execution,
  reportView as reportFixture,
  reportWithRetro,
  runView
} from '../epic/__mocks__/fixtures'
import { gateView, reportView } from './gateView'
import { redraftPanel } from './redraftView'

const RUN = runView({ state: 'awaiting_checkpoint' })
const PANEL = redraftPanel(draftPlan(), RUN, 'sp_2')

/** Every gate met except the plan: the draft has changes the saved plan lacks. */
function checkpointWithDraft(others: boolean = true): ReturnType<typeof checkpointView> {
  return checkpointView({
    gatesMet: false,
    conditions: [
      condition('report_submitted', true, 'Required by checkpoint policy'),
      condition('required_accepted', others, 'DM-202 failed after 2 attempts'),
      condition('plan_current', false, 'The draft (revision 7) has changes the saved plan lacks: save it and adopt the new revision, or discard the draft'),
      condition('approval', false, 'Waiting for your approval')
    ]
  })
}

describe('checkpoint gate with a redraft', () => {
  it('offers Approve retro & redraft, enabled once only the plan gate is unmet, and the redraft meets that gate', () => {
    const view = gateView({ checkpoint: checkpointWithDraft(), run: RUN, bundle: bundle(), redraft: PANEL })
    expect(view).toMatchObject({
      title: 'Ready to approve the retro and the redraft',
      approveLabel: 'Approve retro & redraft',
      approveEnabled: true,
      blockedNote: null
    })
    expect(view.conditions.map((item) => item.id)).toEqual(['report_submitted', 'required_accepted', 'plan_current'])
    expect(view.conditions[2]).toEqual({
      id: 'plan_current',
      label: 'Run executes the current plan',
      met: false,
      detail: 'Approve retro & redraft saves this draft as rev 5 and adopts it into Run #2.',
      resolvedByApproval: true
    })
    expect(view.conditions[0]).not.toHaveProperty('resolvedByApproval')
  })

  it('stays blocked, counting only the other gates, while another gate is unmet', () => {
    const view = gateView({ checkpoint: checkpointWithDraft(false), run: RUN, bundle: bundle(), redraft: PANEL })
    expect(view.approveLabel).toBe('Approve retro & redraft')
    expect(view.approveEnabled).toBe(false)
    expect(view.blockedNote).toBe('Blocked by 1 gate condition.')
  })

  it('is not approvable without a report or with a draft that cannot be saved', () => {
    const noReport = checkpointView({ ...checkpointWithDraft(), report: null })
    expect(gateView({ checkpoint: noReport, run: RUN, bundle: bundle(), redraft: PANEL }).approveEnabled).toBe(false)
    const stale = redraftPanel(draftPlan({ stale: true }), RUN, 'sp_2')
    expect(gateView({ checkpoint: checkpointWithDraft(), run: RUN, bundle: bundle(), redraft: stale }).approveEnabled).toBe(false)
  })

  it('keeps the same label on the final sprint', () => {
    const final = checkpointView({ ...checkpointWithDraft(), isFinalSprint: true, sprintOrdinal: 3 })
    expect(gateView({ checkpoint: final, run: RUN, bundle: bundle(), redraft: PANEL }).approveLabel).toBe('Approve retro & redraft')
  })

  it('reads as it did without a redraft: the plan gate blocks a plain approval', () => {
    const view = gateView({ checkpoint: checkpointWithDraft(), run: RUN, bundle: bundle(), redraft: null })
    expect(view).toMatchObject({ approveLabel: 'Approve & advance to Sprint 3', approveEnabled: false, blockedNote: 'Blocked by 1 gate condition.' })
    expect(view.conditions[2]).not.toHaveProperty('resolvedByApproval')
    expect(gateView({ checkpoint: checkpointWithDraft(), run: RUN, bundle: bundle() })).toEqual(view)
  })
})

/** The sample draft with DM-202, the ticket that failed, moved from sprint 2 to sprint 3. */
function draftMovingTheFailedTicket(): ReturnType<typeof draftPlan> {
  const base = draftPlan()
  const sprints = base.bundle.sprints.map((item) => {
    if (item.id === 'sp_2') return { ...item, ticketIds: item.ticketIds.filter((id) => id !== 'tk_202') }
    return item.id === 'sp_3' ? { ...item, ticketIds: [...item.ticketIds, 'tk_202'] } : item
  })
  return draftPlan({ bundle: { ...base.bundle, sprints } })
}

describe('checkpoint gate with a redraft that moves the leftovers on', () => {
  const failedRun = runView({ state: 'awaiting_checkpoint', tickets: [execution('DM-202', 'sp_2', 'failed', { attemptCount: 2 })] })
  const checkpoint = checkpointView({
    gatesMet: false,
    conditions: [
      condition('report_submitted', true, 'Required by checkpoint policy'),
      condition('required_accepted', false, 'DM-202 failed after 2 attempts'),
      condition('plan_current', false, 'The draft has changes the saved plan lacks')
    ]
  })

  it('does not wait for the required tickets: the approval meets that gate too, after the redraft moves them', () => {
    const panel = redraftPanel(draftMovingTheFailedTicket(), failedRun, 'sp_2')
    const view = gateView({ checkpoint, run: failedRun, bundle: bundle(), redraft: panel })
    expect(view).toMatchObject({ title: 'Ready to approve the retro and the redraft', approveEnabled: true, blockedNote: null })
    expect(view.conditions[1]).toEqual({
      id: 'required_accepted',
      label: 'Every required ticket accepted',
      met: false,
      detail: 'Moved to the next sprint by the redraft: DM-202 failed after 2 attempts',
      resolvedByApproval: true
    })
  })

  it('stays blocked while the failed ticket is still in the sprint, offering its retry', () => {
    const panel = redraftPanel(draftPlan(), failedRun, 'sp_2')
    const view = gateView({ checkpoint, run: failedRun, bundle: bundle(), redraft: panel })
    expect(view.approveEnabled).toBe(false)
    expect(view.blockedNote).toBe("Blocked by 1 gate condition. Retry DM-202 or edit the plan so it's no longer required.")
    expect(view.conditions[1]).not.toHaveProperty('resolvedByApproval')
  })
})

describe('sprint report retro', () => {
  const context = { run: RUN, bundle: bundle(), now: NOW }

  it('is absent for a report without a retro', () => {
    expect(reportView(reportFixture(), context).retro).toBe(null)
  })

  it('names its tickets from the plan the run executes', () => {
    const retro = reportView(reportWithRetro(), context).retro
    expect(retro?.delivered.map((row) => [row.ticket.key, row.ticket.title])).toEqual([
      ['DM-203', 'Folder registry & picker'],
      ['DM-201', 'MCP authoring tools']
    ])
    expect(retro?.leftovers.map((row) => [row.ticket.key, row.accepted])).toEqual([['DM-202', false]])
    expect(retro?.tierFit.map((row) => row.ticket.key)).toEqual(['DM-201', 'DM-202', 'DM-203'])
  })

  it('marks a leftover the run has accepted since the retro was written', () => {
    const accepted = runView({ attempts: [attempt('DM-202', 3, 'accepted')] })
    const retro = reportView(reportWithRetro(), { ...context, run: accepted }).retro
    expect(retro?.leftovers.map((row) => row.accepted)).toEqual([true])
  })
})
