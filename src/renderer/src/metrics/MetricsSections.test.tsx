// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { metricsSummary, ticketRef, trendEntry } from '../__mocks__/metricsFixtures'
import { type MetricsLinks, SprintTrend, TopGaps } from './MetricsSections'

type TicketLink = Parameters<MetricsLinks['openTicket']>[0]

afterEach(cleanup)

function recorder(): { links: MetricsLinks; epics: string[]; tickets: TicketLink[] } {
  const epics: string[] = []
  const tickets: TicketLink[] = []
  return { links: { openEpic: (epicId) => epics.push(epicId), openTicket: (link) => tickets.push(link) }, epics, tickets }
}

const gapLines = (): string[] =>
  within(screen.getByRole('region', { name: 'Top gaps' }))
    .getAllByRole('listitem')
    .map((item) => item.firstElementChild?.textContent ?? '')

describe('sprint trend rows', () => {
  it('a comparable entry reads plainly, names an epic missing from the summary by its id, and opens its epic', () => {
    const previous = trendEntry({ epicId: 'ep_gone', runId: 'rn_0', runNumber: 4, sprintId: 'sp_0', ordinal: 3 })
    const entry = trendEntry({ runId: 'rn_1', comparison: { previous: { epicId: 'ep_gone', runId: 'rn_0', runNumber: 4, sprintId: 'sp_0' }, comparable: true, reasons: [], scoreDelta: 0.5 } })
    const { links, epics } = recorder()
    render(<SprintTrend summary={metricsSummary({ trend: [previous, entry] })} links={links} />)
    const rows = within(screen.getByRole('table', { name: 'Sprint trend' })).getAllByRole('row')
    expect(rows[1]?.className).toBe('is-incomparable')
    expect(rows[2]?.className).toBe('')
    expect(within(rows[1] as HTMLElement).getByRole('rowheader').textContent).toBe('ep_goneSprint 3 · Run #4')
    expect(within(rows[2] as HTMLElement).getAllByRole('cell').at(-1)?.textContent).toBe('±0.0 vs ep_gone · Sprint 3 · Run #4')
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'ep_gone' }))
    expect(epics).toEqual(['ep_gone'])
  })
})

describe('top gaps', () => {
  it('names each gap\'s epic by its id when the summary lists no row for it', () => {
    const summary = metricsSummary({
      gaps: {
        lowestComponents: [{ epicId: 'ep_x', component: 'K', score: 41.26, rule: 'k_rule_v1', evidence: [], ticketIds: [], tickets: [] }],
        failures: [{ epicId: 'ep_x', runId: 'rn_9', runNumber: 9, ticketId: 'tk_9', ticket: ticketRef('tk_9', null, null), attemptId: null, reason: 'mandatory_failure', evidence: [] }],
        rework: [{ epicId: 'ep_x', cause: 'tooling', ms: 90_000, evidence: [], ticketIds: [], tickets: [] }]
      }
    })
    render(<TopGaps summary={summary} links={recorder().links} />)
    expect(gapLines()).toEqual(['tk_9 in ep_x · Run #9: mandatory failure', 'Token efficiency (K) 41.2 in ep_x', 'tooling: 1 min 30 s in ep_x'])
  })

  it('a removed ticket without a title is named by its key, and an untitled ticket links without a tooltip', () => {
    const { links, tickets } = recorder()
    const summary = metricsSummary({
      gaps: {
        lowestComponents: [{ epicId: 'ep_1', component: 'P', score: 50, rule: 'p_rule_v1', evidence: [], ticketIds: ['tk_1', 'tk_2'], tickets: [ticketRef('tk_1', 'DM-1', null, 3), ticketRef('tk_2', 'DM-2', null)] }],
        failures: [],
        rework: []
      }
    })
    render(<TopGaps summary={summary} links={links} />)
    expect(screen.getByText(/^DM-1 was removed after revision 3, so its ticket panel cannot open\./)).toBeTruthy()
    const link = screen.getByRole('button', { name: 'DM-2 Scorecard' })
    expect(link.hasAttribute('title')).toBe(false)
    fireEvent.click(link)
    expect(tickets).toEqual([{ epicId: 'ep_1', ticketId: 'tk_2', runId: null, ticketKey: 'DM-2' }])
  })
})
