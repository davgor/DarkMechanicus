import { describe, expect, it } from 'vitest'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { checkpointView, draftPlan, epicDetail, runView, savedPlan, validation } from './__mocks__/fixtures'
import { buildGraphModel } from '../graph/graphModel'
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
    run: runView(),
    checkpoint: checkpointView(),
    savedTickets: [],
    draftTickets: [],
    validation: validation(),
    ...patch
  }
}

function harness(patch: Partial<WorkspaceData> = {}, backend = new FakeBackend(scenario({ draft: draftPlan() }))) {
  const dispatched: WorkspaceAction[] = []
  const counts = { reloads: 0, changes: 0 }
  let current: WorkspaceState = workspaceReducer(initialWorkspaceState(), { type: 'load_succeeded', data: data(patch), at: 0 })
  const actions = createWorkspaceActions({
    runner: backend.runner,
    epicId: 'ep_1',
    getState: () => current,
    dispatch: (action) => {
      dispatched.push(action)
      current = workspaceReducer(current, action)
    },
    reload: () => {
      counts.reloads += 1
    },
    onChanged: () => {
      counts.changes += 1
    }
  })
  return { actions, backend, dispatched, counts, state: () => current }
}

describe('perform', () => {
  it('marks the workspace busy, reports the change and reloads on success', async () => {
    const h = harness()
    const result = await h.actions.perform(() => Promise.resolve(7))
    expect(result).toEqual({ ok: true, value: 7 })
    expect(h.dispatched).toEqual([
      { type: 'busy', value: true },
      { type: 'busy', value: false }
    ])
    expect(h.counts).toEqual({ reloads: 1, changes: 1 })
  })

  it('reloads without reporting a change when the command fails', async () => {
    const h = harness()
    h.backend.fail('queueRun', 'conflict', 'The draft changed.')
    const result = await h.actions.perform(() => h.backend.runner('queueRun', { epicId: 'ep_1' }))
    expect(result).toEqual({ ok: false, failure: { code: 'conflict', message: 'The draft changed.' } })
    expect(h.counts).toEqual({ reloads: 1, changes: 0 })
    expect(h.state().busy).toBe(false)
  })
})

describe('draft lifecycle actions (1)', () => {
  it('switches to an existing draft without a command, or opens one first', async () => {
    const existing = harness()
    await existing.actions.editDraft()
    expect([existing.backend.names(), existing.state().view]).toEqual([[], 'draft'])
    const fresh = harness({ epic: epicDetail(), draft: null }, new FakeBackend(scenario()))
    await fresh.actions.editDraft()
    expect([fresh.backend.names(), fresh.state().view]).toEqual([['openDraft'], 'draft'])
    const failing = harness({ epic: epicDetail(), draft: null })
    failing.backend.fail('openDraft', 'completed_epic', 'Completed epics are read-only.')
    await failing.actions.editDraft()
    expect([failing.state().view, failing.state().banner]).toEqual(['saved', 'Completed epics are read-only.'])
  })

  it('discards the draft with its expected revision', async () => {
    const h = harness()
    await h.actions.discardDraft()
    expect(h.backend.inputs('discardPlanDraft')).toEqual([{ epicId: 'ep_1', expectedDraftRevision: 7 }])
    expect([h.state().view, h.state().toast, h.state().confirm]).toEqual(['saved', 'Draft discarded.', null])
    const failing = harness()
    failing.backend.fail('discardPlanDraft', 'conflict', 'The draft changed.')
    await failing.actions.discardDraft()
    expect(failing.state().banner).toBe('The draft changed.')
  })

  it('saves and switches to the Saved view with a toast', async () => {
    const h = harness()
    await h.actions.saveDraft()
    expect(h.backend.inputs('savePlan')).toEqual([{ epicId: 'ep_1', expectedDraftRevision: 7 }])
    expect([h.state().view, h.state().toast]).toEqual(['saved', 'Saved rev 5.'])
  })
})

