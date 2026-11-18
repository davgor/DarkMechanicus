import { describe, expect, it } from 'vitest'
import {
  appendSegment,
  classified,
  classify,
  classTotals,
  clip,
  iso,
  type Label,
  type Layer,
  length,
  missing,
  msCoverage,
  overlap,
  quantity,
  type Segment,
  subtract,
  toTimingSegments,
  union,
  within
} from './timingIntervals'

const ACTIVE: Label = { class: 'active', reason: 'activity_span', evidence: 'host' }
const PAUSED: Label = { class: 'blocked', reason: 'run_paused', evidence: 'lifecycle' }
const UNKNOWN: Label = { class: 'unknown', reason: 'no_activity_evidence', evidence: 'none' }

const layer = (start: number, end: number, priority: number, label: Label): Layer => ({ start, end, priority, label })
const spans = (segments: readonly Segment[]): [number, number, string][] => segments.map((s) => [s.start, s.end, s.label.class])

describe('DM-172 c1: ISO times', () => {
  it.each([
    ['epoch', 0],
    ['a time of day with every field padded', Date.parse('2026-01-02T03:04:05.006Z')],
    ['milliseconds 050', Date.parse('2026-11-01T10:00:00.050Z')],
    ['the last millisecond of a day', Date.parse('2026-12-31T23:59:59.999Z')],
    ['before 1970', Date.parse('1969-07-20T20:17:40.123Z')],
    ['the last four-digit-year day', Date.parse('9999-12-31T12:00:00.000Z')],
    ['a six-digit year', Date.parse('+010000-01-01T00:00:00.000Z')]
  ])('formats %s exactly as Date#toISOString', (_name, time) => {
    expect(iso(time)).toBe(new Date(time).toISOString())
  })

  it('truncates a fractional millisecond, so the result is always a valid ISO time', () => {
    const base = Date.parse('2026-11-01T10:00:00.250Z')
    expect(iso(base + 0.75)).toBe('2026-11-01T10:00:00.250Z')
    expect(iso(base + 999.999)).toBe('2026-11-01T10:00:01.249Z')
  })
})

describe('DM-172 c1: interval arithmetic', () => {
  it('a union merges overlapping and touching intervals, drops empty ones and sorts', () => {
    const input = [
      { start: 50, end: 60 },
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 30, end: 30 },
      { start: 15, end: 25 },
      { start: 40, end: 35 }
    ]
    expect(union(input)).toEqual([
      { start: 0, end: 25 },
      { start: 50, end: 60 }
    ])
    expect(input[1]).toEqual({ start: 0, end: 10 })
  })

  it('a union keeps the later end when a shorter interval sits inside a longer one', () => {
    expect(union([{ start: 0, end: 100 }, { start: 10, end: 20 }])).toEqual([{ start: 0, end: 100 }])
  })

  it('length sums the intervals', () => {
    expect(length([{ start: 0, end: 10 }, { start: 20, end: 25 }])).toBe(15)
    expect(length([])).toBe(0)
  })

  it('clip keeps the part inside the window; touching or outside gives null', () => {
    expect(clip({ start: 5, end: 30 }, { start: 10, end: 20 })).toEqual({ start: 10, end: 20 })
    expect(clip({ start: 0, end: 10 }, { start: 10, end: 20 })).toBeNull()
    expect(clip({ start: 25, end: 30 }, { start: 10, end: 20 })).toBeNull()
  })

  it('subtract removes every cut, keeping the pieces between them', () => {
    const cuts = union([{ start: 0, end: 5 }, { start: 10, end: 20 }, { start: 30, end: 40 }, { start: 90, end: 95 }])
    expect(subtract({ start: 8, end: 35 }, cuts)).toEqual([
      { start: 8, end: 10 },
      { start: 20, end: 30 }
    ])
    expect(subtract({ start: 12, end: 18 }, cuts)).toEqual([])
    expect(subtract({ start: 50, end: 60 }, cuts)).toEqual([{ start: 50, end: 60 }])
    expect(subtract({ start: 5, end: 10 }, cuts)).toEqual([{ start: 5, end: 10 }])
  })

  it('overlap is the part of an interval the cuts cover', () => {
    const cuts = union([{ start: 10, end: 20 }, { start: 30, end: 40 }])
    expect(overlap({ start: 15, end: 35 }, cuts)).toBe(10)
    expect(overlap({ start: 20, end: 30 }, cuts)).toBe(0)
  })
})

describe('DM-172 c1: classification covers the window exactly once', () => {
  it('the highest-priority layer wins where layers overlap; the fallback fills the rest', () => {
    const segments = classify({ start: 0, end: 100 }, [layer(20, 60, 30, PAUSED), layer(40, 50, 100, ACTIVE)], UNKNOWN)
    expect(spans(segments)).toEqual([
      [0, 20, 'unknown'],
      [20, 40, 'blocked'],
      [40, 50, 'active'],
      [50, 60, 'blocked'],
      [60, 100, 'unknown']
    ])
  })

  it('layers outside the window are ignored and layers crossing it are clipped', () => {
    const segments = classify({ start: 10, end: 20 }, [layer(0, 15, 100, ACTIVE), layer(30, 40, 100, PAUSED)], UNKNOWN)
    expect(spans(segments)).toEqual([
      [10, 15, 'active'],
      [15, 20, 'unknown']
    ])
  })

  it('one layer ending where the next of the same label starts gives one merged segment', () => {
    const segments = classify({ start: 0, end: 30 }, [layer(0, 10, 100, ACTIVE), layer(10, 30, 100, ACTIVE)], UNKNOWN)
    expect(spans(segments)).toEqual([[0, 30, 'active']])
  })

  it('an empty or inverted window has no segments', () => {
    expect(classify({ start: 10, end: 10 }, [layer(0, 20, 100, ACTIVE)], UNKNOWN)).toEqual([])
    expect(classify({ start: 20, end: 10 }, [layer(0, 30, 100, ACTIVE)], UNKNOWN)).toEqual([])
  })
})

