import type { EpicSummaryView } from '../../../shared/domain/views'
import { classNames } from '../components/classNames'
import { EpicBadges, EpicStatusText } from './EpicMeta'

interface EpicRowProps {
  epic: EpicSummaryView
  selected: boolean
  onOpen(epicId: string): void
}

/** One epic in the sidebar: title, status line and badges; opens the epic when pressed. */
export function EpicRow({ epic, selected, onOpen }: EpicRowProps): JSX.Element {
  return (
    <button
      type="button"
      className={classNames('epic-row', selected && 'is-selected')}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onOpen(epic.id)}
    >
      <span className="epic-row-title" title={epic.title}>
        {epic.title}
      </span>{' '}
      <span className="epic-row-meta">
        <EpicStatusText epic={epic} /> <EpicBadges epic={epic} />
      </span>
    </button>
  )
}
