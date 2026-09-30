import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { BranchEpicView } from '../../../shared/domain/views'
import { useBranchEpics } from '../app/useBranchEpics'
import { useToasts } from '../app/toasts'
import { StatePill } from '../components/StatePill'

function BranchEpicRow({ entry }: { entry: BranchEpicView }): JSX.Element {
  return (
    <li className="branch-epic">
      <span className="branch-epic-title">{entry.title}</span>
      <span className="branch-epic-meta">
        <span className="mono">{entry.branch}</span>
        <StatePill state={entry.status} />
        {entry.revisionNumber === null ? null : <span className="mono">rev {entry.revisionNumber}</span>}
        <span className="muted">{entry.presentLocally ? 'on this checkout' : 'not on this checkout'}</span>
      </span>
    </li>
  )
}

function Body({ folder }: { folder: TrackedFolderView }): JSX.Element {
  const toasts = useToasts()
  const resource = useBranchEpics(folder.path, toasts.reportError)
  if (resource.status === 'loading') {
    return <p className="muted">Loading…</p>
  }
  if (resource.status === 'error') {
    return <p className="muted is-error">Could not read the other branches.</p>
  }
  if (resource.value.length === 0) {
    return <p className="muted">No epics are recorded on other local branches.</p>
  }
  return (
    <ul className="branch-epics">
      {resource.value.map((entry) => (
        <BranchEpicRow key={`${entry.branch}:${entry.epicId}`} entry={entry} />
      ))}
    </ul>
  )
}

/** Epics that exist on other local branches: information only, nothing here can be edited. */
export function BranchEpics({ folder }: { folder: TrackedFolderView }): JSX.Element {
  return (
    <section className="card" aria-label="Epics on other branches">
      <h2 className="card-title">Epics on other branches</h2>
      <p className="note">Read-only. Switch branches in Git to work on them.</p>
      <Body folder={folder} />
    </section>
  )
}
