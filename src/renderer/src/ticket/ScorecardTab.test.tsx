// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, type RenderResult, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AttemptUsageView } from '../../../shared/domain/metrics'
import type { EvidenceRef } from '../../../shared/domain/space'
import type { TicketGradeView } from '../../../shared/domain/spaceGrades'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import {
  attemptUsage,
  attemptView,
  baseline,
  component,
  CUTOFF,
  EPIC,
  FOLDER,
  RUN_1,
  RUN_2,
  spaceGrade,
  subjectReassessment,
  TICKET_A,
  TICKET_B,
  ticketGrade,
  ticketTiming,
  tokenCell
} from '../__mocks__/ticketScorecardFixtures'
import { localTime } from '../scorecard/scorecardFormat'
import type { EvidenceOpener } from '../scorecard/ScorecardParts'
import { ScorecardTab, type ScorecardTabProps } from './ScorecardTab'

let dm: FakeDm
let opened: EvidenceRef[]

/** Opens attempts in Attempts and observations in Evidence; any other record has no view here. */
function opener(): EvidenceOpener {
  return {
    target: (ref) => (ref.kind === 'attempt' ? 'Attempts' : ref.kind === 'observation' ? 'Evidence' : null),
    open: (ref) => {
      opened.push(ref)
    }
  }
}

interface World {
  grades: Map<string, TicketGradeView>
  attempts: { attemptId: string; elapsedMs: number | null; activeMs: number | null }[]
  usage: AttemptUsageView[]
  report: { id: string; reportRevision: number } | null
  reassessment: unknown
}

function serve(world: World): void {
  dm.handlers.getTicketGrade = (input) => {
    const { runId, ticketId } = input as { runId: string; ticketId: string }
    return world.grades.get(`${runId}:${ticketId}`)
  }
  dm.handlers.getRunTiming = () => ({ tickets: [...new Set([...world.grades.values()].map((grade) => grade.ticketId))].map((id) => ticketTiming(id, world.attempts)) })
  dm.handlers.getRunMetrics = () => ({ attempts: world.usage })
  dm.handlers.getSprintReport = () => world.report
  dm.handlers.reassessReportScorecard = () => world.reassessment
  dm.handlers.getRun = (input) => {
    const { runId } = input as { runId: string }
    return { id: runId, number: runId === RUN_1 ? 1 : 2 }
  }
}

function world(grade: TicketGradeView = ticketGrade()): World {
  return {
    grades: new Map([[`${grade.runId}:${grade.ticketId}`, grade]]),
    attempts: [{ attemptId: 'at_1', elapsedMs: 900_000, activeMs: 750_000 }],
    usage: [attemptUsage('at_1', TICKET_A, tokenCell(42_000))],
    report: null,
    reassessment: null
  }
}

function props(patch: Partial<ScorecardTabProps> = {}): ScorecardTabProps {
  return {
    folderPath: FOLDER,
    epicId: EPIC,
    ticketId: TICKET_A,
    attempts: [attemptView('at_1', RUN_1, '2026-03-02T09:00:00.000Z')],
    runId: null,
    onChooseRun: () => undefined,
    scheduler: new ManualScheduler(),
    reloadKey: 0,
    opener: opener(),
    ...patch
  }
}

async function show(patch: Partial<ScorecardTabProps> = {}): Promise<RenderResult> {
  const view = render(<ScorecardTab {...props(patch)} />)
  await settle()
  return view
}

const section = (label: string): HTMLElement => screen.getByRole('region', { name: label })

/** The value beside a fact's label in the named facts list. */
function fact(list: string, label: string): string {
  const facts = screen.getAllByLabelText(list).filter((element) => element.tagName === 'DL')
  expect(facts).toHaveLength(1)
  const term = within(facts[0] as HTMLElement).getByText(label, { selector: 'dt' })
  return term.nextElementSibling?.textContent ?? ''
}

beforeEach(() => {
  dm = new FakeDm()
  opened = []
  window.dm = dm
})

afterEach(cleanup)

