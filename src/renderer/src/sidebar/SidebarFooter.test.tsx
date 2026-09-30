// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { storageStatus } from '../__mocks__/fixtures'
import type { StorageStatusView } from '../../../shared/domain/views'
import { SidebarFooter } from './SidebarFooter'

afterEach(cleanup)

interface Calls {
  flush: number
  reconcile: number
}

interface Options {
  status: StorageStatusView | null
  ready?: boolean
  busy?: { flush: boolean; reconcile: boolean }
}

function renderFooter(options: Options): Calls {
  const calls: Calls = { flush: 0, reconcile: 0 }
  render(
    <SidebarFooter
      status={options.status}
      folderReady={options.ready ?? true}
      busy={options.busy ?? { flush: false, reconcile: false }}
      onFlush={() => {
        calls.flush += 1
      }}
      onReconcile={() => {
        calls.reconcile += 1
      }}
    >
      <span>extra</span>
    </SidebarFooter>
  )
  return calls
}

const sessions = (byRole: Record<string, number>): StorageStatusView =>
  storageStatus({ sessions: { active: 0, byRole } })

describe('SidebarFooter MCP line', () => {
  it('waits for an agent without a status', () => {
    renderFooter({ status: null, ready: false })
    expect(screen.getByText('MCP')).toBeTruthy()
    expect(screen.getByText('Waiting for an agent').className).toContain('tone-muted')
  })

  it('counts connected agent sessions', () => {
    renderFooter({ status: sessions({ desktop: 1, orchestrator: 2 }) })
    expect(screen.getByText('2 agent sessions · stdio').className).toContain('tone-ok')
  })
})

describe('SidebarFooter storage line', () => {
  it('says the repository is not initialized and offers no flush', () => {
    renderFooter({ status: null, ready: false })
    expect(screen.getByText('Not initialized')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Flush' })).toBeNull()
  })

  it('shows uncommitted exported files with a Flush button', () => {
    const calls = renderFooter({ status: storageStatus({ uncommittedRecordFiles: 3 }) })
    expect(screen.getByText('Exported · 3 files uncommitted')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Flush' }))
    expect(calls.flush).toBe(1)
  })

  it('shows a pending save as a warning', () => {
    renderFooter({ status: storageStatus({ outbox: { pending: 1, failed: 0, lastError: null } }) })
    expect(screen.getByText('Save pending').className).toContain('tone-warn')
  })

  it('shows a failed export as an error with the last error as its tooltip', () => {
    renderFooter({ status: storageStatus({ outbox: { pending: 0, failed: 1, lastError: 'disk full' } }) })
    const line = screen.getByText('Export failed')
    expect(line.className).toContain('tone-error')
    expect(line.getAttribute('title')).toBe('disk full')
  })

  it('disables Flush while flushing', () => {
    renderFooter({ status: storageStatus(), busy: { flush: true, reconcile: false } })
    expect((screen.getByRole('button', { name: 'Flush' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('SidebarFooter branch warning', () => {
  const changed = storageStatus({ branch: { recorded: 'main', current: 'feature/x', changed: true } })

  it('is absent while the branch matches', () => {
    renderFooter({ status: storageStatus() })
    expect(screen.queryByText(/Branch changed/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reconcile' })).toBeNull()
  })

  it('warns and offers Reconcile after a branch change', () => {
    const calls = renderFooter({ status: changed })
    expect(screen.getByText('Branch changed: main → feature/x')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }))
    expect(calls.reconcile).toBe(1)
  })

  it('disables Reconcile while reconciling', () => {
    renderFooter({ status: changed, busy: { flush: false, reconcile: true } })
    expect((screen.getByRole('button', { name: 'Reconcile' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders extra footer content', () => {
    renderFooter({ status: null })
    expect(screen.getByText('extra')).toBeTruthy()
  })
})
