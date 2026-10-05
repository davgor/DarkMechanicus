import { WorkingHourglass } from '../graph/WorkingHourglass'
import type { ListRow, ListSection } from './listSections'
import { StateLabel } from './StatePill'

interface ListViewProps {
  sections: ListSection[]
  selectedTicketId: string | null
  onSelect(ticketId: string): void
  /** The hourglass of a ticket being worked on was clicked: open the live activity of that attempt. */
  onOpenActivity(ticketId: string, attemptId: string): void
}

interface RowProps {
  row: ListRow
  selected: boolean
  onSelect(ticketId: string): void
  onOpenActivity(ticketId: string, attemptId: string): void
}

function Row(props: RowProps): JSX.Element {
  const { row, onOpenActivity } = props
  const attemptId = row.working
  return (
    <tr className={props.selected ? 'is-selected' : undefined}>
      <td className="ew-mono">
        <button type="button" className="ew-link" onClick={() => props.onSelect(row.id)}>
          {row.key}
        </button>
      </td>
      <td>
        {row.title}
        {row.optional ? <span className="ew-chip">optional</span> : null}
      </td>
      <td>{row.status}</td>
      <td>
        <span className="ew-list-state">
          <StateLabel tone={row.badge.tone} label={row.badge.label} />
          {attemptId === null ? null : <WorkingHourglass ticketKey={row.key} onOpen={() => onOpenActivity(row.id, attemptId)} />}
        </span>
      </td>
      <td>{row.priority}</td>
      <td>
        {row.tags.map((tag) => (
          <span key={tag} className="ew-chip">
            {tag}
          </span>
        ))}
      </td>
    </tr>
  )
}

/** Supporting table view of the plan, grouped by sprint. */
export function ListView(props: ListViewProps): JSX.Element {
  return (
    <div className="ew-list" aria-label="Plan list">
      {props.sections.map((section) => (
        <section key={section.sprintId} className="ew-list-section" aria-label={section.heading}>
          <h2 className="ew-list-heading">
            <span className="ew-eyebrow">{section.heading}</span>
            <span>{section.goal}</span>
          </h2>
          <table className="ew-table">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Title</th>
                <th scope="col">Status</th>
                <th scope="col">Execution</th>
                <th scope="col">Priority</th>
                <th scope="col">Tags</th>
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  selected={row.id === props.selectedTicketId}
                  onSelect={props.onSelect}
                  onOpenActivity={props.onOpenActivity}
                />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
