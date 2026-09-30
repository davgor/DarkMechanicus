// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { EPIC_A, EPIC_B, epicSummary, folderView, storageStatus } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
  h.epics['/a'] = [
    epicSummary({ id: EPIC_A, title: 'Planning slice', status: 'in_progress' }),
    epicSummary({ id: EPIC_B, title: 'Backlog idea', status: 'backlog' })
  ]
})

afterEach(cleanup)

const stub = (): string | null => screen.getByTestId('epic-stub').textContent
const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))

async function openEpicA(): Promise<void> {
  h.mount()
  await settle()
  fireEvent.click(sidebar().getByRole('button', { name: /Planning slice/ }))
  await settle()
}

async function poll(): Promise<void> {
  act(() => h.scheduler.fireIntervals())
  await settle()
}

describe('App event polling', () => {
  it('polls the selected folder every 1.5 seconds', async () => {
    await openEpicA()
    expect(h.scheduler.intervals()).toEqual([1500])
  })

  it('polls other expanded folders every 5 seconds', async () => {
    h.dm.folders = [...h.dm.folders, folderView({ path: '/b', name: 'beta', displayPath: '~/code/beta' })]
    h.mount()
    await settle()
    expect(h.scheduler.intervals()).toEqual([1500, 5000])
  })

  it('does not replay history when it starts', async () => {
    h.log('/a').append({ epicId: EPIC_A })
    h.log('/a').append({ epicId: EPIC_A })
    await openEpicA()
    expect(stub()).toBe(`alpha|${EPIC_A}|0`)
  })

  it('bumps only the refresh token of the epic named by an event', async () => {
    await openEpicA()
    h.log('/a').append({ epicId: EPIC_B })
    await poll()
    expect(stub()).toBe(`alpha|${EPIC_A}|0`)
    h.log('/a').append({ epicId: EPIC_A })
    await poll()
    expect(stub()).toBe(`alpha|${EPIC_A}|1`)
  })

  it('keeps the epic view mounted, and its state, while tokens change', async () => {
    await openEpicA()
    const before = screen.getByTestId('epic-stub')
    h.log('/a').append({ epicId: EPIC_A })
    await poll()
    expect(screen.getByTestId('epic-stub')).toBe(before)
  })
})

describe('App refreshing after events', () => {
  it('refetches the epic list and shows new epics in the sidebar', async () => {
    await openEpicA()
    h.epics['/a'] = [...(h.epics['/a'] ?? []), epicSummary({ id: 'ep_new', title: 'Agent-made epic', status: 'backlog' })]
    h.log('/a').append({ epicId: 'ep_new' })
    await poll()
    expect(sidebar().getByRole('button', { name: /Agent-made epic/ })).toBeTruthy()
    expect(sidebar().getByRole('button', { name: 'Backlog, 2 epics' })).toBeTruthy()
  })

  it('moves an epic between buckets when its status changes', async () => {
    await openEpicA()
    h.epics['/a'] = [epicSummary({ id: EPIC_A, title: 'Planning slice', status: 'completed', completedAt: '2026-03-15T12:00:00.000Z' })]
    h.log('/a').append({ epicId: EPIC_A })
    await poll()
    expect(sidebar().getByRole('button', { name: 'In progress, 0 epics' })).toBeTruthy()
    expect(sidebar().getByRole('button', { name: 'Completed, 1 epic' })).toBeTruthy()
  })

  it('refetches the storage status', async () => {
    await openEpicA()
    expect(screen.getByText('Waiting for an agent')).toBeTruthy()
    h.statuses['/a'] = storageStatus({ sessions: { active: 1, byRole: { planner: 1 } } })
    h.log('/a').append({ epicId: EPIC_A })
    await poll()
    expect(screen.getByText('1 agent session · stdio')).toBeTruthy()
  })

  it('does not refetch anything while nothing happens', async () => {
    await openEpicA()
    const before = h.dm.callsOf('listEpics').length + h.dm.callsOf('getStorageStatus').length
    await poll()
    await poll()
    expect(h.dm.callsOf('listEpics').length + h.dm.callsOf('getStorageStatus').length).toBe(before)
  })

  it('refreshes the sidebar right after a local change reported by the epic view', async () => {
    await openEpicA()
    const before = h.dm.callsOf('listEpics').length
    h.epics['/a'] = [epicSummary({ id: EPIC_A, title: 'Renamed slice', status: 'in_progress' })]
    fireEvent.click(screen.getByRole('button', { name: 'stub changed' }))
    await settle()
    expect(h.dm.callsOf('listEpics').length).toBe(before + 1)
    expect(sidebar().getByRole('button', { name: /Renamed slice/ })).toBeTruthy()
  })
})

describe('App feed failures', () => {
  it('reports an unreachable event feed once', async () => {
    h.dm.failures.listEvents = { code: 'internal', message: 'main process busy' }
    h.mount()
    await settle()
    await poll()
    await poll()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('main process busy')
  })
})
