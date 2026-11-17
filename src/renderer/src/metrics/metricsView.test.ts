import { describe, expect, it } from 'vitest'
import { estimated, missing, observed, summaryCoverage, summaryGrade, trendEntry } from '../__mocks__/metricsFixtures'
import { localTime } from '../scorecard/scorecardFormat'
import { HOST_USAGE_SUPPORT } from '../../../shared/domain/hostUsage'
import { capabilityRows, comparisonText, gradeText, measureText, reportedText, shareText, statusPill, trendSourceText, windowText } from './metricsView'

const PREVIOUS = { epicId: 'ep_1', runId: 'rn_0', runNumber: 1, sprintId: 'sp_0' }

describe('DM-267 c2: unknown values read unavailable, never 0', () => {
  it('a missing measure reads unavailable with its reason, never 0', () => {
    expect(measureText(missing('not_reported'), 'tokens')).toBe('unavailable (not reported)')
    expect(measureText(missing(null), 'milliseconds')).toBe('unavailable (not reported)')
    expect(measureText(missing('some_new_reason'), 'tokens')).toBe('unavailable (some_new_reason)')
  })

  it('a missing measure with a reported part names it as a lower bound', () => {
    expect(measureText(missing('partial_report', 1200), 'tokens')).toBe('unavailable (partial_report; ≥ 1,200 tokens reported)')
  })

  it('an observed zero is a real 0, and an estimate is marked', () => {
    expect(measureText(observed(0), 'tokens')).toBe('0 tokens')
    expect(measureText(observed(90_000), 'milliseconds')).toBe('1 min 30 s')
    expect(measureText(estimated(2500), 'tokens')).toBe('≈ 2,500 tokens (estimated)')
  })

  it('a share reads as a percentage, unavailable when missing', () => {
    expect(shareText(observed(0.25))).toBe('25.0%')
    expect(shareText(estimated(0.1))).toBe('≈ 10.0% (estimated)')
    expect(shareText(missing(null))).toBe('unavailable (not reported)')
    expect(shareText(missing('x', 0.5))).toBe('unavailable (x; ≥ 50.0% reported)')
  })

  it('a value claimed observed but null still reads unavailable', () => {
    expect(measureText({ state: 'observed', value: null, reason: null, lowerBound: null }, 'tokens')).toBe('unavailable (not reported)')
    expect(shareText({ state: 'estimated', value: null, reason: null, lowerBound: null })).toBe('unavailable (not reported)')
  })
})

describe('DM-267 c2: grades and coverage as the summary gives them', () => {
  it('a grade shows its letter and displayed score, or says it has none', () => {
    expect(gradeText({ letter: 'B', displayScore: '3.4' })).toBe('B 3.4')
    expect(gradeText({ letter: 'B', displayScore: null })).toBe('B —')
    expect(gradeText({ letter: null, displayScore: '2.0' })).toBe('Score 2.0')
    expect(gradeText({ letter: null, displayScore: null })).toBe('No score')
  })

  it('the status pill names the grade status when it differs from the summary status', () => {
    expect(statusPill(summaryGrade())).toEqual({ label: 'Final', tone: 'accepted' })
    expect(statusPill(summaryGrade({ status: 'in_progress', gradeStatus: 'provisional' }))).toEqual({ label: 'In progress · provisional', tone: 'running' })
    expect(statusPill(summaryGrade({ status: 'failed', gradeStatus: 'provisional' }))).toEqual({ label: 'Failed · provisional', tone: 'failed' })
    expect(statusPill(summaryGrade({ status: 'ungraded', gradeStatus: 'ungraded' }))).toEqual({ label: 'Ungraded', tone: 'neutral' })
  })

  it('reported coverage counts attempts, and says when nothing executed', () => {
    const coverage = summaryCoverage({ attempts: 4, unreportedTokenAttempts: 1, unreportedTimeAttempts: 3 })
    expect(reportedText(coverage, 'tokens')).toBe('3 of 4 executed attempts reported tokens')
    expect(reportedText(coverage, 'time')).toBe('1 of 4 executed attempts reported active time')
    expect(reportedText(summaryCoverage({ attempts: 0 }), 'tokens')).toBe('no executed attempt')
  })
})

