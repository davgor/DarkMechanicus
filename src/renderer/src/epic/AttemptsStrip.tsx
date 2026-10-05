import { useState } from 'react'
import { recentAttempts, stripItems, syncedLabel } from './attemptsStripView'
import type { WorkspaceHandle } from './useWorkspace'

/** Bottom strip in the Saved view: open and recent attempts, plus when the view last synced. */
export function AttemptsStrip({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const run = ws.data.run
  if (run === null) {
    return null
  }
  const keys = new Map(run.tickets.map((item) => [item.ticketId, item.key]))
  const items = expanded ? recentAttempts(run, keys, ws.now) : stripItems(run, keys, ws.now)
  return (
    <section className={expanded ? 'ew-strip is-expanded' : 'ew-strip'} aria-label="Run activity">
      <button type="button" className="ew-strip-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        Attempts
      </button>
      <ul className="ew-strip-items">
        {items.map((item) => (
          <li key={item.attemptId}>
            <button
              type="button"
              className={`ew-strip-item ew-tone-${item.tone}`}
              onClick={() => ws.dispatch({ type: 'open_activity', ticketId: item.ticketId, attemptId: item.attemptId })}
            >
              <span className="ew-dot" aria-hidden="true" />
              {item.text}
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 ? <span className="ew-muted">No open attempts</span> : null}
      <span className="ew-strip-sync">{syncedLabel(ws.state.loadedAt, ws.now)}</span>
    </section>
  )
}
