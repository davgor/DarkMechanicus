interface TicketKeyProps {
  ticket: { ticketId: string | null; key: string }
  onSelect(ticketId: string): void
}

/** The ticket key (a link when the plan has the ticket); an entry that names no ticket has none. */
export function TicketKey({ ticket, onSelect }: TicketKeyProps): JSX.Element | null {
  if (ticket.key === '') {
    return null
  }
  if (ticket.ticketId === null) {
    return <span className="ew-mono cp-key">{ticket.key}</span>
  }
  const ticketId = ticket.ticketId
  return (
    <button type="button" className="ew-link ew-mono cp-key" onClick={() => onSelect(ticketId)}>
      {ticket.key}
    </button>
  )
}
