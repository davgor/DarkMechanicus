// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

const existing = folderView({ path: '/home/u/alpha', name: 'alpha', displayPath: '~/alpha' })
const clonedFolder = folderView({ path: '/home/u/GitHub/Hello-World', name: 'Hello-World', displayPath: '~/GitHub/Hello-World' })

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.git.cloneParent = '/home/u/GitHub'
  // Main tracks the clone, so the folder list read after it includes the new folder.
  const clone = h.git.clone.bind(h.git)
  h.git.clone = async (request) => {
    const result = await clone(request)
    if (result.ok) h.dm.folders = [...h.dm.folders, clonedFolder]
    return result.ok ? { ok: true, data: clonedFolder } : result
  }
})

afterEach(cleanup)

async function cloneHelloWorld(): Promise<void> {
  const dialog = within(screen.getByRole('dialog', { name: 'Clone a repository' }))
  fireEvent.click(dialog.getByRole('tab', { name: 'URL' }))
  fireEvent.change(dialog.getByLabelText('Repository URL or owner/repo'), { target: { value: 'octocat/Hello-World' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Clone' }))
  await settle()
}

describe('App cloning', () => {
  it('clones from the sidebar +, then selects the new folder on Source control', async () => {
    h.dm.folders = [existing]
    h.rememberEpicsTab(existing.path, clonedFolder.path)
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Add a folder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clone repository…' }))
    await settle()
    await cloneHelloWorld()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Hello-World ~/GitHub/Hello-World' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Source control' }).getAttribute('aria-selected')).toBe('true')
  })

  it('offers cloning on the welcome view', async () => {
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Clone repository' }))
    await settle()
    await cloneHelloWorld()
    expect(screen.getByRole('button', { name: 'Hello-World ~/GitHub/Hello-World' }).getAttribute('aria-current')).toBe('true')
  })

  it('leaves the selection alone when the dialog is closed', async () => {
    h.dm.folders = [existing]
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Add a folder' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clone repository…' }))
    await settle()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: /Hello-World/ })).toBeNull()
  })
})
