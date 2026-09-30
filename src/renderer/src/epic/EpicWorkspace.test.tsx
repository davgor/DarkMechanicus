// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { draftPlan, epicDetail, runView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

describe('epic workspace: Saved view (1)', () => {
  it('shows the breadcrumb, title, saved badge, run bar and graph', async () => {
    renderWorkspace(new FakeBackend())
    expect((await screen.findByText('REV 4 · SAVED')).textContent).toBe('REV 4 · SAVED')
    expect(screen.getByText('darkmechanicus / In progress').textContent).toBe('darkmechanicus / In progress')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Planning vertical slice')
    expect(screen.getByText('Run #2 · pinned to rev 4 · Sprint 2 of 3 · started 2h 14m ago · host Claude Code')).toBeTruthy()
    expect(within(screen.getByLabelText('Ticket counts')).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '4 accepted',
      '1 in review',
      '1 running',
      '1 ready',
      '3 waiting'
    ])
    expect(screen.getByText('DM-202 · RUNNING · ATTEMPT 2').textContent).toBe('DM-202 · RUNNING · ATTEMPT 2')
    expect(button('Edit draft').disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Start run' })).toBe(null)
  })

  it('lists open attempts and the sync time in the attempts strip', async () => {
    renderWorkspace(new FakeBackend())
    const strip = await screen.findByLabelText('Run activity')
    expect(within(strip).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'DM-202 #2 running · lease 04:12',
      'DM-201 #1 submitted',
      'DM-202 #1 failed · 2 tests failed'
    ])
    expect(within(strip).getByText('synced just now').textContent).toBe('synced just now')
    fireEvent.click(within(strip).getByRole('button', { name: 'Attempts' }))
    expect(within(strip).getAllByRole('listitem').length).toBe(4)
    expect(within(strip).getByRole('button', { name: 'Attempts' }).getAttribute('aria-expanded')).toBe('true')
  })
})

describe('epic workspace: Saved view (2)', () => {
  it('switches to the list view grouped by sprint', async () => {
    renderWorkspace(new FakeBackend())
    fireEvent.click(await screen.findByRole('button', { name: 'List' }))
    const list = screen.getByLabelText('Plan list')
    expect(within(list).getAllByRole('heading').map((item) => item.textContent)).toEqual([
      'SPRINT 1Storage foundation',
      'SPRINT 2Authoring through MCP',
      'SPRINT 3Desktop editing'
    ])
    expect(button('List').getAttribute('aria-pressed')).toBe('true')
    expect(button('Graph').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(list).getByRole('button', { name: 'DM-202' }))
    expect((await screen.findByLabelText('Ticket DM-202')).tagName).toBe('ASIDE')
    fireEvent.click(button('Graph'))
    expect(screen.getByLabelText('Plan graph').className).toBe('pg is-readonly')
  })

  it('offers Start run when there is no active run', async () => {
    const h = renderWorkspace(new FakeBackend(scenario({ run: null, checkpoint: null })))
    const start = await screen.findByRole('button', { name: 'Start run' })
    expect([screen.queryByLabelText('Run activity'), screen.queryByLabelText('Run')]).toEqual([null, null])
    fireEvent.click(start)
    expect(await screen.findByText('Run queued. It starts when an orchestrator picks it up.')).toBeTruthy()
    expect(h.backend.inputs('queueRun')).toEqual([{ epicId: 'ep_1' }])
    expect(h.changes.count).toBe(1)
    expect((await screen.findByText('QUEUED')).textContent).toBe('QUEUED')
    expect(screen.queryByRole('button', { name: 'Start run' })).toBe(null)
  })
})

