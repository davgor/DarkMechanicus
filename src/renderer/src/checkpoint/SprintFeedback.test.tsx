// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { HumanFeedbackEntry, SpaceSignalsView } from '../../../shared/domain/spaceSignals'
import { localTime } from '../scorecard/scorecardFormat'
import { SprintFeedback } from './SprintFeedback'

let dm: FakeDm
let recorded: number

beforeEach(() => {
  dm = new FakeDm()
  dm.responses.recordHumanFeedback = { observationId: 'ob_9' }
  window.dm = dm
  recorded = 0
})

afterEach(cleanup)

const ENTRY: HumanFeedbackEntry = {
  observationId: 'ob_1',
  person: 'Dana',
  recordedAt: '2026-03-04T09:00:00.000Z',
  scope: { level: 'sprint', epicId: 'ep_1', sprintId: 'sp_1', runId: 'rn_1', ticketId: null, attemptId: null },
  value: 4,
  sharedWithTickets: true,
  intervention: null,
  cause: null,
  activity: null,
  recordedBy: { origin: 'this_machine', desktopSession: 'ss_1', machine: 'mc_1' }
}

function signals(sprint: { value: number; shared: boolean } | null): SpaceSignalsView {
  return {
    subject: { level: 'sprint', id: 'sp_1' },
    runId: 'rn_1',
    epicId: 'ep_1',
    cutoff: '2026-03-05T00:00:00.000Z',
    S: {
      input: { ticketRating: null, sprintRating: sprint === null ? null : { observationId: 'ob_1', source: 'human', value: sprint.value, sharedWithTickets: sprint.shared } },
      sprintRatingUse: sprint === null ? 'none' : 'own',
      ratings: sprint === null ? [] : [{ ...ENTRY, value: sprint.value, sharedWithTickets: sprint.shared }],
      rescue: [],
      rescueMinutes: 0,
      plannedReview: [],
      plannedReviewMinutes: 0,
      entriesWithoutMinutes: 0
    }
  } as unknown as SpaceSignalsView
}

function feedback(frozen: boolean): JSX.Element {
  return (
    <SprintFeedback
      source={{ folderPath: '/repo', scheduler: new ManualScheduler(), version: 1 }}
      epicId="ep_1"
      runId="rn_1"
      sprintId="sp_1"
      sprintLabel="Sprint 2"
      frozen={frozen}
      onRecorded={() => (recorded += 1)}
    />
  )
}

describe('DM-183 c1: the sprint’s one rating, its sharing and missing feedback', () => {
  it('says no rating was recorded and offers no pre-chosen answer', async () => {
    dm.responses.getSpaceSignals = signals(null)
    render(feedback(false))
    await settle()
    expect(screen.getByText('No rating recorded for this sprint: S is left out of the grade and nothing is assumed.')).toBeTruthy()
    expect(screen.getAllByRole('radio').some((radio) => (radio as HTMLInputElement).checked)).toBe(false)
    expect(dm.callsOf('getSpaceSignals').map((call) => call.input)).toEqual([{ level: 'sprint', id: 'sp_1', runId: 'rn_1' }])
  })

  it('lists the shared rating with who recorded it and where', async () => {
    dm.responses.getSpaceSignals = signals({ value: 4, shared: true })
    render(feedback(false))
    await settle()
    const section = screen.getByRole('region', { name: 'Sprint feedback' })
    expect(within(section).getByText("Rated 4 of 5, shared with the sprint's tickets: a ticket without its own rating inherits it, marked inherited.")).toBeTruthy()
    expect(within(section).getByText(`4 of 5 · shared with the tickets · by Dana at ${localTime('2026-03-04T09:00:00.000Z')}`)).toBeTruthy()
    expect(within(section).getByText('Recorded by: labelled as recorded on this machine (a label, not a signature); desktop session ss_1, machine mc_1')).toBeTruthy()
    expect(screen.getByRole('radio', { name: '4 · Satisfied' })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /Share with this sprint's tickets/ })).toHaveProperty('checked', true)
  })

  it('an unshared rating is listed as not shared', async () => {
    dm.responses.getSpaceSignals = signals({ value: 2, shared: false })
    render(feedback(false))
    await settle()
    expect(screen.getByText(`2 of 5 · not shared · by Dana at ${localTime('2026-03-04T09:00:00.000Z')}`)).toBeTruthy()
  })

  it('records the sprint rating for the sprint and reads again', async () => {
    dm.responses.getSpaceSignals = signals(null)
    render(feedback(false))
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: '3 · Neutral' }))
    fireEvent.click(screen.getByRole('button', { name: 'Record rating' }))
    await settle()
    const sent = dm.callsOf('recordHumanFeedback').map((call) => call.input as { target: unknown; feedback: unknown })
    expect(sent.map((input) => [input.target, input.feedback])).toEqual([[{ epicId: 'ep_1', sprintId: 'sp_1', runId: 'rn_1' }, { kind: 'rating', value: 3, sharedWithTickets: false }]])
    expect(recorded).toBe(1)
    expect(dm.callsOf('getSpaceSignals')).toHaveLength(2)
  })
})

describe('DM-183 c1: a new sprint rating and a frozen scorecard', () => {
  it('a frozen scorecard says a new rating never changes it', async () => {
    dm.responses.getSpaceSignals = signals(null)
    render(feedback(true))
    await settle()
    expect(screen.getByText('The scorecard above was frozen with the report: a rating recorded now never changes it. It shows in a later reassessment.')).toBeTruthy()
  })

  it('a live scorecard has no frozen note', async () => {
    dm.responses.getSpaceSignals = signals(null)
    render(feedback(false))
    await settle()
    expect(screen.queryByText(/frozen with the report/)).toBeNull()
  })
})
