import { describe, expect, it } from 'vitest'
import { replay, world } from '../__mocks__/scorecardWorlds'
import { type EpicCardView, type EpicRunRead, loadEpicCard } from '../scorecard/scoreReads'
import { durationText, localTime } from '../scorecard/scorecardFormat'
import {
  epicTicketNames,
  failureCauses,
  type GradedEpic,
  gradedEpic,
  gradedSprint,
  outcomeConclusion,
  runTimingRows,
  scopeRows,
  totalRows,
  wallRows
} from './epicScorecardView'

type Rows = ReadonlyArray<{ label: string; value: unknown }>
const value = (rows: Rows, label: string): string => String(rows.find((row) => row.label === label)?.value)

/** The epic card the renderer's loader builds from the recorded world. */
async function cardOf(key: 'epicActive' | 'epicCompleted'): Promise<EpicCardView> {
  const recording = world(key)
  return loadEpicCard(replay(recording.calls), { epicId: recording.ids.epicId, completed: key === 'epicCompleted' })
}

function graded(card: EpicCardView): GradedEpic {
  const result = gradedEpic(card.assessment)
  if (result === null) throw new Error('the world epic is graded')
  return result
}

function runRead(card: EpicCardView, index: number): EpicRunRead {
  const read = card.runs[index]?.read
  if (read?.ok !== true) throw new Error('the world run reads')
  return read.value
}

/** Run #2 of the completed epic: its timing frozen with its last report, its window still open then. */
function frozenTiming(card: EpicCardView): Extract<EpicRunRead['timing'], { ok: true }>['value'] & { state: 'frozen' } {
  const timing = runRead(card, 1).timing
  if (!timing.ok || timing.value.state !== 'frozen') throw new Error('Run #2 froze its timing')
  return timing.value
}

const TOKENS = 'Tokens (every attempt and overhead)'
const WALL = 'Wall time (union of run windows)'
const ACTIVE = 'Someone measurably working (active wall clock)'

describe('DM-181 c2: original scope and outcomes show completed tickets alone do not prove epic success', () => {
  it('names the failed Fireguard (integrated) outcome beside the accepted feature tickets', async () => {
    const card = await cardOf('epicActive')
    expect(outcomeConclusion(graded(card), epicTicketNames(card, null))).toBe(
      '2 of 2 feature ticket(s) and 0 of 2 integrated outcome(s) are verified, yet the epic failed: DM-5 Grade the tests with Fireguard. A confirmed failure of a required or integrated outcome caps the grade at F, so completed tickets alone do not make the epic a success.'
    )
  })

  it('keeps removed scope counted as committed and added scope apart', async () => {
    const rows = scopeRows(graded(await cardOf('epicActive')))
    expect(value(rows, 'Committed before dispatch')).toBe('4 ticket(s)')
    expect(value(rows, 'Delivered of that scope')).toBe('2 of 4 (accepted, every committed criterion verified)')
    expect(value(rows, 'Removed after dispatch')).toBe('1 (still counted as committed): DM-3 Ticket 3')
    expect(value(rows, 'Added after dispatch')).toBe('1 (shown apart, never counted as delivered scope): DM-7 Ticket 7')
  })

  it('puts the confirmed failure capping the grade first, then the unverified integrated outcomes', async () => {
    const card = await cardOf('epicActive')
    const causes = failureCauses(graded(card), epicTicketNames(card, null)).map((cause) => cause.text)
    expect(causes).toEqual([
      'DM-5 Grade the tests with Fireguard — integrated (acceptance or administrative) · failed: confirmed failure (a criterion or check failed, or every try was used); caps the grade at F',
      'DM-4 Sprint 1 acceptance — integrated (acceptance or administrative) · not verified: never dispatched',
      '3 submission(s) rejected by review (their passed checks count as failed in C)'
    ])
  })

  it('drills into each sprint: the reported sprint graded and failed, an unreported sprint never stands in', async () => {
    const card = await cardOf('epicActive')
    const [reported, open] = runRead(card, 0).sprints.map((sprint) => (sprint.assessment.ok ? sprint.assessment.value : null))
    const sprint1 = reported === null || reported === undefined ? null : gradedSprint(reported)
    expect(sprint1?.grade.subject.level).toBe('sprint')
    expect(sprint1?.grade.outcome).toBe('failed')
    expect(open?.state).toBe('live')
    expect(gradedSprint({ state: 'not_reported' })).toBeNull()
  })
})

