// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DmApi } from '../../../shared/desktop/api'
import type { FollowUpProposal, SprintReportView } from '../../../shared/domain/views'
import { NOW, bundle, checkpointView, condition, execution, incrementView, reportView, runView } from '../epic/__mocks__/fixtures'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
import { CheckpointScreen, type CheckpointScreenProps } from './CheckpointScreen'

allowSlowRendering()

beforeEach(() => {
  window.dm = { openExternal: () => Promise.resolve(true) } as Pick<DmApi, 'openExternal'> as DmApi
})

afterEach(() => {
  cleanup()
})

interface Recorded {
  approved: string[]
  retried: string[]
  auto: boolean[]
  followUps: string[]
  edits: number
  selected: string[]
}

const FAILED_RUN = runView({
  state: 'awaiting_checkpoint',
  tickets: [execution('DM-202', 'sp_2', 'failed', { attemptCount: 2 }), execution('DM-203', 'sp_2', 'accepted')]
})

function renderScreen(patch: Partial<CheckpointScreenProps> = {}, followUpResult = true): Recorded {
  const recorded: Recorded = { approved: [], retried: [], auto: [], followUps: [], edits: 0, selected: [] }
  render(
    <CheckpointScreen
      checkpoint={checkpointView()}
      run={FAILED_RUN}
      bundle={bundle()}
      now={NOW}
      busy={false}
      draft={null}
      onApprove={(id) => recorded.approved.push(id)}
      onApproveWithRedraft={() => Promise.resolve(null)}
      onRetry={(id) => recorded.retried.push(id)}
      onAutoContinue={(enabled) => recorded.auto.push(enabled)}
      onAddFollowUp={(proposal: FollowUpProposal) => {
        recorded.followUps.push(proposal.title)
        return Promise.resolve(followUpResult)
      }}
      onEditDraft={() => {
        recorded.edits += 1
      }}
      onSelectTicket={(id) => recorded.selected.push(id)}
      {...patch}
    />
  )
  return recorded
}

describe('checkpoint report', () => {
  it('shows the report header, summary, accepted and failed work, and checks', () => {
    const recorded = renderScreen()
    const report = screen.getByLabelText('Sprint report')
    expect(within(report).getByText('SPRINT 2 REPORT · AUTHORING THROUGH MCP · WRITTEN BY SPRINT REPORTER 12M AGO')).toBeTruthy()
    expect(within(report).getByText('Import').tagName).toBe('STRONG')
    const accepted = screen.getByLabelText('ACCEPTED')
    expect(within(accepted).getByText('ACCEPTED · 2').textContent).toBe('ACCEPTED · 2')
    fireEvent.click(within(accepted).getByRole('button', { name: 'DM-203' }))
    expect(recorded.selected).toEqual(['tk_203'])
    const failed = screen.getByLabelText('FAILED')
    expect(within(failed).getByText('attempt 2 of 2 · 2 tests failed').textContent).toBe('attempt 2 of 2 · 2 tests failed')
    expect(within(screen.getByLabelText('Checks')).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '✓Typecheck0 errors',
      '✗Package · macos-latestexit 1',
      '–Docsn/a'
    ])
    expect(within(screen.getByLabelText('EXIT CRITERIA')).getByText('x1').textContent).toBe('x1')
    expect(within(screen.getByLabelText('Risks')).getByText('macOS signing is unverified')).toBeTruthy()
  })

  it('adds a proposed follow-up to the draft once', async () => {
    const recorded = renderScreen()
    const followUps = screen.getByLabelText('Proposed follow-ups')
    fireEvent.click(within(followUps).getAllByRole('button', { name: '+ Add to draft' })[0] as HTMLElement)
    expect((await within(followUps).findByText('Added to draft')).textContent).toBe('Added to draft')
    expect(within(followUps).getAllByRole('button').length).toBe(1)
    expect(recorded.followUps).toEqual(['Provide a signing identity'])
  })

  it('keeps the button when adding a follow-up fails', async () => {
    const recorded = renderScreen({}, false)
    const followUps = screen.getByLabelText('Proposed follow-ups')
    fireEvent.click(within(followUps).getAllByRole('button')[1] as HTMLElement)
    await act(async () => undefined)
    expect(recorded.followUps).toEqual(['Re-run driver load test'])
    expect(within(followUps).getAllByRole('button').length).toBe(2)
  })

  it('explains when the sprint report has not been written yet', () => {
    renderScreen({ checkpoint: checkpointView({ report: null }) })
    expect(screen.getByText(/No sprint report yet\./).textContent).toBe(
      "No sprint report yet. The orchestrator writes it when the sprint's required work is done."
    )
  })
})

const cells = (row: HTMLElement, selector: string): string[] => [...row.querySelectorAll(selector)].map((item) => item.textContent ?? '')

/** The checkpoint screen for a report that is the fixture's, with these fields replaced. */
function withReport(patch: Partial<SprintReportView['report']>): Recorded {
  return renderScreen({ checkpoint: checkpointView({ report: reportView({ report: { ...reportView().report, ...patch } }) }) })
}

