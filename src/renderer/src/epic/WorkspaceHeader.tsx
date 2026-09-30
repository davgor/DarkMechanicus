import type { HeaderActions, HeaderView } from './headerView'
import { StatePill } from './StatePill'
import type { WorkspaceHandle } from './useWorkspace'
import { saveBlocked } from './validationView'

function LayoutToggle({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const layout = ws.state.layout
  return (
    <div className="ew-toggle" role="group" aria-label="Layout">
      <button
        type="button"
        aria-pressed={layout === 'graph'}
        onClick={() => ws.dispatch({ type: 'show_layout', layout: 'graph' })}
      >
        Graph
      </button>
      <button
        type="button"
        aria-pressed={layout === 'list'}
        onClick={() => ws.dispatch({ type: 'show_layout', layout: 'list' })}
      >
        List
      </button>
    </div>
  )
}

function SavedButtons({ ws, actions }: { ws: WorkspaceHandle; actions: HeaderActions }): JSX.Element {
  const busy = ws.state.busy
  return (
    <>
      {actions.editDraft === null ? null : (
        <button type="button" className="btn" disabled={busy} onClick={() => void ws.actions.editDraft()}>
          {actions.editDraft === 'view' ? 'View draft' : 'Edit draft'}
        </button>
      )}
      {actions.startRun ? (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void ws.actions.startRun()}>
          Start run
        </button>
      ) : null}
    </>
  )
}

function DraftButtons({ ws, actions }: { ws: WorkspaceHandle; actions: HeaderActions }): JSX.Element {
  const busy = ws.state.busy
  const blocked = saveBlocked(ws.state.validation) !== null
  return (
    <>
      {actions.viewSaved ? (
        <button type="button" className="btn btn-ghost" onClick={() => ws.dispatch({ type: 'show_view', view: 'saved' })}>
          View saved
        </button>
      ) : null}
      {actions.discard ? (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => ws.dispatch({ type: 'confirm', kind: 'discard' })}
        >
          Discard draft
        </button>
      ) : null}
      {actions.save === null ? null : (
        <button type="button" className="btn btn-primary" disabled={busy || blocked} onClick={() => void ws.actions.saveDraft()}>
          {actions.save}
        </button>
      )}
    </>
  )
}

function Provenance({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const provenance = ws.data.epic.provenance
  if (provenance === null) {
    return null
  }
  return (
    <button type="button" className="ew-link" onClick={() => ws.onOpenEpic(provenance.sourceEpicId)}>
      Follows an earlier epic
    </button>
  )
}

export function WorkspaceHeader({ ws, header }: { ws: WorkspaceHandle; header: HeaderView }): JSX.Element {
  return (
    <header className="ew-header">
      <div className="ew-heading">
        <span className="ew-crumbs">
          {header.breadcrumb}
          <Provenance ws={ws} />
        </span>
        <div className="ew-title-row">
          <h1 className="ew-title">{ws.data.epic.title}</h1>
          {header.badge === null ? null : (
            <StatePill tone={header.badge.tone === 'saved' ? 'accepted' : 'running'} label={header.badge.label} />
          )}
        </div>
      </div>
      <div className="ew-header-actions">
        <LayoutToggle ws={ws} />
        <SavedButtons ws={ws} actions={header.actions} />
        <DraftButtons ws={ws} actions={header.actions} />
      </div>
    </header>
  )
}
