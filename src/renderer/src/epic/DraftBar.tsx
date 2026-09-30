import { nextRevisionNumber } from './headerView'
import { runLabel } from './runBarView'
import { StatePill } from './StatePill'
import type { WorkspaceHandle } from './useWorkspace'
import { draftBarNote, STALE_DRAFT_NOTE } from './validationView'

function ViewSavedLink({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const saved = ws.data.saved
  if (saved === null) {
    return null
  }
  const run = ws.data.run
  const label =
    run !== null && run.revisionId === saved.revisionId
      ? `View ${runLabel(run).toLowerCase()} on rev ${run.revisionNumber}`
      : `View saved rev ${saved.revisionNumber ?? ''}`
  return (
    <button type="button" className="ew-link" onClick={() => ws.dispatch({ type: 'show_view', view: 'saved' })}>
      {label}
    </button>
  )
}

/** "EDITING DRAFT" bar: what Save will change, and a warning when the draft went stale. */
export function DraftBar({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const stale = ws.data.draft?.stale === true
  return (
    <div className="ew-bar ew-draftbar" aria-label="Draft">
      <div className="ew-bar-row">
        <StatePill tone="running" label="EDITING DRAFT" />
        <span className="ew-bar-text">{draftBarNote(ws.data.run, nextRevisionNumber(ws.data.epic))}</span>
        <div className="ew-bar-actions">
          <button type="button" className="btn btn-ghost" disabled={ws.state.busy} onClick={() => void ws.actions.addSprint()}>
            + Sprint
          </button>
          <ViewSavedLink ws={ws} />
        </div>
      </div>
      {stale ? (
        <p className="ew-bar-warning" role="note">
          {STALE_DRAFT_NOTE}
        </p>
      ) : null}
    </div>
  )
}