describe('DM-267 c2: sprint trend entries', () => {
  it('names where a grade comes from', () => {
    expect(trendSourceText({ source: 'frozen_report', report: { reportId: 'rp_1', reportRevision: 2 } })).toBe('Frozen with report revision 2')
    expect(trendSourceText({ source: 'frozen_report', report: null })).toBe('Frozen with report revision ?')
    expect(trendSourceText({ source: 'legacy_report', report: null })).toBe('Legacy report: ungraded, nothing was frozen')
    expect(trendSourceText({ source: 'live', report: null })).toBe('Live grade')
  })

  it('an incomparable entry lists its reasons and names the entry before', () => {
    const entry = trendEntry({ comparison: { previous: PREVIOUS, comparable: false, reasons: ['policy_changed', 'window_open'], scoreDelta: null } })
    expect(comparisonText(entry, { label: 'Search · Sprint 1 · Run #1', grade: null })).toBe('Not comparable with Search · Sprint 1 · Run #1: grading policy changed; window still open')
    expect(comparisonText(entry, null)).toBe('Not comparable with the entry before: grading policy changed; window still open')
    expect(comparisonText(trendEntry(), null)).toBe('Not comparable: first entry')
  })

  it('DM-269: an unknown cohort and a cross-epic comparison read as words, not codes', () => {
    const entry = trendEntry({ comparison: { previous: { ...PREVIOUS, epicId: 'ep_2' }, comparable: false, reasons: ['cohort_unknown', 'cross_epic'], scoreDelta: null } })
    expect(comparisonText(entry, { label: 'Other · Sprint 2 · Run #3', grade: null })).toBe(
      "Not comparable with Other · Sprint 2 · Run #3: ticket cohort unknown (a sprint has no ticket, or a ticket without a size); another epic's sprint, and neither policy nor cohort vouches for comparing them"
    )
  })

  it('a comparable entry shows the difference of the two displayed scores', () => {
    const entry = trendEntry({ grade: summaryGrade({ displayScore: '3.4' }), comparison: { previous: PREVIOUS, comparable: true, reasons: [], scoreDelta: 0.47 } })
    expect(comparisonText(entry, { label: 'Earlier', grade: { displayScore: '3.1' } })).toBe('+0.3 vs Earlier')
    expect(comparisonText(entry, { label: 'Earlier', grade: { displayScore: '3.6' } })).toBe('−0.2 vs Earlier')
    expect(comparisonText(entry, { label: 'Earlier', grade: { displayScore: '3.4' } })).toBe('±0.0 vs Earlier')
  })

  it('without the earlier score it shows the core delta, and says so when there is none', () => {
    const delta = (scoreDelta: number | null): string =>
      comparisonText(trendEntry({ comparison: { previous: PREVIOUS, comparable: true, reasons: [], scoreDelta } }), null)
    expect(delta(0.37)).toBe('+0.3 vs the entry before')
    expect(delta(null)).toBe('Comparable with the entry before; no change given')
  })

  it('DM-267 review fix: the core delta is cut toward zero for both signs', () => {
    const delta = (scoreDelta: number): string =>
      comparisonText(trendEntry({ comparison: { previous: PREVIOUS, comparable: true, reasons: [], scoreDelta } }), null)
    expect(delta(-0.04)).toBe('±0.0 vs the entry before')
    expect(delta(0.04)).toBe('±0.0 vs the entry before')
    expect(delta(-0.37)).toBe('−0.3 vs the entry before')
    expect(delta(0.37)).toBe('+0.3 vs the entry before')
    expect(delta(-0.3)).toBe('−0.3 vs the entry before')
    expect(delta(0.3)).toBe('+0.3 vs the entry before')
  })

  it('a window names its bounds, basis and whether it is still open', () => {
    const to = '2026-03-04T12:00:00.000Z'
    expect(windowText({ from: null, to, closed: true, basis: 'report_cutoff' })).toBe(`start – ${localTime(to)} (ends at its report)`)
    expect(windowText({ from: '2026-03-01T09:00:00.000Z', to, closed: false, basis: 'live_cutoff' })).toBe(`${localTime('2026-03-01T09:00:00.000Z')} – ${localTime(to)} (live, still open)`)
  })
})

describe('DM-193 c4: measurement capabilities the app cannot read are labelled, never claimed', () => {
  it('lists every built-in agent with whether its host usage is read, then custom agents as not readable', () => {
    expect(capabilityRows()).toEqual([
      { agent: 'Claude Code', tokens: 'Read from the host', activeTime: 'Read from the host', detail: HOST_USAGE_SUPPORT.claude.detail },
      { agent: 'Codex', tokens: 'Not readable', activeTime: 'Not readable', detail: HOST_USAGE_SUPPORT.codex.detail },
      { agent: 'Cursor', tokens: 'Not readable', activeTime: 'Not readable', detail: HOST_USAGE_SUPPORT.cursor.detail },
      { agent: 'Autonomous', tokens: 'Not readable', activeTime: 'Not readable', detail: HOST_USAGE_SUPPORT.autonomous.detail },
      { agent: 'Skitarii', tokens: 'Read from the host', activeTime: 'Read from the host', detail: HOST_USAGE_SUPPORT.omp.detail },
      { agent: 'Custom agents', tokens: 'Not readable', activeTime: 'Not readable', detail: 'Dark Mechanicus cannot read a custom agent’s usage.' }
    ])
  })
})
