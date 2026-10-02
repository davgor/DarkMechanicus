import { describe, expect, it } from 'vitest'
import {
  MINUTE,
  NOW,
  bundle,
  epicDetail,
  iso,
  mcpTestEpic,
  mcpTestPlan,
  mcpTestReport,
  mcpTestRun,
  reportView,
  runView
} from '../epic/__mocks__/fixtures'
import { overviewView } from './overviewView'

const MCP_INPUT = {
  epic: mcpTestEpic(),
  run: mcpTestRun(),
  overview: { bundle: mcpTestPlan().bundle, reports: [mcpTestReport()] },
  now: NOW
}

describe('overview of a completed epic', () => {
  it('reads the recorded outcome, names each criterion from the plan the run executed, and lists the reports', () => {
    const view = overviewView(MCP_INPUT)
    expect(view.eyebrow).toBe('COMPLETED 40M AGO · RUN #1 · REV 1')
    expect(view.summary).toBe(MCP_INPUT.epic.outcome?.summary)
    expect(view.criteria).toEqual([
      {
        text: 'Epic and tickets appear in the desktop app',
        met: true,
        note: 'Epic and both tickets listed (DM-1 accepted); the person saved and queued it from the desktop.'
      },
      { text: 'A person can Save or discard the draft', met: true, note: 'Draft saved as revision 1 from the desktop (DM-2 accepted).' }
    ])
    expect(view.reports.map((item) => item.label)).toEqual(['Sprint 1 report'])
    expect(view.reports[0]?.sections.header).toBe('SPRINT 1 REPORT · WRITTEN BY CLAUDE CODE (ORCHESTRATOR) 45M AGO')
    expect(view.reports[0]?.sections.followUps.length).toBe(2)
  })

  it('leaves the outcome out of each report, since the overview shows the recorded one', () => {
    const report = mcpTestReport()
    expect(report.report.epicOutcome).not.toBe(null)
    expect(overviewView(MCP_INPUT).reports[0]?.sections.outcome).toBe(null)
  })

  it('falls back to the final report outcome, the epic criteria, criterion ids and the run end time', () => {
    const outcome = { summary: 'From the final report', successCriteria: [{ criterionId: 's9', met: false, note: 'missing' }] }
    const first = reportView({ id: 'sr_1', sprintId: 'sp_1', report: { ...reportView().report, epicOutcome: null } })
    const final = reportView({ id: 'sr_3', sprintId: 'sp_3', report: { ...reportView().report, epicOutcome: outcome } })
    const view = overviewView({
      epic: epicDetail({ status: 'completed', completedAt: null, successCriteria: [{ id: 's9', text: 'Saved state survives' }] }),
      run: runView({ state: 'completed', number: 4, revisionNumber: 7, endedAt: iso(-3 * MINUTE) }),
      overview: { bundle: null, reports: [first, final] },
      now: NOW
    })
    expect([view.eyebrow, view.summary]).toEqual(['COMPLETED 3M AGO · RUN #4 · REV 7', 'From the final report'])
    expect(view.criteria).toEqual([{ text: 'Saved state survives', met: false, note: 'missing' }])
    expect(view.reports.map((item) => item.label)).toEqual(['Sprint report', 'Sprint report'])
    const unknown = overviewView({ ...MCP_INPUT, epic: mcpTestEpic({ successCriteria: [] }), overview: { bundle: null, reports: [] } })
    expect(unknown.criteria.map((item) => item.text)).toEqual(['s1', 's2'])
  })

  it('reports no outcome when neither the epic nor its final report recorded one', () => {
    const view = overviewView({
      epic: epicDetail({ status: 'completed' }),
      run: runView({ state: 'completed' }),
      overview: { bundle: bundle(), reports: [reportView({ sprintId: 'sp_3' })] },
      now: NOW
    })
    expect([view.summary, view.criteria]).toEqual([null, []])
    expect(view.reports.map((item) => item.label)).toEqual(['Sprint 3 report'])
  })
})
