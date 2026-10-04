import { describe, expect, it } from 'vitest'
import { NOW, bundle, epicDetail, reportView, reportWithRetro, retroView, runView } from '../epic/__mocks__/fixtures'
import { overviewView } from './overviewView'

const EPIC = epicDetail({ status: 'completed', completedAt: null })
const RUN = runView({ state: 'completed', number: 2, revisionNumber: 4 })

describe('overview of a completed epic with retros', () => {
  const second = retroView({
    delivered: [{ ticket: 'tk_301', demo: 'Open the plan graph.', evidence: 'https://example.test/pull/30' }],
    leftovers: [],
    discoveries: []
  })

  it("carries each sprint's retro, named from the plan the run executed", () => {
    const view = overviewView({
      epic: EPIC,
      run: RUN,
      overview: {
        bundle: bundle(),
        reports: [reportWithRetro(retroView(), { sprintId: 'sp_2' }), reportWithRetro(second, { id: 'sr_3', sprintId: 'sp_3', tierFacts: [] })]
      },
      now: NOW
    })
    expect(view.reports.map((item) => item.label)).toEqual(['Sprint 2 report', 'Sprint 3 report'])
    expect(view.reports.map((item) => item.sections.retro?.delivered.map((row) => row.ticket.key))).toEqual([['DM-203', 'DM-201'], ['DM-301']])
    expect(view.reports[0]?.sections.retro?.tierFit.map((row) => row.ticket.key)).toEqual(['DM-201', 'DM-202', 'DM-203'])
    expect(view.reports[1]?.sections.retro?.leftovers).toEqual([])
  })

  it('has no retro for a report written without one', () => {
    const view = overviewView({
      epic: EPIC,
      run: RUN,
      overview: { bundle: bundle(), reports: [reportView({ sprintId: 'sp_2' })] },
      now: NOW
    })
    expect(view.reports[0]?.sections.retro).toBe(null)
  })
})
