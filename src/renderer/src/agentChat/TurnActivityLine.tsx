import type { AgentChatState } from './agentChatModel'
import { useNow } from '../epic/clock'
import { formatElapsed, turnActivity } from './turnActivity'

interface Props {
  state: AgentChatState
  stop: () => void
  acting: boolean
}

/** Only this leaf subscribes to ticks; elapsed text stays outside the live region. */
export function TurnActivityLine({ state, stop, acting }: Props): JSX.Element | null {
  const activity = turnActivity(state, useNow())
  if (!activity) return null
  const stalled = activity.kind === 'stalled'
  const label = stalled ? 'No activity' : activity.kind === 'waiting' ? 'Waiting for an answer' : 'Working'
  return (
    <div className={`turn-activity${stalled ? ' turn-activity-stalled' : ''}`}>
      <span>
        <span role="status" aria-live="polite">{label}</span>
        {activity.kind === 'working' && <span> {formatElapsed(activity.elapsedMs)}{activity.tool ? ` · ${activity.tool}` : ''}</span>}
        {activity.kind === 'stalled' && <span> for {formatElapsed(activity.silentMs)}</span>}
      </span>
      {stalled && <button className="btn btn-sm" type="button" disabled={acting} onClick={stop}>Stop</button>}
    </div>
  )
}
