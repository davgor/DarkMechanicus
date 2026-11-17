import { describe, expect, it } from 'vitest'
import type { RequiredOutcome } from '../../../shared/domain/spaceGrades'
import type { TimingQuantity } from '../../../shared/domain/timing'
import { replay, reportCardIdentity, type WorldName, world } from '../__mocks__/scorecardWorlds'
import { loadScore, type ReportCardView } from '../scorecard/scoreReads'
import { localTime } from '../scorecard/scorecardFormat'
import {
  coverageRows,
  failureCauses,
  modeView,
  outcomeConclusion,
  overheadRows,
  resourceRows,
  type SprintCard,
  sprintCard,
  subjectRows,
  ticketFacts,
  ticketNames,
  ticketTimeRows,
  timeRows
} from './reportScorecardView'

type Rows = ReadonlyArray<{ label: string; value: unknown }>
type Frozen = Extract<ReportCardView, { state: 'frozen' }>
type Live = Extract<ReportCardView, { state: 'live' }>

const value = (rows: Rows, label: string): string => String(rows.find((row) => row.label === label)?.value)
const NO_NAMES = ticketNames(null)
const EFFORT = 'Effort reported'
const RUN_OVERHEAD = 'Run overhead in the sprint’s window (no ticket’s)'

async function viewOf(key: Extract<WorldName, `report${string}`>): Promise<ReportCardView> {
  const recording = world(key)
  return loadScore(replay(recording.calls), reportCardIdentity(recording))
}

async function frozenView(key: 'reportApproved' | 'reportCheckout'): Promise<Frozen> {
  const view = await viewOf(key)
  if (view.state !== 'frozen') throw new Error('the report is frozen')
  return view
}

async function liveView(): Promise<Live> {
  const view = await viewOf('reportLive')
  if (view.state !== 'live') throw new Error('the sprint has no report')
  return view
}

function cardOf(view: ReportCardView): SprintCard {
  const card = sprintCard(view)
  if (card === null) throw new Error('the world sprint is graded')
  return card
}

function quantity(ms: number | null, state: TimingQuantity['state'], coverage: TimingQuantity['coverage'], open = false): TimingQuantity {
  return { quantity: 'resource_effort', unit: 'milliseconds', aggregation: 'sum', ms, state, coverage, open }
}

function outcome(ticketId: string, role: RequiredOutcome['role'], state: RequiredOutcome['state']): RequiredOutcome {
  return { runId: 'rn_1', ticketId, role, state, reason: state === 'verified' ? 'reviewed' : 'awaiting_review', attemptId: null, movedOut: false, counted: true }
}

describe('a legacy report and the frozen inputs it cannot read', () => {
  it('says a legacy report stays ungraded and shows no sprint card for it', async () => {
    const { report } = await frozenView('reportApproved')
    const legacy = { state: 'legacy' as const, report, reason: 'The report was submitted before scorecards.' }
    expect(modeView(legacy, 'approved')).toEqual({
      label: 'Ungraded (legacy)',
      tone: 'neutral',
      note: 'The report was submitted before scorecards. This report revision 1 stays ungraded: no live grade stands in for it. A reassessment below grades its scope only as a separate, dated reading.'
    })
    expect(sprintCard(legacy)).toBeNull()
  })

  it('reads a frozen input that is absent as unavailable, and drops a ticket whose grade is gone', async () => {
    const view = await frozenView('reportCheckout')
    const { snapshot } = view.scorecard
    const { C, E } = snapshot.sprint.inputs
    const inputs = Object.fromEntries(Object.entries(snapshot.inputs).filter(([hash]) => hash !== C && hash !== E))
    const tickets = view.scorecard.tickets.slice(1)
    const card = cardOf({ ...view, scorecard: { ...view.scorecard, tickets, snapshot: { ...snapshot, inputs } } })
    expect(card.inputs.C).toBeNull()
    expect(value(resourceRows(card), 'Corrective effort (E)')).toBe('unavailable')
    expect(value(resourceRows(card), 'Productive effort')).toBe('unavailable')
    expect(failureCauses(card).map((cause) => cause.text).join(' ')).not.toContain('rejected in review')
    expect(card.tickets.map((ticket) => ticket.ticketId)).toEqual(tickets.map((grade) => grade.subject.id))
  })

  it('leaves a frozen ticket without outcome and times when the snapshot holds none for it', async () => {
    const view = await frozenView('reportCheckout')
    const { snapshot } = view.scorecard
    const detail = { ...view.scorecard.sprint.detail, outcomes: [] }
    const scorecard = { ...view.scorecard, sprint: { ...view.scorecard.sprint, detail }, snapshot: { ...snapshot, timing: { ...snapshot.timing, tickets: [] } } }
    const [first] = cardOf({ ...view, scorecard }).tickets
    expect(first?.outcome).toBeNull()
    expect(ticketTimeRows(first?.times ?? null, null)).toEqual([{ label: 'Times', value: 'unavailable (the timing holds no entry for this ticket)' }])
  })
})

