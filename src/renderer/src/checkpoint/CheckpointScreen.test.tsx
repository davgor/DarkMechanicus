// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DmApi } from '../../../shared/desktop/api'
import type { FollowUpProposal } from '../../../shared/domain/views'
import { NOW, bundle, checkpointView, condition, execution, runView } from '../epic/__mocks__/fixtures'
import { CheckpointScreen, type CheckpointScreenProps } from './CheckpointScreen'

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
      onApprove={(id) => recorded.approved.push(id)}
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
    await Promise.resolve()
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
