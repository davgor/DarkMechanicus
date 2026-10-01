import { plural } from '../app/plural'
import type { EpicListState } from '../app/useEpicLists'
import { EmptyState } from '../components/EmptyState'
import type { EpicSummaryView } from '../../../shared/domain/views'
import { groupEpics } from '../sidebar/buckets'
import type { Bucket } from '../sidebar/buckets'
import { EpicBadges, EpicStatusText } from '../sidebar/EpicMeta'

interface EpicBucketsProps {
  list: EpicListState
  onOpenEpic(epicId: string): void
}

function EpicCard({ epic, onOpen }: { epic: EpicSummaryView; onOpen(epicId: string): void }): JSX.Element {
  return (
    <button type="button" className="epic-card" onClick={() => onOpen(epic.id)}>
      <span className="epic-card-title">{epic.title}</span> <EpicStatusText epic={epic} />{' '}
      <span className="epic-card-meta mono">
        {plural(epic.ticketCount, 'ticket')} · {plural(epic.sprintCount, 'sprint')}
      </span>{' '}
      <EpicBadges epic={epic} />
    </button>
  )
}

function BucketSection({ bucket, onOpenEpic }: { bucket: Bucket; onOpenEpic(epicId: string): void }): JSX.Element {
  return (
    <section className="home-bucket" aria-label={bucket.label}>
      <h2 className="section-title">
        {bucket.label}
        <span className="count-badge">{bucket.count}</span>
      </h2>
      {bucket.count === 0 ? (
        <p className="muted">None</p>
      ) : (
        <ul className="epic-cards">
          {bucket.epics.map((epic) => (
            <li key={epic.id}>
              <EpicCard epic={epic} onOpen={onOpenEpic} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Every epic of the folder, grouped into the same three buckets as the sidebar. */
export function EpicBuckets({ list, onOpenEpic }: EpicBucketsProps): JSX.Element {
  if (list.status === 'loading') {
    return <p className="muted">Loading epics…</p>
  }
  if (list.status === 'ready' && list.epics.length === 0) {
    return (
      <EmptyState icon="folder" title="No epics yet">
        Use New epic to create one here, or ask an agent to plan one over MCP.
      </EmptyState>
    )
  }
  return (
    <div className="home-buckets">
      {list.status === 'error' ? <p className="muted is-error">Could not refresh epics: {list.error}</p> : null}
      {groupEpics(list.epics).map((bucket) => (
        <BucketSection key={bucket.id} bucket={bucket} onOpenEpic={onOpenEpic} />
      ))}
    </div>
  )
}
