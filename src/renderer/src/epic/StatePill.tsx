import type { Tone } from '../graph/ticketStates'
import './tones.css'

/** A bordered state badge: colored dot plus text label (color never stands alone). */
export function StatePill(props: { tone: Tone; label: string }): JSX.Element {
  return (
    <span className={`ew-pill ew-tone-${props.tone}`}>
      <span className="ew-dot" aria-hidden="true" />
      <span>{props.label}</span>
    </span>
  )
}

/** An inline state label with a colored dot, used in lists and rows. */
export function StateLabel(props: { tone: Tone; label: string }): JSX.Element {
  return (
    <span className={`ew-state ew-tone-${props.tone}`}>
      <span className="ew-dot" aria-hidden="true" />
      <span>{props.label}</span>
    </span>
  )
}
