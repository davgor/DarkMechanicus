import type { KanbanCardSummaryView } from '../../../shared/domain/kanban'
import { KANBAN_LANE_LABELS } from '../../../shared/domain/kanban'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { plural } from '../app/plural'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'

interface Props {
  folder: TrackedFolderView
  open: number | null
  cards?: readonly KanbanCardSummaryView[]
  expanded: boolean
  selected: boolean
  selectedCardId?: string
  onToggle(): void
  onSelect(): void
  onSelectCard(id: string): void
}

/** A board entry stays available while its compact, open-card list is collapsed. */
export function KanbanList(props: Props): JSX.Element {
  return <div className="bucket">
    <div className="sidebar-kanban-head">
      <button type="button" className="sidebar-kanban-toggle" aria-label={`${props.expanded ? 'Collapse' : 'Expand'} Kanban in ${props.folder.name}`} aria-expanded={props.expanded} onClick={props.onToggle}>
        <Icon name={props.expanded ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
      <button type="button" className={classNames('bucket-header', 'kanban-row', props.selected && 'is-selected')} aria-current={props.selected ? 'true' : undefined}
        aria-label={props.open === null ? 'Kanban' : `Kanban, ${plural(props.open, 'open card')}`} onClick={props.onSelect}>
        <span className="bucket-label">Kanban</span>
        {props.open === null ? null : <span className="count-badge">{props.open}</span>}
      </button>
    </div>
    {props.expanded && props.cards !== undefined ? <ul className="bucket-epics sidebar-kanban-list">
      {props.cards.map(card => <li key={card.id}>
        <button type="button" className={classNames('epic-row', 'sidebar-kanban-card', props.selectedCardId === card.id && 'is-selected')}
          aria-label={`${card.key} ${card.title} ${KANBAN_LANE_LABELS[card.lane]}`}
          aria-current={props.selectedCardId === card.id ? 'true' : undefined} onClick={() => props.onSelectCard(card.id)}>
          <span className="sidebar-card-heading"><span className="mono">{card.key}</span> <span className="epic-row-title" title={card.title}>{card.title}</span></span>
          <span className="epic-status">{KANBAN_LANE_LABELS[card.lane]}</span>
        </button>
      </li>)}
    </ul> : null}
  </div>
}