describe('DM-180 c1: grade state, coverage, versions and contributions', () => {
  it('shows a final grade with coverage, policy version and each factor contribution', async () => {
    const K = component('K', { explanation: { normalization: 'K normalized', cutoff: CUTOFF, baseline: baseline(), caps: [] } })
    serve(world(ticketGrade({ grade: spaceGrade({ components: [...spaceGrade().components.slice(0, 6), K] }) })))
    await show()
    const headline = section('Grade')
    expect(within(headline).getByLabelText('Letter B').textContent).toBe('B')
    expect(within(headline).getByText('Final')).toBeTruthy()
    expect(within(headline).getByText('Score 80.0')).toBeTruthy()
    expect(within(headline).getByText('Coverage 100.0% of base weight · 7 of 7 components scored')).toBeTruthy()
    expect(within(headline).getByText('Policy balanced v2 · 0123456789ab').getAttribute('title')).toBe('sha256:0123456789abcdef0123')
    const tokens = screen.getByRole('listitem', { name: 'Token efficiency' })
    expect(within(tokens).getByText(`Baseline bl_tokens: budget v3: 50,000 tokens, frozen ${localTime('2026-03-01T09:00:00.000Z')}`)).toBeTruthy()
    expect(tokens.textContent).toContain('80.0 × weight 14.3% = 11.4 points')
  })

  it('review fix 1: says points are rounded to add up, so identical components may differ by 0.1', async () => {
    serve(world())
    await show()
    const breakdown = section('Component breakdown')
    expect(
      within(breakdown).getByText(
        'Each component\'s points are rounded to one decimal so they add up to 80.0, the weighted mean of the scored components; components with the same score and weight may therefore differ by 0.1.'
      )
    ).toBeTruthy()
    const points = within(breakdown)
      .getAllByRole('listitem')
      .filter((item) => item.classList.contains('sc-component'))
      .map((item) => /= (\d+\.\d) points/.exec(item.textContent ?? '')?.[1])
    expect(points).toEqual(['11.5', '11.5', '11.4', '11.4', '11.4', '11.4', '11.4'])
  })

  it.each([
    ['provisional', { status: 'provisional', statusReasons: ['estimated_input'] }, 'Provisional'],
    ['ungraded', { status: 'ungraded', letter: null, displayScore: null, score: null, uncappedScore: null }, 'Ungraded'],
    ['in progress', { status: 'ungraded', statusReasons: ['verification_pending'], letter: null, displayScore: null, score: null, uncappedScore: null }, 'In progress · ungraded'],
    ['failed', { status: 'final', outcome: 'failed', statusReasons: ['mandatory_failure'], letter: 'F', displayScore: '59.0' }, 'Failed · final']
  ] as const)('shows a %s grade as %s', async (_name, patch, pill) => {
    serve(world(ticketGrade({ grade: spaceGrade(patch as never) })))
    await show()
    expect(within(section('Grade')).getByText(pill)).toBeTruthy()
  })

  it('shows a missing component as carrying no weight, never as 0 points', async () => {
    const S = component('S', { score: null, effectiveWeight: 0, state: 'missing', missingReason: 'no_rating' })
    serve(world(ticketGrade({ grade: spaceGrade({ coverage: 6 / 7, scoredComponents: 6, components: [S, ...spaceGrade().components.slice(1)] }) })))
    await show()
    const row = screen.getByRole('listitem', { name: 'Satisfaction' })
    expect(within(row).getByText('No score: no rating given or shared. Carries no weight (never read as 0).')).toBeTruthy()
    expect(within(section('Grade')).getByText('Coverage 85.7% of base weight · 6 of 7 components scored')).toBeTruthy()
  })
})

