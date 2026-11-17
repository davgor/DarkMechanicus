import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { ScorecardReassessment } from '../../../shared/domain/spaceGrades'
import { replay, reportCardIdentity, reportContext, type WorldName, world } from '../__mocks__/scorecardWorlds'
import { loadScore, type ReportCardView } from '../scorecard/scoreReads'
import { localTime } from '../scorecard/scorecardFormat'
import {
  coverageRows,
  differenceText,
  failureCauses,
  identityRows,
  levelRows,
  modeView,
  orderedSubjects,
  outcomeConclusion,
  resourceRows,
  type SprintCard,
  sprintCard,
  subjectLabel,
  subjectRows,
  ticketFacts,
  ticketNames
} from './reportScorecardView'

type Rows = ReadonlyArray<{ label: string; value: unknown }>
const value = (rows: Rows, label: string): string => String(rows.find((row) => row.label === label)?.value)

const TOKENS = 'Tokens (K actual, overhead included)'
const TIME = 'Active time (T actual, waits excluded)'

async function viewOf(key: Extract<WorldName, `report${string}`>): Promise<{ bundle: PlanBundle; view: ReportCardView; card: SprintCard }> {
  const recording = world(key)
  const view = await loadScore(replay(recording.calls), reportCardIdentity(recording))
  const card = sprintCard(view)
  if (card === null) throw new Error('the world sprint is graded')
  return { bundle: (await reportContext(recording)).bundle, view, card }
}

function frozen(view: ReportCardView): Extract<ReportCardView, { state: 'frozen' }> {
  if (view.state !== 'frozen') throw new Error('the report is frozen')
  return view
}

async function reassessment(): Promise<ScorecardReassessment> {
  const recording = world('reportApproved')
  const { report } = recording.ids
  if (report === null) throw new Error('the approved report is pinned')
  return loadScore(replay(recording.calls), { kind: 'reassessment', ...report, request: 1 })
}

/** The card's T and K as summed over its runs (a grade that holds no T or K input). */
const summed = (card: SprintCard): SprintCard => ({ ...card, inputs: { ...card.inputs, T: null, K: null } })

describe('DM-182 c1: a report’s Scorecard is pinned to its report identity', () => {
  it('names the pinned revision, its snapshot and the policy it was graded under', async () => {
    const { view } = await viewOf('reportApproved')
    const { report, scorecard } = frozen(view)
    expect(identityRows(report, scorecard.snapshot, 1)).toEqual([
      { label: 'Report revision', value: '1 (pinned: a later revision has its own scorecard)' },
      { label: 'Report', value: 'rp_00000000000000000000000008' },
      { label: 'Submitted', value: localTime(report.submittedAt) },
      { label: 'Run', value: 'Run #1' },
      { label: 'Snapshot', value: 'as_ntfnwaqd1bm93s1xzp21q430e8 · 6c0e38a34fcb' },
      { label: 'Report content', value: '456118fb9cdb' },
      { label: 'Graded under', value: 'dm-space v2 · f50d32f4eb4e' },
      { label: 'Plan revision', value: 'rv_00000000000000000000000002' }
    ])
  })

  it('reads the run id when the report belongs to another run than the one shown, and a legacy report has no snapshot', async () => {
    const { view } = await viewOf('reportApproved')
    const { report } = frozen(view)
    const rows = identityRows(report, null, null)
    expect(value(rows, 'Run')).toBe(report.runId)
    expect(value(rows, 'Snapshot')).toBe('none: this report predates scorecards')
  })

  it('says what the snapshot stands for at a checkpoint and in history, and that a sprint without a report is live', async () => {
    const { view } = await viewOf('reportApproved')
    const submitted = localTime(frozen(view).report.submittedAt)
    const never = 'Late metrics, ratings, defects and newer rubric versions never change it: they appear only in a dated reassessment below.'
    expect(modeView(view, 'awaiting_approval')).toEqual({
      label: 'Snapshot · awaiting approval',
      tone: 'review',
      note: `Frozen when report revision 1 was submitted (${submitted}), from the records up to then. Approving the checkpoint approves this snapshot as it is. ${never}`
    })
    expect(modeView(view, 'approved').label).toBe('Approved snapshot')
    expect(modeView(view, null)).toEqual({ label: 'Historical snapshot', tone: 'accepted', note: `Frozen when report revision 1 was submitted (${submitted}), from the records up to then. The run has since passed this checkpoint. ${never}` })
    expect(modeView((await viewOf('reportLive')).view, null).label).toBe('Live · provisional')
  })
})

