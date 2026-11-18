/**
 * The Metrics dashboard's sections, each straight from the project metrics summary: the summary tiles, the per-epic
 * table, the sprint trend and the top gaps. Nothing here grades or averages; a missing measure reads `unavailable`.
 * Tables stack into labelled rows when the dashboard is narrow (metrics.css), so no cell is clipped.
 */
import type { ReactNode } from 'react'
import { SPACE_COMPONENT_LABELS } from '../../../shared/domain/space'
import type { MetricsSummaryEpicRow, MetricsSummaryTotals, MetricsSummaryTrendEntry, MetricsSummaryView, SummaryTicketRef } from '../../../shared/domain/views'
import { plural } from '../app/plural'
import { StatePill } from '../epic/StatePill'
import { durationText, percentText, scoreText } from '../scorecard/scorecardFormat'
import {
  capabilityRows,
  type ComparedEntry,
  comparisonText,
  GRADE_STATUSES,
  gradeText,
  measureText,
  reportedText,
  shareText,
  statusPill,
  SUMMARY_STATUSES,
  trendSourceText,
  windowText
} from './metricsView'

/** Where the dashboard's links go: an epic's Scorecard, or a ticket's Scorecard tab (on one run's grade when named). */
export interface MetricsLinks {
  openEpic(epicId: string): void
  openTicket(link: { epicId: string; ticketId: string; runId: string | null; ticketKey: string | null }): void
}

function Tile(props: { title: string; value: string; children: ReactNode }): JSX.Element {
  return (
    <section className="card metrics-tile" aria-label={props.title}>
      <h3 className="card-title">{props.title}</h3>
      <p className="metrics-value">{props.value}</p>
      {props.children}
    </section>
  )
}

