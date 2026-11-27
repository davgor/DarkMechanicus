/** Pure state for the epic workspace: loaded data, the shown view, selection, and feedback. */
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { TransferView } from '../../../shared/domain/transfer'
import type { GraphInput } from '../graph/graphModel'
import { nextRevisionNumber, type ConfirmKind } from './headerView'
import type {
  CheckpointView,
  EpicDetailView,
  PlanView,
  RunView,
  SprintReportView,
  TicketSummaryView,
  ValidationReport
} from '../../../shared/domain/views'

export type PlanViewKind = 'saved' | 'draft'

/** The Transfer to Linear dialog: authorizing a new transfer, or starting an agent on the open one again. */
export type TransferDialogMode = 'queue' | 'resume'

/** What a completed run leaves for the epic overview, read from the run history. */
export interface OverviewData {
  /** The revision the run executed (sprint ordinals, ticket keys, criterion texts); null if unreadable. */
  bundle: PlanBundle | null
  /** The latest report of each sprint, in sprint order. */
  reports: SprintReportView[]
}

export interface WorkspaceData {
  epic: EpicDetailView
  saved: PlanView | null
  draft: PlanView | null
  run: RunView | null
  checkpoint: CheckpointView | null
  savedTickets: TicketSummaryView[]
  draftTickets: TicketSummaryView[]
  validation: ValidationReport | null
  /** Where the epic's Linear transfer stands; null when none can exist (no saved plan, or a completed epic). */
  transfer: TransferView | null
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
  layout: 'graph' | 'list' | 'agent'
  selectedTicketId: string | null
  /** The epic chat the Agent stage shows; null leaves it to the default (the active run's orchestrator, else the newest chat). */
  agentChatId: string | null
  /** A subagent thread of `agentChatId` shown read-only with the relay composer; null shows the chat itself. */
  agentThreadId: string | null
  /**
   * An agent link or landing (a notification, the ticket's Activity tab, an "Open chat" link) asked the Agent stage to
   * show the selected agent: its rail expands even where it starts collapsed, then `agent_revealed` clears this.
   */
  agentReveal: boolean
  /**
   * Set when the person opened the live activity of an attempt (the hourglass, the attempts strip): the ticket panel
   * shows its Activity tab for that attempt. A new object per request, so asking again brings the tab back.
   */
  activity: { attemptId: string } | null
  /**
   * Set when another screen asked for a ticket's Scorecard tab (a Metrics dashboard gap): the ticket panel shows it,
   * on `runId`'s grade (null: the newest attempt's run). A new object per request, so asking again brings the tab back.
   */
  ticketScorecard: { runId: string | null } | null
  /** The checkpoint review, or a completed epic's overview, is shown instead of the plan. */
  checkpointOpen: boolean
  /** The epic's Scorecard is shown instead of the plan (and instead of the checkpoint review or overview). */
  scorecardOpen: boolean
  /** Rejected edit or failed action, shown over the canvas. */
  banner: string | null
  rejected: { from: string; to: string } | null
  toast: string | null
  /** Save feedback shown in the validation panel. */
  saveNotice: Notice | null
  busy: boolean
  confirm: ConfirmKind | null
  /** The Start run dialog is open. */
  startRunOpen: boolean
  /** The Transfer to Linear dialog is open, and for what; null while it is closed. */
  transferDialog: TransferDialogMode | null
  validation: ValidationReport | null
}

