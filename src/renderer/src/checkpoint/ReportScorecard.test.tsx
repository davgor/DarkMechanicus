// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FakeDm } from '../__mocks__/fakeDm'
import { type Recording, replay, reportCardIdentity, reportContext, type WorldName, world, worldDm } from '../__mocks__/scorecardWorlds'
import { loadScore } from '../scorecard/scoreReads'
import { settle } from '../__mocks__/settle'
import type { Scheduler } from '../app/scheduler'
import { localTime } from '../scorecard/scorecardFormat'
import { ReportScorecard } from './ReportScorecard'

afterEach(cleanup)

const IDLE: Scheduler = { after: () => () => undefined, every: () => () => undefined }

interface Shown {
  dm: FakeDm
  selected: string[]
}

async function show(name: WorldName, standing: 'approved' | 'historical' | 'awaiting_approval'): Promise<Shown & { recording: Recording }> {
  const recording = world(name)
  const dm = worldDm(recording.calls)
  window.dm = dm
  const selected: string[] = []
  const identity = reportCardIdentity(recording)
  const report = identity.report === null ? null : { ...identity.report, standing }
  const { run, bundle } = await reportContext(recording)
  render(
    <ReportScorecard
      source={{ folderPath: 'C:/demo', scheduler: IDLE, version: 0 }}
      target={{ runId: identity.runId, sprintId: identity.sprintId, report }}
      run={run}
      bundle={bundle}
      onSelectTicket={(ticketId) => selected.push(ticketId)}
    />
  )
  await settle()
  return { dm, selected, recording }
}

const factsText = (label: string): string => screen.getByLabelText(label).textContent ?? ''

describe('DM-182 c1: the Scorecard tab shows its pinned report identity', () => {
  it('a historical report reads the snapshot frozen with its revision and names it, never a live grade', async () => {
    const { dm } = await show('reportApproved', 'historical')
    expect(screen.getByText('Historical snapshot')).toBeTruthy()
    expect(dm.callsOf('getReportScorecard').map((call) => call.input)).toEqual([{ reportId: 'rp_00000000000000000000000008', reportRevision: 1 }])
    expect(dm.callsOf('getSprintGrade')).toEqual([])
    expect(factsText('Pinned report')).toContain('1 (pinned: a later revision has its own scorecard)')
    expect(factsText('Pinned report')).toContain('dm-space v2 · f50d32f4eb4e')
  })

  it('a checkpoint’s report awaiting approval says approving approves that snapshot', async () => {
    await show('reportCheckout', 'awaiting_approval')
    expect(screen.getByText('Snapshot · awaiting approval')).toBeTruthy()
    expect(screen.getByText(/Approving the checkpoint approves this snapshot as it is\./)).toBeTruthy()
  })

  it('a sprint without a report shows its live, provisional grade and no pinned identity', async () => {
    const { dm } = await show('reportLive', 'approved')
    expect(screen.getByText('Live · provisional')).toBeTruthy()
    expect(screen.queryByLabelText('Pinned report')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reassess now' })).toBeNull()
    expect(dm.callsOf('getReportScorecard')).toEqual([])
  })
})

describe('DM-182 c2: sprint outcome, ticket drill-down, resources and coverage on the tab', () => {
  it('shows why the sprint failed and each ticket’s outcome, and opens a ticket from its key', async () => {
    const { selected } = await show('reportCheckout', 'awaiting_approval')
    const outcome = screen.getByRole('region', { name: 'Sprint outcome' })
    expect(within(outcome).getByRole('note').textContent).toContain('yet the sprint failed: DM-5 Grade the tests with Fireguard')
    const list = within(outcome).getByLabelText('Ticket outcomes')
    expect(list.textContent).toContain('integrated (acceptance or administrative) · failed: confirmed failure')
    expect(list.textContent).toContain('feature ticket · not verified: never dispatched · not counted')
    fireEvent.click(within(list).getByRole('button', { name: 'DM-5' }))
    expect(selected).toEqual(['tk_000000000000000000000000zd'])
  })

  it('opens one ticket’s grade on request and closes it again', async () => {
    await show('reportCheckout', 'awaiting_approval')
    const tickets = screen.getByRole('region', { name: 'Ticket grades' })
    const [first] = within(tickets).getAllByRole('button', { name: 'Show grade' })
    if (first === undefined) throw new Error('a ticket is listed')
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(within(tickets).getAllByRole('region', { name: /^Grade of / }).map((region) => region.getAttribute('aria-label'))).toEqual([`Grade of ${first.closest('li')?.querySelector('.cp-key')?.textContent ?? ''}`])
    fireEvent.click(within(tickets).getByRole('button', { name: 'Hide grade' }))
    expect(within(tickets).queryAllByRole('region', { name: /^Grade of / })).toEqual([])
  })

  it('reads resource totals as lower bounds and lists unreported attempts under coverage', async () => {
    await show('reportCheckout', 'awaiting_approval')
    expect(factsText('Resource totals')).toContain('≥ 48,000 tokens (a lower bound: 1 attempt(s) reported nothing)')
    expect(factsText('Coverage')).toContain('1 (at_00000000000000000000000005)')
  })
})

describe('DM-182 c3: a reassessment is a separate, dated reading', () => {
  async function reassessed(): Promise<{ dm: FakeDm; section: HTMLElement; assessedAt: string }> {
    const { dm, recording } = await show('reportApproved', 'approved')
    const section = screen.getByRole('region', { name: 'Later reassessment' })
    fireEvent.click(within(section).getByRole('button', { name: 'Reassess now' }))
    await settle()
    const { report } = recording.ids
    if (report === null) throw new Error('the approved report is pinned')
    const { assessedAt } = await loadScore(replay(recording.calls), { kind: 'reassessment', ...report, request: 1 })
    return { dm, section, assessedAt }
  }

  it('keeps the approved snapshot and shows the reassessment beside it with its own date and provenance', async () => {
    const { section, assessedAt } = await reassessed()
    expect(screen.getByText('Approved snapshot')).toBeTruthy()
    expect(within(section).getByText(`Reassessment · ${localTime(assessedAt)}`)).toBeTruthy()
    const provenance = within(section).getByLabelText('Reassessment provenance').textContent ?? ''
    expect(provenance).toContain('regraded by the Dark Mechanicus core from this folder’s records when you asked; not stored, not approved')
    expect(provenance).toContain('snapshot as_ntfnwaqd1bm93s1xzp21q430e8')
    expect(within(section).getByLabelText('Reassessed subjects').textContent).toContain('records after the approval (late metrics, ratings, defects or decisions)')
  })

  it('(f) regaining window focus never takes a new reading in place of the one asked for', async () => {
    const { dm } = await reassessed()
    expect(dm.callsOf('reassessReportScorecard').length).toBe(1)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(dm.callsOf('reassessReportScorecard').length).toBe(1)
    expect(dm.callsOf('getReportScorecard').length).toBe(2)
  })

  it('takes a new reading only when asked again', async () => {
    const { dm, section } = await reassessed()
    fireEvent.click(within(section).getByRole('button', { name: 'Reassess again' }))
    await settle()
    expect(dm.callsOf('reassessReportScorecard').length).toBe(2)
  })
})