describe('epic workspace: Draft view', () => {
  it('opens a draft and shows the unsaved badge, draft bar and validation panel', async () => {
    const h = renderWorkspace(new FakeBackend())
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }))
    expect((await screen.findByText('DRAFT REV 5 · UNSAVED')).textContent).toBe('DRAFT REV 5 · UNSAVED')
    expect(h.backend.names().includes('openDraft')).toBe(true)
    expect(screen.getByText('Changes stay in draft rev 5 until you save. Run #2 keeps executing rev 4 unchanged.')).toBeTruthy()
    const panel = screen.getByLabelText('Draft validation')
    expect(within(panel).getByText('VALIDATION · 0 ERRORS · 1 WARNING')).toBeTruthy()
    expect(within(panel).getByText("Saving doesn't change run #2. Adopt rev 5 at the Sprint 2 checkpoint.")).toBeTruthy()
    expect(screen.getByLabelText('Plan graph').className).toBe('pg is-editable')
    expect(h.changes.count).toBe(1)
  })

  it('saves the draft as a new revision and returns to the Saved view', async () => {
    const h = renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() })))
    fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
    const panel = await screen.findByLabelText('Draft validation')
    fireEvent.click(within(panel).getByRole('button', { name: 'Save rev 5' }))
    expect(await screen.findByText('Saved rev 5.')).toBeTruthy()
    expect(h.backend.inputs('savePlan')).toEqual([{ epicId: 'ep_1', expectedDraftRevision: 7 }])
    expect((await screen.findByText('REV 5 · SAVED')).textContent).toBe('REV 5 · SAVED')
    fireEvent.click(button('Dismiss notification'))
    expect(screen.queryByText('Saved rev 5.')).toBe(null)
  })

  it('keeps the draft and says so when the save is pending', async () => {
    const backend = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() }))
    backend.handlers.savePlan = () => ({ status: 'pending', epicId: 'ep_1', revisionId: 'rv_5', revisionNumber: 5, contentHash: 'h', error: null })
    renderWorkspace(backend)
    fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
    const header = screen.getByRole('banner')
    fireEvent.click(await within(header).findByRole('button', { name: 'Save rev 5' }))
    const pending = await screen.findByText("Save pending — the snapshot hasn't been written yet; your draft is kept.")
    expect(pending.getAttribute('role')).toBe('status')
    expect(screen.getByText('DRAFT REV 5 · UNSAVED').textContent).toBe('DRAFT REV 5 · UNSAVED')
  })
})

describe('epic workspace: details that must appear only when relevant', () => {
  it('shows the execution legend and a green saved badge with a run', async () => {
    renderWorkspace(new FakeBackend())
    const badge = await screen.findByText('REV 4 · SAVED')
    expect(badge.closest('.ew-pill')?.className).toBe('ew-pill ew-tone-accepted')
    expect(screen.getByLabelText('Legend').textContent).toBe('AcceptedIn reviewRunningReadyWaitingFailedPrerequisite metWaiting on it')
    expect(within(screen.getByLabelText('Run activity')).queryByText('No open attempts')).toBe(null)
  })

  it('shows a plain legend and an empty strip for a run without attempts', async () => {
    renderWorkspace(new FakeBackend(scenario({ run: runView({ attempts: [], state: 'queued' }), checkpoint: null })))
    expect((await screen.findByText('No open attempts')).textContent).toBe('No open attempts')
    const quiet = new FakeBackend(scenario({ run: null, checkpoint: null }))
    cleanup()
    renderWorkspace(quiet)
    expect((await screen.findByLabelText('Legend')).textContent).toBe('Prerequisite')
  })

  it('marks the selected row in the list view', async () => {
    renderWorkspace(new FakeBackend())
    fireEvent.click(await screen.findByRole('button', { name: 'List' }))
    fireEvent.click(screen.getByRole('button', { name: 'DM-101' }))
    const selected = screen.getByRole('button', { name: 'DM-101' }).closest('tr')
    expect(selected?.className).toBe('is-selected')
    expect(screen.getByRole('button', { name: 'DM-102' }).closest('tr')?.className).toBe('')
  })
})

describe('epic workspace: draft validation panel', () => {
  it('lists changes since the base revision without an empty-state line', async () => {
    renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() })))
    fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
    const changes = await screen.findByLabelText('Changes')
    expect(within(changes).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '+DM-305 Plan list view: added to Sprint 3',
      '~DM-302: acceptance criteria edited (2 lines)',
      '~Sprint 3: concurrency cap 2 → 3',
      '−DM-202: no longer requires DM-102'
    ])
    expect(within(changes).queryByText('No changes yet.')).toBe(null)
    expect(screen.queryByRole('note')).toBe(null)
    expect(document.querySelectorAll('.ew-save-blocked, .ew-save-notice').length).toBe(0)
  })

  it('blocks Save while validation reports errors', async () => {
    const report = { valid: false, errors: [{ code: 'cycle', message: 'Dependency cycle: DM-1 → DM-2 → DM-1.' }], warnings: [] }
    renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan({ changes: [] }), validation: report })))
    fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
    const panel = await screen.findByLabelText('Draft validation')
    expect(within(panel).getByText('VALIDATION · 1 ERROR · 0 WARNINGS')).toBeTruthy()
    expect(within(panel).getByText('Fix 1 error before saving.').className).toBe('ew-save-blocked')
    expect((within(panel).getByRole('button', { name: 'Save rev 5' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(panel).getByText('No changes yet.').textContent).toBe('No changes yet.')
  })

  it('shows a rejected save inline as an alert', async () => {
    const backend = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() }))
    backend.fail('savePlan', 'stale_draft', 'The saved plan changed since this draft was opened.')
    renderWorkspace(backend)
    fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
    fireEvent.click(within(await screen.findByLabelText('Draft validation')).getByRole('button', { name: 'Save rev 5' }))
    const alert = await screen.findByText('The saved plan changed since this draft was opened.')
    expect(alert.getAttribute('role')).toBe('alert')
  })
})
