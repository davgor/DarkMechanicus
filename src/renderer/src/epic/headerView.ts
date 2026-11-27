/** Pure view model for the epic header: breadcrumb, revision badge, and plan actions. */
import { isActiveRunState, WORK_STATUS_LABELS } from '../../../shared/domain/status'
import type { TransferView } from '../../../shared/domain/transfer'
import type { EpicDetailView, RunView } from '../../../shared/domain/views'
import { runLabel } from './runBarView'
import { isOpenTransfer } from './transferView'

export const SAVE_UNAVAILABLE_MESSAGE = 'Save is unavailable while the Linear transfer is open. Cancel the transfer to save.'

export const READ_ONLY_MESSAGE = 'Completed epics are read-only. Create a new epic to extend this work.'

interface HeaderInput {
  folderName: string
  epic: EpicDetailView
  view: 'saved' | 'draft'
  hasActiveRun: boolean
  /** A Linear transfer is queued or in progress: it locks runs until it is verified or canceled. */
  hasOpenTransfer: boolean
}

export interface HeaderActions {
  /** Saved view: open a draft (`edit`) or switch to the existing one (`view`). */
  editDraft: 'edit' | 'view' | null
  /** Draft view: switch back to the saved revision. */
  viewSaved: boolean
  discard: boolean
  /** Save button label, e.g. "Save rev 5". */
  save: string | null
  /** Draft view: why Save is hidden, shown in its place (an open Linear transfer refuses save_plan). */
  saveUnavailable: string | null
  startRun: boolean
  /** Saved view: authorize a Linear transfer of the saved plan (Transfer to Linear). */
  transfer: boolean
}

export interface HeaderView {
  breadcrumb: string
  badge: { label: string; tone: 'saved' | 'draft' } | null
  actions: HeaderActions
  readOnly: string | null
  notices: string[]
}

const NO_ACTIONS: HeaderActions = { editDraft: null, viewSaved: false, discard: false, save: null, saveUnavailable: null, startRun: false, transfer: false }

/** The display number the draft receives when saved. */
export function nextRevisionNumber(epic: EpicDetailView): number {
  return (epic.currentRevisionNumber ?? 0) + 1
}

function badgeFor(epic: EpicDetailView, view: 'saved' | 'draft'): HeaderView['badge'] {
  if (view === 'draft') {
    return { label: `DRAFT REV ${nextRevisionNumber(epic)} · UNSAVED`, tone: 'draft' }
  }
  return epic.currentRevisionNumber === null
    ? null
    : { label: `REV ${epic.currentRevisionNumber} · SAVED`, tone: 'saved' }
}

/** Draft view: save_plan refuses while a transfer is open, so Save gives way to its reason; draft edits and Discard draft stay allowed. */
function draftActions(input: HeaderInput): HeaderActions {
  const epic = input.epic
  return {
    ...NO_ACTIONS,
    viewSaved: epic.currentRevisionId !== null,
    discard: true,
    save: input.hasOpenTransfer ? null : `Save rev ${nextRevisionNumber(epic)}`,
    saveUnavailable: input.hasOpenTransfer ? SAVE_UNAVAILABLE_MESSAGE : null
  }
}

/** The loaded run and transfer as the locks they put on runs: an active run, an open Linear transfer. */
export function runLocks(data: { run: RunView | null; transfer: TransferView | null }): Pick<HeaderInput, 'hasActiveRun' | 'hasOpenTransfer'> {
  return { hasActiveRun: data.run !== null && isActiveRunState(data.run.state), hasOpenTransfer: isOpenTransfer(data.transfer?.status ?? null) }
}

/** Why Start run is withheld from a saved plan. */
export type StartRunBlocker = 'no_plan' | 'active_run' | 'open_transfer'

/**
 * Why a run cannot start from the saved plan, in the order the person can resolve them: no saved plan, an active run,
 * an open Linear transfer; null when Start run is offered.
 */
export function startRunBlocker(input: Pick<HeaderInput, 'epic' | 'hasActiveRun' | 'hasOpenTransfer'>): StartRunBlocker | null {
  if (input.epic.currentRevisionId === null) return 'no_plan'
  if (input.hasActiveRun) return 'active_run'
  return input.hasOpenTransfer ? 'open_transfer' : null
}

function actionsFor(input: HeaderInput): HeaderActions {
  const epic = input.epic
  if (epic.status === 'completed') {
    return NO_ACTIONS
  }
  if (input.view === 'draft') {
    return draftActions(input)
  }
  const saved = epic.currentRevisionId !== null
  return {
    ...NO_ACTIONS,
    editDraft: epic.hasDraft ? 'view' : 'edit',
    startRun: startRunBlocker(input) === null,
    // The same refusals queueTransfer makes: a saved plan, no active run, no open transfer, no unsaved draft changes.
    transfer: saved && !input.hasActiveRun && !input.hasOpenTransfer && !epic.draftChanged
  }
}

function noticesFor(epic: EpicDetailView): string[] {
  const pending = epic.pendingSave ? ["A save is pending — the snapshot hasn't been written yet."] : []
  return epic.conflict === null ? pending : [...pending, epic.conflict]
}

export function headerView(input: HeaderInput): HeaderView {
  const epic = input.epic
  return {
    breadcrumb: `${input.folderName} / ${WORK_STATUS_LABELS[epic.status]}`,
    badge: badgeFor(epic, input.view),
    actions: actionsFor(input),
    readOnly: epic.status === 'completed' ? READ_ONLY_MESSAGE : null,
    notices: noticesFor(epic)
  }
}

interface ConfirmCopy {
  title: string
  text: string
  confirm: string
  keep: string
}

/** What the inline confirmation strip asks about. */
export type ConfirmKind = 'discard' | 'cancel_run' | 'cancel_transfer'

/** Inline confirmation for destructive actions (Electron has no window.prompt; dialogs stay in-page). */
export function confirmCopy(kind: ConfirmKind, epic: EpicDetailView, run: RunView | null): ConfirmCopy {
  if (kind === 'discard') {
    return {
      title: 'Discard draft',
      text: `Discard draft rev ${nextRevisionNumber(epic)}? Its changes are lost; the saved plan stays as it is.`,
      confirm: 'Discard draft',
      keep: 'Keep editing'
    }
  }
  if (kind === 'cancel_transfer') {
    return {
      title: 'Cancel transfer',
      text: 'Cancel the Linear transfer? What is recorded here is cleared and runs and Save unlock; what was already created in Linear stays there.',
      confirm: 'Cancel transfer',
      keep: 'Keep transferring'
    }
  }
  const name = run === null ? 'the run' : runLabel(run)
  return {
    title: 'Cancel run',
    text: `Cancel ${name}? Open attempts are canceled and no more work is dispatched.`,
    confirm: 'Cancel run',
    keep: 'Keep running'
  }
}
