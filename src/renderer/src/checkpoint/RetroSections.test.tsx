// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExperimentReading } from '../../../shared/domain/experiments'
import type { SprintReportView } from '../../../shared/domain/views'
import { bundle, retroView, runView } from '../epic/__mocks__/fixtures'
import { comparison, experiment, improvementReport, outcome, reading } from '../__mocks__/improvementFixtures'
import { retroLookup } from './gateView'
import { ReportTabs } from './ReportTabs'
import { Retro } from './RetroSections'
import { retroSections, type RetroSections } from './retroView'

afterEach(cleanup)

const LOOKUP = retroLookup({ run: runView(), bundle: bundle() })

function gradedIn(epicId: string): ExperimentReading['assessment'] {
  return { ...experiment('x').source, revision: 'earlier', reportId: 'sr_1', epicId, reportContentHash: 'rh', snapshotHash: 'sh' }
}

/** A sprint-graded experiment with unsized, bodiless work, measured once with a note, its corrective ticket in this epic. */
function measuredReport(): SprintReportView {
  const sprintGraded = experiment('xp_s', { source: { ...experiment('x').source, subject: { level: 'sprint', id: 'sp_2' } }, proposedWork: [{ title: 'Trim the packet', body: '' }] })
  const measured = outcome('xp_s', { baseline: reading({ assessment: gradedIn('ep_1') }), comparisons: [comparison({ note: 'Read by hand from the run log' })] })
  const report = improvementReport([sprintGraded, experiment('xp_t')], { experimentOutcomes: [measured] })
  return { ...report, report: { ...report.report, retro: { ...retroView({ experiments: [sprintGraded, experiment('xp_t')] }), delivered: [{ ticket: 'tk_201', demo: 'Run it.', evidence: ' ' }] } } }
}

function sections(report: SprintReportView = measuredReport()): RetroSections {
  const read = retroSections(report, LOOKUP)
  if (read === null) throw new Error('The fixture report has a retro.')
  return read
}

const experiments = (): HTMLElement => screen.getByRole('region', { name: 'Experiments' })

describe('Retro experiments outside an Improvement tab', () => {
  it('shows every field of each experiment, its unsized work and the measured result with its note', () => {
    render(<Retro retro={sections()} onSelectTicket={() => undefined} />)
    const card = within(experiments()).getByText('xp_s').closest('li')!
    expect(card.getAttribute('tabindex')).toBeNull()
    expect(within(card).getByText('Drawn from', { selector: 'dt' }).nextElementSibling?.textContent).toBe('Sprint grade · this revision\'s scorecard')
    expect(within(card).getByText('attempt at_202_1 (first attempt)')).toBeTruthy()
    expect(within(card).getByText('Unsized').closest('li')?.textContent).toBe('Trim the packet Unsized')
    expect(within(card).getByText('Read by hand from the run log', { exact: false })).toBeTruthy()
    expect(within(card).getByText(/Accepted 2026-10-01T09:00:00.000Z in run rn_3/).querySelector('.ew-chip')).toBeNull()
  })

  it('shows the full cards inside report tabs that have no Improvement tab', () => {
    render(<ReportTabs label="Sprint 2" report={<Retro retro={sections()} onSelectTicket={() => undefined} />} scorecard={<p>Scorecard</p>} />)
    expect(within(experiments()).getAllByText('Hypothesis', { selector: 'dt' })).toHaveLength(2)
    expect(within(experiments()).queryByRole('button', { name: /Improvement tab/ })).toBeNull()
  })
})

describe('Retro experiments beside an Improvement tab', () => {
  it('lists them in brief with how each measured up, and opens the Improvement tab', () => {
    render(<ReportTabs label="Sprint 2" report={<Retro retro={sections()} onSelectTicket={() => undefined} />} scorecard={<p>Scorecard</p>} improvement={<p>The improvement chain</p>} />)
    const items = within(experiments()).getAllByRole('listitem')
    expect(items.map((item) => item.querySelectorAll('.ew-pill').length)).toEqual([2, 1])
    expect(within(items[0]!).getByText('Improved')).toBeTruthy()
    expect(within(experiments()).queryByText('Hypothesis', { selector: 'dt' })).toBeNull()
    fireEvent.click(within(experiments()).getByRole('button', { name: /^Review the measured result, findings, experiments and corrective work in the Improvement tab/ }))
    expect(screen.getByRole('tab', { name: 'Improvement' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('The improvement chain')).toBeTruthy()
  })
})

describe('Retro demo and leftovers without links', () => {
  it('shows a delivered item with blank evidence without an evidence line', () => {
    render(<Retro retro={sections()} onSelectTicket={() => undefined} />)
    const demo = screen.getByText('Run it.').closest('li')!
    expect(demo.querySelector('.cp-evidence')).toBeNull()
  })

  it('offers no move for a leftover the plan does not name', () => {
    const base = sections()
    const retro = { ...base, leftovers: [{ ticket: { ticketId: null, key: 'tk_gone', title: '' }, reason: 'Dropped from the plan', accepted: false }] }
    const actions = { busy: false, draft: null, checkpointOrdinal: 2, onAdd: () => Promise.resolve(true) }
    render(<Retro retro={retro} actions={actions} onSelectTicket={() => undefined} />)
    const leftovers = screen.getByRole('region', { name: 'Leftovers' })
    expect(within(leftovers).getByText('Dropped from the plan')).toBeTruthy()
    expect(within(leftovers).queryByRole('button')).toBeNull()
  })
})