describe('DM-181 c3: total resources include abandoned, retried and administrative work', () => {
  it('sums every attempt of every run: rejected retries, the failed Fireguard ticket and orchestration', async () => {
    const card = await cardOf('epicActive')
    const rows = totalRows(card, graded(card))
    expect(value(rows, TOKENS)).toBe('113,000 tokens')
    expect(value(rows, 'Active time (every actor, waits excluded)')).toBe('1 h 01 min')
    expect(value(rows, 'Overhead inside that effort (orchestration, review, verification)')).toBe('6 min')
    expect(value(rows, 'Retried attempts')).toBe('2 (a diagnostic, never scored as waste)')
  })

  it('counts the cancelled run’s abandoned attempt in a completed epic', async () => {
    const card = await cardOf('epicCompleted')
    const rows = totalRows(card, graded(card))
    expect(value(rows, TOKENS)).toBe('55,000 tokens')
    expect(value(rows, 'Active time (every actor, waits excluded)')).toBe('37 min')
    expect(value(rows, 'Runs counted')).toBe('Run #1, Run #2')
  })

  it('never sums parallel elapsed time: two overlapping runs give the union and no combined active clock', async () => {
    const card = await cardOf('epicActive')
    const entry = card.runs[0]
    const timing = runRead(card, 0).timing
    if (entry === undefined || !timing.ok || timing.value.state !== 'live') throw new Error('Run #1 is live')
    const live = timing.value.timing
    const start = Date.parse(live.startedAt ?? '')
    const end = Date.parse(live.asOf)
    const half = (end - start) / 2
    const shifted = { ...live, startedAt: new Date(start + half).toISOString(), endedAt: new Date(end + half).toISOString() }
    const copy = { runId: 'rn_copy', read: { ok: true as const, value: { ...runRead(card, 0), run: { ...runRead(card, 0).run, id: 'rn_copy', number: 2 }, timing: { ok: true as const, value: { state: 'live' as const, timing: shifted } } } } }
    const rows = wallRows({ ...card, runs: [entry, copy] })
    expect(value(rows, WALL)).toBe(`≥ ${durationText(end + half - start)} (Run #1 is still running: as of ${localTime(live.asOf)})`)
    expect(value(rows, ACTIVE)).toBe('not combined (run windows overlap)')
  })
})

describe('DM-181 review fix (a): a frozen window is read as of its run’s last report', () => {
  it('(a) a run frozen open at its last report and since ended runs to its lifecycle end, never "the final report"', async () => {
    const card = await cardOf('epicCompleted')
    const { asOf } = frozenTiming(card).timing
    const ended = runRead(card, 1).run.endedAt ?? ''
    const rows = wallRows(card)
    expect(value(rows, WALL)).toBe('49 min')
    expect(value(rows, ACTIVE)).toBe(`≥ 25 min (Run #1: no activity measured or frozen; Run #2: activity as of its last report, ${localTime(asOf)}; the run ended ${localTime(ended)})`)
  })

  it('(a) a frozen window of a run with no lifecycle end stops at its last report and says so', async () => {
    const card = await cardOf('epicCompleted')
    const { asOf } = frozenTiming(card).timing
    const second = { ...card.runs[1], runId: card.runs[1]?.runId ?? '', read: { ok: true as const, value: { ...runRead(card, 1), run: { ...runRead(card, 1).run, endedAt: null } } } }
    const rows = wallRows({ ...card, runs: [card.runs[0] ?? second, second] })
    expect(value(rows, WALL)).toBe(`≥ 47 min (Run #2: as of its last report, ${localTime(asOf)}; it went on after it)`)
  })
})

