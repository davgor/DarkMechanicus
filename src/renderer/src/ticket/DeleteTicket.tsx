import { useState } from 'react'

interface DeleteTicketProps {
  ticketKey: string
  /** Resolves to the refusal's reason, or null once the ticket is gone. */
  onDelete(): Promise<string | null>
  onKeep(): void
}

/** Saved-view confirmation: deleting saves the plan without the ticket as a new revision. */
export function DeleteTicketConfirm(props: DeleteTicketProps): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const refused = await props.onDelete()
    setBusy(false)
    setError(refused)
  }
  return (
    <div className="tp-remove tp-delete" role="alertdialog" aria-label="Delete ticket">
      <span>
        Delete {props.ticketKey} from the saved plan? Its dependencies go with it, and the plan is saved as a new revision.
      </span>
      <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
        Delete ticket
      </button>
      <button type="button" className="btn btn-ghost" onClick={props.onKeep}>
        Keep
      </button>
      {error === null ? null : (
        <p role="alert" className="tp-error">
          {error}
        </p>
      )}
    </div>
  )
}
