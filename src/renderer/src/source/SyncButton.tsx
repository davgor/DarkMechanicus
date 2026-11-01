import { useState } from 'react'
import type { RepoStatus } from '../../../shared/git/status'
import { plural } from '../app/plural'
import type { Scheduler } from '../app/scheduler'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { Menu } from '../components/Menu'
import { useGithub } from '../github/GithubAccount'
import { SignInPrompt } from '../github/SignInPrompt'
import { useSync } from './useSync'
import type { RunningSync, SyncFailure, SyncOperation } from './useSync'

interface SyncButtonProps {
  folderPath: string
  status: RepoStatus
  scheduler: Scheduler
  /** Reads the repository state again; called after every operation. */
  onRefresh(): void
  /** The clock for "Last fetched …"; injectable for tests. */
  now?: () => number
}

const NO_REMOTE_TIP = 'This repository has no remote to sync with. Add one with `git remote add`.'

interface PrimaryAction {
  label: string
  operation: SyncOperation | null
  behind: number
  ahead: number
}

/** The one action the state calls for: publish, pull, push, fetch, or nothing without a remote. */
function primaryOf(status: RepoStatus): PrimaryAction {
  const { upstream, ahead, behind } = status.branch
  const remote = status.remote?.name ?? 'origin'
  if (status.remote === null) {
    return { label: 'No remote', operation: null, behind: 0, ahead: 0 }
  }
  if (upstream === null) {
    return { label: 'Publish branch', operation: 'push', behind: 0, ahead: 0 }
  }
  if (behind > 0) {
    return { label: `Pull ${remote}`, operation: 'pull', behind, ahead }
  }
  if (ahead > 0) {
    return { label: `Push ${remote}`, operation: 'push', behind: 0, ahead }
  }
  return { label: `Fetch ${remote}`, operation: 'fetch', behind: 0, ahead: 0 }
}

/** "Last fetched 5 minutes ago", or "Never fetched". */
function fetchedLine(lastFetchedAt: string | null, now: number): string {
  const at = lastFetchedAt === null ? Number.NaN : Date.parse(lastFetchedAt)
  if (Number.isNaN(at)) {
    return 'Never fetched'
  }
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) {
    return 'Last fetched just now'
  }
  if (minutes < 60) {
    return `Last fetched ${plural(minutes, 'minute')} ago`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `Last fetched ${plural(hours, 'hour')} ago` : `Last fetched ${plural(Math.floor(hours / 24), 'day')} ago`
}

const RUNNING_LABEL: Record<SyncOperation, string> = { fetch: 'Fetching', pull: 'Pulling', push: 'Pushing' }

function SyncProgress({ running, onCancel }: { running: RunningSync; onCancel(): void }): JSX.Element {
  const percent = running.percent === null ? null : Math.max(0, Math.min(100, Math.round(running.percent)))
  return (
    <div className="sync-progress">
      <div
        className="sync-progress-bar"
        role="progressbar"
        aria-label={`${RUNNING_LABEL[running.operation]} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div className="sync-progress-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <span className="sync-progress-text muted">
        {`${running.phase ?? `${RUNNING_LABEL[running.operation]}…`}${percent === null ? '' : ` ${percent}%`}`}
      </span>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  )
}

interface FailureProps {
  failure: SyncFailure
  onPull(): void
  onDismiss(): void
}

function SyncFailureNotice({ failure, onPull, onDismiss }: FailureProps): JSX.Element {
  if (failure.kind === 'auth') {
    return (
      <div className="sync-failure">
        <SignInPrompt purpose="push and pull" />
        {failure.revoked ? <p className="muted">Your GitHub sign-in may have been revoked.</p> : null}
      </div>
    )
  }
  return (
    <div className="sync-failure" role="alert">
      <p>{failure.kind === 'rejected' ? 'The remote has commits you don’t have. Pull first.' : failure.message}</p>
      {failure.kind === 'other' && failure.detail !== null ? (
        <details>
          <summary>Details</summary>
          <pre className="sync-detail mono">{failure.detail}</pre>
        </details>
      ) : null}
      <div className="sync-failure-actions">
        {failure.kind === 'rejected' ? (
          <Button size="sm" variant="primary" onClick={onPull}>
            Pull
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}

function Counts({ action }: { action: PrimaryAction }): JSX.Element | null {
  if (action.behind === 0 && action.ahead === 0) {
    return null
  }
  return (
    <span className="sync-counts mono">
      {action.behind > 0 ? `↓${action.behind}` : null}
      {action.behind > 0 && action.ahead > 0 ? ' ' : null}
      {action.ahead > 0 ? `↑${action.ahead}` : null}
    </span>
  )
}

/** GitHub Desktop's sync button: the one action the branch needs, a Fetch/Pull/Push menu, progress, errors and background fetch. */
export function SyncButton({ folderPath, status, scheduler, onRefresh, now = Date.now }: SyncButtonProps): JSX.Element {
  const { account } = useGithub()
  const sync = useSync({ folderPath, scheduler, signedIn: account !== null, githubHttps: status.remote?.githubHttps === true, onRefresh })
  const [menuOpen, setMenuOpen] = useState(false)
  const action = primaryOf(status)
  const { operation } = action
  return (
    <div className="sync">
      <div className="sync-row">
        <button
          type="button"
          className="btn sync-primary"
          data-testid="sync-primary"
          disabled={operation === null || sync.running !== null}
          aria-busy={sync.running !== null || undefined}
          title={operation === null ? NO_REMOTE_TIP : undefined}
          onClick={() => operation !== null && sync.run(operation)}
        >
          <span className="sync-label">
            {action.label} <Counts action={action} />
          </span>
          <span className="sync-fetched muted">{fetchedLine(status.lastFetchedAt, now())}</span>
        </button>
        {sync.warning === null ? null : (
          <span className="sync-warning" role="img" aria-label="Background fetch failed" title={`Background fetch failed: ${sync.warning}`}>
            <Icon name="warning" size={14} />
          </span>
        )}
        <Menu
          label="More sync actions"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={(['fetch', 'pull', 'push'] as const).map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), onSelect: () => sync.run(id) }))}
        />
      </div>
      {sync.running === null ? null : <SyncProgress running={sync.running} onCancel={sync.cancel} />}
      {sync.failure === null ? null : <SyncFailureNotice failure={sync.failure} onPull={() => sync.run('pull')} onDismiss={sync.dismiss} />}
    </div>
  )
}
