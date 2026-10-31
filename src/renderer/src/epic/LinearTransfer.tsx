import { StatePill } from './StatePill'
import { transferStripView, type MismatchRow } from './transferView'
import type { WorkspaceHandle } from './useWorkspace'

function Mismatches({ rows }: { rows: MismatchRow[] }): JSX.Element | null {
  if (rows.length === 0) {
    return null
  }
  return (
    <div className="ew-transfer-mismatches">
      <p className="ew-bar-warning">{`The last read-back differs from the plan in ${rows.length === 1 ? '1 place' : `${rows.length} places`}:`}</p>
      <ul aria-label="Last read-back mismatches">
        {rows.map((row, index) => (
          <li key={`${row.subject}\n${row.field}\n${index}`}>
            <span className="ew-transfer-subject">{row.subject}</span>
            <span>{row.field}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** While a transfer is open: its status, how much is created, the last read-back's mismatches, and Resume, Copy prompt and Cancel transfer. */
export function TransferStrip({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const view = transferStripView(ws.data.transfer)
  if (view === null) {
    return null
  }
  const busy = ws.state.busy
  return (
    <div className="ew-bar ew-transferbar" aria-label="Linear transfer">
      <div className="ew-bar-row">
        <StatePill tone={view.pill.tone} label={view.pill.label} />
        <span className="ew-bar-text">{`Transfer to Linear. ${view.text}`}</span>
        <span className="ew-transfer-created">{view.created}</span>
        <div className="ew-bar-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void ws.actions.resumeTransfer()}>
            Resume
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void ws.actions.copyTransferPrompt('resume')}>
            Copy prompt
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => ws.dispatch({ type: 'confirm', kind: 'cancel_transfer' })}>
            Cancel transfer
          </button>
        </div>
      </div>
      <Mismatches rows={view.mismatches} />
    </div>
  )
}

/** A completed epic whose verified Linear transfer completed it: what was handed off, and the project link (opened in the browser). */
export function TransferredPanel({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const outcome = ws.data.epic.outcome?.transfer
  if (outcome === undefined) {
    return null
  }
  const issues = outcome.items.length === 1 ? '1 issue' : `${outcome.items.length} issues`
  const open = async (): Promise<void> => {
    if (!(await window.dm.openExternal(outcome.projectUrl).catch(() => false))) {
      ws.dispatch({ type: 'banner', text: `The Linear project link could not be opened: ${outcome.projectUrl}` })
    }
  }
  return (
    <section className="ew-transferred" aria-label="Transferred to Linear">
      <h2 className="ew-transferred-title">Transferred to Linear</h2>
      <p className="ew-transferred-text">
        {`This epic was handed off to a Linear project: ${issues} in execution order, verified against a read-back. Linear is the board for this work now.`}
      </p>
      <p className="ew-transferred-link">
        <button type="button" className="ew-link" title={outcome.projectUrl} onClick={() => void open()}>
          Open the project in Linear
        </button>
        <span className="ew-transferred-url">{outcome.projectUrl}</span>
      </p>
    </section>
  )
}
