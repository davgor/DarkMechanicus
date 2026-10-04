// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import {
  checkpointView,
  condition,
  draftPlan,
  epicDetail,
  mcpTestEpic,
  mcpTestPlan,
  mcpTestReport,
  mcpTestRun,
  reportWithRetro,
  retroView,
  runView
} from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

const AWAITING = runView({ state: 'awaiting_checkpoint' })

/** A checkpoint whose report has a retro and whose gates are all met. */
const READY = checkpointView({ report: reportWithRetro(), gatesMet: true, conditions: [condition('report_submitted', true, 'ok')] })

/** A checkpoint where the draft is the only thing unmet: its changes are not in the saved plan. */
const WITH_DRAFT = checkpointView({
  report: reportWithRetro(),
  gatesMet: false,
  conditions: [condition('report_submitted', true, 'ok'), condition('plan_current', false, 'The draft has changes the saved plan lacks')]
})

const DRAFT_EPIC = epicDetail({ hasDraft: true, draftRevision: 7, draftChanged: true })

/** Opens the sprint report; an epic whose draft holds changes opens on its Draft view, so that comes first. */
async function openCheckpoint(fromDraft = false): Promise<void> {
  if (fromDraft) {
    fireEvent.click(await screen.findByRole('button', { name: 'View saved' }))
  }
  fireEvent.click(await within(await screen.findByLabelText('Run')).findByRole('button', { name: 'Sprint report' }))
}

