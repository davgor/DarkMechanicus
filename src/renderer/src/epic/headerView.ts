/** Pure view model for the epic header: breadcrumb, revision badge, and plan actions. */
import { WORK_STATUS_LABELS } from '../../../shared/domain/status'
import type { EpicDetailView } from '../../../shared/domain/views'

export const READ_ONLY_MESSAGE = 'Completed epics are read-only. Create a new epic to extend this work.'

export interface HeaderInput {
  folderName: string
  epic: EpicDetailView
  view: 'saved' | 'draft'
  hasActiveRun: boolean
}

export interface HeaderActions {
  /** Saved view: open a draft (`edit`) or switch to the existing one (`view`). */
  editDraft: 'edit' | 'view' | null
  /** Draft view: switch back to the saved revision. */
  viewSaved: boolean
  discard: boolean
  /** Save button label, e.g. "Save rev 5". */
  save: string | null
  startRun: boolean
}

export interface HeaderView {
  breadcrumb: string
  badge: { label: string; tone: 'saved' | 'draft' } | null
  actions: HeaderActions
  readOnly: string | null
  notices: string[]
}

const NO_ACTIONS: HeaderActions = { editDraft: null, viewSaved: false, discard: false, save: null, startRun: false }

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

function actionsFor(input: HeaderInput): HeaderActions {
  const epic = input.epic
  if (epic.status === 'completed') {
    return NO_ACTIONS
  }
  if (input.view === 'draft') {
    return { ...NO_ACTIONS, viewSaved: epic.currentRevisionId !== null, discard: true, save: `Save rev ${nextRevisionNumber(epic)}` }
  }
  return {
    ...NO_ACTIONS,
    editDraft: epic.hasDraft ? 'view' : 'edit',
    startRun: epic.currentRevisionId !== null && !input.hasActiveRun
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