describe('DM-182 c2: sprint outcome status and resource totals', () => {
  it('fails the sprint on a failed integrated outcome although the feature ticket was accepted', async () => {
    const { bundle, card } = await viewOf('reportCheckout')
    expect(outcomeConclusion(card, ticketNames(bundle))).toBe(
      '1 of 1 feature ticket(s) and 0 of 2 integrated outcome(s) verified, yet the sprint failed: DM-5 Grade the tests with Fireguard. A confirmed failure of a required or integrated outcome caps the grade at F.'
    )
  })

  it('names what keeps a live sprint unverified, and says when no outcome counts yet', async () => {
    const live = await viewOf('reportLive')
    expect(outcomeConclusion(live.card, ticketNames(live.bundle))).toBe('1 of 2 feature ticket(s) verified, but the sprint is not verified: DM-2 Ticket 2 pending or without reviewed evidence.')
    const empty = await viewOf('reportEmpty')
    expect(outcomeConclusion(empty.card, ticketNames(empty.bundle))).toBe('No outcome counts toward this sprint yet (nothing was decided or awaits a decision), so the sprint is not verified.')
  })

  it('reads resource totals with unreported attempts as lower bounds, unknown as unavailable, never 0', async () => {
    const checkout = resourceRows((await viewOf('reportCheckout')).card)
    expect(value(checkout, TOKENS)).toBe('≥ 48,000 tokens (a lower bound: 1 attempt(s) reported nothing)')
    expect(value(checkout, TIME)).toBe('≥ 25 min (a lower bound: 1 attempt(s) reported nothing)')
    expect(value(checkout, 'Effort (every actor, summed)')).toBe('≥ 25 min (a lower bound: 2 of 3 attempt(s) reported activity)')
    const empty = resourceRows((await viewOf('reportEmpty')).card)
    expect(value(empty, TOKENS)).toBe('unavailable (not reported)')
    expect(value(empty, 'Retries (a diagnostic, never waste)')).toBe('unavailable')
  })
})

describe('DM-182 c2: measurement coverage, grade factors and ticket drill-down', () => {
  it('shows measurement coverage: unscored components with why, and the attempts that reported nothing', async () => {
    const { bundle, card } = await viewOf('reportCheckout')
    const rows = coverageRows(card, ticketNames(bundle))
    expect(value(rows, 'Grade coverage')).toBe('42.8% of base weight · 3 of 7 components scored')
    expect(value(rows, 'Components without a score')).toBe('S (no rating given or shared) · E (only partly reported) · T (some attempts reported nothing) · K (some attempts reported nothing)')
    expect(value(rows, 'Tickets graded')).toBe('2 of 5 with a letter')
    expect(value(rows, 'Attempts that reported no tokens')).toBe('1 (at_00000000000000000000000005)')
  })

  it('lists the failure causes, confirmed failures first, then the grade status reasons', async () => {
    const causes = failureCauses((await viewOf('reportCheckout')).card)
    expect(causes.map((cause) => cause.text)).toEqual([
      'failed: confirmed failure (a criterion or check failed, or every try was used)',
      'not verified: never dispatched',
      '2 submission(s) rejected in review',
      'Status provisional: a mandatory check or criterion failed',
      'Status provisional: a required component is missing'
    ])
    expect(causes.map((cause) => cause.ticketId).slice(0, 2)).toEqual(['tk_000000000000000000000000zd', 'tk_000000000000000000000000zc'])
  })

  it('drills into each ticket with its own measures, a partial one as a lower bound', async () => {
    const { card } = await viewOf('reportCheckout')
    const unreported = ['coverage 0.0%', 'tokens unavailable (not reported)', 'active unavailable (not reported)', 'S: no rating']
    expect(card.tickets.map((ticket) => ticketFacts(ticket))).toEqual([
      ['coverage 71.4%', 'tokens 40,000 tokens', 'active 20 min', 'S: no rating'],
      unreported,
      unreported,
      unreported,
      ['coverage 42.8%', 'tokens ≥ 8,000 tokens (a lower bound: 1 attempt(s) reported nothing)', 'active ≥ 5 min (a lower bound: 1 attempt(s) reported nothing)', 'S: no rating']
    ])
  })

  it('shows the run and epic grades frozen with the report beside the sprint’s, and only the sprint when live', async () => {
    expect(levelRows((await viewOf('reportApproved')).card)).toEqual([
      { label: 'Sprint', value: 'A 95.0 (provisional)' },
      { label: 'Run (so far, at the cutoff)', value: 'A 90.0 (provisional)' },
      { label: 'Epic (so far)', value: 'not frozen with this report: only the final sprint’s report freezes the epic' }
    ])
    expect(levelRows((await viewOf('reportLive')).card)).toEqual([{ label: 'Sprint (live)', value: 'ungraded' }])
  })
})

