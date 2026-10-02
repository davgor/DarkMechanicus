// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DmApi } from '../../../shared/desktop/api'
import {
  NOW,
  bundle,
  epicDetail,
  execution,
  mcpTestEpic,
  mcpTestPlan,
  mcpTestReport,
  mcpTestRun,
  reportView,
  runView
} from '../epic/__mocks__/fixtures'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
import { EpicOverview } from './EpicOverview'

allowSlowRendering()

beforeEach(() => {
  window.dm = { openExternal: () => Promise.resolve(true) } as Pick<DmApi, 'openExternal'> as DmApi
})

afterEach(() => {
  cleanup()
})

function renderMcpTest(): string[] {
  const selected: string[] = []
  render(
    <EpicOverview
      epic={mcpTestEpic()}
      run={mcpTestRun()}
      overview={{ bundle: mcpTestPlan().bundle, reports: [mcpTestReport()] }}
      now={NOW}
      onSelectTicket={(ticketId) => selected.push(ticketId)}
    />
  )
  return selected
}

describe('completed epic overview', () => {
  it('shows the recorded outcome summary and every success criterion with its result and note', () => {
    renderMcpTest()
    const outcome = screen.getByLabelText('Epic outcome')
    expect(within(outcome).getByRole('heading').textContent).toBe('Epic complete')
    expect(within(outcome).getByText('COMPLETED 40M AGO · RUN #1 · REV 1')).toBeTruthy()
    expect(within(outcome).getByText(/^The MCP authoring and execution path works end to end/).tagName).toBe('P')
    expect(within(screen.getByLabelText('Success criteria')).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '✓Epic and tickets appear in the desktop appEpic and both tickets listed (DM-1 accepted); the person saved and queued it from the desktop.',
      '✓A person can Save or discard the draftDraft saved as revision 1 from the desktop (DM-2 accepted).'
    ])
    expect(within(outcome).getAllByLabelText('met').length).toBe(2)
  })

  it('shows each sprint report with its work, checks, risks and proposed follow-ups', () => {
    renderMcpTest()
    const report = screen.getByLabelText('Sprint 1 report')
    expect(within(report).getByText('SPRINT 1 REPORT · WRITTEN BY CLAUDE CODE (ORCHESTRATOR) 45M AGO')).toBeTruthy()
    expect(within(report).getByText(/^Sprint 1 confirmed the full MCP loop/).tagName).toBe('P')
    expect(within(within(report).getByLabelText('ACCEPTED')).getAllByRole('listitem').length).toBe(2)
    expect(within(within(report).getByLabelText('Checks')).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '✓installed-app MCP smoke (npm run smoke:mcp)55 tools, 6 prompts',
      '✓draft plan validationvalidate_plan view=draft: valid, no errors or warnings',
      '✓dependency gatingDM-2 stayed waiting until DM-1 was accepted'
    ])
    expect(within(report).getByText('Reviews were not independent: the orchestrator session did the work and accepted it.')).toBeTruthy()
    const followUps = within(report).getByLabelText('Proposed follow-ups')
    expect(within(followUps).getByText('Register darkmechanicus MCP server in Claude Code')).toBeTruthy()
    expect(within(report).queryByLabelText('EPIC OUTCOME')).toBe(null)
  })

  it('puts only the ticket key in the key column of each accepted entry, with the sentence beside it', () => {
    const selected = renderMcpTest()
    const rows = within(within(screen.getByLabelText('Sprint 1 report')).getByLabelText('ACCEPTED')).getAllByRole('listitem')
    expect(rows.map((row) => row.querySelector('.cp-key')?.textContent)).toEqual(['DM-1', 'DM-2'])
    expect(rows.map((row) => row.querySelector('.cp-row-title')?.textContent)).toEqual([
      'Confirm epic is visible in the app: verified via list_epics; desktop-only save and queue confirm it was visible in the app',
      'Save or discard the draft: revision 1 saved from the desktop, no draft outstanding'
    ])
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'DM-2' }))
    expect(selected).toEqual(['tk_01m3txy30tvtfbzj1ecax0dvb0'])
  })
})

describe('completed epic overview controls', () => {
  it('is read-only: only ticket links, no approve, advance, retry, follow-up, draft or auto-continue controls', () => {
    renderMcpTest()
    const overview = screen.getByLabelText('Epic overview')
    expect(within(overview).getAllByRole('button').map((item) => item.textContent)).toEqual(['DM-1', 'DM-2'])
    expect(within(overview).queryAllByRole('checkbox')).toEqual([])
    expect(screen.queryByLabelText('Checkpoint gate')).toBe(null)
    expect(within(overview).queryByText(/Approve|Retry|Add to draft|Edit draft|automatic continuation/)).toBe(null)
  })

  it('stays read-only for failed work, which links to its ticket instead of offering a retry', () => {
    const run = runView({ state: 'completed', tickets: [execution('DM-202', 'sp_2', 'failed', { attemptCount: 2 })] })
    const reports = [reportView({ sprintId: 'sp_1', id: 'sr_0', createdAt: reportView().createdAt }), reportView()]
    const selected: string[] = []
    render(
      <EpicOverview
        epic={epicDetail({ status: 'completed' })}
        run={run}
        overview={{ bundle: bundle(), reports }}
        now={NOW}
        onSelectTicket={(ticketId) => selected.push(ticketId)}
      />
    )
    expect(screen.getAllByRole('article').map((item) => item.getAttribute('aria-label'))).toEqual(['Sprint 1 report', 'Sprint 2 report'])
    const sprint2 = screen.getByLabelText('Sprint 2 report')
    fireEvent.click(within(within(sprint2).getByLabelText('FAILED')).getByRole('button', { name: 'DM-202' }))
    expect(selected).toEqual(['tk_202'])
    expect(screen.getAllByRole('button').map((item) => item.textContent)).toEqual(['DM-203', 'DM-201', 'DM-202', 'DM-203', 'DM-201', 'DM-202'])
    expect(screen.getByText('No outcome was recorded for this epic.')).toBeTruthy()
  })

  it('explains when the run left no sprint reports', () => {
    render(<EpicOverview epic={mcpTestEpic()} run={mcpTestRun()} overview={{ bundle: null, reports: [] }} now={NOW} onSelectTicket={() => undefined} />)
    expect(screen.getByText('No sprint reports were recorded for this run.').tagName).toBe('P')
    expect(within(screen.getByLabelText('Success criteria')).getAllByRole('listitem').length).toBe(2)
  })
})