describe('draft lifecycle actions (2)', () => {
  it('keeps the draft on a pending save and shows save errors inline', async () => {
    const pending = harness()
    pending.backend.handlers.savePlan = () => ({ status: 'pending', epicId: 'ep_1', revisionId: 'rv_5', revisionNumber: 5, contentHash: 'h', error: null })
    await pending.actions.saveDraft()
    expect(pending.state().saveNotice).toEqual({
      tone: 'info',
      text: "Save pending — the snapshot hasn't been written yet; your draft is kept."
    })
    expect(pending.dispatched.some((action) => action.type === 'show_view')).toBe(false)
    const stale = harness()
    stale.backend.fail('savePlan', 'stale_draft', 'The saved plan changed since this draft was opened.')
    await stale.actions.saveDraft()
    expect(stale.state().saveNotice).toEqual({ tone: 'error', text: 'The saved plan changed since this draft was opened.' })
    const none = harness({ draft: null })
    await none.actions.saveDraft()
    expect(none.backend.names()).toEqual([])
  })
})

describe('run actions', () => {
  it('queues a run and reports failures in the banner', async () => {
    const h = harness({ run: null })
    await h.actions.startRun()
    expect([h.backend.inputs('queueRun'), h.state().toast]).toEqual([[{ epicId: 'ep_1' }], 'Run queued. It starts when an orchestrator picks it up.'])
    const failing = harness({ run: null })
    failing.backend.fail('queueRun', 'active_run_exists', 'This epic already has an active run.')
    await failing.actions.startRun()
    expect(failing.state().banner).toBe('This epic already has an active run.')
  })

  it('pauses, resumes, cancels and takes over the loaded run', async () => {
    const h = harness()
    await h.actions.runCommand('pause')
    await h.actions.runCommand('resume')
    await h.actions.runCommand('cancel')
    await h.actions.runCommand('takeover')
    expect(h.backend.names()).toEqual(['pauseRun', 'resumeRun', 'cancelRun', 'takeoverRun'])
    expect(h.backend.inputs('cancelRun')).toEqual([{ runId: 'rn_2' }])
    expect(h.state().toast).toBe('Run taken over. Reconcile expired attempts before resuming.')
    const idle = harness({ run: null })
    await idle.actions.runCommand('pause')
    await idle.actions.adopt('rv_5')
    expect(idle.backend.names()).toEqual([])
  })

  it('adopts a newer revision at the checkpoint', async () => {
    const h = harness()
    await h.actions.adopt('rv_5')
    expect(h.backend.inputs('adoptRevision')).toEqual([{ runId: 'rn_2', revisionId: 'rv_5' }])
    expect(h.state().toast).toBe('Revision adopted. The run continues on the new plan.')
  })
})

