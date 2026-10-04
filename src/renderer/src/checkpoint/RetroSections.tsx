import type { PlanBundle } from '../../../shared/domain/bundle'
import { Markdown, SafeLink } from '../markdown/Markdown'
import type { NextSprintItem } from './gateView'
import { placedIn, type DiscoveryItem, type LeftoverItem } from './nextSprint'
import type { DeliveredRow, DiscoveryRow, EvidencePart, LeftoverRow, RetroSections, TierFitRow } from './retroView'
import { TicketKey } from './TicketKey'

/** What the checkpoint can do with the report's work for the next sprint; a report without it is read-only. */
export interface NextSprintActions {
  busy: boolean
  /** The epic's draft, so an item it already holds shows where it is; null when there is none. */
  draft: PlanBundle | null
  checkpointOrdinal: number
  onAdd(item: NextSprintItem): Promise<boolean>
}

interface Selectable {
  onSelectTicket(ticketId: string): void
}

function Evidence({ parts }: { parts: EvidencePart[] }): JSX.Element | null {
  if (parts.length === 0) {
    return null
  }
  return (
    <span className="ew-mono cp-evidence">
      {parts.map((part, index) => (
        <span key={`${index}:${part.text}`}>{part.href === null ? part.text : <SafeLink href={part.href}>{part.text}</SafeLink>}</span>
      ))}
    </span>
  )
}

