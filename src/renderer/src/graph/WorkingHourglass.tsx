import { Icon } from '../components/Icon'
import { useReducedMotion } from '../epic/useReducedMotion'
import '../epic/tones.css'

interface WorkingHourglassProps {
  ticketKey: string
  /** Opens the live activity of the attempt being worked on. */
  onOpen(): void
}

/**
 * The hourglass beside a ticket's state: someone is working on it right now. It is a button that opens
 * the attempt's live activity, and it holds still when the system asks for less motion.
 */
export function WorkingHourglass({ ticketKey, onOpen }: WorkingHourglassProps): JSX.Element {
  const reduced = useReducedMotion()
  return (
    <button
      type="button"
      className={reduced ? 'ew-hourglass nodrag nopan is-static' : 'ew-hourglass nodrag nopan is-animated'}
      data-motion={reduced ? 'static' : 'animated'}
      aria-label={`${ticketKey} is being worked on`}
      title="Being worked on. Open the live activity."
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
    >
      <Icon name="hourglass" size={14} className="ew-hourglass-icon" />
    </button>
  )
}
