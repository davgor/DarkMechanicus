// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { storageStatus } from '../__mocks__/fixtures'
import type { StorageStatusView } from '../../../shared/domain/views'
import { StorageCard } from './StorageCard'

afterEach(cleanup)

interface Calls {
  flush: number
  reconcile: number
}

function renderCard(
  status: StorageStatusView | null,
  busy = { flush: false, reconcile: false },
  titles: Record<string, string> = {}
): Calls {
  const calls: Calls = { flush: 0, reconcile: 0 }
  render(
    <StorageCard
      status={status}
      titles={titles}
      busy={busy}
      onFlush={() => {
        calls.flush += 1
      }}
      onReconcile={() => {
        calls.reconcile += 1
      }}
    />
  )
  return calls
}

const row = (label: string): string | null | undefined =>
  screen.getByText(label).parentElement?.querySelector('dd')?.textContent

describe('StorageCard content', () => {
  it('waits for the status', () => {
    renderCard(null)
    expect(screen.getByText('Loading storage status…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Flush' })).toBeNull()
  })

  it('describes the project and where its records live', () => {
    renderCard(storageStatus({ projectName: 'alpha', projectId: 'pj_1', schemaVersion: 1 }))
    expect(row('Project')).toBe('alpha (pj_1)')
    expect(row('Schema')).toBe('v1')
    expect(row('Branch')).toBe('main')
  })

  it('shows the export state and the last export date', () => {
    renderCard(storageStatus({ uncommittedRecordFiles: 2, lastFlushAt: '2026-03-15T12:00:00.000Z' }))
    expect(row('Export')).toBe('Exported · 2 files uncommitted')
    expect(row('Last export')).toBe('Mar 15, 2026')
  })

  it('says when nothing has been exported yet', () => {
    renderCard(storageStatus({ lastFlushAt: null }))
    expect(row('Last export')).toBe('Never')
  })

  it('shows the save queue with the last error', () => {
    renderCard(storageStatus({ outbox: { pending: 2, failed: 1, lastError: 'disk full' } }))
    expect(row('Save queue')).toBe('2 pending · 1 failed — disk full')
  })

  it('omits the last error when the queue has no failures', () => {
    renderCard(storageStatus({ outbox: { pending: 1, failed: 0, lastError: 'old news' } }))
    expect(row('Save queue')).toBe('1 pending · 0 failed')
  })
})

describe('StorageCard warnings', () => {
  it('warns about a changed branch', () => {
    renderCard(storageStatus({ branch: { current: 'feature/x', recorded: 'main', changed: true } }))
    expect(screen.getByText('Branch changed: main → feature/x')).toBeTruthy()
  })

  it('lists conflicts by epic title when it is known', () => {
    renderCard(storageStatus({ conflicts: [{ epicId: 'ep_1', message: 'edited on two machines' }] }), undefined, {
      ep_1: 'Sprint checkpoints'
    })
    expect(row('Conflicts')).toBe('Sprint checkpoints: edited on two machines')
  })

  it('falls back to the epic id for an unknown epic', () => {
    renderCard(storageStatus({ conflicts: [{ epicId: 'ep_1', message: 'edited on two machines' }] }))
    expect(row('Conflicts')).toBe('ep_1: edited on two machines')
  })

  it('has no warnings otherwise', () => {
    renderCard(storageStatus())
    expect(screen.queryByText(/Branch changed/)).toBeNull()
    expect(screen.queryByText('Conflicts')).toBeNull()
  })
})

describe('StorageCard actions', () => {
  it('flushes and reconciles on request', () => {
    const calls = renderCard(storageStatus())
    fireEvent.click(screen.getByRole('button', { name: 'Flush' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }))
    expect(calls).toEqual({ flush: 1, reconcile: 1 })
  })

  it('disables an action while it runs', () => {
    renderCard(storageStatus(), { flush: true, reconcile: false })
    expect((screen.getByRole('button', { name: 'Flush' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Reconcile' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
