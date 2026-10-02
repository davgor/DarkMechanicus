// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { boardImport, boardOpenEpic, EPIC_A, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
})

afterEach(cleanup)

const setup = folderView({
  path: '/home/u/new-service',
  name: 'new-service',
  displayPath: '~/new-service',
  initialized: false
})
const ready = folderView({ ...setup, initialized: true })

const initResult = {
  projectId: 'pj_1',
  name: 'new-service',
  keyPrefix: 'DM',
  createdFiles: [],
  alreadyInitialized: false
}

describe('App first run', () => {
  it('shows a loading state, then invites tracking a folder', async () => {
    h.mount()
    expect(screen.getByRole('status').textContent).toBe('Loading folders…')
    await settle()
    expect(screen.getByRole('heading', { name: 'Track a folder to get started' })).toBeTruthy()
    expect(screen.getByText('No folders yet. Use + to track one.')).toBeTruthy()
  })

  it('shows the brand, version and an idle footer', async () => {
    h.mount()
    await settle()
    expect(screen.getByText('DARK MECHANICUS')).toBeTruthy()
    expect(screen.getByLabelText('Application version 0.4.0').textContent).toBe('v0.4.0')
    expect(screen.getByText('Waiting for an agent')).toBeTruthy()
    expect(screen.getByText('Not initialized')).toBeTruthy()
  })

  it('tracks a folder from the welcome view', async () => {
    h.dm.pickQueue.push({ folder: setup, added: true })
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    await settle()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('new-service')
  })
})

describe('App onboarding', () => {
  it('selects a picked folder and shows its setup flow', async () => {
    h.dm.pickQueue.push({ folder: setup, added: true })
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Track a folder' }))
    await settle()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('new-service isn’t set up for Dark Mechanicus yet')
    expect(screen.getByRole('button', { name: 'Setup required' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByLabelText('MCP server configuration')).toBeTruthy()
  })

  it('initializing reveals the buckets and the folder home', async () => {
    h.dm.folders = [setup]
    h.dm.handlers.initializeRepository = () => {
      h.dm.folders = [ready]
      return initResult
    }
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    await settle()
    expect(h.dm.callsOf('initializeRepository').map((call) => call.folder)).toEqual([setup.path])
    for (const label of ['In progress, 0 epics', 'Backlog, 0 epics', 'Completed, 0 epics']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
    expect(screen.getByRole('heading', { level: 1, name: 'new-service' })).toBeTruthy()
    expect(screen.getByText('Initialized new-service.')).toBeTruthy()
  })

  it('stays on the setup flow and reports why initialization failed', async () => {
    h.dm.folders = [setup]
    h.dm.failures.initializeRepository = { code: 'unsafe_path', message: 'Cannot write here' }
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Cannot write here')
    expect((screen.getByRole('button', { name: 'Initialize folder' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('offers another folder from the setup flow', async () => {
    h.dm.folders = [setup]
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a different folder' }))
    await settle()
    expect(h.dm.calls).toContain('pickFolder')
  })
})

describe('App onboarding with Claude Code', () => {
  it('writes .mcp.json for Claude Code while initializing, unless the option is turned off', async () => {
    h.dm.folders = [setup]
    h.dm.handlers.initializeRepository = () => initResult
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    await settle()
    expect(h.dm.claudeConnects).toEqual([
      { folder: setup.path, request: { role: 'planner', allowSave: true, replace: false } }
    ])
    expect(screen.getByText('Created .mcp.json for Claude Code.')).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Also write .mcp.json so Claude Code can connect' }))
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    await settle()
    expect(h.dm.callsOf('initializeRepository')).toHaveLength(2)
    expect(h.dm.claudeConnects).toHaveLength(1)
  })
})

describe('App onboarding with an old-style board', () => {
  it('previews the board, imports it after initializing when chosen, and lands on the folder home', async () => {
    h.dm.folders = [setup]
    h.dm.responses.previewBoardImport = boardImport()
    h.dm.responses.importBoard = boardImport({ open: [boardOpenEpic({ state: 'created', epicId: EPIC_A })] })
    h.dm.handlers.initializeRepository = () => {
      h.dm.folders = [ready]
      return initResult
    }
    h.mount()
    await settle()
    expect(screen.getByRole('region', { name: 'Old-style board' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import 1 open epic from board/ as a draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    await settle()
    expect(h.dm.callsOf('importBoard').map((call) => [call.folder, call.input])).toEqual([[setup.path, {}]])
    expect(screen.getByText('Imported 1 epic from board/ as a draft. Review it and press Save.')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'new-service' })).toBeTruthy()
  })
})

describe('App folder states', () => {
  it('selects an already tracked folder instead of duplicating it', async () => {
    h.dm.folders = [ready]
    h.dm.pickQueue.push({ folder: ready, added: false })
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Track a folder' }))
    await settle()
    expect(screen.getAllByRole('button', { name: 'new-service ~/new-service' })).toHaveLength(1)
    expect(screen.getByText('new-service is already tracked.')).toBeTruthy()
  })

  it('explains a folder that can no longer be found', async () => {
    h.dm.folders = [folderView({ path: '/gone', name: 'gone', displayPath: '~/gone', available: false })]
    h.mount()
    await settle()
    expect(screen.getByRole('heading', { name: 'gone can’t be found' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Folder unavailable' })).toBeTruthy()
  })

  it('reports a failure to read the folder list', async () => {
    h.dm.rejects.listFolders = 'registry unreadable'
    h.mount()
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('registry unreadable')
    expect(screen.getByRole('heading', { name: 'Track a folder to get started' })).toBeTruthy()
  })
})

describe('App initialization progress', () => {
  it('shows progress while initializing and blocks a second press', async () => {
    h.dm.folders = [setup]
    const gate = h.dm.holdNext('initializeRepository')
    h.dm.handlers.initializeRepository = () => {
      h.dm.folders = [ready]
      return initResult
    }
    h.mount()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    await settle()
    const busy = screen.getByRole('button', { name: 'Initializing…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    gate.resolve()
    await settle()
    expect(screen.queryByRole('button', { name: 'Initializing…' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'new-service' })).toBeTruthy()
  })

  it('tells the person when an epic list cannot be loaded', async () => {
    h.dm.folders = [ready]
    h.dm.failures.listEpics = { code: 'internal', message: 'database is locked' }
    h.mount()
    await settle()
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('database is locked')
    expect(screen.getAllByText('Could not refresh epics').length).toBeGreaterThan(0)
  })
})
