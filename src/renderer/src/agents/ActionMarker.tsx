import { memo, type ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { markerText, type MarkerModel, type MarkerTarget } from './actionMarkers'
import { useChatContext, useResolvedTarget, type ChatNavigation } from './ChatContext'
import { Hourglass } from './Hourglass'

/** What pressing the marker does: open the ticket (on the attempt's Activity tab when it names one), else the epic, else nothing. */
function opener(target: MarkerTarget, navigation: ChatNavigation | null): (() => void) | null {
  const { epicId, ticketId, attemptId } = target
  if (navigation === null || epicId === null) {
    return null
  }
  if (ticketId !== null) {
    return () => navigation.openTicket({ epicId, ticketId, attemptId })
  }
  return () => navigation.openEpic(epicId)
}

function StatusIcon({ status }: { status: MarkerModel['status'] }): JSX.Element {
  if (status === 'running') {
    return <Hourglass />
  }
  return <Icon name={status === 'completed' ? 'check' : 'close'} size={13} />
}

interface MarkerBodyProps {
  marker: MarkerModel
  text: string
  detail: string | null
}

function MarkerBody({ marker, text, detail }: MarkerBodyProps): ReactNode {
  return (
    <>
      <span className="chat-marker-icon" aria-hidden="true">
        <StatusIcon status={marker.status} />
      </span>
      <span className="chat-marker-text">{text}</span>
      {detail === null ? null : <span className="chat-marker-detail">{detail}</span>}
    </>
  )
}

interface ActionMarkerProps {
  marker: MarkerModel
  /** Why the server refused the call, in its words, when it did; shown after the marker. */
  detail: string | null
}

/**
 * A Dark Mechanicus call as one compact line: "claimed DM-12", "accepted DM-12", "sprint report filed". The
 * words come from the call's tool and the ticket's key, never from its input, so no claim token or id can
 * show. The key and epic are looked up (and the line says "a ticket" until they are found); a marker that can
 * name where it leads is a button that opens the ticket or the epic.
 */
export const ActionMarker = memo(function ActionMarker({ marker, detail }: ActionMarkerProps): JSX.Element {
  const { navigation } = useChatContext()
  const target = useResolvedTarget(marker.target)
  const text = markerText(marker, target.ticketKey)
  const open = opener(target, navigation)
  const label = `Action: ${text}`
  const classes = `chat-marker chat-marker-${marker.status}`
  return (
    <li className={classes} aria-label={label} data-tool={marker.tool}>
      {open === null ? (
        <span className="chat-marker-line">
          <MarkerBody marker={marker} text={text} detail={detail} />
        </span>
      ) : (
        <button type="button" className="chat-marker-line chat-marker-link" title={target.ticketKey === null ? 'Open' : `Open ${target.ticketKey}`} onClick={open}>
          <MarkerBody marker={marker} text={text} detail={detail} />
        </button>
      )}
    </li>
  )
})
