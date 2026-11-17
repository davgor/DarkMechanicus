// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { EpicDetailView } from '../../../shared/domain/views'
import { settle } from '../__mocks__/settle'
import { installDomShims } from './__mocks__/domShims'
import { changeAnswers, epicWorldBackend } from './__mocks__/epicScorecardBackend'
import type { FakeBackend } from './__mocks__/fakeBackend'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(cleanup)

type World = 'epicActive' | 'epicCompleted'

async function openScorecard(backend: FakeBackend): Promise<void> {
  renderWorkspace(backend)
  await settle()
  fireEvent.click(await screen.findByRole('button', { name: 'Scorecard' }))
  await settle()
}

/** The world with the workspace showing the world's own run and saved plan, so its tickets and attempts open here. */
async function withWorldRun(key: World, epic: Partial<EpicDetailView> = {}): Promise<FakeBackend> {
  const backend = epicWorldBackend(key, epic)
  const runId = key === 'epicActive' ? 'rn_00000000000000000000000003' : 'rn_00000000000000000000000005'
  const run = await backend.runner('getRun', { runId })
  if (run === null) throw new Error('the world holds its run')
  const plan = await backend.runner('getPlan', { epicId: 'ep_1', view: 'saved', revisionId: run.revisionId })
  changeAnswers(backend, 'getRun', (output, input) => ('epicId' in input ? run : output))
  changeAnswers(backend, 'getPlan', (output, input) => (input.view === 'saved' && input.revisionId === undefined ? plan : output))
  return backend
}

const region = (name: string): HTMLElement => screen.getByRole('region', { name })
const facts = (label: string): string => screen.getByLabelText(label).textContent ?? ''

describe('an ungraded completed epic', () => {
  it('a final report from before scorecards: ungraded, its sprint legacy, nothing compared, cut off at its submission', async () => {
    const backend = epicWorldBackend('epicCompleted')
    changeAnswers(backend, 'getReportScorecard', (output) => ({ state: 'legacy', report: output.report, reason: 'Submitted before scorecards.' }))
    await openScorecard(backend)
    expect(screen.getByText('Ungraded')).toBeTruthy()
    expect(screen.getByText(/^Ungraded \(legacy\): Submitted before scorecards\. The epic is completed and read-only/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Grade' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Original scope and outcomes' })).toBeNull()
    expect(region('Total resources').textContent).toContain('No graded totals: nothing was frozen for this epic.')
    expect(region('Comparisons').textContent).toContain('The final report predates scorecards: there is no frozen grade to compare.')
    const toggle = within(region('Sprints')).getByRole('button', { name: /^Sprint 1/ })
    expect(toggle.textContent).toContain('ungraded · its report predates scorecards (legacy)')
    fireEvent.click(toggle)
    expect(within(region('Sprints')).getByRole('region', { name: 'Sprint 1 of Run #2' }).textContent).toBe('Submitted before scorecards. No grade stands in for it.')
    expect(screen.getByLabelText('Data freshness').querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-15T09:48:00.000Z')
  })

  it('an epic no run executed: not graded, no run, nothing to compare', async () => {
    const backend = epicWorldBackend('epicCompleted')
    changeAnswers(backend, 'getRun', (output, input) => ('epicId' in input ? null : output))
    await openScorecard(backend)
    expect(screen.getByText(/^Not graded: No run executed this epic, so no grade was ever frozen for it\./)).toBeTruthy()
    expect(region('Sprints').textContent).toContain('No run has executed this epic yet.')
    expect(facts('Wall time')).toBe('Wall timeunavailable (no run)')
    expect(region('Comparisons').textContent).toContain('No epic grade was frozen, so there is nothing to compare.')
    expect(screen.queryByRole('region', { name: 'High-impact failure causes' })).toBeNull()
  })

  it('an epic with no saved plan reads nothing and says so', async () => {
    const backend = epicWorldBackend('epicActive', { currentRevisionId: null, currentRevisionNumber: null })
    await openScorecard(backend)
    expect(screen.getByText('No saved plan yet: nothing is graded until a plan is saved and a run dispatches its tickets.')).toBeTruthy()
    expect(backend.names()).not.toContain('getEpicGrade')
  })
})