export type WorkspaceAction =
  | { type: 'load_started' }
  | { type: 'load_succeeded'; data: WorkspaceData; at: number }
  | { type: 'load_failed'; message: string; unavailable?: boolean }
  /** The person picked a view: show it and remember the choice (unless `remember` is false, as when a link needs a view). */
  | { type: 'show_view'; view: PlanViewKind; remember?: boolean }
  /** Save or Discard ended the draft: show Saved and forget the choice, so the next draft opens by default. */
  | { type: 'draft_closed' }
  /** An unchanged draft the load skipped was read on request: add it to the loaded data. */
  | { type: 'draft_loaded'; draft: Pick<WorkspaceData, 'draft' | 'draftTickets' | 'validation'> }
  | { type: 'show_layout'; layout: 'graph' | 'list' | 'agent' }
  | { type: 'select_ticket'; ticketId: string | null }
  /** Show an epic chat, or one of its subagent threads, in the Agent stage. */
  | { type: 'select_agent'; chatId: string; threadId?: string | null }
  /**
   * An "Open chat" link or landing inside the epic: show the Agent stage with that chat, or one of its threads, selected
   * and revealed in the rail. The ticket panel closes, since it floats over the rail.
   */
  | { type: 'open_agent'; chatId: string; threadId?: string | null }
  /** The Agent stage expanded its rail for `agentReveal`. */
  | { type: 'agent_revealed' }
  /** Select the ticket and show the live activity of one of its attempts in its panel. */
  | { type: 'open_activity'; ticketId: string; attemptId: string }
  /** Select the ticket and show its Scorecard tab, on one run's grade when named. */
  | { type: 'open_ticket_scorecard'; ticketId: string; runId: string | null }
  | { type: 'open_checkpoint' }
  | { type: 'close_checkpoint' }
  | { type: 'open_scorecard' }
  | { type: 'close_scorecard' }
  | { type: 'busy'; value: boolean }
  | { type: 'banner'; text: string | null; rejected?: { from: string; to: string } | null }
  | { type: 'toast'; text: string | null }
  | { type: 'save_notice'; notice: Notice | null }
  | { type: 'confirm'; kind: ConfirmKind | null }
  | { type: 'start_run_dialog'; open: boolean }
  | { type: 'transfer_dialog'; mode: TransferDialogMode | null }
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
    agentChatId: null,
    agentThreadId: null,
    agentReveal: false,
    activity: null,
    ticketScorecard: null,
    checkpointOpen: false,
    scorecardOpen: false,
    banner: null,
    rejected: null,
    toast: null,
    saveNotice: null,
    busy: false,
    confirm: null,
    startRunOpen: false,
    transferDialog: null,
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
    // Approving the final checkpoint completes the run: its overview replaces the review in place.
    checkpointOpen: state.checkpointOpen && (data.checkpoint !== null || data.run?.state === 'completed'),
    validation: data.validation
  }
}

type Handlers = {
  [K in WorkspaceAction['type']]: (state: WorkspaceState, action: Extract<WorkspaceAction, { type: K }>) => WorkspaceState
}

/** Shows a view, clearing feedback that belonged to the previous one. */
function showView(state: WorkspaceState, view: PlanViewKind, chosenView: PlanViewKind | null): WorkspaceState {
  return { ...state, view, chosenView, banner: null, rejected: null, checkpointOpen: false, scorecardOpen: false, saveNotice: null, confirm: null }
}

const HANDLERS: Handlers = {
  load_started: (state) => ({ ...state, loading: true }),
  load_succeeded: (state, action) => loadSucceeded(state, action.data, action.at),
  load_failed: (state, action) => ({
    ...(action.unavailable ? initialWorkspaceState(state.chosenView) : state),
    loading: false,
    loadError: action.message
  }),
  show_view: (state, action) => showView(state, action.view, action.remember === false ? state.chosenView : action.view),
  draft_closed: (state) => showView(state, 'saved', null),
  draft_loaded: (state, action) =>
    state.data === null ? state : { ...state, data: { ...state.data, ...action.draft }, validation: action.draft.validation },
  show_layout: (state, action) => ({
    ...state,
    layout: action.layout,
    checkpointOpen: action.layout === 'agent' ? false : state.checkpointOpen,
    scorecardOpen: false
  }),
  select_ticket: (state, action) => ({ ...state, selectedTicketId: action.ticketId, activity: null, ticketScorecard: null }),
  select_agent: (state, action) => ({ ...state, agentChatId: action.chatId, agentThreadId: action.threadId ?? null }),
  open_agent: (state, action) => ({
    ...state,
    layout: 'agent',
    agentChatId: action.chatId,
    agentThreadId: action.threadId ?? null,
    agentReveal: true,
    selectedTicketId: null,
    activity: null,
    ticketScorecard: null,
    checkpointOpen: false,
    scorecardOpen: false
  }),
  agent_revealed: (state) => ({ ...state, agentReveal: false }),
  open_activity: (state, action) => ({ ...state, selectedTicketId: action.ticketId, activity: { attemptId: action.attemptId }, ticketScorecard: null }),
  open_ticket_scorecard: (state, action) => ({ ...state, selectedTicketId: action.ticketId, activity: null, ticketScorecard: { runId: action.runId } }),
  open_checkpoint: (state) => ({ ...state, layout: state.layout === 'agent' ? 'graph' : state.layout, checkpointOpen: true, scorecardOpen: false }),
  close_checkpoint: (state) => ({ ...state, checkpointOpen: false }),
  open_scorecard: (state) => ({ ...state, scorecardOpen: true, checkpointOpen: false }),
  close_scorecard: (state) => ({ ...state, scorecardOpen: false }),
  busy: (state, action) => ({ ...state, busy: action.value }),
  banner: (state, action) => ({ ...state, banner: action.text, rejected: action.rejected ?? null }),
  toast: (state, action) => ({ ...state, toast: action.text }),
  save_notice: (state, action) => ({ ...state, saveNotice: action.notice }),
  confirm: (state, action) => ({ ...state, confirm: action.kind }),
  start_run_dialog: (state, action) => ({ ...state, startRunOpen: action.open }),
  transfer_dialog: (state, action) => ({ ...state, transferDialog: action.mode }),
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
