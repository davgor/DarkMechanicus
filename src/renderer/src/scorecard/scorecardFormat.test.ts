import { describe, expect, it } from 'vitest'
import { baseline, component, quantity, spaceGrade, tokenCell } from '../__mocks__/ticketScorecardFixtures'
import {
  baselineText,
  displayedPoints,
  durationText,
  gradeState,
  localTime,
  measurementText,
  percentText,
  provenanceText,
  quantityText,
  scoreText,
  shortHash,
  summaryText,
  usageCellText,
  windowsText
} from './scorecardFormat'

describe('DM-180 c1: grade states', () => {
  it('reads final, provisional and ungraded as the core status', () => {
    expect(gradeState({ status: 'final', outcome: 'verified', statusReasons: [] })).toEqual({ state: 'final', label: 'Final', tone: 'accepted' })
    expect(gradeState({ status: 'provisional', outcome: 'unverified', statusReasons: ['estimated_input'] })).toEqual({ state: 'provisional', label: 'Provisional', tone: 'attention' })
    expect(gradeState({ status: 'ungraded', outcome: 'unverified', statusReasons: [] })).toEqual({ state: 'ungraded', label: 'Ungraded', tone: 'neutral' })
  })

  it('names a pending outcome in progress, keeping the core status in the label', () => {
    expect(gradeState({ status: 'ungraded', outcome: 'unverified', statusReasons: ['verification_pending'] })).toEqual({ state: 'in_progress', label: 'In progress · ungraded', tone: 'running' })
  })

  it('names a confirmed failure failed, even while an outcome is also pending', () => {
    expect(gradeState({ status: 'provisional', outcome: 'failed', statusReasons: ['verification_pending'] })).toEqual({ state: 'failed', label: 'Failed · provisional', tone: 'failed' })
  })
})

describe('DM-180 c1: coverage and score text never read higher than they are', () => {
  it('rounds scores and coverage down to one decimal', () => {
    expect(scoreText(79.99)).toBe('79.9')
    expect(scoreText(null)).toBe('—')
    expect(percentText(0.8571)).toBe('85.7%')
    expect(percentText(0.99999)).toBe('99.9%')
  })
})

describe('DM-180 c1 / review fix 1: factor contributions add up to the shown score', () => {
  const thirds = (score: number) => (['S', 'P', 'A'] as const).map((key) => component(key, { score, effectiveWeight: 1 / 3 }))

  it('gives identical components points 0.1 apart so the points sum to the displayed composite', () => {
    const points = displayedPoints(spaceGrade({ components: thirds(70.1), uncappedScore: 70.1 }))
    expect([...points.entries()]).toEqual([
      ['S', '23.4'],
      ['P', '23.4'],
      ['A', '23.3']
    ])
  })

  it('raises the largest remainder, not the first component', () => {
    const components = [component('S', { score: 81.27, effectiveWeight: 0.5 }), component('P', { score: 80.35, effectiveWeight: 0.5 })]
    expect([...displayedPoints(spaceGrade({ components, uncappedScore: 80.81 })).entries()]).toEqual([
      ['S', '40.6'],
      ['P', '40.2']
    ])
  })

  it('leaves a missing component out instead of giving it 0 points', () => {
    const components = [component('S', { score: null, effectiveWeight: 0, missingReason: 'no_rating' }), component('P', { score: 90, effectiveWeight: 1 })]
    expect([...displayedPoints(spaceGrade({ components, uncappedScore: 90 })).entries()]).toEqual([['P', '90.0']])
  })
})

describe('DM-180 c1: baseline version', () => {
  it('names kind, version, value, sample and freeze time, and a refusal', () => {
    const frozen = localTime('2026-03-01T09:00:00.000Z')
    expect(baselineText(baseline({ sampleSize: 4 }), 'tokens')).toBe(`budget v3: 50,000 tokens, 4 in sample, frozen ${frozen}`)
    expect(baselineText(baseline({ refusedReason: 'metric_mismatch' }), 'tokens')).toBe(`budget v3: 50,000 tokens, frozen ${frozen}; refused (metric mismatch)`)
  })
})

