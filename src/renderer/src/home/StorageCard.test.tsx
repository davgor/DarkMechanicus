// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { localNoonIso, storageStatus } from '../__mocks__/fixtures'
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
    expect(screen.queryByText(/Flush writes pending changes/)).toBeNull()
  })

  it('explains the two actions once the status is known', () => {
    renderCard(storageStatus())
    expect(screen.getByText(/Flush writes pending changes to the repository files\./)).toBeTruthy()
    expect(screen.getByText(/Reconcile re-reads them after a pull, clone or branch switch\./)).toBeTruthy()
  })

  it('describes the project and where its records live', () => {
    renderCard(storageStatus({ projectName: 'alpha', projectId: 'pj_1', schemaVersion: 1 }))
    expect(row('Project')).toBe('alpha')
    expect(row('Project ID')).toBe('pj_1')
    expect(row('Schema')).toBe('v1')
    expect(row('Branch')).toBe('main')
  })

  it('shows the export state and the last export date', () => {
    renderCard(storageStatus({ uncommittedRecordFiles: 2, lastFlushAt: localNoonIso(2026, 3, 15) }))
    expect(row('Export')).toBe('Exported · 2 files uncommitted')
    expect(row('Last export')).toBe('Mar 15, 2026')
  })

  it('falls back when the project has no name or id yet', () => {
    renderCard(storageStatus({ projectName: null, projectId: null, schemaVersion: null }))
    expect(row('Project')).toBe('Unnamed')
    expect(row('Project ID')).toBe('none')
    expect(row('Schema')).toBe('—')
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
    renderCard(storageStatus({ branch: { current: 'feature/x', recorded: 'main', changed: true, repository: true } }))
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

  it('lists profile conflicts after epic conflicts', () => {
    renderCard(
      storageStatus({
        conflicts: [{ epicId: 'ep_1', message: 'edited on two machines' }],
        profileConflicts: [{ name: 'deep-review', message: 'saved on two machines' }]
      })
    )
    expect(row('Conflicts')).toBe('ep_1: edited on two machinesProfile deep-review: saved on two machines')
  })

  it('lists every conflict of one epic, and only those still open after an update', () => {
    const first = { epicId: 'ep_1', message: 'Comment cm_1 already exists with different content.' }
    const second = { epicId: 'ep_1', message: 'Comment cm_2 already exists with different content.' }
    const other = { epicId: 'ep_2', message: 'edited on two machines' }
    const card = (conflicts: StorageStatusView['conflicts']): JSX.Element => (
      <StorageCard status={storageStatus({ conflicts })} titles={{}} busy={{ flush: false, reconcile: false }} onFlush={() => undefined} onReconcile={() => undefined} />
    )
    const { rerender } = render(card([first, other, second]))
    expect(row('Conflicts')).toBe(`ep_1: ${first.message}ep_2: ${other.message}ep_1: ${second.message}`)
    rerender(card([other, second]))
    expect(row('Conflicts')).toBe(`ep_2: ${other.message}ep_1: ${second.message}`)
  })

  it('shows the conflicts row for profile conflicts alone', () => {
    renderCard(storageStatus({ profileConflicts: [{ name: 'ui', message: 'saved on two machines' }] }))
    expect(row('Conflicts')).toBe('Profile ui: saved on two machines')
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

describe('StorageCard branch row', () => {
  it('names a detached HEAD and a folder outside Git differently', () => {
    renderCard(storageStatus({ branch: { current: null, recorded: '', changed: false, repository: true } }))
    expect(row('Branch')).toBe('detached HEAD')
    cleanup()
    renderCard(storageStatus({ branch: { current: null, recorded: '', changed: false, repository: false } }))
    expect(row('Branch')).toBe('Not a Git repository')
  })
})
