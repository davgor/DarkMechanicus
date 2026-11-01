// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import type { FolderTab } from '../app/folderTabs'
import { FolderPage } from './FolderPage'

afterEach(cleanup)

const folder = folderView({ name: 'alpha', displayPath: '~/code/alpha' })

function renderPage(tab: FolderTab = 'source'): FolderTab[] {
  const chosen: FolderTab[] = []
  render(
    <FolderPage folder={folder} tab={tab} onTab={(next) => chosen.push(next)}>
      <p>panel body</p>
    </FolderPage>
  )
  return chosen
}

describe('FolderPage', () => {
  it('shows the folder header and the panel', () => {
    renderPage()
    expect(screen.getByText('FOLDER')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'alpha' })).toBeTruthy()
    expect(screen.getByText('~/code/alpha')).toBeTruthy()
    expect(screen.getByRole('tabpanel').textContent).toBe('panel body')
  })

  it('lists the two tabs and marks the chosen one', () => {
    renderPage('epics')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Source control', 'Epics'])
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect(screen.getByRole('tablist', { name: 'Folder sections' })).toBeTruthy()
  })

  it('chooses a tab on click', () => {
    const chosen = renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'Epics' }))
    expect(chosen).toEqual(['epics'])
  })

  it('moves between tabs with the arrow, Home and End keys, wrapping around', () => {
    const chosen = renderPage('source')
    const tab = screen.getByRole('tab', { name: 'Source control' })
    fireEvent.keyDown(tab, { key: 'ArrowRight' })
    fireEvent.keyDown(tab, { key: 'ArrowLeft' })
    fireEvent.keyDown(tab, { key: 'End' })
    fireEvent.keyDown(tab, { key: 'Home' })
    fireEvent.keyDown(tab, { key: 'a' })
    expect(chosen).toEqual(['epics', 'epics', 'epics', 'source'])
  })

  it('only the chosen tab is in the tab order', () => {
    renderPage('epics')
    expect(screen.getByRole('tab', { name: 'Epics' }).getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('tab', { name: 'Source control' }).getAttribute('tabindex')).toBe('-1')
  })
})