describe('graph edit actions (1)', () => {
  it('applies draft ops with the expected draft revision and keeps the returned validation', async () => {
    const h = harness()
    const result = await h.actions.applyOps([{ op: 'set_rationale', rationale: 'x' }])
    expect(result.ok).toBe(true)
    expect(h.backend.inputs('updatePlanDraft')).toEqual([
      { epicId: 'ep_1', ops: [{ op: 'set_rationale', rationale: 'x' }], expectedDraftRevision: 7 }
    ])
    expect(h.state().validation).toEqual(validation())
    const noDraft = harness({ draft: null })
    await noDraft.actions.applyOps([])
    expect(noDraft.backend.inputs('updatePlanDraft')).toEqual([{ epicId: 'ep_1', ops: [], expectedDraftRevision: undefined }])
  })

  it('shows a rejected dependency with the server reason and marks both tickets', async () => {
    const h = harness()
    const reason = "Dependency not added. DM-203 is in Sprint 2 and can't require DM-301 in Sprint 3."
    h.backend.fail('updatePlanDraft', 'invalid_graph', reason)
    await h.actions.connect('tk_301', 'tk_203')
    expect([h.state().banner, h.state().rejected]).toEqual([reason, { from: 'tk_301', to: 'tk_203' }])
    const validBefore = h.state().validation
    await h.actions.connect('tk_101', 'tk_102')
    expect([h.state().banner, h.state().rejected]).toEqual([null, null])
    expect(h.backend.inputs('updatePlanDraft')[1]).toMatchObject({ ops: [{ op: 'add_dependency', from: 'tk_101', to: 'tk_102' }] })
    expect(validBefore).toEqual(validation())
  })

  it('moves tickets, removes dependencies and reports rejections without a marker', async () => {
    const h = harness()
    h.backend.fail('updatePlanDraft', 'invalid_graph', 'Move rejected. DM-204 would require…')
    await h.actions.move('tk_204', 'sp_1')
    expect([h.state().banner, h.state().rejected]).toEqual(['Move rejected. DM-204 would require…', null])
    await h.actions.disconnect('tk_203', 'tk_204')
    expect(h.state().banner).toBe(null)
    expect(h.backend.inputs('updatePlanDraft').map((input) => (input as { ops: unknown[] }).ops)).toEqual([
      [{ op: 'move_ticket', ticket: 'tk_204', toSprint: 'sp_1' }],
      [{ op: 'remove_dependency', from: 'tk_203', to: 'tk_204' }]
    ])
    h.backend.fail('updatePlanDraft', 'not_found', 'DM-204 does not require DM-203.')
    await h.actions.disconnect('tk_203', 'tk_204')
    expect(h.state().banner).toBe('DM-204 does not require DM-203.')
  })
})

describe('graph edit actions (2)', () => {
  it('adds a ticket and selects it, and adds a sprint', async () => {
    const h = harness()
    await h.actions.addTicket('sp_2')
    expect(h.state().selectedTicketId).toBe('tk_new')
    await h.actions.addSprint()
    expect(h.backend.inputs('updatePlanDraft').map((input) => (input as { ops: unknown[] }).ops)).toEqual([
      [{ op: 'add_ticket', ref: 'new', sprint: 'sp_2', ticket: { title: 'New ticket' } }],
      [{ op: 'add_sprint', sprint: { goal: '' } }]
    ])
    h.backend.handlers.updatePlanDraft = () => ({ epicId: 'ep_1', draftRevision: 9, refMap: {}, validation: validation() })
    await h.actions.addTicket('sp_2')
    expect(h.state().selectedTicketId).toBe(null)
    h.backend.fail('updatePlanDraft', 'invalid_input', 'A ticket needs a title.')
    await h.actions.addTicket('sp_2')
    h.backend.fail('updatePlanDraft', 'invalid_input', 'A plan keeps at least one sprint.')
    await h.actions.addSprint()
    expect(h.state().banner).toBe('A plan keeps at least one sprint.')
  })
})

describe('checkpoint actions', () => {
  it('approves and advances, then closes the checkpoint view', async () => {
    const h = harness()
    h.dispatched.length = 0
    await h.actions.approve('sr_1')
    expect(h.backend.inputs('approveAndAdvance')).toEqual([{ runId: 'rn_2', reportId: 'sr_1' }])
    expect([h.state().checkpointOpen, h.state().toast]).toEqual([false, 'Checkpoint approved — Sprint 3 started.'])
    h.backend.handlers.approveAndAdvance = () => runView({ state: 'completed' })
    await h.actions.approve('sr_1')
    expect(h.state().toast).toBe('Checkpoint approved — the epic is complete.')
    h.backend.fail('approveAndAdvance', 'gate_blocked', 'Sprint 2 gates are not met.')
    await h.actions.approve('sr_1')
    expect(h.state().banner).toBe('Sprint 2 gates are not met.')
  })

  it('grants retries and toggles automatic continuation', async () => {
    const h = harness()
    await h.actions.retry('tk_202')
    await h.actions.setAutoContinue(true)
    await h.actions.setAutoContinue(false)
    expect([h.backend.inputs('grantRetry'), h.backend.inputs('authorizeAutoContinue')]).toEqual([
      [{ runId: 'rn_2', ticketId: 'tk_202' }],
      [
        { runId: 'rn_2', enabled: true },
        { runId: 'rn_2', enabled: false }
      ]
    ])
    expect(h.state().toast).toBe('Automatic continuation turned off.')
    const idle = harness({ run: null })
    await idle.actions.approve('sr_1')
    await idle.actions.retry('tk_202')
    await idle.actions.setAutoContinue(true)
    expect(idle.backend.names()).toEqual([])
  })
})