describe('DM-180 c2: units, attribution and unavailable values', () => {
  it('shows usage and time with units and the run they are attributed to', async () => {
    serve(world())
    await show()
    expect(section('Usage and time').textContent).toContain("Attributed to this ticket's attempts in Run #1")
    expect(fact('Usage', 'Tokens (K)')).toBe('42,000 tokens')
    expect(fact('Usage', 'Active time (T)')).toBe('12 min 30 s')
    expect(fact('Usage', 'Active time by others')).toBe('1 min 30 s')
    expect(fact('Time', 'Cycle time (first claim → end)')).toBe('1 h 00 min')
    expect(fact('Time', 'Wait: Build and test')).toBe('unavailable')
    expect(fact('Time', 'Effort by role (roles that reported)')).toBe('worker 12 min 30 s · reviewer 1 min 30 s')
  })

  it('reads values the core has no number for as unavailable, never 0', async () => {
    serve(world(ticketGrade({ tokens: { state: 'missing', reason: 'not_reported' }, tokensReported: null, time: { state: 'missing', reason: 'host_unavailable' }, overheadMs: null })))
    await show()
    expect(fact('Usage', 'Tokens (K)')).toBe('unavailable (not reported)')
    expect(fact('Usage', 'Tokens reported so far')).toBe('unavailable (nothing reported)')
    expect(fact('Usage', 'Active time (T)')).toBe('unavailable (the host cannot report it)')
    expect(fact('Usage', 'Active time by others')).toBe('unavailable (no review or orchestration span reported)')
  })

  it('reads an attempt with no usage cell as tokens unavailable', async () => {
    const w = world()
    w.usage = []
    serve(w)
    await show()
    expect(within(section('Attempts in this run')).getByText('elapsed 15 min · active 12 min 30 s · effort 10 min · tokens unavailable')).toBeTruthy()
  })

  it('opens the attempt a row names and the evidence a component cites', async () => {
    const P = component('P', { evidence: [{ kind: 'observation', id: 'ob_7', detail: 'check passed' }, { kind: 'commit', id: 'c0ffee', detail: null }] as EvidenceRef[] })
    const w = world(ticketGrade({ grade: spaceGrade({ components: [component('S'), P] }), attempts: [{ attemptId: 'at_1', number: 1, outcome: 'rejected', effortMs: 1000 }, { attemptId: 'at_2', number: 2, outcome: 'accepted', effortMs: 2000 }] }))
    serve(w)
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Attempt #2 · accepted' }))
    fireEvent.click(screen.getByRole('button', { name: 'observation ob_7 · check passed → Evidence' }))
    expect(opened).toEqual([
      { kind: 'attempt', id: 'at_2', detail: null },
      { kind: 'observation', id: 'ob_7', detail: 'check passed' }
    ])
    expect(screen.queryByRole('button', { name: /commit c0ffee/ })).toBeNull()
    expect(screen.getByTitle('Not viewable here').textContent).toBe('commit c0ffee')
  })
})

describe('DM-180 c3: legacy and multi-attempt tickets render without fabricated grades', () => {
  it('renders a legacy ticket ungraded with no invented original grade or effort', async () => {
    const legacy = ticketGrade({
      grade: spaceGrade({ status: 'ungraded', outcome: 'unverified', letter: null, displayScore: null, score: null, uncappedScore: null, coverage: 0, scoredComponents: 0, components: [] }),
      tokens: { state: 'missing', reason: 'not_reported' },
      classification: { denominator: { state: 'missing', reason: 'not_reported' }, observationIds: [], correctiveMs: null, productiveMs: null, unclassifiedMs: null }
    })
    const w = world(legacy)
    w.report = { id: 'rp_1', reportRevision: 1 }
    w.reassessment = { legacy: true, assessedAt: CUTOFF, subjects: [] }
    serve(w)
    await show()
    expect(within(section('Grade')).getByLabelText('No letter').textContent).toBe('—')
    expect(within(section('Grade')).getByText('No score')).toBeTruthy()
    const report = section('Original and reassessed grades')
    expect(within(report).getByText('This report predates scorecards: it stays ungraded, so there is no original grade to compare.')).toBeTruthy()
    expect(report.textContent).not.toContain('Original (frozen')
    expect(fact('Usage', 'Tokens (K)')).toBe('unavailable (not reported)')
    expect(fact('Corrective effort', 'Corrective effort (E, as classified)')).toBe('unavailable (no effort reported)')
    expect(fact('Corrective effort', 'Unclassified effort')).toBe('unavailable (no effort reported)')
  })

  it('lists every attempt of a multi-attempt ticket and offers each run it worked in', async () => {
    const grade = ticketGrade({ runId: RUN_2, attempts: [{ attemptId: 'at_1', number: 1, outcome: 'rejected', effortMs: 1000 }, { attemptId: 'at_2', number: 2, outcome: 'accepted', superseded: true, effortMs: null }] })
    serve(world(grade))
    await show({ attempts: [attemptView('at_0', RUN_1, '2026-03-01T09:00:00.000Z'), attemptView('at_2', RUN_2, '2026-03-03T09:00:00.000Z'), attemptView('at_cf', RUN_2, '2026-03-04T09:00:00.000Z', { kind: 'carry_forward' })] })
    const attempts = section('Attempts in this run')
    expect(within(attempts).getByText('ATTEMPTS IN THIS RUN (2)')).toBeTruthy()
    expect(within(attempts).getByRole('button', { name: 'Attempt #1 · rejected' })).toBeTruthy()
    expect(within(attempts).getByRole('button', { name: 'Attempt #2 · accepted · superseded' })).toBeTruthy()
    expect(within(attempts).getByText(/effort unavailable/)).toBeTruthy()
    const picker = screen.getByDisplayValue('Run #2 (latest)') as HTMLSelectElement
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual(['Run #2 (latest)', 'Run #1'])
    expect(picker.value).toBe(RUN_2)
  })
})

