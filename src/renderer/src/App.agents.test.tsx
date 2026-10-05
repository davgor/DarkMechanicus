// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { agentView, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
})

afterEach(cleanup)

const claude = agentView({ kind: 'claude', version: '2.1.4' })
const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))
const workspace = (): ReturnType<typeof within> => within(screen.getByRole('main', { name: 'Workspace' }))
const onFolderHome = (): boolean => screen.queryByRole('heading', { level: 1, name: 'alpha' }) !== null

async function mount(): Promise<void> {
  h.mount()
  await settle()
}

describe('App agents section', () => {
  it('shows the empty note above the folders when no agent is connected', async () => {
    await mount()
    const head = sidebar().getByText('AGENTS')
    expect(sidebar().getByText('No agents yet. Use + to add one.')).toBeTruthy()
    expect(head.compareDocumentPosition(sidebar().getByText('FOLDERS')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('lists connected agents with their version and sign-in state', async () => {
    h.dm.agents = [claude]
    h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    await mount()
    const row = sidebar().getByRole('button', { name: /Claude Code/ })
    expect(within(row).getByText('v2.1.4')).toBeTruthy()
    expect(within(row).getByText('Signed in')).toBeTruthy()
  })
})

describe('App add-agent pane', () => {
  it('replaces the folder home with the three cards when + is pressed', async () => {
    await mount()
    expect(onFolderHome()).toBe(true)
    fireEvent.click(sidebar().getByRole('button', { name: 'Add an agent' }))
    await settle()
    expect(onFolderHome()).toBe(false)
    expect(workspace().getByRole('heading', { level: 1, name: 'Add an agent' })).toBeTruthy()
    expect(workspace().getAllByRole('article')).toHaveLength(3)
  })

  it('goes back to the folder when the folder is chosen in the sidebar', async () => {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'Add an agent' }))
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: 'alpha ~/code/alpha' }))
    await settle()
    expect(onFolderHome()).toBe(true)
  })

  it('is still open after a reload', async () => {
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'Add an agent' }))
    await settle()
    cleanup()
    await mount()
    expect(workspace().getByRole('heading', { level: 1, name: 'Add an agent' })).toBeTruthy()
  })

})

describe('App add-agent pane actions', () => {
  it('lists an agent in the sidebar once Find connects it, and shows it connected on its card', async () => {
    h.dm.findOutcomes = [{ outcome: 'connected', agent: claude }]
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'Add an agent' }))
    await settle()
    fireEvent.click(workspace().getByRole('button', { name: 'Find Claude Code' }))
    await settle()
    expect(h.dm.agentCallsOf('findAgent')).toEqual([['claude']])
    expect(sidebar().getByRole('button', { name: /Claude Code/ })).toBeTruthy()
    expect(workspace().getByText('Connected · v2.1.4')).toBeTruthy()
  })

  it('keeps a download running while the person looks at another page', async () => {
    h.dm.agents = [claude]
    h.dm.holdAgent('downloadAgent')
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: 'Add an agent' }))
    await settle()
    fireEvent.click(workspace().getByRole('button', { name: 'Update Claude Code' }))
    await settle()
    fireEvent.click(sidebar().getByRole('button', { name: /Claude Code/ }))
    await settle()
    expect(workspace().getByText('Waiting for your confirmation…')).toBeTruthy()
    expect((workspace().getByRole('button', { name: 'Update' }) as HTMLButtonElement).disabled).toBe(true)
    expect(h.dm.agentCallsOf('downloadAgent')).toHaveLength(1)
  })
})

describe('App agent page', () => {
  it('opens from the sidebar and marks its row', async () => {
    h.dm.agents = [claude]
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: /Claude Code/ }))
    await settle()
    expect(workspace().getByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
    expect(workspace().getByText('/usr/local/bin/claude')).toBeTruthy()
    expect(sidebar().getByRole('button', { name: /Claude Code/ }).getAttribute('aria-current')).toBe('true')
    expect(onFolderHome()).toBe(false)
  })

  it('is still open after a reload', async () => {
    h.dm.agents = [claude]
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: /Claude Code/ }))
    await settle()
    cleanup()
    await mount()
    expect(workspace().getByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
  })

})

describe('App agent page fallback', () => {
  it('falls back to the folder view when the stored agent is no longer connected', async () => {
    window.localStorage.setItem(
      'dm.selection',
      JSON.stringify({ folderPath: '/a', epicId: null, agentPane: { kind: 'agent', agent: 'claude' } })
    )
    await mount()
    expect(onFolderHome()).toBe(true)
    expect(sidebar().getByText('No agents yet. Use + to add one.')).toBeTruthy()
  })

  it('shows loading, not the folder, while a stored agent page waits for the agent list', async () => {
    window.localStorage.setItem(
      'dm.selection',
      JSON.stringify({ folderPath: '/a', epicId: null, agentPane: { kind: 'agent', agent: 'claude' } })
    )
    h.dm.agents = [claude]
    h.dm.holdAgent('listAgents')
    h.mount()
    await settle()
    expect(onFolderHome()).toBe(false)
  })

  it('removes the agent after a confirmation and falls back to the folder view', async () => {
    h.dm.agents = [claude]
    await mount()
    fireEvent.click(sidebar().getByRole('button', { name: /Claude Code/ }))
    await settle()
    fireEvent.click(workspace().getByRole('button', { name: 'Remove' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    await settle()
    expect(h.dm.agentCallsOf('removeAgent')).toEqual([['claude']])
    expect(onFolderHome()).toBe(true)
    expect(sidebar().queryByRole('button', { name: /Claude Code/ })).toBeNull()
    expect(sidebar().getByText('No agents yet. Use + to add one.')).toBeTruthy()
  })
})
