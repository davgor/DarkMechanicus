/** Pure state for the epic workspace: loaded data, the shown view, selection, and feedback. */
import type { GraphInput } from '../graph/graphModel'
import { nextRevisionNumber } from './headerView'
import type {
  CheckpointView,
  EpicDetailView,
  PlanView,
  RunView,
  TicketSummaryView,
  ValidationReport
} from '../../../shared/domain/views'

export type PlanViewKind = 'saved' | 'draft'

export interface WorkspaceData {
  epic: EpicDetailView
  saved: PlanView | null
  draft: PlanView | null
  run: RunView | null
  checkpoint: CheckpointView | null
  savedTickets: TicketSummaryView[]
  draftTickets: TicketSummaryView[]
  validation: ValidationReport | null
}

interface Notice {
  tone: 'error' | 'info'
  text: string
}

export interface WorkspaceState {
  data: WorkspaceData | null
  loading: boolean
  loadError: string | null
  loadedAt: number | null
  view: PlanViewKind
  /** The view the person last picked for this epic, remembered across visits; null leaves it to the default. */
  chosenView: PlanViewKind | null
  layout: 'graph' | 'list'
  selectedTicketId: string | null
  checkpointOpen: boolean
  /** Rejected edit or failed action, shown over the canvas. */
  banner: string | null
  rejected: { from: string; to: string } | null
  toast: string | null
  /** Save feedback shown in the validation panel. */
  saveNotice: Notice | null
  busy: boolean
  confirm: 'discard' | 'cancel_run' | null
  validation: ValidationReport | null
}

export type WorkspaceAction =
  | { type: 'load_started' }
  | { type: 'load_succeeded'; data: WorkspaceData; at: number }
  | { type: 'load_failed'; message: string }
  /** The person picked a view: show it and remember the choice. */
  | { type: 'show_view'; view: PlanViewKind }
  /** Save or Discard ended the draft: show Saved and forget the choice, so the next draft opens by default. */
  | { type: 'draft_closed' }
  | { type: 'show_layout'; layout: 'graph' | 'list' }
  | { type: 'select_ticket'; ticketId: string | null }
  | { type: 'open_checkpoint' }
  | { type: 'close_checkpoint' }
  | { type: 'busy'; value: boolean }
  | { type: 'banner'; text: string | null; rejected?: { from: string; to: string } | null }
  | { type: 'toast'; text: string | null }
  | { type: 'save_notice'; notice: Notice | null }
  | { type: 'confirm'; kind: 'discard' | 'cancel_run' | null }
  | { type: 'validation'; report: ValidationReport | null }

export function initialWorkspaceState(chosenView: PlanViewKind | null = null): WorkspaceState {
  return {
    data: null,
    loading: true,
    loadError: null,
    loadedAt: null,
    view: 'saved',
    chosenView,
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
  }
}

/** The requested view when it exists, otherwise the other one. */
function resolveView(requested: PlanViewKind, data: WorkspaceData): PlanViewKind {
  const available = { saved: data.saved !== null, draft: data.draft !== null }
  if (available[requested]) {
    return requested
  }
  return requested === 'saved' ? 'draft' : 'saved'
}

/** Where an epic opens: the remembered choice, else the draft when it holds unsaved changes, else Saved. */
function openingView(chosen: PlanViewKind | null, data: WorkspaceData): PlanViewKind {
  if (chosen !== null) {
    return chosen
  }
  return data.epic.draftChanged ? 'draft' : 'saved'
}

export function planFor(data: WorkspaceData, view: PlanViewKind): PlanView | null {
  return view === 'draft' ? data.draft : data.saved
}

function keepSelection(selected: string | null, plan: PlanView | null): string | null {
  const exists = plan?.bundle.tickets.some((item) => item.id === selected) ?? false
  return exists ? selected : null
}

function loadSucceeded(state: WorkspaceState, data: WorkspaceData, at: number): WorkspaceState {
  // Only the first load picks the view; later loads (refreshes) keep the one shown.
  const requested = state.data === null ? openingView(state.chosenView, data) : state.view
  const view = resolveView(requested, data)
  return {
    ...state,
    data,
    loading: false,
    loadError: null,
    loadedAt: at,
    view,
    selectedTicketId: keepSelection(state.selectedTicketId, planFor(data, view)),
    checkpointOpen: state.checkpointOpen && data.checkpoint !== null,
    validation: data.validation
  }
}

type Handlers = {
  [K in WorkspaceAction['type']]: (state: WorkspaceState, action: Extract<WorkspaceAction, { type: K }>) => WorkspaceState
}

/** Shows a view, clearing feedback that belonged to the previous one. */
function showView(state: WorkspaceState, view: PlanViewKind, chosenView: PlanViewKind | null): WorkspaceState {
  return { ...state, view, chosenView, banner: null, rejected: null, checkpointOpen: false, saveNotice: null, confirm: null }
}

const HANDLERS: Handlers = {
  load_started: (state) => ({ ...state, loading: true }),
  load_succeeded: (state, action) => loadSucceeded(state, action.data, action.at),
  load_failed: (state, action) => ({ ...state, loading: false, loadError: action.message }),
  show_view: (state, action) => showView(state, action.view, action.view),
  draft_closed: (state) => showView(state, 'saved', null),
  show_layout: (state, action) => ({ ...state, layout: action.layout }),
  select_ticket: (state, action) => ({ ...state, selectedTicketId: action.ticketId }),
  open_checkpoint: (state) => ({ ...state, checkpointOpen: true }),
  close_checkpoint: (state) => ({ ...state, checkpointOpen: false }),
  busy: (state, action) => ({ ...state, busy: action.value }),
  banner: (state, action) => ({ ...state, banner: action.text, rejected: action.rejected ?? null }),
  toast: (state, action) => ({ ...state, toast: action.text }),
  save_notice: (state, action) => ({ ...state, saveNotice: action.notice }),
  confirm: (state, action) => ({ ...state, confirm: action.kind }),
  validation: (state, action) => ({ ...state, validation: action.report })
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  const handler = HANDLERS[action.type] as (state: WorkspaceState, action: WorkspaceAction) => WorkspaceState
  return handler(state, action)
}

function outcomeOf(data: WorkspaceData): GraphInput['outcome'] {
  return data.epic.outcome?.successCriteria ?? data.checkpoint?.report?.report.epicOutcome?.successCriteria ?? null
}

/** Everything the graph and list views need for the currently shown plan. */
export function graphInputFor(state: WorkspaceState): GraphInput | null {
  const data = state.data
  const plan = data === null ? null : planFor(data, state.view)
  if (data === null || plan === null) {
    return null
  }
  const tickets = state.view === 'draft' ? data.draftTickets : data.savedTickets
  return {
    plan,
    mode: state.view,
    run: data.run,
    statuses: new Map(tickets.map((item) => [item.id, item.status])),
    outcome: outcomeOf(data),
    rejected: state.rejected,
    draftNumber: nextRevisionNumber(data.epic)
  }
}