describe('DM-180 c3: switching ticket or run never shows stale data', () => {
  it('never shows the previous ticket while the next ticket\'s grade is still loading', async () => {
    const w = world()
    const other = ticketGrade({ ticketId: TICKET_B, grade: spaceGrade({ letter: 'D', displayScore: '61.2', status: 'provisional' }), tokens: { state: 'observed', value: 7_000 } })
    w.grades.set(`${RUN_1}:${TICKET_B}`, other)
    serve(w)
    const view = await show()
    expect(within(section('Grade')).getByText('Score 80.0')).toBeTruthy()
    const hold = dm.holdNext('getTicketGrade')
    view.rerender(<ScorecardTab {...props({ ticketId: TICKET_B })} />)
    await settle()
    expect(screen.queryByText('Score 80.0')).toBeNull()
    expect(screen.queryByText('42,000 tokens')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Loading the scorecard…')
    await act(async () => hold.resolve())
    await settle()
    expect(within(section('Grade')).getByText('Score 61.2')).toBeTruthy()
    expect(fact('Usage', 'Tokens (K)')).toBe('7,000 tokens')
  })

  it('never shows the previous run while the chosen run\'s grade is still loading', async () => {
    const w = world(ticketGrade({ runId: RUN_2 }))
    w.grades.set(`${RUN_1}:${TICKET_A}`, ticketGrade({ runId: RUN_1, grade: spaceGrade({ letter: 'C', displayScore: '72.0' }) }))
    serve(w)
    const attempts = [attemptView('at_0', RUN_1, '2026-03-01T09:00:00.000Z'), attemptView('at_1', RUN_2, '2026-03-03T09:00:00.000Z')]
    const view = await show({ attempts })
    expect(within(section('Grade')).getByText('Score 80.0')).toBeTruthy()
    const hold = dm.holdNext('getTicketGrade')
    view.rerender(<ScorecardTab {...props({ attempts, runId: RUN_1 })} />)
    await settle()
    expect(screen.queryByRole('region', { name: 'Grade' })).toBeNull()
    expect(screen.queryByText('Score 80.0')).toBeNull()
    await act(async () => hold.resolve())
    await settle()
    expect(within(section('Grade')).getByText('Score 72.0')).toBeTruthy()
  })
})

describe('review fixes: attempts, timing failure, classification and windows', () => {
  it('fix 2: states the usage read time once for the section, not on every attempt row', async () => {
    const w = world(ticketGrade({ attempts: [{ attemptId: 'at_1', number: 1, outcome: 'rejected', effortMs: 1000 }, { attemptId: 'at_2', number: 2, outcome: 'accepted', effortMs: 2000 }] }))
    w.usage = [attemptUsage('at_1', TICKET_A, tokenCell(10)), attemptUsage('at_2', TICKET_A, tokenCell(20))]
    serve(w)
    await show()
    const text = section('Attempts in this run').textContent ?? ''
    expect(text.match(/as of/g)).toHaveLength(1)
    expect(text).toMatch(/Tokens as of .+, from the run's usage table when this was read\./)
    expect(within(section('Attempts in this run')).getByText('elapsed 15 min · active 12 min 30 s · effort 1 s · tokens 10 tokens')).toBeTruthy()
  })

  it('fix 3: shows a failed timing read once, under Usage and time; Attempts says the times are unavailable', async () => {
    serve(world())
    dm.failures.getRunTiming = { code: 'internal', message: 'timing store locked' }
    await show()
    const alerts = screen.getAllByRole('alert')
    expect(alerts.map((alert) => alert.textContent)).toEqual(['timing store locked It may work if you try again.Try again'])
    expect(section('Usage and time').contains(alerts[0] ?? null)).toBe(true)
    const attempts = section('Attempts in this run')
    expect(within(attempts).getByText('Elapsed and active time per attempt are unavailable: the timing read failed (see Usage and time).')).toBeTruthy()
    expect(within(attempts).getByText(/^elapsed unavailable · active unavailable · effort 10 min · tokens 42,000 tokens$/)).toBeTruthy()
  })

  it('fix 4: shows as-classified effort when effort is unreported but a classification record exists', async () => {
    serve(world(ticketGrade({ classification: { denominator: { state: 'missing', reason: 'not_reported' }, observationIds: ['ob_c'], correctiveMs: 0, productiveMs: 120_000, unclassifiedMs: null } })))
    await show()
    expect(fact('Corrective effort', 'Corrective effort (E, as classified)')).toBe('0 ms')
    expect(fact('Corrective effort', 'Productive effort (as classified)')).toBe('2 min')
    expect(fact('Corrective effort', 'Unclassified effort')).toBe('unavailable')
    expect(fact('Corrective effort', 'Corrective by cause')).toBe('none classified')
  })

  it('fix 5: shows the report windows in local time, not the core\'s raw ISO note', async () => {
    const w = world()
    w.report = { id: 'rp_1', reportRevision: 3 }
    w.reassessment = { legacy: false, assessedAt: CUTOFF, subjects: [subjectReassessment()] }
    serve(w)
    await show()
    const windows = fact('Original and reassessed grades', 'Windows')
    expect(windows).toBe(
      `both windows start at the first dispatch (${localTime('2026-03-02T09:00:00.000Z')}); the current one runs ${localTime('2026-03-03T09:00:00.000Z')} → ${localTime(CUTOFF)} longer`
    )
    expect(windows).not.toMatch(/\d{4}-\d\d-\d\dT/)
    expect(fact('Original and reassessed grades', `Original (frozen ${localTime('2026-03-03T09:00:00.000Z')})`)).toBe('B 81.0 (final)')
    expect(fact('Original and reassessed grades', `Reassessed (${localTime(CUTOFF)})`)).toBe('C 74.2 (provisional)')
  })
})

describe('runs, refreshes and the person\'s own rating', () => {
  it('a ticket no run has dispatched has no scorecard and reads nothing', async () => {
    serve(world())
    await show({ attempts: [] })
    expect(screen.getByText('No run has worked on this ticket yet, so it has no scorecard: nothing is graded before a run dispatches it.')).toBeTruthy()
    expect(dm.callsOf('getTicketGrade')).toHaveLength(0)
    expect(dm.callsOf('getRun')).toHaveLength(0)
  })

  it('choosing another run in the picker asks for that run', async () => {
    const chosen: string[] = []
    serve(world(ticketGrade({ runId: RUN_2 })))
    await show({ attempts: [attemptView('at_0', RUN_1, '2026-03-01T09:00:00.000Z'), attemptView('at_1', RUN_2, '2026-03-03T09:00:00.000Z')], onChooseRun: (runId) => chosen.push(runId) })
    fireEvent.change(screen.getByDisplayValue('Run #2 (latest)'), { target: { value: RUN_1 } })
    expect(chosen).toEqual([RUN_1])
  })

  it('names a run by its id when its number cannot be read', async () => {
    serve(world())
    dm.failures.getRun = { code: 'internal', message: 'run store locked' }
    await show()
    expect(section('Usage and time').textContent).toContain(`Attributed to this ticket's attempts in Run ${RUN_1} through`)
  })

  it('lists the read anomalies the grade reports', async () => {
    serve(world({ ...ticketGrade(), anomalies: [{ kind: 'dispatch_mismatch', detail: 'at_9 was dispatched by another run' }] }))
    await show()
    expect(within(screen.getByRole('list', { name: 'Read anomalies' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['at_9 was dispatched by another run'])
  })

  it('shows the ticket\'s own recorded rating as the chosen one', async () => {
    const grade = ticketGrade()
    const S = { ...grade.sources.signals.S, input: { ticketRating: { observationId: 'ob_r', source: 'human' as const, value: 4 }, sprintRating: null } }
    serve(world({ ...grade, sources: { ...grade.sources, signals: { ...grade.sources.signals, S } } }))
    await show()
    expect(within(screen.getByRole('group', { name: 'Rate this ticket' })).getByRole('radio', { name: '4 · Satisfied' })).toHaveProperty('checked', true)
  })

  it('Refresh and a workspace reload each read the grade again in place', async () => {
    const w = world()
    serve(w)
    const view = await show()
    w.grades.set(`${RUN_1}:${TICKET_A}`, ticketGrade({ grade: spaceGrade({ displayScore: '70.0' }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await settle()
    expect(within(section('Grade')).getByText('Score 70.0')).toBeTruthy()
    w.grades.set(`${RUN_1}:${TICKET_A}`, ticketGrade({ grade: spaceGrade({ displayScore: '65.0' }) }))
    view.rerender(<ScorecardTab {...props({ reloadKey: 1 })} />)
    await settle()
    expect(within(section('Grade')).getByText('Score 65.0')).toBeTruthy()
    expect(dm.callsOf('getTicketGrade')).toHaveLength(3)
  })
})
