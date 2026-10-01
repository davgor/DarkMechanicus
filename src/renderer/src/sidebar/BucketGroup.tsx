import { plural } from '../app/plural'
import { Icon } from '../components/Icon'
import type { Bucket } from './buckets'
import { EpicRow } from './EpicRow'

interface BucketGroupProps {
  bucket: Bucket
  expanded: boolean
  selectedEpicId: string | null
  onToggle(): void
  onOpenEpic(epicId: string): void
}

/** One collapsible bucket (In progress, Backlog or Completed) with its count and epic rows. */
export function BucketGroup(props: BucketGroupProps): JSX.Element {
  const { bucket, expanded, selectedEpicId } = props
  return (
    <div className="bucket">
      <button
        type="button"
        className="bucket-header"
        aria-expanded={expanded}
        aria-label={`${bucket.label}, ${plural(bucket.count, 'epic')}`}
        onClick={props.onToggle}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="bucket-label">{bucket.label}</span>
        <span className="count-badge">{bucket.count}</span>
      </button>
      {expanded ? (
        <ul className="bucket-epics">
          {bucket.epics.map((epic) => (
            <li key={epic.id}>
              <EpicRow epic={epic} selected={epic.id === selectedEpicId} onOpen={props.onOpenEpic} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
