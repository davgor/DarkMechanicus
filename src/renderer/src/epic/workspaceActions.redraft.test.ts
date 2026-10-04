import { describe, expect, it } from 'vitest'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { checkpointView, draftPlan, epicDetail, runView, savedPlan, validation } from './__mocks__/fixtures'
import { createWorkspaceActions } from './workspaceActions'
import {
  initialWorkspaceState,
  workspaceReducer,
  type WorkspaceAction,
  type WorkspaceData,
  type WorkspaceState
} from './workspaceState'

function data(patch: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    epic: epicDetail({ hasDraft: true }),
    saved: savedPlan(),
    draft: draftPlan(),
    run: runView({ state: 'awaiting_checkpoint' }),
    checkpoint: checkpointView(),
    overview: null,
    savedTickets: [],
    draftTickets: [],
    validation: validation(),
    ...patch
  }
}

function harness(patch: Partial<WorkspaceData> = {}, backend = new FakeBackend(scenario({ draft: draftPlan() }))) {
  const dispatched: WorkspaceAction[] = []
  let current: WorkspaceState = workspaceReducer(initialWorkspaceState(), { type: 'load_succeeded', data: data(patch), at: 0 })
  const dispatch = (action: WorkspaceAction): void => {
    dispatched.push(action)
    current = workspaceReducer(current, action)
  }
  const actions = createWorkspaceActions({
    runner: backend.runner,
    epicId: 'ep_1',
    getState: () => current,
    dispatch,
    reload: () => undefined,
    onChanged: () => undefined
  })
  return { actions, backend, dispatched, dispatch, state: () => current }
}

describe('approve retro & redraft', () => {
  it('approves with the report and the draft revision, then closes the checkpoint and says what happened', async () => {
    const h = harness()
    h.dispatch({ type: 'open_checkpoint' })
    expect(await h.actions.approveWithRedraft('sr_1', 7)).toBe(null)
    expect(h.backend.inputs('approveWithRedraft')).toEqual([{ runId: 'rn_2', expectedDraftRevision: 7, reportId: 'sr_1' }])
    expect([h.state().checkpointOpen, h.state().toast, h.state().banner]).toEqual([
      false,
      'Retro and redraft approved — rev 5 adopted, Sprint 3 started.',
      null
    ])
  })

  it('words an approval that adopted nothing, and keeps the overview open when the epic is complete', async () => {
    const h = harness()
    h.dispatch({ type: 'open_checkpoint' })
    const advanced = (adoption: unknown, outcome: string): unknown => ({
      save: { status: 'unchanged', revisionId: 'rv_4', revisionNumber: 4 },
      adoption,
      approval: { id: 'ap_1', runId: 'rn_2', sprintId: 'sp_2', reportId: 'sr_1', issuedAt: '2026-09-30T12:00:00.000Z' },
      advance: { outcome, activeSprintId: null },
      run: runView({ state: outcome === 'completed' ? 'completed' : 'running', activeSprintOrdinal: 3 })
    })
    h.backend.handlers.approveWithRedraft = () => advanced(null, 'advanced')
    await h.actions.approveWithRedraft('sr_1', 7)
    expect([h.state().checkpointOpen, h.state().toast]).toEqual([false, 'Retro and redraft approved — Sprint 3 started.'])
    h.dispatch({ type: 'open_checkpoint' })
    h.backend.handlers.approveWithRedraft = () => advanced(null, 'completed')
    await h.actions.approveWithRedraft('sr_1', 7)
    expect([h.state().checkpointOpen, h.state().toast]).toEqual([true, 'Retro and redraft approved — the epic is complete.'])
  })

})