describe('follow-up and review actions', () => {
  it('adds a follow-up to the next sprint of the existing draft', async () => {
    const h = harness()
    const added = await h.actions.addFollowUp({ title: 'Signing identity', body: 'Needs a person.' }, 2)
    expect(added).toBe(true)
    expect(h.backend.inputs('updatePlanDraft')).toEqual([
      {
        epicId: 'ep_1',
        ops: [{ op: 'add_ticket', sprint: 'sp_3', ticket: { title: 'Signing identity', body: 'Needs a person.' } }],
        expectedDraftRevision: 7
      }
    ])
    expect(h.state().toast).toBe('Added "Signing identity" to Sprint 3 of the draft.')
  })

  it('opens a draft first when none exists and stops when that fails', async () => {
    const h = harness({ epic: epicDetail(), draft: null }, new FakeBackend(scenario()))
    expect(await h.actions.addFollowUp({ title: 'T', body: '' }, 1)).toBe(true)
    expect(h.backend.names()).toEqual(['openDraft', 'updatePlanDraft'])
    const failing = harness({ epic: epicDetail(), draft: null })
    failing.backend.fail('openDraft', 'completed_epic', 'Completed epics are read-only.')
    expect(await failing.actions.addFollowUp({ title: 'T', body: '' }, 1)).toBe(false)
    expect(failing.state().banner).toBe('Completed epics are read-only.')
    const empty = harness({ draft: draftPlan({ bundle: { ...draftPlan().bundle, sprints: [] } }) })
    expect(await empty.actions.addFollowUp({ title: 'T', body: '' }, 1)).toBe(false)
    const rejected = harness()
    rejected.backend.fail('updatePlanDraft', 'conflict', 'The draft changed.')
    expect(await rejected.actions.addFollowUp({ title: 'T', body: '' }, 1)).toBe(false)
  })

  it('accepts, rejects with a reason and abandons attempts', async () => {
    const h = harness()
    expect(await h.actions.review({ attemptId: 'at_1', decision: 'accept' })).toBe(null)
    expect(await h.actions.review({ attemptId: 'at_1', decision: 'reject', reason: 'c2 unmet' })).toBe(null)
    expect(await h.actions.review({ attemptId: 'at_2', decision: 'abandon' })).toBe(null)
    expect([h.backend.inputs('acceptAttempt'), h.backend.inputs('rejectAttempt'), h.backend.inputs('reconcileAttempt')]).toEqual([
      [{ attemptId: 'at_1' }],
      [{ attemptId: 'at_1', reasons: ['c2 unmet'] }],
      [{ attemptId: 'at_2', resolution: 'abandon' }]
    ])
    h.backend.fail('acceptAttempt', 'stale_claim', 'The attempt is no longer submitted.')
    expect(await h.actions.review({ attemptId: 'at_1', decision: 'accept' })).toBe('The attempt is no longer submitted.')
  })
})

describe('dropping a dragged card', () => {
  it('moves the ticket only when its card lands in another sprint band', async () => {
    const h = harness()
    const model = buildGraphModel({
      plan: draftPlan(),
      mode: 'draft',
      run: null,
      statuses: new Map(),
      outcome: null,
      rejected: null,
      draftNumber: 5
    })
    await h.actions.dropTicket(model, 'tk_204', 420)
    expect(h.backend.names()).toEqual([])
    await h.actions.dropTicket(model, 'tk_204', 600)
    expect(h.backend.inputs('updatePlanDraft')).toEqual([
      { epicId: 'ep_1', ops: [{ op: 'move_ticket', ticket: 'tk_204', toSprint: 'sp_3' }], expectedDraftRevision: 7 }
    ])
  })
})
