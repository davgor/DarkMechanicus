import '../epic/tones.css'
import './checkpoint.css'
import type { EpicDetailView, RunView, SprintReportView } from '../../../shared/domain/views'
import type { OverviewData } from '../epic/workspaceState'
import { Markdown } from '../markdown/Markdown'
import { hasImprovement, SprintReport } from './CheckpointScreen'
import type { CorrectionHost } from './CorrectivePlanner'
import { overviewView, type OverviewView } from './overviewView'
import type { ReportScoreSource } from './ReportScorecard'
import type { ScorecardTarget } from './reportScorecardView'

interface EpicOverviewProps {
  epic: EpicDetailView
  /** The completed run whose history the overview shows. */
  run: RunView
  overview: OverviewData
  now: number
  /** Where each report's Scorecard tab reads (the folder, timers and the workspace's reload version). */
  scores: ReportScoreSource
  /**
   * Previews and creates corrective work for a report's experiments, in a follow-up epic of the completed one (never
   * in it); absent, each Improvement tab is read-only.
   */
  corrections?: CorrectionHost
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

/** A history report's scorecard: pinned to the revision shown, a snapshot the run has since passed. */
function historyTarget(report: SprintReportView): ScorecardTarget {
  return { runId: report.runId, sprintId: report.sprintId, report: { reportId: report.id, reportRevision: report.reportRevision, standing: 'historical' } }
}

/**
 * A completed epic's overview: every sprint report, each with its Scorecard and Improvement tabs, beside the recorded
 * outcome. The epic itself stays read-only: it takes no approve, retry, follow-up or draft handlers, so it offers none of
 * those controls; corrective work it asks for goes into a follow-up epic's draft.
 */
export function EpicOverview(props: EpicOverviewProps): JSX.Element {
  const view = overviewView(props)
  return (
    <div className="cp" aria-label="Epic overview">
      <div className="cp-report">
        {view.reports.length === 0 ? <p className="ew-muted">No sprint reports were recorded for this run.</p> : null}
        {view.reports.map((item, index) => {
          // overviewView maps overview.reports one to one, in order: each item's own report is at its index.
          const source = props.overview.reports[index]
          return (
            <SprintReport
              key={item.id}
              label={item.label}
              report={item.sections}
              scorecard={{ source: props.scores, target: historyTarget(source), run: props.run, bundle: props.overview.bundle }}
              onSelectTicket={props.onSelectTicket}
              improvement={
                hasImprovement(source)
                  ? { report: source, epicTitle: props.epic.title, epicCompleted: props.epic.status === 'completed', corrections: props.corrections }
                  : undefined
              }
            />
          )
        })}
      </div>
      <Outcome view={view} />
    </div>
  )
}
