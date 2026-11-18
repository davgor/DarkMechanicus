// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DmApi } from '../../../shared/desktop/api'
import type { MetricsSummaryView } from '../../../shared/domain/views'
import { deferred } from '../__mocks__/deferred'
import { FakeDm } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import {
  epicRow,
  metricsSummary,
  missing,
  ticketRef,
  summaryCoverage,
  summaryGrade,
  summaryTime,
  summaryTokens,
  trendEntry
} from '../__mocks__/metricsFixtures'
import { settle } from '../__mocks__/settle'
import { MetricsDashboard } from './MetricsDashboard'
import type { MetricsLinks } from './MetricsSections'

type TicketLink = Parameters<MetricsLinks['openTicket']>[0]

let dm: FakeDm
let epics: string[]
let tickets: TicketLink[]

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm as DmApi
  epics = []
  tickets = []
})

afterEach(cleanup)

async function show(summary: MetricsSummaryView): Promise<void> {
  dm.responses.getMetricsSummary = summary
  render(<MetricsDashboard folder={folderView()} onOpenEpic={(epicId) => epics.push(epicId)} onOpenTicket={(link) => tickets.push(link)} />)
  await settle()
}

const tile = (title: string): HTMLElement => screen.getByRole('region', { name: title })
const epicTable = (): HTMLElement => screen.getByRole('table', { name: 'Epics' })
const cellsOf = (row: HTMLElement): string[] => within(row).getAllByRole('cell').map((cell) => cell.textContent ?? '')

