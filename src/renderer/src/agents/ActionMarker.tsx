import { memo } from 'react'
import { Icon } from '../components/Icon'
import { markerText, type MarkerModel } from './actionMarkers'
import { Hourglass } from './Hourglass'

function StatusIcon({ status }: { status: MarkerModel['status'] }): JSX.Element {
  if (status === 'running') {
    return <Hourglass />
  }
  return <Icon name={status === 'completed' ? 'check' : 'close'} size={13} />
}

interface ActionMarkerProps {
  marker: MarkerModel
  /** Why the server refused the call, in its words, when it did; shown after the marker. */
  detail: string | null
}

/**
 * A Dark Mechanicus call as one compact line: "claimed DM-12", "accepted DM-12", "sprint report filed". The
 * words come from the call's tool and the ticket's key the call carried, never from its input, so no claim token
 * or id can show; a call that carried no key says "a ticket".
 */
export const ActionMarker = memo(function ActionMarker({ marker, detail }: ActionMarkerProps): JSX.Element {
  const text = markerText(marker, marker.target.ticketKey)
  return (
    <li className={`chat-marker chat-marker-${marker.status}`} aria-label={`Action: ${text}`} data-tool={marker.tool}>
      <span className="chat-marker-line">
        <span className="chat-marker-icon" aria-hidden="true">
          <StatusIcon status={marker.status} />
        </span>
        <span className="chat-marker-text">{text}</span>
        {detail === null ? null : <span className="chat-marker-detail">{detail}</span>}
      </span>
    </li>
  )
})
