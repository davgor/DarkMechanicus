import { plural } from '../app/plural'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'

interface Props {
  open: number | null
  selected: boolean
  onSelect(): void
}

/** One quick link opens the project's board; cards stay on the board itself. */
export function KanbanLink({ open, selected, onSelect }: Props): JSX.Element {
  return <div className="bucket">
    <button type="button" className={classNames('bucket-header', 'kanban-row', selected && 'is-selected')}
      aria-current={selected ? 'true' : undefined}
      aria-label={open === null ? 'Kanban' : `Kanban, ${plural(open, 'open card')}`} onClick={onSelect}>
      <Icon name="kanban" size={14} />
      <span className="bucket-label">Kanban</span>
      {open === null ? null : <span className="count-badge">{open}</span>}
    </button>
  </div>
}
