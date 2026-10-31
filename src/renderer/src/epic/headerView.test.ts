import { describe, expect, it } from 'vitest'
import type { EpicDetailView } from '../../../shared/domain/views'
import { epicDetail, runView } from './__mocks__/fixtures'
import { confirmCopy, headerView, nextRevisionNumber, READ_ONLY_MESSAGE, SAVE_UNAVAILABLE_MESSAGE, type HeaderView } from './headerView'

interface Situation {
  folderName?: string
  view?: 'saved' | 'draft'
  hasActiveRun?: boolean
  hasOpenTransfer?: boolean
}

/** The header of `epic` in the Saved view with no active run and no open transfer, unless the situation says otherwise. */
function header(epic: EpicDetailView, situation: Situation = {}): HeaderView {
  return headerView({ folderName: 'dm', view: 'saved', hasActiveRun: false, hasOpenTransfer: false, ...situation, epic })
}

describe('header badge and breadcrumb', () => {
  it('shows the saved revision in the Saved view', () => {
    const view = header(epicDetail(), { folderName: 'darkmechanicus' })
    expect(view.breadcrumb).toBe('darkmechanicus / In progress')
    expect(view.badge).toEqual({ label: 'REV 4 · SAVED', tone: 'saved' })
  })

  it('shows the unsaved draft revision in the Draft view', () => {
    const view = header(epicDetail({ hasDraft: true }), { view: 'draft', hasActiveRun: true })
    expect(view.badge).toEqual({ label: 'DRAFT REV 5 · UNSAVED', tone: 'draft' })
    expect(nextRevisionNumber(epicDetail({ currentRevisionNumber: null }))).toBe(1)
  })

  it('has no saved badge before the first save', () => {
    const epic = epicDetail({ status: 'backlog', currentRevisionId: null, currentRevisionNumber: null, hasDraft: true })
    const view = header(epic)
    expect(view.badge).toBe(null)
    expect(view.breadcrumb).toBe('dm / Backlog')
  })
})

describe('header actions', () => {
  it('offers Edit draft, Start run and Transfer to Linear in the Saved view', () => {
    const view = header(epicDetail())
    expect(view.actions).toEqual({ editDraft: 'edit', viewSaved: false, discard: false, save: null, saveUnavailable: null, startRun: true, transfer: true })
    expect(view.readOnly).toBe(null)
  })

  it('offers View draft when a draft exists and hides Start run and Transfer to Linear during an active run', () => {
    const view = header(epicDetail({ hasDraft: true }), { hasActiveRun: true })
    expect(view.actions).toEqual({ editDraft: 'view', viewSaved: false, discard: false, save: null, saveUnavailable: null, startRun: false, transfer: false })
  })

  it('cannot start a run or transfer without a saved revision', () => {
    const epic = epicDetail({ currentRevisionId: null, currentRevisionNumber: null })
    expect(header(epic).actions).toMatchObject({ startRun: false, transfer: false })
  })

  it('offers Discard and Save (distinct from starting a run) in the Draft view', () => {
    const view = header(epicDetail({ hasDraft: true }), { view: 'draft' })
    expect(view.actions).toEqual({ editDraft: null, viewSaved: true, discard: true, save: 'Save rev 5', saveUnavailable: null, startRun: false, transfer: false })
    const unsaved = epicDetail({ currentRevisionId: null, currentRevisionNumber: null, hasDraft: true })
    expect(header(unsaved, { view: 'draft' }).actions).toEqual({
      editDraft: null,
      viewSaved: false,
      discard: true,
      save: 'Save rev 1',
      saveUnavailable: null,
      startRun: false,
      transfer: false
    })
  })

  it('makes completed epics read-only with no reopen, edit, run or transfer actions', () => {
    const epic = epicDetail({ status: 'completed' })
    const view = header(epic)
    expect(view.actions).toEqual({ editDraft: null, viewSaved: false, discard: false, save: null, saveUnavailable: null, startRun: false, transfer: false })
    expect(view.readOnly).toBe(READ_ONLY_MESSAGE)
    expect(READ_ONLY_MESSAGE).toBe('Completed epics are read-only. Create a new epic to extend this work.')
    expect(view.breadcrumb).toBe('dm / Completed')
  })
})

