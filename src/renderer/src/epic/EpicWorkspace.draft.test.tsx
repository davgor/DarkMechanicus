// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { draftPlan, epicDetail, runView } from './__mocks__/fixtures'
import { renderWorkspace, type WorkspaceHarness } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

const REJECTION =
  "Dependency not added. DM-203 is in Sprint 2 and can't require DM-301 in Sprint 3. A prerequisite must be in the same sprint or an earlier one."

async function openDraftView(backend = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() }))): Promise<WorkspaceHarness> {
  const h = renderWorkspace(backend)
  fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
  await screen.findByText('DRAFT REV 5 · UNSAVED')
  return h
}

describe('discarding a draft', () => {
  it('asks for confirmation, then discards with the expected draft revision', async () => {
    const h = await openDraftView()
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Discard draft' })
    expect(within(dialog).getByText('Discard draft rev 5? Its changes are lost; the saved plan stays as it is.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('alertdialog')).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard draft' }))
    expect(await screen.findByText('Draft discarded.')).toBeTruthy()
    expect(h.backend.inputs('discardPlanDraft')).toEqual([{ epicId: 'ep_1', expectedDraftRevision: 7 }])
    expect((await screen.findByText('REV 4 · SAVED')).textContent).toBe('REV 4 · SAVED')
  })
})

describe('rejected graph edits', () => {
  it("shows the server's concrete reason when a dependency edit is rejected", async () => {
    const h = await openDraftView()
    h.backend.fail('updatePlanDraft', 'invalid_graph', REJECTION)
    const graph = screen.getByLabelText('Plan graph')
    fireEvent.click(graph.querySelector('[data-id$="-tk_301-null-source"]') as Element)
    fireEvent.click(graph.querySelector('[data-id$="-tk_203-null-target"]') as Element)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(`${REJECTION}×`)
    expect(within(alert).getByText('Dependency not added.').tagName).toBe('STRONG')
    expect(h.backend.inputs('updatePlanDraft')).toEqual([
      { epicId: 'ep_1', ops: [{ op: 'add_dependency', from: 'tk_301', to: 'tk_203' }], expectedDraftRevision: 7 }
    ])
    expect((await screen.findByText('Rejected: would require DM-301')).textContent).toBe('Rejected: would require DM-301')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBe(null)
  })

  it('adds tickets and sprints from the draft bar and sprint labels', async () => {
    const h = await openDraftView()
    fireEvent.click(screen.getAllByRole('button', { name: '+ Ticket' })[0] as HTMLElement)
    fireEvent.click(await screen.findByRole('button', { name: '+ Sprint' }))
    await screen.findByLabelText('Draft validation')
    expect(h.backend.inputs('updatePlanDraft').map((input) => (input as { ops: unknown }).ops)).toEqual([
      [{ op: 'add_ticket', ref: 'new', sprint: 'sp_1', ticket: { title: 'New ticket' } }],
      [{ op: 'add_sprint', sprint: { goal: '' } }]
    ])
  })
})

describe('draft bar details', () => {
  it('warns about a stale draft and links back to the run revision', async () => {
    const stale = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan({ stale: true }) }))
    await openDraftView(stale)
    expect(screen.getByRole('note').textContent).toContain('The saved plan changed since this draft was opened.')
    fireEvent.click(screen.getByRole('button', { name: 'View run #2 on rev 4' }))
    expect((await screen.findByText('REV 4 · SAVED')).textContent).toBe('REV 4 · SAVED')
  })

  it('links to the saved revision when no run is pinned to it', async () => {
    await openDraftView(new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan(), run: null })))
    fireEvent.click(screen.getByRole('button', { name: 'View saved rev 4' }))
    expect((await screen.findByText('REV 4 · SAVED')).textContent).toBe('REV 4 · SAVED')
  })
})

describe('completed and failing epics', () => {
  it('opens completed epics read-only without reopen, edit or run actions', async () => {
    renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ status: 'completed' }), run: runView({ state: 'completed' }) })))
    expect((await screen.findByText('Completed epics are read-only. Create a new epic to extend this work.')).textContent).toBe(
      'Completed epics are read-only. Create a new epic to extend this work.'
    )
    const names = screen.getAllByRole('button').map((item) => item.textContent)
    expect(names.filter((name) => /draft|Start run|Reopen|Save/.test(name ?? ''))).toEqual([])
    expect(screen.getByText('darkmechanicus / Completed').textContent).toBe('darkmechanicus / Completed')
  })

  it('reports a load failure and retries', async () => {
    const backend = new FakeBackend()
    backend.fail('getEpic', 'not_found', 'Epic ep_1 not found.')
    renderWorkspace(backend)
    expect((await screen.findByRole('alert')).textContent).toBe('Epic ep_1 not found.Retry')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect((await screen.findByText('REV 4 · SAVED')).textContent).toBe('REV 4 · SAVED')
  })

  it('reloads when the refresh token changes and keeps data when a refresh fails', async () => {
    const h = renderWorkspace(new FakeBackend())
    await screen.findByText('REV 4 · SAVED')
    const loads = h.backend.inputs('getEpic').length
    h.backend.state.epic = epicDetail({ currentRevisionId: 'rv_5', currentRevisionNumber: 5 })
    h.refresh(1)
    expect((await screen.findByText('REV 5 · SAVED')).textContent).toBe('REV 5 · SAVED')
    expect(h.backend.inputs('getEpic').length).toBe(loads + 1)
    h.backend.fail('getEpic', 'internal', 'Database is locked.')
    h.refresh(2)
    expect((await screen.findByText("Couldn't refresh: Database is locked.")).textContent).toBe("Couldn't refresh: Database is locked.")
    expect(screen.getByText('REV 5 · SAVED').textContent).toBe('REV 5 · SAVED')
  })

  it('opens the source epic of a follow-up', async () => {
    const epic = epicDetail({ provenance: { sourceEpicId: 'ep_0', note: 'follow-up' } })
    const h = renderWorkspace(new FakeBackend(scenario({ epic })))
    fireEvent.click(await screen.findByRole('button', { name: 'Follows an earlier epic' }))
    expect(h.opened).toEqual(['ep_0'])
  })
})
