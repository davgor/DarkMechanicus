// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { ToastProvider } from '../app/toasts'
import { ClaudeCodeConnect } from './ClaudeCodeConnect'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const alpha = folderView({ path: '/home/u/code/alpha', displayPath: '~/code/alpha' })
const DEFAULTS = { role: 'orchestrator', allowSave: true, replace: false }
const EXISTING = '{\n  "command": "node",\n  "args": ["/old/mcp.js"]\n}'

function renderConnect(folder: TrackedFolderView = alpha): void {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <ClaudeCodeConnect folder={folder} />
    </ToastProvider>
  )
}

const connect = (): HTMLButtonElement => screen.getByRole('button', { name: 'Connect Claude Code' }) as HTMLButtonElement
const role = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Role' }) as HTMLSelectElement
const allowSave = (): HTMLInputElement =>
  screen.getByRole('checkbox', { name: 'Let it save plans (--allow-save)' }) as HTMLInputElement

async function pressConnect(): Promise<void> {
  fireEvent.click(connect())
  await settle()
}

describe('ClaudeCodeConnect before writing', () => {
  it('shows the target file, the role and whether saving is allowed', () => {
    renderConnect()
    expect(screen.getByRole('heading', { level: 3, name: 'Claude Code' })).toBeTruthy()
    expect(screen.getByText('~/code/alpha/.mcp.json')).toBeTruthy()
    expect(role().value).toBe('orchestrator')
    expect([...role().options].map((option) => [option.value, option.textContent])).toEqual([
      ['planner', 'Planner'],
      ['orchestrator', 'Orchestrator']
    ])
    expect(allowSave().checked).toBe(true)
    expect(dm.claudeConnects).toEqual([])
  })

  it('shows a Windows target path with backslashes', () => {
    renderConnect(folderView({ path: 'C:\\work\\alpha', displayPath: 'C:\\work\\alpha' }))
    expect(screen.getByText('C:\\work\\alpha\\.mcp.json')).toBeTruthy()
  })

  it('says plainly that the file holds this machine’s app path and leaves committing to the person', () => {
    renderConnect()
    expect(
      screen.getByText(
        'The file contains this machine’s path to the Dark Mechanicus app, so it only works as is on this machine. Whether to commit it is up to you; nothing is committed.'
      )
    ).toBeTruthy()
  })
})

describe('ClaudeCodeConnect writing', () => {
  it('writes .mcp.json for the folder with the defaults and confirms', async () => {
    renderConnect()
    await pressConnect()
    expect(dm.claudeConnects).toEqual([{ folder: '/home/u/code/alpha', request: DEFAULTS }])
    expect(screen.getByRole('status').textContent).toContain('Created .mcp.json for Claude Code.')
  })

  it('writes the chosen role and save setting', async () => {
    renderConnect()
    fireEvent.change(role(), { target: { value: 'planner' } })
    fireEvent.click(allowSave())
    await pressConnect()
    expect(allowSave().checked).toBe(false)
    expect(dm.claudeConnects.map((call) => call.request)).toEqual([
      { role: 'planner', allowSave: false, replace: false }
    ])
  })

  it('says when the file already has this entry', async () => {
    dm.claudeOutcomes = [{ outcome: 'unchanged' }]
    renderConnect()
    await pressConnect()
    expect(screen.getByRole('status').textContent).toContain('.mcp.json already connects Claude Code with these settings.')
  })
})

describe('ClaudeCodeConnect failures', () => {
  it('reports a file it could not read and leaves the button usable', async () => {
    dm.claudeOutcomes = [{ outcome: 'invalid', message: '.mcp.json is not valid JSON (oops), so it was left untouched.' }]
    renderConnect()
    await pressConnect()
    expect(screen.getByRole('alert').textContent).toContain('.mcp.json is not valid JSON (oops), so it was left untouched.')
    expect(connect().disabled).toBe(false)
  })

  it('reports a refused write and can be retried', async () => {
    dm.rejects.connectClaudeCode = 'Refusing to write .mcp.json: it is a symbolic link.'
    renderConnect()
    await pressConnect()
    expect(screen.getByRole('alert').textContent).toContain('Refusing to write .mcp.json: it is a symbolic link.')
    expect(connect().disabled).toBe(false)
  })

  it('is busy while writing', async () => {
    const gate = deferred()
    const original = dm.connectClaudeCode.bind(dm)
    dm.connectClaudeCode = async (folder, request) => {
      await gate.promise
      return original(folder, request)
    }
    renderConnect()
    await pressConnect()
    expect(connect().disabled).toBe(true)
    gate.resolve()
    await settle()
    expect(connect().disabled).toBe(false)
  })
})

describe('ClaudeCodeConnect replacing an entry', () => {
  async function showConflict(): Promise<void> {
    dm.claudeOutcomes = [{ outcome: 'conflict', existing: EXISTING }, { outcome: 'replaced' }]
    renderConnect()
    await pressConnect()
  }

  it('asks before replacing a different darkmechanicus entry and shows what is there', async () => {
    await showConflict()
    expect(screen.getByText('.mcp.json already has a different darkmechanicus entry. Replace it?')).toBeTruthy()
    expect(screen.getByLabelText('Current darkmechanicus entry').textContent).toBe(EXISTING)
    expect(screen.queryByRole('button', { name: 'Connect Claude Code' })).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('replaces the entry once confirmed', async () => {
    await showConflict()
    fireEvent.click(screen.getByRole('button', { name: 'Replace entry' }))
    await settle()
    expect(dm.claudeConnects.map((call) => call.request)).toEqual([DEFAULTS, { ...DEFAULTS, replace: true }])
    expect(screen.getByRole('status').textContent).toContain('Replaced the darkmechanicus entry in .mcp.json.')
    expect(screen.queryByLabelText('Current darkmechanicus entry')).toBeNull()
    expect(connect().disabled).toBe(false)
  })

  it('keeps the current entry when the person declines', async () => {
    await showConflict()
    fireEvent.click(screen.getByRole('button', { name: 'Keep current entry' }))
    await settle()
    expect(dm.claudeConnects).toHaveLength(1)
    expect(screen.queryByLabelText('Current darkmechanicus entry')).toBeNull()
    expect(connect().disabled).toBe(false)
  })
})