describe('DM-180 c2: units and unavailable values', () => {
  it('gives durations their unit at each scale', () => {
    expect(durationText(0)).toBe('0 ms')
    expect(durationText(999)).toBe('999 ms')
    expect(durationText(45_000)).toBe('45 s')
    expect(durationText(120_000)).toBe('2 min')
    expect(durationText(750_000)).toBe('12 min 30 s')
    expect(durationText(7_500_000)).toBe('2 h 05 min')
  })

  it('reads a missing measurement as unavailable with its reason, never 0', () => {
    expect(measurementText({ state: 'missing', reason: 'not_reported' }, 'tokens')).toBe('unavailable (not reported)')
    expect(measurementText({ state: 'observed', value: 42_000 }, 'tokens')).toBe('42,000 tokens')
    expect(measurementText({ state: 'estimated', value: 60_000, method: 'span sum' }, 'milliseconds')).toBe('≈ 1 min (estimated: span sum)')
  })

  it('reads a missing timing quantity as unavailable and an open one as a lower bound', () => {
    expect(quantityText(quantity(null))).toBe('unavailable')
    expect(quantityText(quantity(0))).toBe('0 ms')
    expect(quantityText(quantity(60_000, { state: 'estimated', open: true }))).toBe('1 min (estimated; still running, a lower bound)')
  })

  it('reads usage cells with no number as unavailable and partial ones as a lower bound', () => {
    expect(usageCellText(tokenCell(null, 'unavailable'))).toBe('unavailable (the host cannot report it)')
    expect(usageCellText(tokenCell(null, 'unreported'))).toBe('unavailable (unreported)')
    expect(usageCellText(tokenCell(1200, 'partial'))).toBe('≥ 1,200 tokens (partial)')
    expect(usageCellText(tokenCell(1200, 'estimated'))).toBe('≈ 1,200 tokens (estimated)')
    expect(usageCellText(tokenCell(1200))).toBe('1,200 tokens')
  })
})

describe('DM-180 c3: legacy and missing grades are never fabricated', () => {
  it('reads no summary as not graded and an ungraded one by its status', () => {
    expect(summaryText(null)).toBe('not graded')
    expect(summaryText({ letter: null, displayScore: null, status: 'ungraded' })).toBe('ungraded')
    expect(summaryText({ letter: 'B', displayScore: '81.0', status: 'final' })).toBe('B 81.0 (final)')
  })
})

describe('review fix 5: report windows in local time', () => {
  const approved = { from: '2026-03-02T09:00:00.000Z', to: '2026-03-03T09:00:00.000Z' }

  it('formats comparable windows with local times, not raw ISO', () => {
    const text = windowsText({ approved, current: { from: approved.from, to: '2026-03-04T10:00:00.000Z' }, comparable: true })
    expect(text).toBe(
      `both windows start at the first dispatch (${localTime(approved.from)}); the current one runs ${localTime(approved.to)} → ${localTime('2026-03-04T10:00:00.000Z')} longer`
    )
    expect(text).not.toContain('T09:00:00.000Z')
  })

  it('says why incomparable windows differ, naming a missing dispatch', () => {
    expect(windowsText({ approved, current: { from: null, to: approved.to }, comparable: false })).toBe(
      `not comparable: the approved window starts at ${localTime(approved.from)}, the current one at no dispatch`
    )
  })
})

describe('scorecard format edges: time cells, scores without a display, short ids and provenance', () => {
  it('reads an active-time usage cell as a duration and a letter without a display score with a dash', () => {
    expect(usageCellText({ metric: 'active_ms', unit: 'milliseconds', coverage: 'observed', value: 90_000 })).toBe('1 min 30 s')
    expect(summaryText({ letter: 'B', displayScore: null, status: 'provisional' })).toBe('B — (provisional)')
  })

  it('keeps a short id whole and cuts a hash to its first 12 characters', () => {
    expect(shortHash('sha256:abc123')).toBe('abc123')
    expect(shortHash('rv_short')).toBe('rv_short')
    expect(shortHash('sha256:0123456789abcdef')).toBe('0123456789ab')
  })

  it('names where a rating was recorded only by what the provenance holds', () => {
    expect(provenanceText({ origin: 'unattested', desktopSession: null, machine: null })).toBe('unattested: names no recording desktop session on this machine')
    expect(provenanceText({ origin: 'other_machine', desktopSession: null, machine: 'm-2' })).toBe('recorded on another machine (imported, not checkable here); machine m-2')
    expect(provenanceText({ origin: 'this_machine', desktopSession: 'ds-1', machine: null })).toBe('labelled as recorded on this machine (a label, not a signature); desktop session ds-1')
  })
})
