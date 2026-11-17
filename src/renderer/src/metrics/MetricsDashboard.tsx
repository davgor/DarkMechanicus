import '../epic/tones.css'
import '../epic/epic.css'
import './metrics.css'
import { useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { MetricsSummaryView } from '../../../shared/domain/views'
import { Button } from '../components/Button'
import { type ScoreReadError } from '../scorecard/scoreReads'
import { ScoreReadNotice } from '../scorecard/ScorecardParts'
import { localTime, shortHash } from '../scorecard/scorecardFormat'
import { EpicTable, MeasurementCapabilities, type MetricsLinks, SprintTrend, SummaryTiles, TopGaps } from './MetricsSections'
import { useMetricsRead } from './useMetricsRead'

interface MetricsDashboardProps {
  folder: TrackedFolderView
  /** Opens an epic's workspace on its Scorecard. */
  onOpenEpic(epicId: string): void
  /** Opens a ticket in its epic's workspace on its Scorecard tab, on one run's grade when named. */
  onOpenTicket: MetricsLinks['openTicket']
}

interface FreshnessProps {
  summary: MetricsSummaryView
  loadedAt: number
  refreshError: ScoreReadError | null
  refreshing: boolean
  onRefresh(): void
}

/** The grading policy, when the summary was read and its cutoff, and Refresh: the only way it is read again. */
function Freshness(props: FreshnessProps): JSX.Element {
  const { policy, window } = props.summary
  return (
    <div className="metrics-freshness">
      <span className="ew-mono" title={policy.hash}>
        Policy {policy.policyId} v{policy.version} · {shortHash(policy.hash)}
      </span>
      <div className="sc-freshness" aria-label="Data freshness">
        <span>
          Read {localTime(props.loadedAt)} · records up to <time dateTime={window.cutoff}>{localTime(window.cutoff)}</time> · read when opened and on Refresh, not
          polled
        </span>
        <Button variant="ghost" size="sm" busy={props.refreshing} onClick={props.onRefresh}>
          {props.refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      {props.refreshError === null || props.refreshing ? null : (
        <p role="alert" className="sc-stale">
          The last refresh failed ({props.refreshError.message}); showing the data read {localTime(props.loadedAt)}.
        </p>
      )}
    </div>
  )
}

/** How measurements reach a folder, for a folder with nothing measured yet. */
function HowMeasurementsArrive({ epics }: { epics: number }): JSX.Element {
  return (
    <section className="card card-dashed metrics-empty" aria-label="No measurements yet">
      <h2 className="card-subtitle">{epics === 0 ? 'No epics to measure yet' : 'No epic has executed work yet'}</h2>
      <p className="metrics-note">
        Measurements arrive while agents run epics. Connect an agent over MCP (the MCP line in the sidebar shows connected sessions), plan and save an epic,
        and start a run: workers report their tokens and active time as they work, and each ticket is graded once its work is reviewed. Nothing is
        shown as 0 in the meantime.
      </p>
    </section>
  )
}

function Dashboard({ summary, links }: { summary: MetricsSummaryView; links: MetricsLinks }): JSX.Element {
  if (summary.epics.length === 0) {
    return (
      <>
        <HowMeasurementsArrive epics={0} />
        <MeasurementCapabilities />
      </>
    )
  }
  return (
    <>
      {summary.totals.epics === 0 ? <HowMeasurementsArrive epics={summary.epics.length} /> : null}
      <SummaryTiles summary={summary} />
      <EpicTable rows={summary.epics} links={links} />
      <SprintTrend summary={summary} links={links} />
      <TopGaps summary={summary} links={links} />
      <MeasurementCapabilities />
    </>
  )
}

/**
 * A folder's measured performance, from the project metrics summary (`getMetricsSummary`, the same read model the MCP
 * `get_metrics_summary` tool returns): grade distribution, totals, one row per epic, the sprint trend and the top gaps.
 * It is read when the dashboard opens and on Refresh only, never polled; Refresh and Try again show while they run.
 */
export function MetricsDashboard({ folder, onOpenEpic, onOpenTicket }: MetricsDashboardProps): JSX.Element {
  const [version, setVersion] = useState(0)
  const { state, refreshing } = useMetricsRead(folder.path, version)
  const refresh = (): void => setVersion((current) => current + 1)
  const retrying = state.status === 'error' && refreshing
  return (
    <section className="metrics" aria-label="Metrics">
      <header className="metrics-head">
        <h1 className="metrics-title">Metrics</h1>
        <span className="metrics-folder mono">{folder.displayPath}</span>
      </header>
      {state.status === 'ready' ? (
        <>
          <Freshness summary={state.data} loadedAt={state.loadedAt} refreshError={state.refreshError} refreshing={refreshing} onRefresh={refresh} />
          <Dashboard summary={state.data} links={{ openEpic: onOpenEpic, openTicket: onOpenTicket }} />
        </>
      ) : (
        <ScoreReadNotice state={retrying ? { status: 'loading', key: state.key } : state} what="the metrics summary" onRetry={refresh} />
      )}
    </section>
  )
}
