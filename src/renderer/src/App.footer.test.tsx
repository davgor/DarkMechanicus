// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { EPIC_A, epicDetail, epicSummary, folderView, storageStatus } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.rememberEpicsTab('/a')
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
})

afterEach(cleanup)

const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))

async function start(): Promise<void> {
  h.mount()
  await settle()
}

describe('App footer status', () => {
  it('shows MCP sessions and export state from the storage status', async () => {
    h.statuses['/a'] = storageStatus({ sessions: { active: 3, byRole: { desktop: 1, orchestrator: 2 } }, uncommittedRecordFiles: 3 })
    await start()
    expect(sidebar().getByText('MCP')).toBeTruthy()
    expect(sidebar().getByText('2 agent sessions · stdio')).toBeTruthy()
    expect(sidebar().getByText('Exported · 3 files uncommitted')).toBeTruthy()
  })

  it('shows a pending save and a failed export', async () => {
    h.statuses['/a'] = storageStatus({ outbox: { pending: 1, failed: 0, lastError: null } })
    await start()
    expect(sidebar().getByText('Save pending')).toBeTruthy()
    cleanup()
    h.statuses['/a'] = storageStatus({ outbox: { pending: 0, failed: 1, lastError: 'disk full' } })
    await start()
    expect(sidebar().getByText('Export failed')).toBeTruthy()
  })

  it('shows the status of the selected folder only', async () => {
    h.dm.folders = [...h.dm.folders, folderView({ path: '/setup', name: 'setup', displayPath: '~/setup', initialized: false })]
    h.statuses['/a'] = storageStatus({ uncommittedRecordFiles: 3 })
    await start()
    expect(sidebar().getByText('Exported · 3 files uncommitted')).toBeTruthy()
    fireEvent.click(sidebar().getByRole('button', { name: 'Setup required' }))
    await settle()
    expect(sidebar().getByText('Not initialized')).toBeTruthy()
    expect(sidebar().queryByRole('button', { name: 'Flush' })).toBeNull()
  })
})

describe('App flush', () => {
  it('flushes the selected folder and confirms', async () => {
    h.dm.responses.flushPortableState = { flushed: 2, failed: 0, errors: [] }
    await start()
    fireEvent.click(sidebar().getByRole('button', { name: 'Flush' }))
    await settle()
    expect(h.dm.callsOf('flushPortableState').map((call) => call.folder)).toEqual(['/a'])
    expect(screen.getByText('Exported 2 pending changes.')).toBeTruthy()
  })

  it('is busy while flushing and refreshes the status afterwards', async () => {
    const gate = h.dm.holdNext('flushPortableState')
    h.dm.responses.flushPortableState = { flushed: 1, failed: 0, errors: [] }
    await start()
    const statusCalls = h.dm.callsOf('getStorageStatus').length
    fireEvent.click(sidebar().getByRole('button', { name: 'Flush' }))
    await settle()
    expect((sidebar().getByRole('button', { name: 'Flush' }) as HTMLButtonElement).disabled).toBe(true)
    gate.resolve()
    await settle()
    expect((sidebar().getByRole('button', { name: 'Flush' }) as HTMLButtonElement).disabled).toBe(false)
    expect(h.dm.callsOf('getStorageStatus').length).toBeGreaterThan(statusCalls)
  })

  it('reports a flush failure as an error toast', async () => {
    h.dm.failures.flushPortableState = { code: 'internal', message: 'Could not write records' }
    await start()
    fireEvent.click(sidebar().getByRole('button', { name: 'Flush' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Could not write records')
  })
})

describe('App reconcile', () => {
  const changed = storageStatus({ branch: { recorded: 'main', current: 'feature/x', changed: true, repository: true } })

  it('warns after a branch change and reconciles on request', async () => {
    h.statuses['/a'] = changed
    h.dm.responses.reconcileRepository = { imported: ['a'], unchanged: [], conflicts: [], profileConflicts: [], rejected: [], branchChanged: true, pausedRuns: [] }
    await start()
    expect(sidebar().getByText('Branch changed: main → feature/x')).toBeTruthy()
    fireEvent.click(sidebar().getByRole('button', { name: 'Reconcile' }))
    await settle()
    expect(h.dm.callsOf('reconcileRepository').map((call) => call.folder)).toEqual(['/a'])
    expect(screen.getByText('Reconciled. 1 record imported.')).toBeTruthy()
  })

  it('shows no warning while the branch matches', async () => {
    await start()
    expect(sidebar().queryByText(/Branch changed/)).toBeNull()
  })
})

describe('App creating epics', () => {
  it('creates an epic from the folder home and opens it', async () => {
    h.dm.handlers.createEpic = () => {
      h.epics['/a'] = [epicSummary({ id: EPIC_A, title: 'Ship it', status: 'backlog' })]
      return epicDetail({ id: EPIC_A, title: 'Ship it' })
    }
    await start()
    fireEvent.click(screen.getByRole('button', { name: 'New epic' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Ship it' } })
    fireEvent.change(screen.getByLabelText('Success criteria'), { target: { value: '- works\n- tested' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create epic' }))
    await settle()
    expect(h.dm.callsOf('createEpic').map((call) => call.input)).toEqual([
      { title: 'Ship it', successCriteria: ['works', 'tested'] }
    ])
    expect(screen.getByTestId('epic-stub').textContent).toBe(`alpha|${EPIC_A}|0`)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sidebar().getByRole('button', { name: /Ship it/ }).getAttribute('aria-current')).toBe('true')
  })

  it('keeps the dialog open and shows the reason when creation fails', async () => {
    h.dm.failures.createEpic = { code: 'invalid_input', message: 'Title is not allowed' }
    await start()
    fireEvent.click(screen.getByRole('button', { name: 'New epic' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create epic' }))
    await settle()
    expect(screen.getByRole('dialog', { name: 'New epic' })).toBeTruthy()
    expect(screen.getByText('Title is not allowed')).toBeTruthy()
  })
})

describe('App updates', () => {
  it('checks for updates from the footer', async () => {
    await start()
    fireEvent.click(sidebar().getByRole('button', { name: 'Check for updates' }))
    expect(h.autoUpdate.checks).toBe(1)
  })

  it('keeps the update banner mounted and offers a restart once downloaded', async () => {
    await start()
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull()
    act(() => h.autoUpdate.emit({ phase: 'downloaded', currentVersion: '0.4.0', availableVersion: '0.5.0' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(h.autoUpdate.installs).toBe(1)
  })

  it('shows a version label next to the brand that follows the app version', async () => {
    await start()
    expect(sidebar().getByLabelText('Application version 0.4.0').textContent).toBe('v0.4.0')
    act(() => h.autoUpdate.emit({ phase: 'idle', currentVersion: '0.5.0' }))
    expect(sidebar().getByLabelText('Application version 0.5.0').textContent).toBe('v0.5.0')
  })
})
