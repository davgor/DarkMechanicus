import { refusalNotice, type RedraftPanel, type RedraftRefusal } from './redraftView'

/** The draft's changes read as the next sprint's plan, and what approving them does. */
export function RedraftSection({ panel }: { panel: RedraftPanel }): JSX.Element {
  return (
    <section className="cp-redraft" aria-label="Redraft">
      <h3 className="ew-eyebrow">{panel.heading}</h3>
      <ul className="ew-changes">
        {panel.rows.map((row, index) => (
          <li key={`${index}:${row.text}`} className={`ew-change is-${row.tone}`}>
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
      {panel.warning === null ? null : (
        <p role="note" className="ew-muted">
          {panel.warning}
        </p>
      )}
      {panel.blocked === null ? null : (
        <p role="note" className="cp-redraft-blocked">
          {panel.blocked}
        </p>
      )}
      <p className="ew-muted">{panel.approves}</p>
    </section>
  )
}

/** Why Approve retro & redraft stopped: the step, the reason, and whether the draft was saved but still has to be adopted. */
export function RefusalAlert(props: { refusal: RedraftRefusal; onDismiss(): void }): JSX.Element {
  const notice = refusalNotice(props.refusal)
  return (
    <div className="cp-refusal" role="alert" aria-label="Approval refused">
      <p>
        <strong>{notice.lead}</strong>
      </p>
      <p className="ew-muted">{notice.message}</p>
      {notice.adoption === null ? null : <p>{notice.adoption}</p>}
      <button type="button" className="ew-icon-btn cp-refusal-dismiss" aria-label="Dismiss" onClick={props.onDismiss}>
        ×
      </button>
    </div>
  )
}