describe('Save in the Draft view while a transfer is open', () => {
  it('hides Save in the Draft view while a transfer is queued or in progress, and offers it again after cancel', () => {
    const draft = epicDetail({ hasDraft: true, draftChanged: true })
    // Queued and in progress both count as open: the workspace passes hasOpenTransfer for either status.
    expect(header(draft, { view: 'draft', hasOpenTransfer: true }).actions).toEqual({
      editDraft: null,
      viewSaved: true,
      discard: true,
      save: null,
      saveUnavailable: 'Save is unavailable while the Linear transfer is open. Cancel the transfer to save.',
      startRun: false,
      transfer: false
    })
    expect(SAVE_UNAVAILABLE_MESSAGE).toContain('Linear transfer')
    // After cancel the transfer is no longer open.
    expect(header(draft, { view: 'draft', hasOpenTransfer: false }).actions).toEqual({
      editDraft: null,
      viewSaved: true,
      discard: true,
      save: 'Save rev 5',
      saveUnavailable: null,
      startRun: false,
      transfer: false
    })
  })
})

describe('Transfer to Linear and Start run in each state', () => {
  const visible = (epic: EpicDetailView, situation: Situation = {}): { transfer: boolean; startRun: boolean } => {
    const { transfer, startRun } = header(epic, situation).actions
    return { transfer, startRun }
  }

  it('offers both for a saved plan with no active run, no open transfer and no draft changes', () => {
    expect(visible(epicDetail())).toEqual({ transfer: true, startRun: true })
    expect(visible(epicDetail({ status: 'backlog' }))).toEqual({ transfer: true, startRun: true })
  })

  it('still offers the transfer when a draft exists without changes, and hides only it once the draft changed', () => {
    expect(visible(epicDetail({ hasDraft: true, draftChanged: false }))).toEqual({ transfer: true, startRun: true })
    expect(visible(epicDetail({ hasDraft: true, draftChanged: true }))).toEqual({ transfer: false, startRun: true })
  })

  it('hides both while a transfer is open: no second transfer, and no run until it is verified or canceled', () => {
    expect(visible(epicDetail(), { hasOpenTransfer: true })).toEqual({ transfer: false, startRun: false })
    expect(header(epicDetail(), { hasOpenTransfer: true }).actions.editDraft).toBe('edit')
  })

  it('hides both during an active run, for a never-saved plan, for a completed epic and in the Draft view', () => {
    const hidden = { transfer: false, startRun: false }
    expect(visible(epicDetail(), { hasActiveRun: true })).toEqual(hidden)
    expect(visible(epicDetail({ currentRevisionId: null, currentRevisionNumber: null }))).toEqual(hidden)
    expect(visible(epicDetail({ status: 'completed' }))).toEqual(hidden)
    expect(visible(epicDetail({ hasDraft: true }), { view: 'draft' })).toEqual(hidden)
  })
})

describe('header notices', () => {
  it('reports a pending save and an import conflict', () => {
    const epic = epicDetail({ pendingSave: true, conflict: 'Tracked state changed on another branch.' })
    expect(header(epic).notices).toEqual([
      "A save is pending — the snapshot hasn't been written yet.",
      'Tracked state changed on another branch.'
    ])
    expect(header(epicDetail()).notices).toEqual([])
  })
})

describe('confirmation copy', () => {
  it('names the draft revision being discarded and the run being canceled', () => {
    expect(confirmCopy('discard', epicDetail(), null)).toEqual({
      title: 'Discard draft',
      text: 'Discard draft rev 5? Its changes are lost; the saved plan stays as it is.',
      confirm: 'Discard draft',
      keep: 'Keep editing'
    })
    expect(confirmCopy('cancel_run', epicDetail(), runView())).toEqual({
      title: 'Cancel run',
      text: 'Cancel Run #2? Open attempts are canceled and no more work is dispatched.',
      confirm: 'Cancel run',
      keep: 'Keep running'
    })
    expect(confirmCopy('cancel_run', epicDetail(), null).text).toBe(
      'Cancel the run? Open attempts are canceled and no more work is dispatched.'
    )
  })

  it('says what canceling a transfer clears and what stays in Linear', () => {
    expect(confirmCopy('cancel_transfer', epicDetail(), null)).toEqual({
      title: 'Cancel transfer',
      text: 'Cancel the Linear transfer? What is recorded here is cleared and runs and Save unlock; what was already created in Linear stays there.',
      confirm: 'Cancel transfer',
      keep: 'Keep transferring'
    })
  })
})
