import { useEffect, useRef, useState } from 'react'
import type { CorrectionProvenance } from '../../../shared/domain/bundle'
import { runCommand } from '../api/dm'
import { DeleteEpic } from './DeleteEpic'
import type { HeaderActions, HeaderView } from './headerView'
import { StatePill } from './StatePill'
import type { WorkspaceHandle } from './useWorkspace'
import { saveBlocked } from './validationView'

/** What the stage shows: the plan as a graph or a list, or the epic's Scorecard (live, or immutable once completed). */
function ViewToggle({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const { layout, scorecardOpen } = ws.state
  return (
    <div className="ew-toggle" role="group" aria-label="View">
      <button
        type="button"
        aria-pressed={!scorecardOpen && layout === 'graph'}
        onClick={() => ws.dispatch({ type: 'show_layout', layout: 'graph' })}
      >
        Graph
      </button>
      <button
        type="button"
        aria-pressed={!scorecardOpen && layout === 'list'}
        onClick={() => ws.dispatch({ type: 'show_layout', layout: 'list' })}
      >
        List
      </button>
      <button
        type="button"
        aria-pressed={scorecardOpen}
        title={ws.data.epic.status === 'completed' ? 'The assessment frozen when the epic completed' : 'The epic’s live grade'}
        onClick={() => ws.dispatch({ type: scorecardOpen ? 'close_scorecard' : 'open_scorecard' })}
      >
        Scorecard
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
      {actions.transfer ? (
        <button type="button" className="btn" disabled={busy} onClick={() => ws.dispatch({ type: 'transfer_dialog', mode: 'queue' })}>
          Transfer to Linear
        </button>
      ) : null}
      {actions.startRun ? (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => ws.dispatch({ type: 'start_run_dialog', open: true })}>
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
      {actions.saveUnavailable === null ? null : (
        <span className="ew-header-notice" role="status">
          {actions.saveUnavailable}
        </span>
      )}
      {actions.save === null ? null : (
        <button type="button" className="btn btn-primary" disabled={busy || blocked} onClick={() => void ws.actions.saveDraft()}>
          {actions.save}
        </button>
      )}
    </>
  )
}

/**
 * The tracked folder holding project `projectId` on this machine, or null when none does. Each folder asked opens its
 * workspace in main, so this runs only when the person follows the link: one set-up folder at a time, stopping at the
 * first that holds the project, never asking `skip` (the folder showing this epic, which holds another project).
 */
async function findProjectFolder(projectId: string, skip: string): Promise<string | null> {
  const folders = (await window.dm.listFolders().catch(() => [])).filter((folder) => folder.initialized && folder.available && folder.path !== skip)
  for (const folder of folders) {
    const project = await runCommand(folder.path, 'getProject', undefined).catch(() => null)
    if (project?.projectId === projectId) return folder.path
  }
  return null
}

/**
 * Where a correction epic came from: the project, epic, report revision and experiment that asked for it, opened in
 * that project's own folder when it is tracked here (its retro measures this epic's grades, before and after). Opening
 * it only shows it: a completed epic stays completed. A project correcting itself asked from this very folder; another
 * project's folder is looked up only when the link is followed.
 */
function CorrectionSource({ ws, provenance }: { ws: WorkspaceHandle; provenance: CorrectionProvenance }): JSX.Element {
  const { source, target } = provenance
  const [lookup, setLookup] = useState<'idle' | 'finding' | 'untracked'>('idle')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const open = ws.onOpenFolderEpic
  const label = `Corrective work from ${source.projectName} · ${source.experimentId} · report revision ${source.reportRevision}`
  const where = `Epic ${source.epicId} of project ${source.projectId}`
  if (open === null) return <span title={where}>{label}</span>
  const here = ws.folder.path
  const follow = async (): Promise<void> => {
    if (source.projectId === target.projectId) return open(here, source.epicId)
    setLookup('finding')
    const folder = await findProjectFolder(source.projectId, here)
    if (!mounted.current) return
    setLookup(folder === null ? 'untracked' : 'idle')
    if (folder !== null) open(folder, source.epicId)
  }
  return (
    <>
      <button
        type="button"
        className="ew-link"
        title={where}
        disabled={lookup === 'finding'}
        aria-busy={lookup === 'finding'}
        onClick={() => void follow()}
      >
        {label}: open the epic that asked for it
      </button>
      {lookup === 'untracked' ? (
        <span role="status">
          {' '}
          {source.projectName} ({source.projectId}) is not in your folder list on this machine: add its folder to open the epic.
        </span>
      ) : null}
    </>
  )
}

function Provenance({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const provenance = ws.data.epic.provenance
  if (provenance === null) {
    return null
  }
  if ('kind' in provenance) {
    return <CorrectionSource key={provenance.key} ws={ws} provenance={provenance} />
  }
  const { sourceEpicId } = provenance
  return (
    <button type="button" className="ew-link" onClick={() => ws.onOpenEpic(sourceEpicId)}>
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
        <ViewToggle ws={ws} />
        <SavedButtons ws={ws} actions={header.actions} />
        <DraftButtons ws={ws} actions={header.actions} />
        <DeleteEpic ws={ws} />
      </div>
    </header>
  )
}
