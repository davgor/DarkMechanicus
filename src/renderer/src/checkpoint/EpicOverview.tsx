import '../epic/tones.css'
import './checkpoint.css'
import type { EpicDetailView, RunView } from '../../../shared/domain/views'
import type { OverviewData } from '../epic/workspaceState'
import { Markdown } from '../markdown/Markdown'
import { SprintReport } from './CheckpointScreen'
import { overviewView, type OverviewView } from './overviewView'

interface EpicOverviewProps {
  epic: EpicDetailView
  /** The completed run whose history the overview shows. */
  run: RunView
  overview: OverviewData
  now: number
  onSelectTicket(ticketId: string): void
}

function Outcome({ view }: { view: OverviewView }): JSX.Element {
  return (
    <aside className="cp-gate" aria-label="Epic outcome">
      <span className="ew-eyebrow">{view.eyebrow}</span>
      <h2 className="cp-gate-title">Epic complete</h2>
      {view.summary === null ? (
        <p className="ew-muted">No outcome was recorded for this epic.</p>
      ) : (
        <Markdown source={view.summary} className="cp-summary" />
      )}
      <ul className="cp-conditions" aria-label="Success criteria">
        {view.criteria.map((line) => (
          <li key={line.text} className={line.met ? 'is-passed' : 'is-failed'}>
            <span className="cp-icon" aria-label={line.met ? 'met' : 'not met'}>
              {line.met ? '✓' : '✗'}
            </span>
            <span className="cp-condition-text">
              <span>{line.text}</span>
              <span className="ew-muted">{line.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </aside>
  )
}

/**
 * A completed epic's overview: every sprint report beside the recorded outcome. Read-only: it takes
 * no approve, retry, follow-up or draft handlers, so it offers none of those controls.
 */
export function EpicOverview(props: EpicOverviewProps): JSX.Element {
  const view = overviewView(props)
  return (
    <div className="cp" aria-label="Epic overview">
      <div className="cp-report">
        {view.reports.length === 0 ? <p className="ew-muted">No sprint reports were recorded for this run.</p> : null}
        {view.reports.map((item) => (
          <SprintReport key={item.id} label={item.label} report={item.sections} onSelectTicket={props.onSelectTicket} />
        ))}
      </div>
      <Outcome view={view} />
    </div>
  )
}
