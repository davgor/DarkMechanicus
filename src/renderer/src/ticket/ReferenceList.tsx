import type { TicketReference } from '../../../shared/domain/bundle'
import { SafeLink } from '../markdown/Markdown'

export function isWebLocation(location: string): boolean {
  return /^https?:\/\//i.test(location)
}

/** A card's or ticket's inert references: each label and location, as a safe link when the location is a web address. */
export function ReferenceList({ references }: { references: TicketReference[] }): JSX.Element | null {
  if (references.length === 0) {
    return null
  }
  return (
    <section className="tp-section" aria-label="References">
      <h3 className="ew-eyebrow">REFERENCES</h3>
      <ul className="tp-files">
        {references.map((reference) => {
          const text = reference.label === reference.location ? reference.location : `${reference.label} (${reference.location})`
          return (
            <li key={`${reference.kind}:${reference.location}`}>
              {isWebLocation(reference.location) ? <SafeLink href={reference.location}>{text}</SafeLink> : <span className="ew-mono">{text}</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