describe('retro on the checkpoint in the workspace', () => {
  it('adds a discovery to the next sprint of a draft it opens, and says so', async () => {
    const h = renderWorkspace(new FakeBackend(scenario({ run: AWAITING, checkpoint: READY })))
    await openCheckpoint()
    fireEvent.click(within(screen.getByLabelText('Discoveries')).getAllByRole('button', { name: '+ Add to next sprint' })[0] as HTMLElement)
    expect(await screen.findByText('Added "Cache the folder registry" to Sprint 3 of the draft.')).toBeTruthy()
    expect(h.backend.names().filter((name) => name === 'openDraft' || name === 'updatePlanDraft')).toEqual(['openDraft', 'updatePlanDraft'])
    expect(h.backend.inputs('updatePlanDraft')).toEqual([
      {
        epicId: 'ep_1',
        ops: [{ op: 'add_ticket', sprint: 'sp_3', ticket: { title: 'Cache the folder registry', body: 'Reads hit the disk on every poll.' } }],
        expectedDraftRevision: 7
      }
    ])
  })

  it('moves a leftover, with what requires it, to the next sprint of the existing draft', async () => {
    const report = reportWithRetro(retroView({ leftovers: [{ ticket: 'tk_203', reason: 'Picker crashes on Windows' }] }))
    const h = renderWorkspace(
      new FakeBackend(scenario({ epic: DRAFT_EPIC, draft: draftPlan(), run: AWAITING, checkpoint: checkpointView({ report }) }))
    )
    await openCheckpoint(true)
    fireEvent.click(within(screen.getByLabelText('Leftovers')).getByRole('button', { name: 'Move to next sprint' }))
    expect(await screen.findByText('Moved DM-203 with DM-204 to Sprint 3 of the draft.')).toBeTruthy()
    expect(h.backend.names()).not.toContain('openDraft')
    expect(h.backend.inputs('updatePlanDraft')).toEqual([
      {
        epicId: 'ep_1',
        ops: [
          { op: 'move_ticket', ticket: 'tk_204', toSprint: 'sp_3' },
          { op: 'move_ticket', ticket: 'tk_203', toSprint: 'sp_3', position: 4 }
        ],
        expectedDraftRevision: 7
      }
    ])
  })

  it('says why a move was rejected and keeps the checkpoint open', async () => {
    const h = renderWorkspace(new FakeBackend(scenario({ epic: DRAFT_EPIC, draft: draftPlan(), run: AWAITING, checkpoint: READY })))
    h.backend.fail('updatePlanDraft', 'invalid_graph', 'Move rejected. DM-304 (Sprint 3) would require DM-202 in later Sprint 4.')
    await openCheckpoint(true)
    fireEvent.click(within(screen.getByLabelText('Leftovers')).getByRole('button', { name: 'Move to next sprint' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Move rejected.')
    expect(screen.getByLabelText('Sprint checkpoint')).toBeTruthy()
  })

})

describe('retro on the checkpoint in the workspace (2)', () => {
  it('does not touch the draft for an item it already holds', async () => {
    const base = draftPlan()
    const holding = draftPlan({
      bundle: {
        ...base.bundle,
        sprints: base.bundle.sprints.map((item) => ({ ...item, ticketIds: item.ticketIds.filter((id) => id !== 'tk_202').concat(item.id === 'sp_3' ? ['tk_202'] : []) }))
      }
    })
    const h = renderWorkspace(new FakeBackend(scenario({ epic: DRAFT_EPIC, draft: holding, run: AWAITING, checkpoint: READY })))
    await openCheckpoint(true)
    expect(within(screen.getByLabelText('Leftovers')).getByText('In Sprint 3 of the draft')).toBeTruthy()
    expect(h.backend.names()).not.toContain('updatePlanDraft')
  })
})

describe('approve retro & redraft in the workspace', () => {
  it('shows the redraft, approves it with the report and the draft revision, and moves on to the next sprint', async () => {
    const h = renderWorkspace(
      new FakeBackend(scenario({ epic: DRAFT_EPIC, draft: draftPlan(), run: AWAITING, checkpoint: WITH_DRAFT }))
    )
    await openCheckpoint(true)
    expect(within(screen.getByLabelText('Redraft')).getByText('REDRAFT · CHANGES AGAINST REV 4')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Approve & advance/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve retro & redraft' }))
    expect(await screen.findByText('Retro and redraft approved — rev 5 adopted, Sprint 3 started.')).toBeTruthy()
    expect(h.backend.inputs('approveWithRedraft')).toEqual([{ runId: 'rn_2', expectedDraftRevision: 7, reportId: 'sr_1' }])
    expect(h.backend.names()).not.toContain('approveAndAdvance')
    expect(screen.queryByLabelText('Sprint checkpoint')).toBeNull()
  })

  it('approves a checkpoint without a redraft as it always did', async () => {
    const h = renderWorkspace(new FakeBackend(scenario({ run: AWAITING, checkpoint: READY })))
    await openCheckpoint()
    expect(screen.queryByLabelText('Redraft')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve & advance to Sprint 3' }))
    expect(await screen.findByText('Checkpoint approved — Sprint 3 started.')).toBeTruthy()
    expect(h.backend.inputs('approveAndAdvance')).toEqual([{ runId: 'rn_2', reportId: 'sr_1' }])
    expect(h.backend.names()).not.toContain('approveWithRedraft')
  })

})

describe('approve retro & redraft in the workspace (2)', () => {
  it('shows the step that refused, and that the draft was saved but adoption is still needed, and stays on the checkpoint', async () => {
    const h = renderWorkspace(
      new FakeBackend(scenario({ epic: DRAFT_EPIC, draft: draftPlan(), run: AWAITING, checkpoint: WITH_DRAFT }))
    )
    h.backend.fail(
      'approveWithRedraft',
      'run_not_active',
      'Approve with redraft stopped at step 2 of 5 (adopt): Run #2 has an open attempt. The draft is saved as revision 5, but Run #2 still executes revision 4: adoption is still needed. Nothing was approved or advanced.',
      { step: 'adopt', stepNumber: 2, savedRevisionId: 'rv_5', savedRevisionNumber: 5, adoptionNeeded: true }
    )
    await openCheckpoint(true)
    fireEvent.click(screen.getByRole('button', { name: 'Approve retro & redraft' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Approve retro & redraft stopped at step 2 of 5: adopting the revision.')).toBeTruthy()
    expect(within(alert).getByText(/^The draft was saved as rev 5, but adoption is still needed/)).toBeTruthy()
    expect(screen.getAllByRole('alert').length).toBe(1)
    expect(screen.getByLabelText('Sprint checkpoint')).toBeTruthy()
  })

  it('keeps the overview open when the approval completes the epic', async () => {
    const final = checkpointView({ ...WITH_DRAFT, isFinalSprint: true, sprintOrdinal: 3 })
    const h = renderWorkspace(new FakeBackend(scenario({ epic: DRAFT_EPIC, draft: draftPlan(), run: AWAITING, checkpoint: final })))
    h.backend.handlers.approveWithRedraft = () => {
      Object.assign(h.backend.state, { epic: mcpTestEpic(), saved: mcpTestPlan(), draft: null, run: mcpTestRun(), checkpoint: null, reports: [mcpTestReport()] })
      return {
        save: { status: 'saved', revisionId: 'rv_5', revisionNumber: 5 },
        adoption: { revisionId: 'rv_5', kept: [], superseded: [], freshBudget: [] },
        approval: { id: 'ap_1', runId: 'rn_2', sprintId: 'sp_3', reportId: 'sr_1', issuedAt: '2026-09-30T12:00:00.000Z' },
        advance: { outcome: 'completed', activeSprintId: null },
        run: h.backend.state.run
      }
    }
    await openCheckpoint(true)
    fireEvent.click(screen.getByRole('button', { name: 'Approve retro & redraft' }))
    expect(await screen.findByText('Retro and redraft approved — the epic is complete.')).toBeTruthy()
    expect(await screen.findByLabelText('Epic overview')).toBeTruthy()
  })
})