describe('a live sprint whose timing is partial or failed', () => {
  it('reads every timing row as unavailable when the timing read failed', async () => {
    const live = await liveView()
    const card = cardOf({ ...live, timing: { ok: false, error: { code: 'unexpected', message: 'the app was busy', action: 'retry' } } })
    const coverage = coverageRows(card, NO_NAMES)
    expect(value(coverage, 'Timing anomalies')).toBe('unavailable (timing read failed)')
    expect(value(coverage, EFFORT)).toBe('unavailable')
    expect(value(overheadRows(card, NO_NAMES), RUN_OVERHEAD)).toBe('unavailable')
    expect(card.tickets.every((ticket) => ticket.times === null)).toBe(true)
  })

  it('reads the sprint window as unavailable when the timing holds no window for the sprint', async () => {
    const live = await liveView()
    if (!live.timing.ok) throw new Error('the live timing reads')
    const card = cardOf({ ...live, timing: { ok: true, value: { ...live.timing.value, sprints: [] } } })
    if (!card.timing.ok) throw new Error('the timing stays read')
    expect(timeRows(card.timing.value)).toEqual([{ label: 'Sprint window', value: 'unavailable (the timing holds no window for this sprint)' }])
    expect(value(coverageRows(card, NO_NAMES), EFFORT)).toBe('unavailable')
    expect(value(overheadRows(card, NO_NAMES), RUN_OVERHEAD)).toBe('unavailable')
  })

  it('keeps a live ticket without an outcome or a timing entry, and a source without a measured run id', async () => {
    const live = await liveView()
    if (!live.timing.ok) throw new Error('the live timing reads')
    const sprint = { ...live.sprint, outcomes: [], measuredRunIds: [] }
    const card = cardOf({ ...live, sprint, timing: { ok: true, value: { ...live.timing.value, tickets: live.timing.value.tickets.slice(1) } } })
    expect(card.tickets.map((ticket) => [ticket.outcome, ticket.times === null])).toEqual([[null, true], [null, false], [null, false]])
    expect(card.measures.map((measure) => measure.runId)).toEqual([''])
  })
})

describe('the sprint outcome in words', () => {
  it('falls back to the failed mandatory check, says when nothing is open, and confirms a verified sprint', async () => {
    const card = cardOf(await frozenView('reportCheckout'))
    const outcomes = [outcome('tk_a', 'work', 'verified')]
    const as = (state: SprintCard['sprint']['outcome']): SprintCard => ({ ...card, outcomes, sprint: { ...card.sprint, outcome: state } })
    expect(outcomeConclusion(as('failed'), NO_NAMES)).toBe('1 of 1 feature ticket(s) verified, yet the sprint failed: a mandatory check failed. A confirmed failure of a required or integrated outcome caps the grade at F.')
    expect(outcomeConclusion(as('unverified'), NO_NAMES)).toBe('1 of 1 feature ticket(s) verified, but the sprint is not verified.')
    expect(outcomeConclusion(as('verified'), NO_NAMES)).toBe('1 of 1 feature ticket(s) verified: every counted outcome, integrated ones included, is verified.')
  })
})

