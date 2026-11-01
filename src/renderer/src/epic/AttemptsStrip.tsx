import { useState } from 'react'
import type { RunView } from '../../../shared/domain/views'
import { usePersistentState } from '../app/usePersistentState'
import { recentAttempts, stripItems, syncedLabel } from './attemptsStripView'
import type { WorkspaceHandle } from './useWorkspace'

/** Whether the person hid the strip's attempts: kept across epics and restarts, like the sidebar's expansion. */
const HIDDEN_STORAGE_KEY = 'dm.attemptsStrip.hidden'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

function AttemptItems({ ws, run, expanded }: { ws: WorkspaceHandle; run: RunView; expanded: boolean }): JSX.Element {
  const keys = new Map(run.tickets.map((item) => [item.ticketId, item.key]))
  const items = expanded ? recentAttempts(run, keys, ws.now) : stripItems(run, keys, ws.now)
  return (
    <>
      <ul className="ew-strip-items">
        {items.map((item) => (
          <li key={item.attemptId}>
            <button
              type="button"
              className={`ew-strip-item ew-tone-${item.tone}`}
              title={item.text}
              onClick={() => ws.dispatch({ type: 'open_activity', ticketId: item.ticketId, attemptId: item.attemptId })}
            >
              <span className="ew-dot" aria-hidden="true" />
              <span className="ew-strip-text">{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 ? <span className="ew-muted">No open attempts</span> : null}
    </>
  )
}

/**
 * Bottom strip in the Saved view: open and recent attempts, plus when the view last synced. Each attempt
 * keeps to one line (its full text is the tooltip) and the expanded list scrolls, so long failure or
 * rejection reasons cannot push the graph off screen; the person can also hide the attempts entirely.
 */
export function AttemptsStrip({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [hidden, setHidden] = usePersistentState(HIDDEN_STORAGE_KEY, false, isBoolean)
  const run = ws.data.run
  if (run === null) {
    return null
  }
  const open = expanded && !hidden
  // Pressing Attempts while hidden asks to see them: show the strip again, expanded.
  const toggleExpanded = (): void => {
    setHidden(false)
    setExpanded(!open)
  }
  const hideLabel = hidden ? 'Show attempts' : 'Hide attempts'
  return (
    <section className={open ? 'ew-strip is-expanded' : 'ew-strip'} aria-label="Run activity">
      <button type="button" className="ew-strip-toggle" aria-expanded={open} onClick={toggleExpanded}>
        Attempts
      </button>
      {hidden ? null : <AttemptItems ws={ws} run={run} expanded={open} />}
      <span className="ew-strip-sync">{syncedLabel(ws.state.loadedAt, ws.now)}</span>
      <button type="button" className="ew-icon-btn ew-strip-hide" aria-label={hideLabel} title={hideLabel} onClick={() => setHidden(!hidden)}>
        {hidden ? '▴' : '▾'}
      </button>
    </section>
  )
}
