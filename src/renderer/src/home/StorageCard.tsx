import type { ReactNode } from 'react'
import type { StorageStatusView } from '../../../shared/domain/views'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { formatShortDate } from '../sidebar/epicStatusLine'
import { branchWarning, storageFooterLine } from '../sidebar/footerStatus'

interface StorageCardProps {
  status: StorageStatusView | null
  /** Epic titles by id, so conflicts can name the epic instead of its id. */
  titles: Readonly<Record<string, string>>
  busy: { flush: boolean; reconcile: boolean }
  onFlush(): void
  onReconcile(): void
}

function branchLabel(branch: StorageStatusView['branch']): string {
  if (!branch.repository) {
    return 'Not a Git repository'
  }
  return branch.current ?? 'detached HEAD'
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function queueText(status: StorageStatusView): string {
  const { pending, failed, lastError } = status.outbox
  const summary = `${pending} pending · ${failed} failed`
  return failed > 0 && lastError !== null ? `${summary} — ${lastError}` : summary
}

function Details({ status, titles }: { status: StorageStatusView; titles: Readonly<Record<string, string>> }): JSX.Element {
  const exported = storageFooterLine(status)
  return (
    <dl className="kv">
      <Row label="Project">{status.projectName ?? 'Unnamed'}</Row>
      <Row label="Project ID">
        <span className="mono">{status.projectId ?? 'none'}</span>
      </Row>
      <Row label="Schema">{status.schemaVersion === null ? '—' : `v${status.schemaVersion}`}</Row>
      <Row label="Branch">{branchLabel(status.branch)}</Row>
      <Row label="Export">
        <span className={`tone-${exported.tone}`}>{exported.text}</span>
      </Row>
      <Row label="Last export">{status.lastFlushAt === null ? 'Never' : formatShortDate(status.lastFlushAt)}</Row>
      <Row label="Save queue">{queueText(status)}</Row>
      {status.conflicts.length + status.profileConflicts.length === 0 ? null : (
        <Row label="Conflicts">
          {/* One epic can have several conflicts (its own, runs, comments), so the epic id alone is no key. */}
          {status.conflicts.map((conflict, index) => (
            <div key={`${index}:${conflict.epicId}:${conflict.message}`}>
              {titles[conflict.epicId] ?? conflict.epicId}: {conflict.message}
            </div>
          ))}
          {status.profileConflicts.map((conflict) => (
            <div key={`profile:${conflict.name}`}>
              Profile {conflict.name}: {conflict.message}
            </div>
          ))}
        </Row>
      )}
    </dl>
  )
}

/** Where the folder's records stand: export state, branch, save queue, and Flush/Reconcile. */
export function StorageCard({ status, titles, busy, onFlush, onReconcile }: StorageCardProps): JSX.Element {
  const warning = branchWarning(status)
  return (
    <section className="card" aria-label="Storage">
      <h2 className="card-title">Storage</h2>
      {status === null ? <p className="muted">Loading storage status…</p> : <Details status={status} titles={titles} />}
      {warning === null ? null : (
        <p className="inline-warning">
          <Icon name="warning" />
          <span>{warning}</span>
        </p>
      )}
      {status === null ? null : (
        <div className="button-row">
          <Button icon="export" busy={busy.flush} onClick={onFlush}>
            Flush
          </Button>
          <Button icon="refresh" busy={busy.reconcile} onClick={onReconcile}>
            Reconcile
          </Button>
        </div>
      )}
      {status === null ? null : (
        <p className="note">
          Flush writes pending changes to the repository files. Reconcile re-reads them after a pull, clone or branch
          switch.
        </p>
      )}
    </section>
  )
}