describe('resources summed over the measured runs', () => {
  it('keeps both qualifiers on a run sum that is estimated and misses an attempt', async () => {
    const card = cardOf(await frozenView('reportCheckout'))
    const measures = card.measures.map((measure) => ({ ...measure, tokens: { ...measure.tokens, actual: { state: 'estimated' as const, value: 48_000, method: 'host estimate' } } }))
    const rows = resourceRows({ ...card, measures, inputs: { ...card.inputs, K: null } })
    expect(value(rows, 'Tokens (K actual, overhead included)')).toBe('≥ ≈ 48,000 tokens (a lower bound, estimated in part: 1 attempt(s) reported nothing)')
  })

  it('reads effort, overhead and retries as unavailable when one of two runs reports none of it', async () => {
    const card = cardOf(await frozenView('reportApproved'))
    const [base] = card.measures
    if (base === undefined) throw new Error('the approved sprint measured a run')
    const run: SprintCard['measures'][number] = { ...base, effort: { ...base.effort, effortMs: 60_000, overheadMs: 30_000, coverage: { ...base.effort.coverage, covered: 1, of: 1 } }, retries: 1 }
    const rowsWith = (other: SprintCard['measures'][number]): Rows => resourceRows({ ...card, measures: [run, { ...other, runId: 'rn_other' }] })
    const labels = ['Effort (every actor, summed)', 'Overhead (orchestration, review)', 'Retries (a diagnostic, never waste)']
    const read = (rows: Rows): string[] => labels.map((label) => value(rows, label))
    expect(read(rowsWith(run))).toEqual(['2 min', '1 min', '2'])
    expect(read(rowsWith({ ...run, effort: { ...run.effort, effortMs: null } }))).toEqual(['unavailable (no effort reported)', '1 min', '2'])
    expect(read(rowsWith({ ...run, effort: { ...run.effort, overheadMs: null } }))).toEqual(['2 min', 'unavailable (no review or orchestration span reported)', '2'])
    expect(read(rowsWith({ ...run, retries: null }))).toEqual(['2 min', '1 min', 'unavailable'])
  })

  it('adds up the reported overhead, and reads retries as unavailable when a run has none', async () => {
    const card = cardOf(await frozenView('reportApproved'))
    const measures = card.measures.flatMap((measure) => [
      { ...measure, effort: { ...measure.effort, overheadMs: 120_000 } },
      { ...measure, runId: 'rn_other', effort: { ...measure.effort, overheadMs: 30_000 }, retries: null }
    ])
    const rows = resourceRows({ ...card, measures })
    expect(value(rows, 'Overhead (orchestration, review)')).toBe('2 min 30 s')
    expect(value(rows, 'Retries (a diagnostic, never waste)')).toBe('unavailable')
    expect(value(overheadRows({ ...card, measures }, NO_NAMES), 'Orchestration and review effort')).toBe('2 min 30 s')
  })

  it('reads a ticket’s tokens as unavailable when its grade holds no K input', async () => {
    const [ticket] = cardOf(await frozenView('reportApproved')).tickets
    if (ticket === undefined) throw new Error('the approved sprint graded a ticket')
    expect(ticketFacts({ ...ticket, inputs: { ...ticket.inputs, K: null } })[1]).toBe('tokens unavailable')
  })
})