describe('a live epic', () => {
  it('names no run yet when the grade covers none', async () => {
    const backend = epicWorldBackend('epicActive')
    changeAnswers(backend, 'getEpicGrade', (output) => ({ ...output, runIds: [], measuredRunIds: [] }))
    await openScorecard(backend)
    expect(screen.getByText(/^Live: the epic graded now from every run's records \(no run yet\)/)).toBeTruthy()
    expect(region('Sprints').textContent).toContain('No run has executed this epic yet.')
  })

  it('opens a ticket the plan shown holds from its outcome, and an attempt and a ticket from the evidence', async () => {
    const backend = await withWorldRun('epicActive')
    await openScorecard(backend)
    fireEvent.click(within(region('Original scope and outcomes')).getByRole('button', { name: 'DM-1 Ticket 1' }))
    await settle()
    expect(backend.inputs('getTicket').at(-1)).toMatchObject({ ticketId: 'tk_000000000000000000000000z9' })
    const breakdown = screen.getByRole('region', { name: 'Component breakdown' })
    fireEvent.click(within(breakdown).getAllByRole('button', { name: /^ticket tk_000000000000000000000000zd .* → ticket$/ })[0] as HTMLElement)
    await settle()
    expect(backend.inputs('getTicket').at(-1)).toMatchObject({ ticketId: 'tk_000000000000000000000000zd' })
    fireEvent.click(within(breakdown).getAllByRole('button', { name: /^attempt at_00000000000000000000000006 .*→ Activity$/ })[0] as HTMLElement)
    await settle()
    expect(backend.inputs('getTicket').at(-1)).toMatchObject({ ticketId: 'tk_000000000000000000000000za' })
  })
})

describe('reads that fail on their own', () => {
  it('shows a failed timing and sprint read beside the rest, and Try again reads the card afresh', async () => {
    const backend = epicWorldBackend('epicActive')
    backend.fail('getRunTiming', 'internal', 'The timing projection was busy.')
    backend.fail('getSprintReport', 'internal', 'The report store was busy.')
    await openScorecard(backend)
    const resources = region('Total resources')
    expect(within(resources).getByRole('alert').textContent).toContain('The timing projection was busy.')
    expect(screen.queryByLabelText('Run #1 timing')).toBeNull()
    const toggle = within(region('Sprints')).getByRole('button', { name: /^Sprint 1/ })
    expect(toggle.textContent).toContain('read failed')
    fireEvent.click(toggle)
    const detail = within(region('Sprints')).getByRole('region', { name: 'Sprint 1 of Run #1' })
    expect(within(detail).getByRole('alert').textContent).toContain('The report store was busy.')
    fireEvent.click(within(detail).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(backend.names().filter((name) => name === 'getEpicGrade')).toHaveLength(2)
    expect(within(region('Sprints')).getByRole('button', { name: /^Sprint 1/ }).textContent).toContain('frozen with report revision 1')
    expect(facts('Run #1 timing')).toContain('Window (start → end)')
  })

  it('names a run that could not be read in the sprints and the resources', async () => {
    const backend = epicWorldBackend('epicCompleted')
    const gone = 'rn_00000000000000000000000003'
    changeAnswers(backend, 'getRun', (output, input) => {
      if ('runId' in input && input.runId === gone) throw new Error(`Run ${gone} is gone.`)
      return output
    })
    await openScorecard(backend)
    const sprints = region('Sprints')
    expect(within(sprints).getByRole('heading', { name: `Run ${gone}` })).toBeTruthy()
    expect(within(sprints).getByRole('alert').textContent).toBe(`Run ${gone} is gone. It does not exist in this folder.`)
    expect(within(region('Total resources')).getByRole('heading', { name: `Run ${gone}` })).toBeTruthy()
    expect(facts(`Run ${gone} usage`)).toBe('Tokens18,000 tokensActive time12 minEffort12 minRetried attempts0')
    expect(screen.queryByLabelText(`Run ${gone} timing`)).toBeNull()
  })

  it('shows a sprint without a goal by its number, and an unreported sprint as never assessed', async () => {
    const backend = epicWorldBackend('epicCompleted')
    changeAnswers(backend, 'getPlan', (output) => ({ ...output, bundle: { ...output.bundle, sprints: output.bundle.sprints.map((sprint) => ({ ...sprint, goal: '' })) } }))
    await openScorecard(backend)
    const sprints = region('Sprints')
    const [first] = within(sprints).getAllByRole('button', { name: /^Sprint 1/ })
    if (first === undefined) throw new Error('Run #1 lists its sprint')
    expect(first.querySelector('strong')?.textContent).toBe('Sprint 1')
    expect(first.textContent).toContain('not assessed · no report was submitted')
    fireEvent.click(first)
    expect(within(sprints).getByRole('region', { name: 'Sprint 1 of Run #1' }).textContent).toBe('Nothing was assessed for this sprint.')
  })
})

describe('the frozen grade against the records now', () => {
  it('shows a failed reassessment read as an error', async () => {
    const backend = epicWorldBackend('epicCompleted')
    backend.fail('reassessReportScorecard', 'internal', 'The reassessment timed out.')
    await openScorecard(backend)
    expect(within(region('Comparisons')).getByRole('alert').textContent).toContain('The reassessment timed out.')
  })

  it('says so when the reassessment holds no epic grade', async () => {
    const backend = epicWorldBackend('epicCompleted')
    changeAnswers(backend, 'reassessReportScorecard', (output) => ({ ...output, subjects: output.subjects.filter((subject) => subject.subject.level !== 'epic') }))
    await openScorecard(backend)
    expect(region('Comparisons').textContent).toContain('The reassessment holds no epic grade.')
  })

  it('lists each component that differs, with its causes, when the readings are comparable', async () => {
    const backend = epicWorldBackend('epicCompleted')
    const difference = { component: 'K' as const, approved: null, sameWindow: null, current: null, causes: ['later_records' as const, 'policy_changed' as const], detail: 'K 80 → 70' }
    changeAnswers(backend, 'reassessReportScorecard', (output) => ({
      ...output,
      subjects: output.subjects.map((subject) => (subject.subject.level === 'epic' ? { ...subject, differences: [difference] } : subject))
    }))
    await openScorecard(backend)
    expect(within(region('Comparisons')).getByRole('list', { name: 'Differences' }).textContent).toBe('K K 80 → 70 (later records, policy changed)')
  })
})
