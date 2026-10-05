import { Icon } from '../components/Icon'
import { useReducedMotion } from '../epic/useReducedMotion'

/** The hourglass of work in progress: it turns over every few seconds, and holds still when the person prefers reduced motion. */
export function Hourglass({ size = 13 }: { size?: number }): JSX.Element {
  const reduced = useReducedMotion()
  return (
    <span className="chat-hourglass" data-motion={reduced ? 'still' : undefined}>
      <Icon name="hourglass" size={size} />
    </span>
  )
}