describe('measurement coverage of the sprint', () => {
  async function withEffort(effort: TimingQuantity): Promise<string> {
    const card = cardOf(await frozenView('reportCheckout'))
    if (!card.timing.ok || card.timing.value.sprint === null) throw new Error('the checkout timing holds the sprint')
    const timing = { ...card.timing.value, sprint: { ...card.timing.value.sprint, effort } }
    return value(coverageRows({ ...card, timing: { ok: true, value: timing } }, NO_NAMES), EFFORT)
  }

  it('reads effort coverage as nothing reported, or as the share of the window classified', async () => {
    expect(await withEffort(quantity(null, 'missing', { covered: 0, of: 3, unit: 'attempts' }))).toBe('unavailable (nothing reported)')
    expect(await withEffort(quantity(900_000, 'partial', { covered: 450_000, of: 900_000, unit: 'milliseconds' }))).toBe('50.0% of the window classified')
    expect(await withEffort(quantity(0, 'observed', { covered: 0, of: 0, unit: 'milliseconds' }))).toBe('0.0% of the window classified')
  })

  it('names a partial roll-up’s uncovered tickets and an unscored component by its state', async () => {
    const card = cardOf(await frozenView('reportCheckout'))
    const T = { baseline: true, partial: true, overhead: [], uncovered: [{ runId: 'rn_1', ticketId: 'tk_x' }] }
    const components = card.sprint.components.map((component) => (component.component === 'P' ? { ...component, score: null } : component))
    const rows = coverageRows({ ...card, rollups: { ...card.rollups, T }, sprint: { ...card.sprint, components } }, NO_NAMES)
    expect(value(rows, 'T baseline roll-up')).toBe('partial: some executed work ticket has no baseline (tk_x); its cost is left out of the comparison')
    expect(value(rows, 'Components without a score')).toBe('S (no rating given or shared) · P (observed) · E (only partly reported) · T (some attempts reported nothing) · K (some attempts reported nothing)')
  })

  it('says no component lacks a score when every one was scored', async () => {
    const card = cardOf(await frozenView('reportCheckout'))
    const components = card.sprint.components.map((component) => ({ ...component, score: component.score ?? 50 }))
    expect(value(coverageRows({ ...card, sprint: { ...card.sprint, components } }, NO_NAMES), 'Components without a score')).toBe('none')
  })
})

describe('collaboration and corrective effort among the failure causes', () => {
  it('lists failed handoff checks, coordination defects and corrective effort after the rejections', async () => {
    const card = cardOf(await frozenView('reportCheckout'))
    const { C, E } = card.inputs
    if (C === null || E === null) throw new Error('the checkout grade read C and E')
    const inputs = { ...card.inputs, C: { ...C, handoffChecks: { passed: 1, failed: 2 }, coordinationDefects: 1 }, E: { ...E, correctiveMs: { state: 'observed' as const, value: 90_000 } } }
    const texts = failureCauses({ ...card, inputs, outcomes: [], sprint: { ...card.sprint, statusReasons: [] } }).map((cause) => cause.text)
    expect(texts).toEqual(['2 submission(s) rejected in review', '2 handoff check(s) failed', '1 coordination defect(s) recorded', '1 min 30 s of effort classified corrective'])
  })
})

describe('a reassessed subject with nothing approved', () => {
  it('says nothing was approved beside the readings now', async () => {
    const recording = world('reportApproved')
    const { report } = recording.ids
    if (report === null) throw new Error('the approved report is pinned')
    const reading = await loadScore(replay(recording.calls), { kind: 'reassessment', ...report, request: 1 })
    const [subject] = reading.subjects
    if (subject === undefined) throw new Error('the reassessment holds subjects')
    const rows = subjectRows({ ...subject, approved: null, membership: 'joined' }, reading.assessedAt)
    expect(value(rows, 'Approved (frozen)')).toBe('nothing approved')
    expect(value(rows, 'Membership')).toBe('joined the sprint after the report (nothing approved for it)')
    expect(rows.map((row) => row.label)).toContain(`Reassessed (${localTime(reading.assessedAt)})`)
  })
})
