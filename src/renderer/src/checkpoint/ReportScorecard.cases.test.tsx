// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandName } from '../../../shared/domain/api'
import type { CommandOutput } from '../../../shared/desktop/api'
import type { RunView } from '../../../shared/domain/views'
import type { FakeDm } from '../__mocks__/fakeDm'
import { reportCardIdentity, reportContext, type WorldName, world, worldDm } from '../__mocks__/scorecardWorlds'
import { settle } from '../__mocks__/settle'
import type { Scheduler } from '../app/scheduler'
import { ReportScorecard } from './ReportScorecard'

afterEach(cleanup)

const IDLE: Scheduler = { after: () => () => undefined, every: () => () => undefined }

interface Options {
  /** The plan shown is unreadable: no ticket has a name. */
  noPlan?: boolean
  /** The tab is shown for another run than the report's. */
  otherRun?: boolean
  change?(dm: FakeDm): void
}

/** The world's report tab, rendered as the checkpoint review shows it. */
async function show(name: WorldName, options: Options = {}): Promise<FakeDm> {
  const recording = world(name)
  const dm = worldDm(recording.calls)
  options.change?.(dm)
  window.dm = dm
  const identity = reportCardIdentity(recording)
  const { run, bundle } = await reportContext(recording)
  const shown: RunView = options.otherRun === true ? { ...run, id: 'rn_other' } : run
  render(
    <ReportScorecard
      source={{ folderPath: 'C:/demo', scheduler: IDLE, version: 0 }}
      target={{ runId: identity.runId, sprintId: identity.sprintId, report: identity.report === null ? null : { ...identity.report, standing: 'historical' } }}
      run={shown}
      bundle={options.noPlan === true ? null : bundle}
      onSelectTicket={() => undefined}
    />
  )
  await settle()
  return dm
}

/** Answers `name` with `change` applied to the world's answer. */
function changeAnswers<K extends CommandName>(dm: FakeDm, name: K, change: (output: CommandOutput<K>) => CommandOutput<K>): void {
  const before = dm.handlers[name]
  if (before === undefined) throw new Error(`The world never read ${name}`)
  dm.handlers[name] = (input, folder) => change(before(input, folder) as CommandOutput<K>)
}

const region = (name: string): HTMLElement => screen.getByRole('region', { name })
const factsText = (label: string): string => screen.getByLabelText(label).textContent ?? ''

describe('a report from before scorecards', () => {
  it('is pinned and ungraded, names its run by id when shown for another, and shows no card in its place', async () => {
    const recording = world('reportApproved')
    let submittedAt = ''
    await show('reportApproved', {
      otherRun: true,
      noPlan: true,
      change: (dm) =>
        changeAnswers(dm, 'getReportScorecard', (output) => {
          submittedAt = output.report.submittedAt
          return { state: 'legacy', report: output.report, reason: 'It was submitted before scorecards.' }
        })
    })
    expect(screen.getByText('Ungraded (legacy)')).toBeTruthy()
    expect(factsText('Pinned report')).toContain(`Run${recording.ids.runId}`)
    expect(factsText('Pinned report')).toContain('Snapshotnone: this report predates scorecards')
    expect(screen.queryByRole('region', { name: 'Sprint outcome' })).toBeNull()
    expect(screen.getByLabelText('Data freshness').querySelector('time')?.getAttribute('dateTime')).toBe(submittedAt)
    expect(screen.getByRole('region', { name: 'Later reassessment' })).toBeTruthy()
  })
})

describe('a report shown without its plan', () => {
  it('names tickets by id, and opens a ticket’s grade without an outcome the sprint holds none for', async () => {
    await show('reportCheckout', {
      noPlan: true,
      change: (dm) =>
        changeAnswers(dm, 'getReportScorecard', (output) =>
          output.state === 'legacy' ? output : { ...output, scorecard: { ...output.scorecard, sprint: { ...output.scorecard.sprint, detail: { ...output.scorecard.sprint.detail, outcomes: [] } } } }
        )
    })
    const outcome = region('Sprint outcome')
    expect(within(outcome).queryAllByRole('button')).toEqual([])
    const tickets = region('Ticket grades')
    expect(within(tickets).getByText('tk_000000000000000000000000z9')).toBeTruthy()
    const [first] = within(tickets).getAllByRole('button', { name: 'Show grade' })
    if (first === undefined) throw new Error('a ticket is listed')
    fireEvent.click(first)
    const grade = within(tickets).getByRole('region', { name: 'Grade of tk_000000000000000000000000z9' })
    expect(grade.textContent).not.toContain('Outcome:')
    expect(within(grade).getByLabelText('Ticket time').textContent).toContain('Cycle time (first claim → end)')
  })
})

describe('a sprint without a report', () => {
  it('shows a failed timing read beside the grade, and Try again reads the tab afresh', async () => {
    const dm = await show('reportLive', { change: (next) => (next.failures.getRunTiming = { code: 'internal', message: 'The timing projection was busy.' }) })
    const resources = region('Tokens and time')
    expect(within(resources).getByRole('alert').textContent).toContain('The timing projection was busy.')
    expect(within(resources).queryByLabelText('Sprint time')).toBeNull()
    delete dm.failures.getRunTiming
    fireEvent.click(within(resources).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(dm.callsOf('getSprintGrade')).toHaveLength(2)
    expect(factsText('Sprint time')).toContain('Sprint elapsed (activation → next sprint or cutoff)')
  })

  it('says nothing failed and no ticket was graded when the grade holds neither', async () => {
    await show('reportLive', {
      change: (dm) =>
        changeAnswers(dm, 'getSprintGrade', (output) => ({
          ...output,
          grade: { ...output.grade, statusReasons: [] },
          outcomes: output.outcomes.map((outcome) => ({ ...outcome, state: 'verified' as const, reason: 'reviewed' as const })),
          tickets: []
        }))
    })
    expect(region('Failure causes').textContent).toContain('Nothing failed, and nothing held the grade back.')
    expect(region('Ticket grades').textContent).toContain('No ticket of this sprint was graded.')
  })
})

describe('a reassessment against a legacy or differently graded snapshot', () => {
  it('compares with nothing when nothing was approved, and names a policy other than the snapshot’s', async () => {
    let asked = 0
    await show('reportApproved', {
      change: (dm) =>
        changeAnswers(dm, 'reassessReportScorecard', (output) => {
          asked += 1
          if (asked === 1 || output.approved === null) return { ...output, approved: null }
          return { ...output, approved: { ...output.approved, policy: { ...output.approved.policy, hash: 'sha256:0000000000000000' } } }
        })
    })
    const section = region('Later reassessment')
    fireEvent.click(within(section).getByRole('button', { name: 'Reassess now' }))
    await settle()
    const policy = 'dm-space v2 · f50d32f4eb4e'
    expect(factsText('Reassessment provenance')).toContain(`Graded under${policy}Compared withnothing: the report predates scorecards, so no grade was approved`)
    fireEvent.click(within(section).getByRole('button', { name: 'Reassess again' }))
    await settle()
    expect(factsText('Reassessment provenance')).toContain(`Graded under${policy} (a different policy from the snapshot’s)`)
  })
})
