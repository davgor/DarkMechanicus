import { describe, expect, it } from 'vitest'
import { checkpointView, draftPlan, epicDetail, runView, savedPlan, validation } from './__mocks__/fixtures'
import { initialWorkspaceState, workspaceReducer, type WorkspaceData, type WorkspaceState } from './workspaceState'

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

function loaded(patch: Partial<WorkspaceData> = {}, state: WorkspaceState = initialWorkspaceState()): WorkspaceState {
  return workspaceReducer(state, { type: 'load_succeeded', data: data(patch), at: 42 })
}

describe('workspace loading', () => {
  it('starts in the Saved graph view with nothing loaded', () => {
    expect(initialWorkspaceState()).toEqual({
      data: null,
      loading: true,
      loadError: null,
      loadedAt: null,
      view: 'saved',
      layout: 'graph',
      selectedTicketId: null,
      checkpointOpen: false,
      banner: null,
      rejected: null,
      toast: null,
      saveNotice: null,
      busy: false,
      confirm: null,
      validation: null
    })
  })

  it('stores loaded data, time and draft validation', () => {
    const state = loaded()
    expect(state).toMatchObject({ loading: false, loadError: null, loadedAt: 42, view: 'saved' })
    expect(state.validation).toEqual(validation())
    expect(state.data?.epic.id).toBe('ep_1')
  })

  it('keeps old data while reloading and reports load failures', () => {
    const reloading = workspaceReducer(loaded(), { type: 'load_started' })
    expect(reloading.loading).toBe(true)
    expect(reloading.data).not.toBe(null)
    const failed = workspaceReducer(reloading, { type: 'load_failed', message: 'Epic not found' })
    expect(failed).toMatchObject({ loading: false, loadError: 'Epic not found' })
    expect(workspaceReducer(failed, { type: 'load_succeeded', data: data(), at: 1 }).loadError).toBe(null)
  })
})

describe('workspace view resolution', () => {
  it('falls back to the draft when there is no saved revision, and back to saved when the draft is gone', () => {
    expect(loaded({ saved: null }).view).toBe('draft')
    const inDraft = workspaceReducer(loaded(), { type: 'show_view', view: 'draft' })
    expect(inDraft.view).toBe('draft')
    expect(loaded({ draft: null }, inDraft).view).toBe('saved')
    expect(loaded({}, inDraft).view).toBe('draft')
  })

  it('drops a selection whose ticket no longer exists in the shown plan and closes a vanished checkpoint', () => {
    const selected = workspaceReducer(loaded(), { type: 'select_ticket', ticketId: 'tk_202' })
    expect(loaded({}, selected).selectedTicketId).toBe('tk_202')
    const withCheckpoint = workspaceReducer(selected, { type: 'open_checkpoint' })
    expect(loaded({}, withCheckpoint).checkpointOpen).toBe(true)
    expect(loaded({ checkpoint: null }, withCheckpoint).checkpointOpen).toBe(false)
    const gone = savedPlan({ bundle: { ...savedPlan().bundle, tickets: [] } })
    expect(loaded({ saved: gone }, selected).selectedTicketId).toBe(null)
    const newTicket = workspaceReducer(workspaceReducer(loaded(), { type: 'show_view', view: 'draft' }), {
      type: 'select_ticket',
      ticketId: 'tk_305'
    })
    expect(loaded({}, newTicket).selectedTicketId).toBe('tk_305')
  })

  it('switches views, layouts and the checkpoint view, clearing edit feedback on view change', () => {
    const noisy = workspaceReducer(loaded(), { type: 'banner', text: 'Dependency not added.', rejected: { from: 'a', to: 'b' } })
    const draft = workspaceReducer(workspaceReducer(noisy, { type: 'open_checkpoint' }), { type: 'show_view', view: 'draft' })
    expect(draft).toMatchObject({ view: 'draft', banner: null, rejected: null, checkpointOpen: false, saveNotice: null })
    expect(workspaceReducer(draft, { type: 'show_layout', layout: 'list' }).layout).toBe('list')
    const open = workspaceReducer(loaded(), { type: 'open_checkpoint' })
    expect(open.checkpointOpen).toBe(true)
    expect(workspaceReducer(open, { type: 'close_checkpoint' }).checkpointOpen).toBe(false)
  })
})

describe('workspace feedback', () => {
  it('tracks busy, confirmations, toasts, notices, banners and validation', () => {
    let state = loaded()
    state = workspaceReducer(state, { type: 'busy', value: true })
    expect(state.busy).toBe(true)
    state = workspaceReducer(state, { type: 'confirm', kind: 'discard' })
    expect(state.confirm).toBe('discard')
    state = workspaceReducer(state, { type: 'toast', text: 'Saved rev 5.' })
    expect(state.toast).toBe('Saved rev 5.')
    state = workspaceReducer(state, { type: 'save_notice', notice: { tone: 'error', text: 'stale' } })
    expect(state.saveNotice).toEqual({ tone: 'error', text: 'stale' })
    state = workspaceReducer(state, { type: 'banner', text: 'Move rejected.' })
    expect([state.banner, state.rejected]).toEqual(['Move rejected.', null])
    const report = validation({ warnings: [] })
    state = workspaceReducer(state, { type: 'validation', report })
    expect(state.validation).toBe(report)
  })

  it('selects tickets without leaving the checkpoint view', () => {
    const open = workspaceReducer(loaded(), { type: 'open_checkpoint' })
    const selected = workspaceReducer(open, { type: 'select_ticket', ticketId: 'tk_101' })
    expect([selected.selectedTicketId, selected.checkpointOpen]).toEqual(['tk_101', true])
    expect(workspaceReducer(selected, { type: 'select_ticket', ticketId: null }).selectedTicketId).toBe(null)
  })
})
