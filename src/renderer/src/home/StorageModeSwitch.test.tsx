// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { storageStatus } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { StorageModeSwitch } from './StorageModeSwitch'

let dm: FakeDm
beforeEach(() => { dm = new FakeDm(); window.dm = dm })
afterEach(cleanup)

describe('storage switch confirmation', () => {
  it('warns about the repo purge, and cancellation issues no command', () => {
    render(<StorageModeSwitch status={storageStatus()} onChanged={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to database only…' }))
    expect(screen.getByRole('dialog').textContent).toContain('.darkmechanicus/')
    expect(screen.getByRole('dialog').textContent).toContain('.gitignore')
    expect(screen.getByRole('dialog').textContent).toContain('.mcp.json')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dm.callsOf('switchStorageMode')).toHaveLength(0)
  })

  it('sends the explicit target only after confirmation and refreshes the folder', async () => {
    let refreshed = 0
    render(<StorageModeSwitch status={storageStatus()} onChanged={() => { refreshed += 1 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to database only…' }))
    expect(dm.callsOf('switchStorageMode')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Move records and delete repository store' }))
    await settle()
    expect(dm.callsOf('switchStorageMode')).toHaveLength(1)
    expect(dm.callsOf('switchStorageMode')[0]?.input).toEqual({ mode: 'db', confirmed: true })
    expect(refreshed).toBe(1)
  })

  it('names the local source that will be deleted for database to repository', () => {
    const status = storageStatus()
    status.storage.mode = 'db'
    status.storage.projectDir = 'C:/isolated/dm/projects/proof'
    render(<StorageModeSwitch status={status} onChanged={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to repository files…' }))
    expect(screen.getByRole('dialog').textContent).toContain(status.storage.projectDir)
    expect(screen.getByRole('dialog').textContent).toContain('verified')
  })

  it('shows a refused migration without claiming success', async () => {
    dm.failures.switchStorageMode = { code: 'conflict', message: 'Close the active run first.' }
    let refreshed = 0
    render(<StorageModeSwitch status={storageStatus()} onChanged={() => { refreshed += 1 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to database only…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move records and delete repository store' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Close the active run first.')
    expect(refreshed).toBe(0)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
