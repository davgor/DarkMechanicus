import { describe, expect, it } from 'vitest'
import { epicDetail, runView } from './__mocks__/fixtures'
import { confirmCopy, headerView, nextRevisionNumber, READ_ONLY_MESSAGE } from './headerView'

describe('header badge and breadcrumb', () => {
  it('shows the saved revision in the Saved view', () => {
    const view = headerView({ folderName: 'darkmechanicus', epic: epicDetail(), view: 'saved', hasActiveRun: false })
    expect(view.breadcrumb).toBe('darkmechanicus / In progress')
    expect(view.badge).toEqual({ label: 'REV 4 · SAVED', tone: 'saved' })
  })

  it('shows the unsaved draft revision in the Draft view', () => {
    const view = headerView({ folderName: 'dm', epic: epicDetail({ hasDraft: true }), view: 'draft', hasActiveRun: true })
    expect(view.badge).toEqual({ label: 'DRAFT REV 5 · UNSAVED', tone: 'draft' })
    expect(nextRevisionNumber(epicDetail({ currentRevisionNumber: null }))).toBe(1)
  })

  it('has no saved badge before the first save', () => {
    const epic = epicDetail({ status: 'backlog', currentRevisionId: null, currentRevisionNumber: null, hasDraft: true })
    const view = headerView({ folderName: 'dm', epic, view: 'saved', hasActiveRun: false })
    expect(view.badge).toBe(null)
    expect(view.breadcrumb).toBe('dm / Backlog')
  })
})

describe('header actions', () => {
  it('offers Edit draft and Start run in the Saved view', () => {
    const view = headerView({ folderName: 'dm', epic: epicDetail(), view: 'saved', hasActiveRun: false })
    expect(view.actions).toEqual({ editDraft: 'edit', viewSaved: false, discard: false, save: null, startRun: true })
    expect(view.readOnly).toBe(null)
  })

  it('offers View draft when a draft exists and hides Start run during an active run', () => {
    const view = headerView({ folderName: 'dm', epic: epicDetail({ hasDraft: true }), view: 'saved', hasActiveRun: true })
    expect(view.actions).toEqual({ editDraft: 'view', viewSaved: false, discard: false, save: null, startRun: false })
  })

  it('cannot start a run without a saved revision', () => {
    const epic = epicDetail({ currentRevisionId: null, currentRevisionNumber: null })
    expect(headerView({ folderName: 'dm', epic, view: 'saved', hasActiveRun: false }).actions.startRun).toBe(false)
  })

  it('offers Discard and Save (distinct from starting a run) in the Draft view', () => {
    const view = headerView({ folderName: 'dm', epic: epicDetail({ hasDraft: true }), view: 'draft', hasActiveRun: false })
    expect(view.actions).toEqual({ editDraft: null, viewSaved: true, discard: true, save: 'Save rev 5', startRun: false })
    const unsaved = epicDetail({ currentRevisionId: null, currentRevisionNumber: null, hasDraft: true })
    expect(headerView({ folderName: 'dm', epic: unsaved, view: 'draft', hasActiveRun: false }).actions).toEqual({
      editDraft: null,
      viewSaved: false,
      discard: true,
      save: 'Save rev 1',
      startRun: false
    })
  })

  it('makes completed epics read-only with no reopen, edit or run actions', () => {
    const epic = epicDetail({ status: 'completed' })
    const view = headerView({ folderName: 'dm', epic, view: 'saved', hasActiveRun: false })
    expect(view.actions).toEqual({ editDraft: null, viewSaved: false, discard: false, save: null, startRun: false })
    expect(view.readOnly).toBe(READ_ONLY_MESSAGE)
    expect(READ_ONLY_MESSAGE).toBe('Completed epics are read-only. Create a new epic to extend this work.')
    expect(view.breadcrumb).toBe('dm / Completed')
  })
})

describe('header notices', () => {
  it('reports a pending save and an import conflict', () => {
    const epic = epicDetail({ pendingSave: true, conflict: 'Tracked state changed on another branch.' })
    expect(headerView({ folderName: 'dm', epic, view: 'saved', hasActiveRun: false }).notices).toEqual([
      "A save is pending — the snapshot hasn't been written yet.",
      'Tracked state changed on another branch.'
    ])
    expect(headerView({ folderName: 'dm', epic: epicDetail(), view: 'saved', hasActiveRun: false }).notices).toEqual([])
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
})
