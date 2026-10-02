import { describe, expect, it } from 'vitest'
import {
  checkpointView,
  draftPlan,
  epicDetail,
  mcpTestEpic,
  mcpTestPlan,
  mcpTestReport,
  mcpTestRun,
  runView,
  savedPlan,
  validation
} from './__mocks__/fixtures'
import type { TicketSummaryView } from '../../../shared/domain/views'
import { graphInputFor, initialWorkspaceState, workspaceReducer, type WorkspaceData, type WorkspaceState } from './workspaceState'

function data(patch: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    epic: epicDetail({ hasDraft: true }),
    saved: savedPlan(),
    draft: draftPlan(),
    run: runView(),
    checkpoint: checkpointView(),
    overview: null,
    savedTickets: [],
    draftTickets: [],
    validation: validation(),
    ...patch
  }
}

/** The completed "MCP connection test" epic: no checkpoint any more, an overview instead. */
function completed(): Partial<WorkspaceData> {
  const saved = mcpTestPlan()
  return {
    epic: mcpTestEpic(),
    saved,
    draft: null,
    run: mcpTestRun(),
    checkpoint: null,
    overview: { bundle: saved.bundle, reports: [mcpTestReport()] },
    validation: null
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
    const others = savedPlan().bundle.tickets.filter((item) => item.id !== 'tk_202')
    const gone = savedPlan({ bundle: { ...savedPlan().bundle, tickets: others } })
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

describe('completed epic overview state', () => {
  it('keeps the review open as the overview once the final approval completes the run', () => {
    const reviewing = workspaceReducer(loaded({ run: runView({ state: 'awaiting_checkpoint' }) }), { type: 'open_checkpoint' })
    const done = loaded(completed(), reviewing)
    expect([done.checkpointOpen, done.data?.checkpoint, done.data?.overview?.reports.length]).toEqual([true, null, 1])
    expect(loaded({}, done).checkpointOpen).toBe(true)
  })

  it('opens and closes the overview of a completed epic, and closes when neither review nor overview remains', () => {
    const graph = loaded(completed())
    expect([graph.checkpointOpen, graph.view]).toEqual([false, 'saved'])
    const open = workspaceReducer(graph, { type: 'open_checkpoint' })
    expect(open.checkpointOpen).toBe(true)
    expect(workspaceReducer(open, { type: 'close_checkpoint' }).checkpointOpen).toBe(false)
    expect(loaded({ checkpoint: null, overview: null }, open).checkpointOpen).toBe(false)
    expect(loaded({ ...completed(), overview: null }, open).checkpointOpen).toBe(false)
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

describe('graph input for the shown view', () => {
  it('is null until a plan is loaded', () => {
    expect(graphInputFor(initialWorkspaceState())).toBe(null)
    expect(graphInputFor(loaded({ saved: null, draft: null }))).toBe(null)
  })

  it('uses the saved plan, saved statuses and the recorded epic outcome in the Saved view', () => {
    const outcome = { summary: 'x', successCriteria: [{ criterionId: 's1', met: true, note: '' }], recordedAt: '', runId: null }
    const state = loaded({
      epic: epicDetail({ hasDraft: true, outcome }),
      savedTickets: [{ ...summaryRow('tk_101'), status: 'completed' }]
    })
    const input = graphInputFor(state)
    expect(input?.mode).toBe('saved')
    expect(input?.plan.view).toBe('saved')
    expect(input?.statuses.get('tk_101')).toBe('completed')
    expect(input?.outcome).toEqual(outcome.successCriteria)
    expect(input?.draftNumber).toBe(5)
    expect(input?.run?.id).toBe('rn_2')
  })

  it('uses the draft plan and draft statuses in the Draft view and the final report outcome as a fallback', () => {
    const report = checkpointView().report
    const final = checkpointView({
      report: report === null ? null : { ...report, report: { ...report.report, epicOutcome: { summary: '', successCriteria: [] } } }
    })
    const state = workspaceReducer(
      loaded({ draftTickets: [{ ...summaryRow('tk_305'), status: null }], checkpoint: final }),
      { type: 'show_view', view: 'draft' }
    )
    const rejected = workspaceReducer(state, { type: 'banner', text: 'x', rejected: { from: 'a', to: 'b' } })
    const input = graphInputFor(rejected)
    expect([input?.mode, input?.plan.view, input?.statuses.get('tk_305'), input?.rejected]).toEqual([
      'draft',
      'draft',
      null,
      { from: 'a', to: 'b' }
    ])
    expect(input?.outcome).toEqual([])
    expect(graphInputFor(loaded({ checkpoint: null }))?.outcome).toBe(null)
  })
})

function summaryRow(id: string): TicketSummaryView {
  return { id, key: id, title: id, status: 'backlog', sprintId: null, sprintOrdinal: null, priority: 'normal', tags: [], optional: false }
}
