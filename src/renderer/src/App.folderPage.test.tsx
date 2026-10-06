// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { EPIC_A, epicSummary, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

const alpha = folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })
const fresh = folderView({ path: '/n', name: 'newbie', displayPath: '~/code/newbie', initialized: false })

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.dm.folders = [alpha, fresh]
  h.epics['/a'] = [epicSummary({ id: EPIC_A, title: 'Planning slice', status: 'in_progress' })]
})

afterEach(cleanup)

const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))

async function start(): Promise<void> {
  h.mount()
  await settle()
}

const tab = (name: string): HTMLElement => screen.getByRole('tab', { name })

describe('the folder page', () => {
  it('opens on Source control, with the header and both tabs', async () => {
    await start()
    expect(screen.getByRole('heading', { level: 1, name: 'alpha' })).toBeTruthy()
    expect(tab('Source control').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('0 changed files')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New epic' })).toBeNull()
  })

  it('shows the folder home on the Epics tab of an initialized folder', async () => {
    await start()
    fireEvent.click(tab('Epics'))
    await settle()
    expect(screen.getByRole('button', { name: 'New epic' })).toBeTruthy()
    expect(within(screen.getByRole('main')).getByRole('button', { name: /Planning slice/ })).toBeTruthy()
  })

  it('remembers the Epics tab for the folder across a reload, and only for that folder', async () => {
    await start()
    fireEvent.click(tab('Epics'))
    await settle()
    expect(JSON.parse(window.localStorage.getItem('dm.folderTabs') ?? '{}')).toEqual({ '/a': 'epics' })
    cleanup()
    h = new AppHarness()
    h.dm.folders = [alpha, fresh]
    await start()
    expect(tab('Epics').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(sidebar().getByRole('button', { name: 'Setup required' }))
    await settle()
    expect(tab('Source control').getAttribute('aria-selected')).toBe('true')
  })

  it('opens the folder on its remembered tab when its row is clicked', async () => {
    h.rememberEpicsTab('/a')
    await start()
    fireEvent.click(sidebar().getByRole('button', { name: 'Setup required' }))
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: /^alpha/ }))
    await settle()
    expect(tab('Epics').getAttribute('aria-selected')).toBe('true')
  })

})

describe('the folder page memory', () => {
  it('falls back to Source control for an unknown stored tab', async () => {
    window.localStorage.setItem('dm.folderTabs', JSON.stringify({ '/a': 'history' }))
    await start()
    expect(tab('Source control').getAttribute('aria-selected')).toBe('true')
  })

  it('shows onboarding on the Epics tab of a folder that is not initialized', async () => {
    h.rememberEpicsTab('/n')
    window.localStorage.setItem('dm.selection', JSON.stringify({ folderPath: '/n', epicId: null }))
    await start()
    expect(screen.getByRole('button', { name: 'Initialize folder' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New epic' })).toBeNull()
  })

  it('still opens an epic in the epic workspace', async () => {
    await start()
    fireEvent.click(sidebar().getByRole('button', { name: /Planning slice/ }))
    await settle()
    expect(screen.getByTestId('epic-stub').textContent).toBe(`alpha|${EPIC_A}|0`)
    expect(screen.queryByRole('tablist', { name: 'Folder sections' })).toBeNull()
  })

  it('switches tabs with the arrow keys', async () => {
    await start()
    fireEvent.keyDown(tab('Source control'), { key: 'ArrowRight' })
    await settle()
    expect(tab('Epics').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab('Epics'))
  })
})