describe('DM-172 c1: segment helpers', () => {
  it('appendSegment extends a contiguous segment of the same label and starts a new one otherwise', () => {
    const out: Segment[] = []
    appendSegment(out, { start: 0, end: 10, label: ACTIVE, key: 'a' })
    appendSegment(out, { start: 10, end: 20, label: ACTIVE, key: 'a' })
    appendSegment(out, { start: 25, end: 30, label: ACTIVE, key: 'a' })
    appendSegment(out, { start: 30, end: 40, label: PAUSED, key: 'b' })
    expect(spans(out)).toEqual([
      [0, 20, 'active'],
      [25, 30, 'active'],
      [30, 40, 'blocked']
    ])
  })

  it('within keeps the clipped part of each segment inside the window', () => {
    const segments = classify({ start: 0, end: 30 }, [layer(10, 20, 100, ACTIVE)], UNKNOWN)
    expect(spans(within(segments, { start: 5, end: 15 }))).toEqual([
      [5, 10, 'unknown'],
      [10, 15, 'active']
    ])
  })

  it('timing segments carry ISO ends and the length in milliseconds; class totals add up per class', () => {
    const t0 = Date.parse('2026-11-01T10:00:00.000Z')
    const segments = classify({ start: t0, end: t0 + 600_000 }, [layer(t0, t0 + 60_000, 100, ACTIVE)], UNKNOWN)
    expect(toTimingSegments(segments)).toEqual([
      { class: 'active', reason: 'activity_span', evidence: 'host', start: '2026-11-01T10:00:00.000Z', end: '2026-11-01T10:01:00.000Z', ms: 60_000 },
      { class: 'unknown', reason: 'no_activity_evidence', evidence: 'none', start: '2026-11-01T10:01:00.000Z', end: '2026-11-01T10:10:00.000Z', ms: 540_000 }
    ])
    expect(classTotals(segments)).toEqual({ active: 60_000, queue: 0, build_test: 0, blocked: 0, review: 0, human_approval: 0, unknown: 540_000 })
  })
})

describe('DM-172 c2/c4: quantities state their coverage; missing is never zero', () => {
  const coverage = { covered: 5, of: 10, unit: 'milliseconds' } as const

  it('a null number is missing, with nothing covered', () => {
    expect(quantity('measured_active', { aggregation: 'single', ms: null, state: 'observed', coverage, open: true })).toEqual({
      quantity: 'measured_active',
      unit: 'milliseconds',
      aggregation: 'single',
      ms: null,
      state: 'missing',
      coverage: { covered: 0, of: 10, unit: 'milliseconds' },
      open: true
    })
  })

  it('a missing state drops a number that was given', () => {
    expect(quantity('classified_wait', { aggregation: 'sum', ms: 7, state: 'missing', coverage, open: false })).toMatchObject({ ms: null, state: 'missing', coverage: { covered: 0 } })
  })

  it('a known number keeps its state and coverage and is never negative', () => {
    expect(quantity('resource_effort', { aggregation: 'sum', ms: 7, state: 'partial', coverage, open: false })).toMatchObject({ ms: 7, state: 'partial', coverage })
    expect(quantity('resource_effort', { aggregation: 'sum', ms: -3, state: 'observed', coverage, open: false }).ms).toBe(0)
  })

  it('missing() has no number and covers 0 of 0 in its unit', () => {
    expect(missing('ticket_lead_time', 'attempts', 'union')).toEqual({ quantity: 'ticket_lead_time', unit: 'milliseconds', aggregation: 'union', ms: null, state: 'missing', coverage: { covered: 0, of: 0, unit: 'attempts' }, open: false })
  })

  it('millisecond coverage is the classified part of the window', () => {
    expect(msCoverage({ ...classTotals([]), unknown: 30 }, 100)).toEqual({ covered: 70, of: 100, unit: 'milliseconds' })
    expect(msCoverage({ ...classTotals([]), unknown: 130 }, 100)).toEqual({ covered: 0, of: 100, unit: 'milliseconds' })
  })

  it('with no window every wait and the unknown time are missing; with one they carry their totals', () => {
    const none = classified(classTotals([]), 0, 'sum', false)
    expect(Object.values(none.waits).map((q) => q.state)).toEqual(['missing', 'missing', 'missing', 'missing', 'missing'])
    expect(none.unknown).toMatchObject({ ms: null, state: 'missing' })
    const some = classified({ ...classTotals([]), queue: 40, review: 10, unknown: 50 }, 100, 'single', true)
    expect(some.waits.queue).toMatchObject({ quantity: 'classified_wait', ms: 40, state: 'observed', open: true, coverage: { covered: 50, of: 100 } })
    expect(some.waits.review.ms).toBe(10)
    expect(some.unknown).toMatchObject({ quantity: 'unclassified', ms: 50, state: 'observed' })
  })
})
