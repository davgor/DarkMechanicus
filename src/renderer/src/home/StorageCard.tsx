import { type ReactNode, useState } from 'react'
import type { EpicConflictChoice, StorageStatusView } from '../../../shared/domain/views'
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
  /** Keeps one side of an epic records conflict; settles once the outcome has been reported. */
  onResolveConflict(epicId: string, keep: EpicConflictChoice): Promise<void>
}

type ResolveConflict = StorageCardProps['onResolveConflict']

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

/** 1536 -> "1.5 KB"; whole bytes below 1 KB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

function imagesText({ count, bytes, missing }: NonNullable<StorageStatusView['attachments']>): string {
  const summary = `${count} (${formatBytes(bytes)})`
  return missing > 0 ? `${summary}, ${missing} missing` : summary
}

const MODE_LABELS: Record<StorageStatusView['storage']['mode'], string> = {
  repo: 'In this repository',
  db: 'Database only'
}

/**
 * The person's two ways out of an epic records conflict. Each drops one side, so the labels name what survives and
 * the title what is lost; one choice runs at a time.
 */
function ConflictChoice({ epicId, onResolve }: { epicId: string; onResolve: ResolveConflict }): JSX.Element {
  const [running, setRunning] = useState<EpicConflictChoice | null>(null)
  const choose = (keep: EpicConflictChoice): void => {
    setRunning(keep)
    void onResolve(epicId, keep).finally(() => setRunning(null))
  }
  return (
    <span className="button-row">
      <Button
        size="sm"
        busy={running === 'tracked'}
        disabled={running !== null}
        title="Imports the tracked records and drops this machine's changes to the epic that wait to be exported"
        onClick={() => choose('tracked')}
      >
        Keep tracked records
      </Button>
      <Button
        size="sm"
        busy={running === 'local'}
        disabled={running !== null}
        title="Writes this machine's records of the epic over the tracked ones, which are then no longer current"
        onClick={() => choose('local')}
      >
        Write local
      </Button>
    </span>
  )
}

function SaveQueueRow({ status }: { status: StorageStatusView }): JSX.Element {
  return (
    <Row label="Save queue">
      {queueText(status)}
      {(status.outbox.failedEntries ?? []).map((entry, index) => (
        <div key={`${index}:${entry.kind}:${entry.entityId}`}>
          {entry.kind} {entry.entityId}: failed {entry.attempts} {entry.attempts === 1 ? 'time' : 'times'}
          {entry.lastError === null ? '' : ` — ${entry.lastError}`}
        </div>
      ))}
    </Row>
  )
}

interface DetailsProps {
  status: StorageStatusView
  titles: Readonly<Record<string, string>>
  onResolveConflict: ResolveConflict
}

function Details({ status, titles, onResolveConflict }: DetailsProps): JSX.Element {
  const exported = storageFooterLine(status)
  const databaseOnly = status.storage.mode === 'db'
  return (
    <dl className="kv">
      <Row label="Project">{status.projectName ?? 'Unnamed'}</Row>
      <Row label="Project ID">
        <span className="mono">{status.projectId ?? 'none'}</span>
      </Row>
      <Row label="Schema">{status.schemaVersion === null ? '—' : `v${status.schemaVersion}`}</Row>
      <Row label="Storage">{MODE_LABELS[status.storage.mode]}</Row>
      <Row label="Database">
        <span className="mono">{status.storage.databasePath}</span>
      </Row>
      {databaseOnly ? null : <Row label="Branch">{branchLabel(status.branch)}</Row>}
      {databaseOnly ? null : (
        <Row label="Export">
          <span className={`tone-${exported.tone}`}>{exported.text}</span>
        </Row>
      )}
      {databaseOnly ? null : (
        <Row label="Last export">{status.lastFlushAt === null ? 'Never' : formatShortDate(status.lastFlushAt)}</Row>
      )}
      <SaveQueueRow status={status} />
      {status.attachments === undefined ? null : <Row label="Images">{imagesText(status.attachments)}</Row>}
      {status.conflicts.length + status.profileConflicts.length === 0 ? null : (
        <Row label="Conflicts">
          {/* One epic can have several conflicts (its own, runs, comments), so the epic id alone is no key. */}
          {status.conflicts.map((conflict, index) => (
            <div key={`${index}:${conflict.epicId}:${conflict.message}`}>
              {titles[conflict.epicId] ?? conflict.epicId}: {conflict.message}
              {conflict.resolvable ? <ConflictChoice epicId={conflict.epicId} onResolve={onResolveConflict} /> : null}
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
export function StorageCard({ status, titles, busy, onFlush, onReconcile, onResolveConflict }: StorageCardProps): JSX.Element {
  const warning = branchWarning(status)
  // Flush and Reconcile move repository record files, which a db project does not have.
  const databaseOnly = status?.storage.mode === 'db'
  return (
    <section className="card" aria-label="Storage">
      <h2 className="card-title">Storage</h2>
      {status === null ? (
        <p className="muted">Loading storage status…</p>
      ) : (
        <Details status={status} titles={titles} onResolveConflict={onResolveConflict} />
      )}
      {warning === null || databaseOnly ? null : (
        <p className="inline-warning">
          <Icon name="warning" />
          <span>{warning}</span>
        </p>
      )}
      {status === null || databaseOnly ? null : (
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
          {databaseOnly
            ? 'Everything for this folder is in the database above. Nothing is written into the repository, so there is nothing to flush, reconcile or commit, and nothing travels with a clone.'
            : 'Flush writes pending changes to the repository files. Reconcile re-reads them after a pull, clone or branch switch.'}
        </p>
      )}
    </section>
  )
}