/** The sprint demo: each delivered item with its ticket, what to look at and its evidence links. */
function Delivered(props: Selectable & { rows: DeliveredRow[] }): JSX.Element | null {
  if (props.rows.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label="Delivered">
      <h3 className="ew-eyebrow">DELIVERED · {props.rows.length}</h3>
      <ul className="cp-delivered">
        {props.rows.map((row, index) => (
          <li key={`${index}:${row.ticket.key}`}>
            <span className="cp-ticket-head">
              <TicketKey ticket={row.ticket} onSelect={props.onSelectTicket} />
              <span>{row.ticket.title}</span>
            </span>
            <Markdown source={row.demo} className="cp-demo" />
            <Evidence parts={row.evidence} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function Notes(props: { label: string; title: string; items: string[] }): JSX.Element | null {
  if (props.items.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label={props.label}>
      <h3 className="ew-eyebrow">{props.title}</h3>
      <ul className="cp-notes">
        {props.items.map((text, index) => (
          <li key={`${index}:${text}`}>{text}</li>
        ))}
      </ul>
    </section>
  )
}

const TIER_COLUMNS = ['Ticket', 'Planned', 'Used', 'Attempts', 'Verdict']

function TierFitRowView(props: Selectable & { row: TierFitRow }): JSX.Element {
  const { row } = props
  return (
    <tr>
      <td className="cp-tier-ticket">
        <TicketKey ticket={row.ticket} onSelect={props.onSelectTicket} />
        <span className="cp-tier-title">{row.ticket.title}</span>
      </td>
      <td>{row.planned}</td>
      <td>
        <ul className="cp-tier-used">
          {row.used.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </td>
      <td>{row.attempts}</td>
      <td className="cp-tier-verdict">
        {row.verdict === null ? (
          <span className="ew-muted">no verdict</span>
        ) : (
          <span className={`ew-pill ew-tone-${row.verdict.tone}`}>{row.verdict.label}</span>
        )}
        {row.note === '' ? null : <span className="ew-muted">{row.note}</span>}
      </td>
    </tr>
  )
}

/** Each worked ticket's planned size, level and effort against the models and efforts it actually used. */
function TierFit(props: Selectable & { rows: TierFitRow[] }): JSX.Element | null {
  if (props.rows.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label="Tier fit">
      <h3 className="ew-eyebrow">TIER FIT</h3>
      <div className="cp-tier-scroll">
        <table className="cp-tier">
          <thead>
            <tr>
              {TIER_COLUMNS.map((name) => (
                <th key={name} scope="col">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, index) => (
              <TierFitRowView key={`${index}:${row.ticket.key}`} row={row} onSelectTicket={props.onSelectTicket} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** The button that puts the item into the draft's next sprint, or where the draft already holds it; nothing in a read-only report. */
function ItemAction(props: { item: DiscoveryItem | LeftoverItem; label: string; actions: NextSprintActions | undefined }): JSX.Element | null {
  const { actions, item } = props
  if (actions === undefined) {
    return null
  }
  const placed = actions.draft === null ? null : placedIn(item, actions.draft, actions.checkpointOrdinal)
  if (placed !== null) {
    return <span className="ew-chip">{`In Sprint ${placed} of the draft`}</span>
  }
  return (
    <button type="button" className="btn" disabled={actions.busy} onClick={() => void actions.onAdd(item)}>
      {props.label}
    </button>
  )
}

function DiscoveryItemView(props: Selectable & { row: DiscoveryRow; actions: NextSprintActions | undefined }): JSX.Element {
  const { row } = props
  const item: DiscoveryItem = { kind: 'discovery', title: row.title, body: row.body }
  return (
    <li className="cp-followup">
      <span className="cp-followup-text">
        <span>{row.title}</span>
        {row.body === '' ? null : <span className="ew-muted">{row.body}</span>}
        {row.source === null ? null : (
          <span className="ew-muted">
            Came up on <TicketKey ticket={row.source} onSelect={props.onSelectTicket} />
          </span>
        )}
      </span>
      <ItemAction item={item} label="+ Add to next sprint" actions={props.actions} />
    </li>
  )
}

function Discoveries(props: Selectable & { rows: DiscoveryRow[]; actions: NextSprintActions | undefined }): JSX.Element | null {
  if (props.rows.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label="Discoveries">
      <h3 className="ew-eyebrow">DISCOVERIES · {props.rows.length}</h3>
      <ul className="cp-items">
        {props.rows.map((row, index) => (
          <DiscoveryItemView key={`${index}:${row.title}`} row={row} actions={props.actions} onSelectTicket={props.onSelectTicket} />
        ))}
      </ul>
    </section>
  )
}

function LeftoverAction({ row, actions }: { row: LeftoverRow; actions: NextSprintActions | undefined }): JSX.Element | null {
  if (row.accepted) {
    return <span className="ew-chip">Accepted since the retro</span>
  }
  const ticketId = row.ticket.ticketId
  return ticketId === null ? null : <ItemAction item={{ kind: 'leftover', ticketId }} label="Move to next sprint" actions={actions} />
}

function Leftovers(props: Selectable & { rows: LeftoverRow[]; actions: NextSprintActions | undefined }): JSX.Element | null {
  if (props.rows.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label="Leftovers">
      <h3 className="ew-eyebrow">LEFTOVERS · {props.rows.length}</h3>
      <ul className="cp-items">
        {props.rows.map((row, index) => (
          <li key={`${index}:${row.ticket.key}`} className="cp-followup">
            <span className="cp-followup-text">
              <span className="cp-ticket-head">
                <TicketKey ticket={row.ticket} onSelect={props.onSelectTicket} />
                <span>{row.ticket.title}</span>
              </span>
              <span className="ew-muted">{row.reason}</span>
            </span>
            <LeftoverAction row={row} actions={props.actions} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The retro as the sprint demo then the retro: what was delivered, what went well and poorly, the actions,
 * the tier fit, and the work for the next sprint. Without `actions` it is read-only.
 */
export function Retro(props: Selectable & { retro: RetroSections | null; actions?: NextSprintActions }): JSX.Element | null {
  const { retro } = props
  if (retro === null) {
    return null
  }
  return (
    <>
      <Delivered rows={retro.delivered} onSelectTicket={props.onSelectTicket} />
      <Notes label="Went well" title="WENT WELL" items={retro.wentWell} />
      <Notes label="Went poorly" title="WENT POORLY" items={retro.wentPoorly} />
      <Notes label="Actions" title="ACTIONS FOR THE NEXT SPRINT" items={retro.actions} />
      <TierFit rows={retro.tierFit} onSelectTicket={props.onSelectTicket} />
      <Discoveries rows={retro.discoveries} actions={props.actions} onSelectTicket={props.onSelectTicket} />
      <Leftovers rows={retro.leftovers} actions={props.actions} onSelectTicket={props.onSelectTicket} />
    </>
  )
}