describe('approve retro & redraft (2)', () => {
  it('returns the refusal with its step and saved revision instead of a banner, and leaves the checkpoint open', async () => {
    const h = harness()
    h.dispatch({ type: 'open_checkpoint' })
    h.backend.fail('approveWithRedraft', 'run_not_active', 'Approve with redraft stopped at step 2 of 5 (adopt): open attempt.', {
      step: 'adopt',
      stepNumber: 2,
      savedRevisionId: 'rv_5',
      savedRevisionNumber: 5,
      adoptionNeeded: true
    })
    expect(await h.actions.approveWithRedraft('sr_1', 7)).toEqual({
      message: 'Approve with redraft stopped at step 2 of 5 (adopt): open attempt.',
      step: 'adopt',
      stepNumber: 2,
      savedRevisionNumber: 5,
      adoptionNeeded: true
    })
    expect([h.state().checkpointOpen, h.state().toast, h.state().banner]).toEqual([true, null, null])
  })

  it('returns a refusal that names no step for a failure that is not one, and does nothing without a run', async () => {
    const h = harness()
    h.backend.handlers.approveWithRedraft = () => {
      throw new Error('boom')
    }
    expect((await h.actions.approveWithRedraft('sr_1', 7))?.step).toBe(null)
    const idle = harness({ run: null })
    expect(await idle.actions.approveWithRedraft('sr_1', 7)).toBe(null)
    expect(idle.backend.names()).toEqual([])
  })
})

describe('moving checkpoint items to the next sprint', () => {
  it('adds a retro discovery as a ticket of the next sprint', async () => {
    const h = harness()
    expect(await h.actions.addFollowUp({ kind: 'discovery', title: 'Cache the registry', body: 'Slow.' }, 2)).toBe(true)
    expect(h.backend.inputs('updatePlanDraft')).toEqual([
      {
        epicId: 'ep_1',
        ops: [{ op: 'add_ticket', sprint: 'sp_3', ticket: { title: 'Cache the registry', body: 'Slow.' } }],
        expectedDraftRevision: 7
      }
    ])
    expect(h.state().toast).toBe('Added "Cache the registry" to Sprint 3 of the draft.')
  })

  it('moves a leftover and says which tickets went with it', async () => {
    const alone = harness()
    expect(await alone.actions.addFollowUp({ kind: 'leftover', ticketId: 'tk_202' }, 2)).toBe(true)
    expect(alone.state().toast).toBe('Moved DM-202 to Sprint 3 of the draft.')
    const together = harness()
    await together.actions.addFollowUp({ kind: 'leftover', ticketId: 'tk_203' }, 2)
    expect(together.state().toast).toBe('Moved DM-203 with DM-204 to Sprint 3 of the draft.')
    const chained = harness({ draft: draftPlan({ bundle: { ...draftPlan().bundle, edges: [...draftPlan().bundle.edges, { from: 'tk_202', to: 'tk_203' }] } }) })
    await chained.actions.addFollowUp({ kind: 'leftover', ticketId: 'tk_202' }, 2)
    expect(chained.state().toast).toBe('Moved DM-202 with DM-203 and DM-204 to Sprint 3 of the draft.')
  })

  it('says a new sprint was added for an item that goes after the final sprint', async () => {
    const h = harness()
    expect(await h.actions.addFollowUp({ kind: 'discovery', title: 'Next epic idea', body: '' }, 3)).toBe(true)
    expect(h.state().toast).toBe('Added "Next epic idea" to Sprint 4 of the draft (a sprint added for it).')
  })

  it('changes nothing and says so when the draft already holds the item', async () => {
    const h = harness()
    expect(await h.actions.addFollowUp({ kind: 'leftover', ticketId: 'tk_301' }, 2)).toBe(true)
    expect(await h.actions.addFollowUp({ kind: 'discovery', title: 'Plan list view', body: '' }, 2)).toBe(true)
    expect(h.backend.names()).toEqual([])
    expect(h.state().toast).toBe('"Plan list view" is already in Sprint 3 of the draft.')
    await h.actions.addFollowUp({ kind: 'leftover', ticketId: 'tk_301' }, 2)
    expect(h.state().toast).toBe('DM-301 is already in Sprint 3 of the draft.')
  })

  it('says it could not place a ticket the draft does not have', async () => {
    const h = harness()
    expect(await h.actions.addFollowUp({ kind: 'leftover', ticketId: 'tk_gone' }, 2)).toBe(false)
    expect(h.state().banner).toBe('Could not place that in the draft: the ticket or the sprint it goes to is not in the draft.')
    expect(h.backend.names()).toEqual([])
  })
})