describe('DM-181 review fixes (b), (c), (d) and frozen usage', () => {
  it('(b) a completed run’s frozen block reads open quantities as of its last report, never "still running"', async () => {
    const card = await cardOf('epicCompleted')
    const timing = frozenTiming(card)
    const rows = runTimingRows(runRead(card, 1).run, timing)
    const asOf = localTime(timing.timing.asOf)
    expect(value(rows, 'Window (start → end)')).toBe(`≥ 32 min (open at its last report, ${asOf}; a lower bound)`)
    expect(value(rows, 'Active wall clock (union)')).toBe(`≥ 25 min (open at its last report, ${asOf}; a lower bound)`)
    expect(rows.map((row) => String(row.value)).join(' ')).not.toContain('still running')
  })

  it('(c) a total both estimated and a lower bound shows both qualifiers', async () => {
    const card = await cardOf('epicCompleted')
    const grade = graded(card)
    const run2 = card.runs[1]?.runId
    const measures = grade.measures.filter((measure) => measure.runId === run2).map((measure) => ({ ...measure, tokens: { state: 'estimated' as const, value: 37_000, method: 'host estimate' } }))
    expect(value(totalRows(card, { ...grade, measures }), TOKENS)).toBe('≥ ≈ 37,000 tokens (a lower bound, estimated in part: Run #1: no usage was frozen for it)')
  })

  it('(d) the active-clock note names a run once, for its missing activity alone', async () => {
    const card = await cardOf('epicActive')
    const entry = card.runs[0]
    const timing = runRead(card, 0).timing
    if (entry === undefined || !timing.ok || timing.value.state !== 'live') throw new Error('Run #1 is live')
    const live = timing.value.timing
    const later = Date.parse(live.asOf) + 3_600_000
    const unmeasured = { ...live, startedAt: new Date(later).toISOString(), asOf: new Date(later + 600_000).toISOString(), activeWallClock: { ...live.activeWallClock, ms: null } }
    const copy = { runId: 'rn_copy', read: { ok: true as const, value: { ...runRead(card, 0), run: { ...runRead(card, 0).run, id: 'rn_copy', number: 2 }, timing: { ok: true as const, value: { state: 'live' as const, timing: unmeasured } } } } }
    const active = value(wallRows({ ...card, runs: [entry, copy] }), ACTIVE)
    expect(active).toBe(`≥ 58 min (Run #1 is still running: as of ${localTime(live.asOf)}; Run #2: no activity measured or frozen)`)
  })

  it('a completed epic’s run with no frozen usage makes the total a lower bound naming it, never read live', async () => {
    const card = await cardOf('epicCompleted')
    const grade = graded(card)
    const run2 = card.runs[1]?.runId
    const rows = totalRows(card, { ...grade, measures: grade.measures.filter((measure) => measure.runId === run2) })
    expect(value(rows, TOKENS)).toBe('≥ 37,000 tokens (a lower bound: Run #1: no usage was frozen for it)')
    expect(value(rows, 'Runs counted')).toBe('Run #1 (no usage: no usage was frozen for it), Run #2')
  })
})

describe('DM-181 c3: nothing missing ever reads as 0', () => {
  it('reads a total with no run’s usage as unavailable, naming every run, never "≥ 0"', async () => {
    const card = await cardOf('epicCompleted')
    const rows = totalRows(card, { ...graded(card), measures: [] })
    expect(value(rows, TOKENS)).toBe('unavailable (Run #1: no usage was frozen for it; Run #2: no usage was frozen for it)')
    expect(value(rows, 'Active time (every actor, waits excluded)')).toBe('unavailable (Run #1: no usage was frozen for it; Run #2: no usage was frozen for it)')
  })

  it('reads the active clock as unavailable when no run measured any activity', async () => {
    const card = await cardOf('epicCompleted')
    const timing = frozenTiming(card)
    const unmeasured = { ...timing, timing: { ...timing.timing, run: { ...timing.timing.run, activeWallClock: { ...timing.timing.run.activeWallClock, ms: null } } } }
    const second = { runId: card.runs[1]?.runId ?? '', read: { ok: true as const, value: { ...runRead(card, 1), timing: { ok: true as const, value: unmeasured } } } }
    const rows = wallRows({ ...card, runs: [card.runs[0] ?? second, second] })
    expect(value(rows, ACTIVE)).toBe('unavailable (Run #1: no activity measured or frozen; Run #2: no activity measured or frozen)')
  })

  it('reads a frozen quantity still open at the report but with no number as unavailable, not "≥ 0"', async () => {
    const card = await cardOf('epicCompleted')
    const timing = frozenTiming(card)
    const run = timing.timing.run
    const unknown = { ...timing, timing: { ...timing.timing, run: { ...run, elapsed: { ...run.elapsed, open: true, ms: null } } } }
    expect(value(runTimingRows(runRead(card, 1).run, unknown), 'Window (start → end)')).toBe('unavailable')
  })

  it('reads a frozen quantity still open at the report and marked missing as unavailable, though it carries a number', async () => {
    const card = await cardOf('epicCompleted')
    const timing = frozenTiming(card)
    const run = timing.timing.run
    const missing = { ...timing, timing: { ...timing.timing, run: { ...run, elapsed: { ...run.elapsed, open: true, ms: 60_000, state: 'missing' as const } } } }
    expect(value(runTimingRows(runRead(card, 1).run, missing), 'Window (start → end)')).toBe('unavailable')
  })
})
