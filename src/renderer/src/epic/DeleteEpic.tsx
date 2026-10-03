import { useState } from 'react'
import { deleteOpenEpic } from './deletion'
import type { WorkspaceHandle } from './useWorkspace'

/** "Delete epic…" in the header, with the confirmation dropping down below it. */
export function DeleteEpic({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const confirm = (): void => {
    setConfirming(false)
    void deleteOpenEpic(ws)
  }
  return (
    <div className="ew-delete">
      <button type="button" className="btn btn-ghost ew-danger-link" disabled={ws.state.busy} onClick={() => setConfirming(true)}>
        Delete epic…
      </button>
      {confirming ? (
        <div className="ew-delete-pop" role="alertdialog" aria-label="Delete epic">
          <p>
            Delete this epic with its runs, comments and .darkmechanicus files? The files are removed from this
            checkout; commit the removal yourself.
          </p>
          <div className="ew-delete-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button type="button" className="btn btn-danger" disabled={ws.state.busy} onClick={confirm}>
              Delete epic
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