describe('DM-267 c2: the summary renders as get_metrics_summary gives it', () => {
  it('the grade distribution counts every status as the summary does', async () => {
    await show(
      metricsSummary({
        epics: [epicRow({ epicId: 'ep_1' }), epicRow({ epicId: 'ep_2', title: 'Other' }), epicRow({ epicId: 'ep_3', title: 'Third' })],
        distribution: { byStatus: { final: 1, provisional: 0, in_progress: 2, failed: 0, ungraded: 0 }, byGradeStatus: { final: 1, provisional: 2, ungraded: 0 } },
        coverage: { epics: 3, gradedEpics: 2, ungradedEpics: 1, unavailable: [] }
      })
    )
    expect(within(tile('Grades')).getByText('2 of 3 epics graded')).toBeTruthy()
    const items = within(screen.getByRole('list', { name: 'Epics by grade status' })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(['Final1', 'Provisional0', 'In progress2', 'Failed0', 'Ungraded0'])
    expect(within(tile('Grades')).getByText(/By the grade's own status: final 1 · provisional 2 · ungraded 0\./)).toBeTruthy()
  })

  it('the totals tiles show the summed measures', async () => {
    await show(metricsSummary())
    expect(within(tile('Tokens')).getByText('1,300 tokens')).toBeTruthy()
    expect(within(tile('Tokens')).getByText('Coverage: 3 of 4 executed attempts reported tokens.')).toBeTruthy()
    expect(within(tile('Time')).getByText('2 h 00 min elapsed')).toBeTruthy()
    expect(within(tile('Effort')).getByText('40 min')).toBeTruthy()
    expect(within(tile('Corrective share')).getByText('25.0%')).toBeTruthy()
  })

  it('each epic row shows its grade, coverage, tokens, active and wall time', async () => {
    await show(metricsSummary({ epics: [epicRow(), epicRow({ epicId: 'ep_2', title: 'Other', grade: summaryGrade({ letter: 'C', displayScore: '2.1', coverage: 0.5 }) })] }))
    const rows = within(epicTable()).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Epic', 'Grade', 'Coverage', 'Tokens', 'Active time', 'Wall time'])
    expect(within(rows[1]).getByRole('rowheader').textContent).toBe('Search tuningin progress')
    expect(cellsOf(rows[1])).toEqual(['B 3.4Final', '87.5% of base weight3 of 4 executed attempts reported tokens', '1,300 tokens', '30 min', '2 h 00 min'])
    expect(cellsOf(rows[2])[0]).toBe('C 2.1Final')
    expect(cellsOf(rows[2])[1]).toMatch(/^50\.0% of base weight/)
  })

  it('unknown measures read unavailable, never 0', async () => {
    const unknownTokens = summaryTokens({ total: missing('not_reported'), input: missing(null) })
    const unknownTime = summaryTime({ elapsedMs: missing(null), activeMs: missing('host_unavailable'), effortMs: missing(null) })
    const summary = metricsSummary({ epics: [epicRow({ tokens: unknownTokens, time: unknownTime })] })
    await show({ ...summary, totals: { ...summary.totals, tokens: unknownTokens, time: unknownTime, correctiveShare: missing('insufficient_classification'), coverage: summaryCoverage({ classificationCoverage: null }) } })
    expect(within(tile('Tokens')).getByText('unavailable (not reported)', { selector: '.metrics-value' })).toBeTruthy()
    expect(within(tile('Time')).getByText('Elapsed: unavailable (not reported)')).toBeTruthy()
    expect(within(tile('Effort')).getByText('unavailable (not reported)', { selector: '.metrics-value' })).toBeTruthy()
    expect(within(tile('Effort')).getByText(/classified as productive or corrective: unavailable\./)).toBeTruthy()
    expect(within(tile('Corrective share')).getByText('unavailable (too little effort classified)')).toBeTruthy()
    const cells = cellsOf(within(epicTable()).getAllByRole('row')[1])
    expect(cells.slice(2)).toEqual(['unavailable (not reported)', 'unavailable (the host cannot report it)', 'unavailable (not reported)'])
    expect(cells.some((text) => /^0\b/.test(text))).toBe(false)
  })
})

describe('DM-267 c2: empty and nothing-to-grade states', () => {
  it('an empty folder explains how measurements arrive', async () => {
    await show(metricsSummary({ epics: [] }))
    const empty = screen.getByRole('region', { name: 'No measurements yet' })
    expect(within(empty).getByRole('heading').textContent).toBe('No epics to measure yet')
    expect(within(empty).getByText(/Connect an agent over MCP/)).toBeTruthy()
    // No summary table; only the measurement capabilities, which hold for any folder.
    expect(screen.getAllByRole('table').map((table) => table.getAttribute('aria-label'))).toEqual(['Agents by measurement capability'])
  })

  it('Nothing to grade yet: epics that executed no work keep their rows and say so', async () => {
    const summary = metricsSummary({ epics: [epicRow({ grade: summaryGrade({ inputHash: null, letter: null, displayScore: null, coverage: 0 }) })] })
    await show({ ...summary, totals: { ...summary.totals, epics: 0, measuredEpicIds: [] } })
    expect(within(screen.getByRole('region', { name: 'No measurements yet' })).getByRole('heading').textContent).toBe('No epic has executed work yet')
    expect(cellsOf(within(epicTable()).getAllByRole('row')[1])[1]).toBe('Nothing to grade yet: no saved plan')
  })

  it('DM-267 review fix: an epic whose only run executed nothing reads Nothing to grade yet, not 0.0% of base weight', async () => {
    // The core measures such an epic on its last run, so measuredRunIds is not empty while no attempt executed.
    await show(metricsSummary({ epics: [epicRow({ runIds: ['rn_1'], measuredRunIds: ['rn_1'], grade: summaryGrade({ coverage: 0, letter: null, displayScore: null }), coverage: summaryCoverage({ attempts: 0 }) })] }))
    const coverage = cellsOf(within(epicTable()).getAllByRole('row')[1])[1]
    expect(coverage).toBe('Nothing to grade yet: no run executed work')
  })
})

describe('DM-267 c2: tables, trend and read states', () => {
  it('DM-267 review fix: stacked tables keep their table, row, header and cell roles', async () => {
    await show(metricsSummary({ trend: [trendEntry()] }))
    const trend = screen.getByRole('table', { name: 'Sprint trend' })
    const rows = within(trend).getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Sprint', 'Source', 'Grade', 'Window', 'Compared with'])
    expect(within(rows[1]).getByRole('rowheader').textContent).toBe('Search tuningSprint 1 · Run #1')
    expect(within(rows[1]).getAllByRole('cell').map((cell) => cell.getAttribute('data-label'))).toEqual(['Source', 'Grade', 'Window', 'Compared with'])
    expect(within(epicTable()).getAllByRole('rowgroup')).toHaveLength(2)
    // Stacked rows are display:block, which drops implicit table roles in browsers: every part names its role explicitly.
    for (const table of [epicTable(), trend]) {
      const explicit = (selector: string): (string | null)[] => [...table.querySelectorAll(selector)].map((element) => element.getAttribute('role'))
      expect(table.getAttribute('role')).toBe('table')
      expect(explicit('thead, tbody')).toEqual(['rowgroup', 'rowgroup'])
      expect(new Set(explicit('tr'))).toEqual(new Set(['row']))
      expect(new Set(explicit('th[scope="col"]'))).toEqual(new Set(['columnheader']))
      expect(new Set(explicit('th[scope="row"]'))).toEqual(new Set(['rowheader']))
      expect(new Set(explicit('td'))).toEqual(new Set(['cell']))
    }
  })

  it('a legacy trend entry reads ungraded, not a score', async () => {
    await show(metricsSummary({ trend: [trendEntry({ source: 'legacy_report', grade: null })] }))
    const row = within(screen.getByRole('table', { name: 'Sprint trend' })).getAllByRole('row')[1]
    expect(cellsOf(row).slice(0, 2)).toEqual(['Legacy report: ungraded, nothing was frozen', 'Ungraded (legacy)'])
  })

  it('shows loading, then an error with Try again that reads the summary again', async () => {
    const hold = deferred()
    dm.holds.getMetricsSummary = [hold]
    dm.failures.getMetricsSummary = { code: 'internal', message: 'main process busy' }
    render(<MetricsDashboard folder={folderView()} onOpenEpic={() => undefined} onOpenTicket={() => undefined} />)
    await settle()
    expect(screen.getByRole('status').textContent).toBe('Loading the metrics summary…')
    hold.resolve()
    await settle()
    expect(within(screen.getByRole('alert')).getByText(/main process busy/)).toBeTruthy()
    delete dm.failures.getMetricsSummary
    dm.responses.getMetricsSummary = metricsSummary()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(epicTable()).getAllByRole('row')).toHaveLength(2)
    expect(dm.callsOf('getMetricsSummary')).toHaveLength(2)
  })
})

describe('DM-267 c3: epic rows and gaps open the matching Scorecard', () => {
  it('an epic row opens that epic', async () => {
    await show(metricsSummary({ epics: [epicRow(), epicRow({ epicId: 'ep_2', title: 'Other' })] }))
    fireEvent.click(within(epicTable()).getByRole('button', { name: 'Other' }))
    expect(epics).toEqual(['ep_2'])
  })

  it('a failure gap opens the ticket Scorecard tab on its run', async () => {
    await show(
      metricsSummary({
        gaps: { lowestComponents: [], failures: [{ epicId: 'ep_1', runId: 'rn_1', runNumber: 7, ticketId: 'tk_2', ticket: ticketRef('tk_2', 'DM-2', 'Tune ranking'), attemptId: 'at_1', reason: 'review_rejected', evidence: [] }], rework: [] }
      })
    )
    const gaps = screen.getByRole('region', { name: 'Top gaps' })
    expect(within(gaps).getByText(/in Search tuning · Run #7: review rejected/)).toBeTruthy()
    fireEvent.click(within(gaps).getByRole('button', { name: 'DM-2 Scorecard' }))
    expect(tickets).toEqual([{ epicId: 'ep_1', ticketId: 'tk_2', runId: 'rn_1', ticketKey: 'DM-2' }])
  })

  it('a component gap with no ticket opens the epic Scorecard', async () => {
    await show(metricsSummary({ gaps: { lowestComponents: [{ epicId: 'ep_1', component: 'K', score: 1.26, rule: 'k.rule', evidence: [], ticketIds: [], tickets: [] }], failures: [], rework: [] } }))
    fireEvent.click(within(screen.getByRole('region', { name: 'Top gaps' })).getByRole('button', { name: "Open the epic's Scorecard" }))
    expect(epics).toEqual(['ep_1'])
    expect(tickets).toEqual([])
  })

  it('DM-267 review fix: a removed ticket names the revision the summary gives and offers the epic Scorecard', async () => {
    const named = [ticketRef('tk_9', 'DM-9', 'Dropped', 2), ticketRef('tk_2', 'DM-2', 'Kept'), ticketRef('tk_404', null, null)]
    await show(
      metricsSummary({
        epics: [epicRow({ runIds: ['rn_1', 'rn_2'] })],
        gaps: { lowestComponents: [], failures: [], rework: [{ epicId: 'ep_1', cause: 'implementation', ms: 60_000, evidence: [], ticketIds: named.map((ticket) => ticket.ticketId), tickets: named }] }
      })
    )
    const gaps = screen.getByRole('region', { name: 'Top gaps' })
    expect(within(gaps).getByText(/DM-9 \(Dropped\) was removed after revision 2, so its ticket panel cannot open\./)).toBeTruthy()
    expect(within(gaps).getByText(/tk_404 is not in any saved plan of this epic, so its ticket panel cannot open\./)).toBeTruthy()
    expect(within(gaps).queryByRole('button', { name: 'DM-9 Scorecard' })).toBeNull()
    fireEvent.click(within(gaps).getAllByRole('button', { name: "Open the epic's Scorecard" })[0])
    fireEvent.click(within(gaps).getByRole('button', { name: 'DM-2 Scorecard' }))
    expect(epics).toEqual(['ep_1'])
    expect(tickets).toEqual([{ epicId: 'ep_1', ticketId: 'tk_2', runId: null, ticketKey: 'DM-2' }])
  })
})

describe('DM-269: the dashboard names runs and tickets from the summary alone', () => {
  it('opening and refreshing the dashboard send only the summary read', async () => {
    const failure = { epicId: 'ep_1', runId: 'rn_4', runNumber: 4, ticketId: 'tk_2', ticket: ticketRef('tk_2', 'DM-2', 'Kept'), attemptId: null, reason: 'review_rejected', evidence: [] }
    await show(metricsSummary({ trend: [trendEntry({ runId: 'rn_4', runNumber: 4 })], gaps: { lowestComponents: [], failures: [failure], rework: [] } }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(dm.commandCalls.map((call) => call.name)).toEqual(['getMetricsSummary', 'getMetricsSummary'])
    expect(within(screen.getByRole('region', { name: 'Top gaps' })).getByText(/^DM-2$/)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Top gaps' })).getByText(/in Search tuning · Run #4: review rejected/)).toBeTruthy()
    expect(within(screen.getByRole('table', { name: 'Sprint trend' })).getAllByRole('row')[1].querySelector('th')?.textContent).toBe('Search tuningSprint 1 · Run #4')
  })

  it("names the compared entry by the summary's epic and run, also across epics and when it is not listed", async () => {
    const first = trendEntry({ epicId: 'ep_1', runId: 'rn_1', runNumber: 1, sprintId: 'sp_1', ordinal: 1 })
    const crossEpic = trendEntry({
      epicId: 'ep_2',
      runId: 'rn_5',
      runNumber: 5,
      sprintId: 'sp_9',
      ordinal: 2,
      comparison: { previous: { epicId: 'ep_1', runId: 'rn_1', runNumber: 1, sprintId: 'sp_1' }, comparable: false, reasons: ['cohort_unknown', 'cross_epic'], scoreDelta: null }
    })
    const unlisted = trendEntry({ epicId: 'ep_2', runId: 'rn_6', runNumber: 6, sprintId: 'sp_10', ordinal: 3, comparison: { previous: { epicId: 'ep_2', runId: 'rn_3', runNumber: 3, sprintId: 'sp_0' }, comparable: false, reasons: ['window_open'], scoreDelta: null } })
    await show(metricsSummary({ epics: [epicRow(), epicRow({ epicId: 'ep_2', title: 'Other' })], trend: [first, crossEpic, unlisted] }))
    const rows = within(screen.getByRole('table', { name: 'Sprint trend' })).getAllByRole('row')
    expect(cellsOf(rows[2])[3]).toBe(
      "Not comparable with Search tuning · Sprint 1 · Run #1: ticket cohort unknown (a sprint has no ticket, or a ticket without a size); another epic's sprint, and neither policy nor cohort vouches for comparing them"
    )
    expect(cellsOf(rows[3])[3]).toBe('Not comparable with Other · Sprint · Run #3: window still open')
  })
})

describe('DM-267 c2: a failed Refresh keeps the data it read', () => {
  it('shows the old values beside the refresh error, then a Refresh that succeeds replaces them and clears it', async () => {
    await show(metricsSummary({ epics: [epicRow({ title: 'Old epic' })] }))
    dm.failures.getMetricsSummary = { code: 'internal', message: 'main process busy' }
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/^The last refresh failed \(main process busy\); showing the data read .+\.$/)
    expect(within(epicTable()).getByRole('button', { name: 'Old epic' })).toBeTruthy()
    expect(within(tile('Tokens')).getByText('1,300 tokens')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()

    delete dm.failures.getMetricsSummary
    dm.responses.getMetricsSummary = metricsSummary({ epics: [epicRow({ title: 'New epic' })] })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(epicTable()).getByRole('button', { name: 'New epic' })).toBeTruthy()
    expect(within(epicTable()).queryByRole('button', { name: 'Old epic' })).toBeNull()
    expect(dm.callsOf('getMetricsSummary')).toHaveLength(3)
  })

  it('hides the last refresh error while the next Refresh runs, and shows it again if that one fails too', async () => {
    await show(metricsSummary({ epics: [epicRow({ title: 'Old epic' })] }))
    dm.failures.getMetricsSummary = { code: 'internal', message: 'main process busy' }
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/^The last refresh failed \(main process busy\)/)

    const hold = dm.holdNext('getMetricsSummary')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(epicTable()).getByRole('button', { name: 'Old epic' })).toBeTruthy()

    hold.resolve()
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/^The last refresh failed \(main process busy\)/)
    expect(dm.callsOf('getMetricsSummary')).toHaveLength(3)
  })
})

describe('DM-193 c4: the dashboard labels the hosts whose usage cannot be read', () => {
  it('lists each agent with whether its tokens and active time are read, the unreadable ones marked Not readable', async () => {
    await show(metricsSummary())
    const section = screen.getByRole('region', { name: 'Measurement capabilities' })
    const row = (agent: string) => within(section).getByRole('row', { name: new RegExp(`^${agent} `, 'u') })
    expect(within(row('Claude Code')).getAllByText('Read from the host')).toHaveLength(2)
    expect(within(row('Codex')).getAllByText('Not readable')).toHaveLength(2)
    expect(within(row('Custom agents')).getAllByText('Not readable')).toHaveLength(2)
    expect(within(section).getByText(/relayed over\s+MCP/u)).toBeTruthy()
  })

  it('shows the capabilities on an empty folder too', async () => {
    await show(metricsSummary({ epics: [], trend: [] }))
    expect(screen.getByRole('region', { name: 'Measurement capabilities' })).toBeTruthy()
  })
})
