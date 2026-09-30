import { confirmCopy, type HeaderView } from './headerView'
import { splitLead } from './runner'
import type { WorkspaceHandle } from './useWorkspace'

/** Rejected edits and failed actions, with the server's concrete reason. */
export function Banner({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const text = ws.state.banner
  if (text === null) {
    return null
  }
  const parts = splitLead(text)
  return (
    <div className="ew-banner" role="alert">
      <span className="ew-banner-text">
        {parts.lead === '' ? null : <strong>{parts.lead} </strong>}
        {parts.rest}
      </span>
      <button type="button" className="ew-icon-btn" aria-label="Dismiss" onClick={() => ws.dispatch({ type: 'banner', text: null })}>
        ×
      </button>
    </div>
  )
}

export function Toast({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const text = ws.state.toast
  if (text === null) {
    return null
  }
  return (
    <div className="ew-toast toast" role="status">
      <span>{text}</span>
      <button type="button" className="ew-icon-btn" aria-label="Dismiss notification" onClick={() => ws.dispatch({ type: 'toast', text: null })}>
        ×
      </button>
    </div>
  )
}

export function ConfirmStrip({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const kind = ws.state.confirm
  if (kind === null) {
    return null
  }
  const copy = confirmCopy(kind, ws.data.epic, ws.data.run)
  const confirm = (): void => {
    if (kind === 'discard') {
      void ws.actions.discardDraft()
      return
    }
    ws.dispatch({ type: 'confirm', kind: null })
    void ws.actions.runCommand('cancel')
  }
  return (
    <div className="ew-confirm" role="alertdialog" aria-label={copy.title}>
      <span className="ew-confirm-text">{copy.text}</span>
      <button type="button" className="btn btn-danger" disabled={ws.state.busy} onClick={confirm}>
        {copy.confirm}
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => ws.dispatch({ type: 'confirm', kind: null })}>
        {copy.keep}
      </button>
    </div>
  )
}

/** Read-only, pending-save and conflict notices under the header. */
export function Notices({ header }: { header: HeaderView }): JSX.Element | null {
  const lines = header.readOnly === null ? header.notices : [header.readOnly, ...header.notices]
  if (lines.length === 0) {
    return null
  }
  return (
    <div className="ew-notices" role="note">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}