describe('checkpoint report blocked and changes', () => {
  it('shows blocked entries as keyed rows that link to their ticket', () => {
    const recorded = withReport({ blocked: ['DM-201 Waiting on signing key', 'Infrastructure unavailable'] })
    const blocked = screen.getByLabelText('BLOCKED')
    expect(within(blocked).getByText('BLOCKED · 2').textContent).toBe('BLOCKED · 2')
    const rows = within(blocked).getAllByRole('listitem')
    expect(rows.map((row) => [cells(row, '.cp-key'), cells(row, '.cp-row-title')])).toEqual([
      [['DM-201'], ['Waiting on signing key']],
      [[], ['Infrastructure unavailable']]
    ])
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'DM-201' }))
    expect(recorded.selected).toEqual(['tk_201'])
  })

  it('shows the changed files and the commits as short hashes in rows like the other sections', () => {
    withReport({ changes: { files: ['src/mcp/tools.ts', 'src/core/plans.ts'], commits: ['a1b2c3d4e5f6a7b8c9d0', 'f8de0e6dd12345 (squash of 2)'] } })
    const rows = within(screen.getByLabelText('Changes')).getAllByRole('listitem')
    expect(rows.map((row) => row.className)).toEqual(['cp-row', 'cp-row', 'cp-row', 'cp-row'])
    expect(rows.map((row) => [cells(row, '.cp-key'), cells(row, '.cp-row-title')])).toEqual([
      [['file'], ['src/mcp/tools.ts']],
      [['file'], ['src/core/plans.ts']],
      [['commit'], ['a1b2c3d']],
      [['commit'], ['f8de0e6 (squash of 2)']]
    ])
    expect(screen.queryByText(/a1b2c3d4e5f6a7b8c9d0/)).toBeNull()
  })

  it('shows only the kind of change the report has', () => {
    withReport({ changes: { files: [], commits: ['a1b2c3d'] } })
    expect(within(screen.getByLabelText('Changes')).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['commita1b2c3d'])
  })
})

describe('checkpoint report epic outcome', () => {
  it('shows the epic outcome summary, rendered as Markdown, with its criteria in the EPIC OUTCOME section', () => {
    withReport({
      epicOutcome: { summary: 'MCP authoring is **ready** for users.', successCriteria: [{ criterionId: 's1', met: true, note: 'verified' }] }
    })
    const outcome = screen.getByLabelText('EPIC OUTCOME')
    expect(within(outcome).getByText('ready').tagName).toBe('STRONG')
    expect(within(outcome).getByText(/^MCP authoring is/).textContent).toBe('MCP authoring is ready for users.')
    expect(within(outcome).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '✓An agent saves a plan through MCPverified'
    ])
  })

  it('shows an outcome that has a summary but no criteria, and one that has criteria but no summary', () => {
    withReport({ epicOutcome: { summary: 'Shipped.', successCriteria: [] } })
    expect(within(screen.getByLabelText('EPIC OUTCOME')).getByText('Shipped.')).toBeTruthy()
    expect(within(screen.getByLabelText('EPIC OUTCOME')).queryAllByRole('listitem')).toEqual([])
    cleanup()
    withReport({ epicOutcome: { summary: '', successCriteria: [{ criterionId: 's1', met: false, note: 'open' }] } })
    expect(within(screen.getByLabelText('EPIC OUTCOME')).getAllByRole('listitem').length).toBe(1)
    expect(screen.getByLabelText('EPIC OUTCOME').querySelector('.md')).toBeNull()
  })

})

/** The checkpoint screen for a report whose sprint increment is the fixture's, with these fields replaced. */
function withIncrement(patch: Parameters<typeof incrementView>[0] = {}): Recorded {
  return renderScreen({ checkpoint: checkpointView({ report: reportView({ increment: incrementView(patch) }) }) })
}

describe('checkpoint report increment', () => {
  it("shows the sprint's increment commit with its branch and what it follows, in rows like the other sections", () => {
    withIncrement()
    const section = screen.getByLabelText('INCREMENT')
    expect(within(section).getByText('INCREMENT · SPRINT 2').textContent).toBe('INCREMENT · SPRINT 2')
    const rows = within(section).getAllByRole('listitem').filter((row) => row.className.startsWith('cp-row'))
    expect(rows.map((row) => [cells(row, '.cp-key'), cells(row, '.cp-row-title'), cells(row, '.cp-row-detail')])).toEqual([
      [['commit'], ['5d3e1f0'], ['✓ VERIFIED']],
      [['branch'], ['epic/planning'], []],
      [['after'], ["9f8e7d6 · previous sprint's increment"], []]
    ])
    expect(screen.getByText('5d3e1f0').getAttribute('title')).toBe('5d3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e')
  })

  it('lists the checks the server made on the increment', () => {
    withIncrement()
    expect(within(screen.getByLabelText('Increment checks')).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '✓One commit on the epic branchepic/planning is at 5d3e1f0',
      '✓Parent is the previous increment9f8e7d6'
    ])
  })

  it('marks an increment that did not pass, and gives the reasons', () => {
    const base = incrementView().increment
    withIncrement({
      increment: {
        ...base,
        passed: false,
        reasons: ['The commit has 2 parents; a sprint lands as one squashed commit.'],
        checks: [{ name: 'Single parent', status: 'failed', detail: '2 parents' }]
      }
    })
    const section = screen.getByLabelText('INCREMENT')
    expect(within(section).getByText('✗ NOT VERIFIED')).toBeTruthy()
    expect(within(section).getByText('The commit has 2 parents; a sprint lands as one squashed commit.')).toBeTruthy()
    expect(within(screen.getByLabelText('Increment checks')).getAllByRole('listitem').map((item) => item.className)).toEqual(['is-failed'])
  })

  it('shows no increment section for a sprint that named none', () => {
    renderScreen()
    expect(screen.queryByLabelText('INCREMENT')).toBeNull()
  })
})

