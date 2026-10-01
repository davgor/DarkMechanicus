import { nextRevisionNumber } from './headerView'
import type { WorkspaceHandle } from './useWorkspace'
import {
  changeRows,
  changesHeading,
  saveBlocked,
  saveNote,
  validationSummary,
  type ChangeRow,
  type ValidationItem
} from './validationView'

const VALIDATION_ICONS: Record<ValidationItem['tone'], string> = { ok: '✓', error: '✗', warning: '⚠' }

function ValidationList({ heading, items }: { heading: string; items: ValidationItem[] }): JSX.Element {
  return (
    <section className="ew-vpanel-section" aria-label="Validation">
      <h3 className="ew-eyebrow">{heading}</h3>
      <ul className="ew-vlist">
        {items.map((item, index) => (
          <li key={index} className={`ew-vitem is-${item.tone}`}>
            <span className="ew-vicon" aria-hidden="true">
              {VALIDATION_ICONS[item.tone]}
            </span>
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ChangeList({ heading, rows }: { heading: string; rows: ChangeRow[] }): JSX.Element {
  return (
    <section className="ew-vpanel-section" aria-label="Changes">
      <h3 className="ew-eyebrow">{heading}</h3>
      {rows.length === 0 ? <p className="ew-muted">No changes yet.</p> : null}
      <ul className="ew-changes">
        {rows.map((row, index) => (
          <li key={index} className={`ew-change is-${row.tone}`}>
            <span className="ew-change-symbol" aria-label={row.tone}>
              {row.symbol}
            </span>
            <span>
              {row.label === '' ? null : <strong>{row.label}: </strong>}
              {row.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SaveBox({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const next = nextRevisionNumber(ws.data.epic)
  const blocked = saveBlocked(ws.state.validation)
  const notice = ws.state.saveNotice
  return (
    <div className="ew-savebox">
      <button
        type="button"
        className="btn btn-primary ew-save"
        disabled={ws.state.busy || blocked !== null}
        onClick={() => void ws.actions.saveDraft()}
      >
        Save rev {next}
      </button>
      <p className="ew-muted">{saveNote(ws.data.run, next)}</p>
      {blocked === null ? null : <p className="ew-save-blocked">{blocked}</p>}
      {notice === null ? null : (
        <p className={`ew-save-notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
    </div>
  )
}

/** Draft view footer: validation results, changes since the base revision, and Save. */
export function ValidationPanel({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const draft = ws.data.draft
  if (draft === null || draft.readOnly) {
    return null
  }
  const summary = validationSummary(ws.state.validation)
  return (
    <section className="ew-vpanel" aria-label="Draft validation">
      <ValidationList heading={summary.heading} items={summary.items} />
      <ChangeList heading={changesHeading(draft)} rows={changeRows(draft.changes)} />
      <SaveBox ws={ws} />
    </section>
  )
}
