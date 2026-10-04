// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DmApi } from '../../../shared/desktop/api'
import { NOW, bundle, epicDetail, reportWithRetro, retroView, runView } from '../epic/__mocks__/fixtures'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
import { EpicOverview } from './EpicOverview'

allowSlowRendering()

const opened: string[] = []

beforeEach(() => {
  opened.length = 0
  window.dm = {
    openExternal: (url: string) => {
      opened.push(url)
      return Promise.resolve(true)
    }
  } as Pick<DmApi, 'openExternal'> as DmApi
})

afterEach(() => {
  cleanup()
})

const SECOND = retroView({
  delivered: [{ ticket: 'tk_301', demo: 'Open the **plan graph**.', evidence: 'https://example.test/pull/30' }],
  wentWell: ['Pairing on the graph went smoothly'],
  wentPoorly: [],
  actions: [],
  discoveries: [],
  leftovers: [],
  tierFit: []
})

function renderOverview(): string[] {
  const selected: string[] = []
  render(
    <EpicOverview
      epic={epicDetail({ status: 'completed', completedAt: null })}
      run={runView({ state: 'completed', number: 2, revisionNumber: 4 })}
      overview={{
        bundle: bundle(),
        reports: [reportWithRetro(retroView(), { sprintId: 'sp_2' }), reportWithRetro(SECOND, { id: 'sr_3', sprintId: 'sp_3', tierFacts: [] })]
      }}
      now={NOW}
      onSelectTicket={(ticketId) => selected.push(ticketId)}
    />
  )
  return selected
}

describe('completed epic overview retros', () => {
  it("shows each sprint's retro inside its own report: delivered, retro notes, tier fit, discoveries and leftovers", () => {
    renderOverview()
    const first = screen.getByLabelText('Sprint 2 report')
    const labels = [...first.querySelectorAll('section[aria-label]')].map((item) => item.getAttribute('aria-label'))
    expect(labels.slice(0, 7)).toEqual(['Delivered', 'Went well', 'Went poorly', 'Actions', 'Tier fit', 'Discoveries', 'Leftovers'])
    expect(within(within(first).getByLabelText('Tier fit')).getAllByRole('row').length).toBe(4)
    const second = screen.getByLabelText('Sprint 3 report')
    expect(within(second).getByText('plan graph').tagName).toBe('STRONG')
    expect(within(within(second).getByLabelText('Went well')).getByText('Pairing on the graph went smoothly')).toBeTruthy()
    expect(within(second).queryByLabelText('Tier fit')).toBeNull()
    expect(within(second).queryByLabelText('Leftovers')).toBeNull()
  })

  it('is read-only: no add, move or approve control, only links to tickets and evidence', () => {
    const selected = renderOverview()
    expect(screen.queryAllByRole('button', { name: /Add to|Move to|Approve|Retry|Edit draft/ })).toEqual([])
    expect(screen.queryAllByRole('checkbox')).toEqual([])
    const first = screen.getByLabelText('Sprint 2 report')
    fireEvent.click(within(within(first).getByLabelText('Delivered')).getAllByRole('button', { name: 'DM-203' })[0] as HTMLElement)
    expect(selected).toEqual(['tk_203'])
    fireEvent.click(within(first).getByRole('link', { name: 'https://example.test/pull/12' }))
    expect(opened).toEqual(['https://example.test/pull/12'])
  })

  it('shows the discoveries and leftovers as plain entries, with their reason', () => {
    renderOverview()
    const first = screen.getByLabelText('Sprint 2 report')
    expect(within(within(first).getByLabelText('Discoveries')).getByText('Cache the folder registry')).toBeTruthy()
    expect(within(within(first).getByLabelText('Leftovers')).getByText('The replay test is still flaky after 2 attempts')).toBeTruthy()
  })
})
