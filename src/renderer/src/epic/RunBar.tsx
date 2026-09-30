import { isActiveRunState } from '../../../shared/domain/status'
import type { RunView } from '../../../shared/domain/views'
import { adoptNotice, runActions, runBarCounts, runPill, runSummary, type AdoptNotice, type RunActions } from './runBarView'
import { StatePill } from './StatePill'
import type { WorkspaceHandle } from './useWorkspace'

function RunButtons({ ws, actions }: { ws: WorkspaceHandle; actions: RunActions }): JSX.Element {
  const busy = ws.state.busy
  const open = ws.state.checkpointOpen
  return (
    <div className="ew-bar-actions">
      {actions.pause ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void ws.actions.runCommand('pause')}>
          Pause run
        </button>
      ) : null}
      {actions.resume ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void ws.actions.runCommand('resume')}>
          Resume run
        </button>
      ) : null}
      {actions.takeover ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void ws.actions.runCommand('takeover')}>
          Take over
        </button>
      ) : null}
      {actions.cancel ? (
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => ws.dispatch({ type: 'confirm', kind: 'cancel_run' })}>
          Cancel run
        </button>
      ) : null}
      {actions.report ? (
        <button type="button" className="btn" onClick={() => ws.dispatch({ type: open ? 'close_checkpoint' : 'open_checkpoint' })}>
          {open ? 'Open graph' : 'Sprint report'}
        </button>
      ) : null}
    </div>
  )
}

function AdoptLine({ ws, notice }: { ws: WorkspaceHandle; notice: AdoptNotice }): JSX.Element {
  return (
    <p className="ew-bar-note">
      <span>{notice.note}</span>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={!notice.enabled || ws.state.busy}
        title={notice.enabled ? undefined : 'Available at a checkpoint or while the run is paused'}
        onClick={() => void ws.actions.adopt(notice.revisionId)}
      >
        Adopt
      </button>
    </p>
  )
}

function OwnershipLine({ run }: { run: RunView }): JSX.Element | null {
  const imported = !run.ownedByThisMachine && isActiveRunState(run.state)
  return imported ? (
    <p className="ew-bar-note">This run was imported from another machine. Take over to control it here.</p>
  ) : null
}

/** Run state, pinned revision, sprint progress, counts and controls (Saved view). */
export function RunBar({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const run = ws.data.run
  if (run === null) {
    return null
  }
  const pill = runPill(run)
  const adopt = adoptNotice(run, ws.data.epic)
  const reportAt = ws.data.checkpoint?.report?.createdAt ?? null
  return (
    <div className="ew-bar ew-runbar" aria-label="Run">
      <div className="ew-bar-row">
        <StatePill tone={pill.tone} label={pill.label} />
        <span className="ew-bar-text">{runSummary(run, ws.now, reportAt)}</span>
        <ul className="ew-counts" aria-label="Ticket counts">
          {runBarCounts(run).map((item) => (
            <li key={item.key} className={`ew-count ew-tone-${item.tone}`}>
              <span className="ew-dot" aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
        <RunButtons ws={ws} actions={runActions(run, ws.data.checkpoint !== null)} />
      </div>
      {adopt === null ? null : <AdoptLine ws={ws} notice={adopt} />}
      <OwnershipLine run={run} />
    </div>
  )
}
