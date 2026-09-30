import type { ListRow, ListSection } from './listView'
import { StateLabel } from './StatePill'

interface ListViewProps {
  sections: ListSection[]
  selectedTicketId: string | null
  onSelect(ticketId: string): void
}

function Row(props: { row: ListRow; selected: boolean; onSelect(ticketId: string): void }): JSX.Element {
  const row = props.row
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
        <StateLabel tone={row.badge.tone} label={row.badge.label} />
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
                <Row key={row.id} row={row} selected={row.id === props.selectedTicketId} onSelect={props.onSelect} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