function Pairs({ rows }: { rows: [string, string][] }): JSX.Element {
  return (
    <dl className="metrics-pairs">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * A table cell that names its column, so a stacked (narrow) row still reads `Tokens: …`. The table parts carry their
 * roles explicitly: stacked rows are `display: block`, which drops the implicit table semantics in some browsers.
 */
function Cell({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <td role="cell" data-label={label}>
      <div className="metrics-cell">{children}</div>
    </td>
  )
}

function GradesTile({ summary }: { summary: MetricsSummaryView }): JSX.Element {
  const { byStatus, byGradeStatus } = summary.distribution
  const { epics, gradedEpics } = summary.coverage
  return (
    <Tile title="Grades" value={`${gradedEpics} of ${plural(epics, 'epic')} graded`}>
      <ul className="metrics-distribution" aria-label="Epics by grade status">
        {SUMMARY_STATUSES.map((entry) => (
          <li key={entry.status}>
            <StatePill tone={entry.tone} label={entry.label} />
            <span className="metrics-count">{byStatus[entry.status]}</span>
          </li>
        ))}
      </ul>
      <p className="metrics-note">By the grade&apos;s own status: {GRADE_STATUSES.map((status) => `${status} ${byGradeStatus[status]}`).join(' · ')}. Letters are counted, never averaged.</p>
    </Tile>
  )
}

function ResourceTiles({ totals }: { totals: MetricsSummaryTotals }): JSX.Element {
  const { tokens, time, coverage } = totals
  const elapsed = measureText(time.elapsedMs, 'milliseconds')
  return (
    <>
      <Tile title="Tokens" value={measureText(tokens.total, 'tokens')}>
        <p className="metrics-note">Coverage: {reportedText(coverage, 'tokens')}.</p>
        <Pairs rows={[['Input', measureText(tokens.input, 'tokens')], ['Cached input', measureText(tokens.cachedInput, 'tokens')], ['Output', measureText(tokens.output, 'tokens')], ['Reasoning', measureText(tokens.reasoning, 'tokens')]]} />
        <p className="metrics-note">Categories overlap (cached inside input, reasoning inside output), so they are not added up.</p>
      </Tile>
      <Tile title="Time" value={time.elapsedMs.value === null ? `Elapsed: ${elapsed}` : `${elapsed} elapsed`}>
        <Pairs rows={[['Elapsed (run windows)', elapsed], ['Active', measureText(time.activeMs, 'milliseconds')], ['Waiting', measureText(time.waitingMs, 'milliseconds')]]} />
        <p className="metrics-note">Coverage: {reportedText(coverage, 'time')}. Waits are summed per ticket and never counted as active, so they can exceed the elapsed time.</p>
      </Tile>
      <Tile title="Effort" value={measureText(time.effortMs, 'milliseconds')}>
        <p className="metrics-note">
          Every actor&apos;s activity summed. Share of it classified as productive or corrective:{' '}
          {coverage.classificationCoverage === null ? 'unavailable' : percentText(coverage.classificationCoverage)}.
        </p>
      </Tile>
      <Tile title="Corrective share" value={shareText(totals.correctiveShare)}>
        <p className="metrics-note">Corrective (rework) effort over classified effort.</p>
      </Tile>
    </>
  )
}

/** The summary tiles: how the epics' grades stand, and the totals over the epics that executed work. */
export function SummaryTiles({ summary }: { summary: MetricsSummaryView }): JSX.Element {
  const { totals } = summary
  return (
    <section className="metrics-section" aria-label="Summary">
      <p className="metrics-note">
        Totals are summed from the raw measures of the {plural(totals.epics, 'epic')} that executed work; an epic that ran nothing keeps its row
        below but adds nothing.
      </p>
      <div className="metrics-tiles">
        <GradesTile summary={summary} />
        <ResourceTiles totals={totals} />
      </div>
    </section>
  )
}

/**
 * Why an epic has nothing to grade yet (no saved plan, or no run that executed work), or null when it has. The core
 * measures an epic whose runs executed nothing on its last run, so an empty attempt count says so, not the run ids.
 */
function nothingToGrade(row: MetricsSummaryEpicRow): string | null {
  if (row.grade.inputHash === null) return 'Nothing to grade yet: no saved plan'
  return row.coverage.attempts === 0 ? 'Nothing to grade yet: no run executed work' : null
}

function EpicRow({ row, links }: { row: MetricsSummaryEpicRow; links: MetricsLinks }): JSX.Element {
  const pill = statusPill(row.grade)
  const nothing = nothingToGrade(row)
  return (
    <tr role="row">
      <th scope="row" role="rowheader">
        <button type="button" className="sc-link" title="Open the epic's Scorecard" onClick={() => links.openEpic(row.epicId)}>
          {row.title}
        </button>
        <span className="metrics-sub">{row.status.replaceAll('_', ' ')}</span>
      </th>
      <Cell label="Grade">
        <span className="metrics-grade">{gradeText(row.grade)}</span>
        <StatePill tone={pill.tone} label={pill.label} />
      </Cell>
      <Cell label="Coverage">
        {nothing ?? `${percentText(row.grade.coverage)} of base weight`}
        {nothing === null ? <span className="metrics-sub">{reportedText(row.coverage, 'tokens')}</span> : null}
      </Cell>
      <Cell label="Tokens">{measureText(row.tokens.total, 'tokens')}</Cell>
      <Cell label="Active time">{measureText(row.time.activeMs, 'milliseconds')}</Cell>
      <Cell label="Wall time">{measureText(row.time.elapsedMs, 'milliseconds')}</Cell>
    </tr>
  )
}

/** One row per epic; its title opens the epic's Scorecard. */
export function EpicTable({ rows, links }: { rows: MetricsSummaryEpicRow[]; links: MetricsLinks }): JSX.Element {
  return (
    <section className="metrics-section" aria-label="Epics">
      <h2 className="metrics-heading">Epics</h2>
      <div className="metrics-table-wrap">
        <table className="metrics-table" role="table" aria-label="Epics">
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">Epic</th>
              <th scope="col" role="columnheader">Grade</th>
              <th scope="col" role="columnheader">Coverage</th>
              <th scope="col" role="columnheader">Tokens</th>
              <th scope="col" role="columnheader">Active time</th>
              <th scope="col" role="columnheader">Wall time</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => (
              <EpicRow key={row.epicId} row={row} links={links} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** A trend entry's name: its epic, sprint and run (`Search tuning · Sprint 1 · Run #2`); a sprint without an ordinal reads `Sprint`. */
function trendLabel(entry: { epicId: string; ordinal: number | null; runNumber: number }, titles: ReadonlyMap<string, string>): string {
  const sprint = entry.ordinal === null ? 'Sprint' : `Sprint ${entry.ordinal}`
  return `${titles.get(entry.epicId) ?? entry.epicId} · ${sprint} · Run #${entry.runNumber}`
}

/**
 * The entry `entry` is compared with, as the summary names it (its epic, which may be another epic's, and run number);
 * its sprint number and grade come from the trend when it is listed there.
 */
function comparedEntry(entry: MetricsSummaryTrendEntry, trend: readonly MetricsSummaryTrendEntry[], titles: ReadonlyMap<string, string>): ComparedEntry | null {
  const previous = entry.comparison.previous
  if (previous === null) return null
  const found = trend.find((other) => other.runId === previous.runId && other.sprintId === previous.sprintId)
  return { label: trendLabel({ ...previous, ordinal: found?.ordinal ?? null }, titles), grade: found?.grade ?? null }
}

function TrendRow({ entry, trend, titles, links }: { entry: MetricsSummaryTrendEntry; trend: readonly MetricsSummaryTrendEntry[]; titles: ReadonlyMap<string, string>; links: MetricsLinks }): JSX.Element {
  const pill = entry.grade === null ? null : statusPill(entry.grade)
  const [title, ...rest] = trendLabel(entry, titles).split(' · ')
  return (
    <tr role="row" className={entry.comparison.comparable ? undefined : 'is-incomparable'}>
      <th scope="row" role="rowheader">
        <button type="button" className="sc-link" title="Open the epic's Scorecard" onClick={() => links.openEpic(entry.epicId)}>
          {title}
        </button>
        <span className="metrics-sub">{rest.join(' · ')}</span>
      </th>
      <Cell label="Source">{trendSourceText(entry)}</Cell>
      <Cell label="Grade">
        <span className="metrics-grade">{entry.grade === null ? 'Ungraded (legacy)' : gradeText(entry.grade)}</span>
        {pill === null ? null : <StatePill tone={pill.tone} label={pill.label} />}
      </Cell>
      <Cell label="Window">{windowText(entry.window)}</Cell>
      <Cell label="Compared with">{comparisonText(entry, comparedEntry(entry, trend, titles))}</Cell>
    </tr>
  )
}

/** Sprint grades by end time; each entry names the entry it is compared with, and says why when it is not. */
export function SprintTrend({ summary, links }: { summary: MetricsSummaryView; links: MetricsLinks }): JSX.Element {
  const titles = new Map(summary.epics.map((row) => [row.epicId, row.title]))
  return (
    <section className="metrics-section" aria-label="Sprint trend">
      <h2 className="metrics-heading">Sprint trend</h2>
      {summary.trend.length === 0 ? (
        <p className="metrics-note">No sprint has a grade yet.</p>
      ) : (
        <div className="metrics-table-wrap">
          <table className="metrics-table" role="table" aria-label="Sprint trend">
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">Sprint</th>
                <th scope="col" role="columnheader">Source</th>
                <th scope="col" role="columnheader">Grade</th>
                <th scope="col" role="columnheader">Window</th>
                <th scope="col" role="columnheader">Compared with</th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {summary.trend.map((entry) => (
                <TrendRow key={`${entry.runId}:${entry.sprintId}`} entry={entry} trend={summary.trend} titles={titles} links={links} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

interface GapContext {
  titles: ReadonlyMap<string, string>
  links: MetricsLinks
}

function EpicScorecardLink({ epicId, context }: { epicId: string; context: GapContext }): JSX.Element {
  return (
    <button type="button" className="sc-link" onClick={() => context.links.openEpic(epicId)}>
      Open the epic&apos;s Scorecard
    </button>
  )
}

/** Why a gap's ticket cannot open on the epic's current saved plan, or null when it can. */
function unopenable(ticket: SummaryTicketRef): string | null {
  if (ticket.key === null) return `${ticket.ticketId} is not in any saved plan of this epic`
  if (ticket.removedAfterRevision === null) return null
  const name = ticket.title === null ? ticket.key : `${ticket.key} (${ticket.title})`
  return `${name} was removed after revision ${ticket.removedAfterRevision}`
}

/**
 * A gap's ticket, named by the summary: a link to its Scorecard tab while the epic's current saved plan holds it. A
 * ticket removed since (named from the newest revision a run was pinned to), or that no plan holds, cannot open on the
 * current plan, so it says so and offers the epic's Scorecard instead.
 */
function GapTicket({ epicId, ticket, runId, context }: { epicId: string; ticket: SummaryTicketRef; runId: string | null; context: GapContext }): JSX.Element {
  const why = unopenable(ticket)
  if (why === null) {
    return (
      <button type="button" className="sc-link" title={ticket.title ?? undefined} onClick={() => context.links.openTicket({ epicId, ticketId: ticket.ticketId, runId, ticketKey: ticket.key })}>
        {ticket.key} Scorecard
      </button>
    )
  }
  return (
    <span className="metrics-removed">
      {why}, so its ticket panel cannot open. <EpicScorecardLink epicId={epicId} context={context} />
    </span>
  )
}

function TicketLinks({ epicId, tickets, runId, context }: { epicId: string; tickets: SummaryTicketRef[]; runId: string | null; context: GapContext }): JSX.Element {
  if (tickets.length === 0) {
    return <EpicScorecardLink epicId={epicId} context={context} />
  }
  return (
    <span className="metrics-tickets">
      {tickets.map((ticket) => (
        <GapTicket key={ticket.ticketId} epicId={epicId} ticket={ticket} runId={runId} context={context} />
      ))}
    </span>
  )
}

function ComponentGaps({ gaps, context }: { gaps: MetricsSummaryView['gaps']['lowestComponents']; context: GapContext }): JSX.Element | null {
  if (gaps.length === 0) return null
  return (
    <div className="metrics-gap-group">
      <h3 className="card-title">Lowest scored components</h3>
      <ul className="metrics-gaps">
        {gaps.map((gap) => (
          <li key={`${gap.epicId}:${gap.component}`}>
            <span>
              <strong>
                {SPACE_COMPONENT_LABELS[gap.component]} ({gap.component}) {scoreText(gap.score)}
              </strong>{' '}
              in {context.titles.get(gap.epicId) ?? gap.epicId}
            </span>
            <span className="metrics-sub ew-mono">{gap.rule}</span>
            <TicketLinks epicId={gap.epicId} tickets={gap.tickets} runId={null} context={context} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function FailureGaps({ gaps, context }: { gaps: MetricsSummaryView['gaps']['failures']; context: GapContext }): JSX.Element | null {
  if (gaps.length === 0) return null
  return (
    <div className="metrics-gap-group">
      <h3 className="card-title">Confirmed failures</h3>
      <ul className="metrics-gaps">
        {gaps.map((gap) => (
          <li key={`${gap.runId}:${gap.ticketId}:${gap.attemptId ?? ''}`}>
            <span>
              <strong>{gap.ticket.key ?? gap.ticketId}</strong> in {context.titles.get(gap.epicId) ?? gap.epicId} · Run #{gap.runNumber}: {gap.reason.replaceAll('_', ' ')}
            </span>
            <TicketLinks epicId={gap.epicId} tickets={[gap.ticket]} runId={gap.runId} context={context} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function ReworkGaps({ gaps, context }: { gaps: MetricsSummaryView['gaps']['rework']; context: GapContext }): JSX.Element | null {
  if (gaps.length === 0) return null
  return (
    <div className="metrics-gap-group">
      <h3 className="card-title">Rework by cause</h3>
      <ul className="metrics-gaps">
        {gaps.map((gap) => (
          <li key={`${gap.epicId}:${gap.cause}`}>
            <span>
              <strong>
                {gap.cause.replaceAll('_', ' ')}: {durationText(gap.ms)}
              </strong>{' '}
              in {context.titles.get(gap.epicId) ?? gap.epicId}
            </span>
            <TicketLinks epicId={gap.epicId} tickets={gap.tickets} runId={null} context={context} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The lowest scored components, confirmed failures and rework, each linking to the ticket's Scorecard tab. */
export function TopGaps({ summary, links }: { summary: MetricsSummaryView; links: MetricsLinks }): JSX.Element {
  const context: GapContext = { titles: new Map(summary.epics.map((row) => [row.epicId, row.title])), links }
  const { lowestComponents, failures, rework } = summary.gaps
  return (
    <section className="metrics-section" aria-label="Top gaps">
      <h2 className="metrics-heading">Top gaps</h2>
      {lowestComponents.length + failures.length + rework.length === 0 ? <p className="metrics-note">No scored component, confirmed failure or rework to show yet.</p> : null}
      <div className="metrics-gap-groups">
        <FailureGaps gaps={failures} context={context} />
        <ComponentGaps gaps={lowestComponents} context={context} />
        <ReworkGaps gaps={rework} context={context} />
      </div>
    </section>
  )
}

/**
 * Which agents' usage Dark Mechanicus reads from their host and which it cannot: labelled, so an unreadable host's
 * usage is never taken for a measured zero or for verified support.
 */
export function MeasurementCapabilities(): JSX.Element {
  return (
    <section className="metrics-section" aria-label="Measurement capabilities">
      <h2 className="metrics-heading">Measurement capabilities</h2>
      <p className="metrics-note">
        Tokens and active time are read from the host only where it writes them. For the others, usage reads unavailable unless real numbers are relayed over
        MCP (record_attempt_metrics, record_run_metrics).
      </p>
      <div className="metrics-table-wrap">
        <table className="metrics-table" role="table" aria-label="Agents by measurement capability">
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">Agent</th>
              <th scope="col" role="columnheader">Tokens</th>
              <th scope="col" role="columnheader">Active time</th>
              <th scope="col" role="columnheader">Source</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {capabilityRows().map((row) => (
              <tr key={row.agent} role="row">
                <th scope="row" role="rowheader">
                  {row.agent}
                </th>
                <Cell label="Tokens">{row.tokens}</Cell>
                <Cell label="Active time">{row.activeTime}</Cell>
                <Cell label="Source">{row.detail}</Cell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