describe('DM-182 c3: a later reading never replaces the approved score', () => {
  it('compares the approved ticket with its reassessment, each reading dated on its own', async () => {
    const reading = await reassessment()
    const ticket = reading.subjects.find((subject) => subject.subject.level === 'ticket' && subject.differences.length > 0)
    if (ticket === undefined) throw new Error('a ticket is reassessed with a difference')
    const rows = subjectRows(ticket, reading.assessedAt)
    expect(rows.map((row) => row.label)).toEqual(['Approved (frozen)', 'Same window, regraded now', `Reassessed (${localTime(reading.assessedAt)})`, 'Membership', 'Windows'])
    expect(rows.slice(0, 4).map((row) => row.value)).toEqual([
      `A 100.0 (provisional) · as of ${localTime(ticket.windows.approved.to)}`,
      'A 100.0 (provisional)',
      'B 87.5 (provisional)',
      'frozen with the report, still in the sprint'
    ])
  })

  it('names the later record behind the difference and lists the changed subject first', async () => {
    const reading = await reassessment()
    const ordered = orderedSubjects(reading.subjects)
    const names = ticketNames((await reportContext(world('reportApproved'))).bundle)
    expect(ordered.map((subject) => `${subjectLabel(subject.subject, names)}: ${subject.differences.length}`)).toEqual(['DM-1 Ticket 1: 1', 'Sprint: 0', 'Run: 0', 'DM-2 Ticket 2: 0', 'DM-3 Ticket 3: 0'])
    expect(ordered[0]?.differences.map((difference) => differenceText(difference))).toEqual([
      'since the approved cutoff: ticketRating — → —; sprintRating — → —; rating — → 2; ratingScope — → ticket — records after the approval (late metrics, ratings, defects or decisions)'
    ])
  })
})

describe('DM-182 review fix (g): a summed actual with unreported attempts is a lower bound', () => {
  it('qualifies the run-summed tokens and time when the grade holds no T or K input', async () => {
    const rows = resourceRows(summed((await viewOf('reportCheckout')).card))
    expect(value(rows, TOKENS)).toBe('≥ 48,000 tokens (a lower bound: 1 attempt(s) reported nothing)')
    expect(value(rows, TIME)).toBe('≥ 25 min (a lower bound: 1 attempt(s) reported nothing)')
  })

  it('shows both qualifiers when the grade’s actual is estimated and some attempt reported nothing', async () => {
    const { card } = await viewOf('reportCheckout')
    const K = card.inputs.K
    if (K === null || K.actual.state === 'missing') throw new Error('the checkout grade read tokens')
    const rows = resourceRows({ ...card, inputs: { ...card.inputs, K: { ...K, actual: { state: 'estimated', value: K.actual.value, method: 'host estimate' } } } })
    expect(value(rows, TOKENS)).toBe('≥ ≈ 48,000 tokens (a lower bound, estimated in part: 1 attempt(s) reported nothing)')
  })

  it('reads a fully reported run sum as the plain total', async () => {
    const rows = resourceRows(summed((await viewOf('reportApproved')).card))
    expect(value(rows, TOKENS)).toBe('100,000 tokens')
  })
})

describe('DM-182 c2: a run sum never reads a missing run as 0', () => {
  it('reads unavailable when no run executed work', async () => {
    const { card } = await viewOf('reportApproved')
    expect(value(resourceRows(summed({ ...card, measures: [] })), TOKENS)).toBe('unavailable (no run executed work)')
  })

  it('reads unavailable with the reason when one run has no number, beside one that has', async () => {
    const approved = (await viewOf('reportApproved')).card
    const live = (await viewOf('reportLive')).card
    const rows = resourceRows(summed({ ...approved, measures: [...approved.measures, ...live.measures] }))
    expect(value(rows, TOKENS)).toBe('unavailable (only partly reported)')
    expect(value(rows, TIME)).toBe('unavailable (only partly reported)')
  })

  it('marks a sum over runs as estimated when one run’s number is', async () => {
    const { card } = await viewOf('reportApproved')
    const [measure] = card.measures
    if (measure === undefined) throw new Error('the approved sprint measured its run')
    const estimated = { ...measure, runId: 'rn_other', tokens: { ...measure.tokens, actual: { state: 'estimated' as const, value: 5_000, method: 'host estimate' } } }
    expect(value(resourceRows(summed({ ...card, measures: [measure, estimated] })), TOKENS)).toBe('≈ 105,000 tokens (estimated: some runs estimated)')
  })
})