describe('checkpoint report empty sections', () => {
  it('omits the blocked, changes and epic outcome sections when the report has none', () => {
    withReport({ blocked: [], changes: { files: [], commits: [] }, epicOutcome: null })
    expect(screen.queryByLabelText('BLOCKED')).toBeNull()
    expect(screen.queryByLabelText('Changes')).toBeNull()
    expect(screen.queryByLabelText('EPIC OUTCOME')).toBeNull()
  })
})

describe('checkpoint report entries', () => {
  it('keeps free-text report entries out of the key column', () => {
    const entries = ['DM-203 Folder picker works: verified by hand', 'Verified list_epics against the installed app', 'DM-998 Never started']
    const report = reportView({ report: { ...reportView().report, accepted: entries.slice(0, 2), failed: entries.slice(2) } })
    renderScreen({ checkpoint: checkpointView({ report }) })
    const accepted = within(screen.getByLabelText('ACCEPTED')).getAllByRole('listitem')
    expect(accepted.map((row) => [cells(row, '.cp-key'), cells(row, '.cp-row-title')])).toEqual([
      [['DM-203'], ['Folder picker works: verified by hand']],
      [[], ['Verified list_epics against the installed app']]
    ])
    expect(accepted[1]?.querySelector('.cp-row-title')?.classList.contains('is-keyless')).toBe(true)
    expect(accepted[0]?.querySelector('.cp-row-title')?.classList.contains('is-keyless')).toBe(false)
    const failed = within(screen.getByLabelText('FAILED')).getAllByRole('listitem')
    expect(failed.map((row) => [cells(row, '.cp-key'), cells(row, '.cp-row-title')])).toEqual([[['DM-998'], ['Never started']]])
  })

  it('lists entries that share a ticket key or have none without duplicate React keys', () => {
    const accepted = ['DM-203 Picker works', 'DM-203 Picker remembers its folder', 'Checked the installed app', 'Checked the packaged app']
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderScreen({ checkpoint: checkpointView({ report: reportView({ report: { ...reportView().report, accepted } }) }) })
    expect(within(screen.getByLabelText('ACCEPTED')).getAllByRole('listitem').length).toBe(4)
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe('checkpoint gate', () => {
  it('lists unmet gate conditions and blocks approval, offering retry and draft edits', () => {
    const recorded = renderScreen()
    const gate = screen.getByLabelText('Checkpoint gate')
    expect(within(gate).getByRole('heading').textContent).toBe("Sprint 3 can't start yet")
    expect(within(gate).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '✓Sprint report submittedRequired by checkpoint policy',
      '✓No worker still holds a leaseAll claims released or expired',
      '✗Every required ticket acceptedDM-202 failed after 2 attempts',
      '✗Exit criteria: driver loads on both platformsmacOS unverified'
    ])
    const approve = within(gate).getByRole('button', { name: 'Approve & advance to Sprint 3' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    expect(within(gate).getByText("Blocked by 2 gate conditions. Retry DM-202 or edit the plan so it's no longer required.")).toBeTruthy()
    fireEvent.click(within(gate).getByRole('button', { name: 'Retry DM-202' }))
    fireEvent.click(within(gate).getByRole('button', { name: 'Edit draft to change the gate' }))
    fireEvent.click(within(gate).getByRole('checkbox'))
    expect([recorded.retried, recorded.edits, recorded.auto]).toEqual([['tk_202'], 1, [true]])
  })

  it('approves and advances when every gate is met', () => {
    const checkpoint = checkpointView({ gatesMet: true, conditions: [condition('report_submitted', true, 'ok')] })
    const recorded = renderScreen({ checkpoint, run: runView({ state: 'awaiting_checkpoint', autoContinue: true }) })
    const gate = screen.getByLabelText('Checkpoint gate')
    expect(within(gate).getByRole('heading').textContent).toBe('Ready to advance to Sprint 3')
    fireEvent.click(within(gate).getByRole('button', { name: 'Approve & advance to Sprint 3' }))
    expect(recorded.approved).toEqual(['sr_1'])
    expect((within(gate).getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  it('names the final approval and disables actions while busy', () => {
    const checkpoint = checkpointView({ gatesMet: true, isFinalSprint: true, sprintOrdinal: 3 })
    renderScreen({ checkpoint, busy: true })
    const approve = screen.getByRole('button', { name: 'Approve & complete epic' }) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
  })
})
