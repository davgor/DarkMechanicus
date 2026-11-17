/**
 * Interval arithmetic, classification and quantity builders for the timing projection (`./timing.ts`). Times are
 * epoch milliseconds; every interval is half-open `[start, end)` and empty when `end <= start`.
 */
import {
  type SegmentEvidence,
  type SegmentReason,
  type TimingAggregation,
  type TimingClass,
  type TimingCoverage,
  type TimingQuantity,
  type TimingQuantityKind,
  type TimingSegment,
  type TimingState,
  WAIT_CLASSES,
  type WaitTotals
} from '../../shared/domain/timing'

export interface Interval {
  start: number
  end: number
}

const DAY_MS = 86_400_000
/** The last day `Date#toISOString` writes with a four-digit year (9999-12-31). */
const LAST_FOUR_DIGIT_DAY = 2_932_896
const dayPrefixes = new Map<number, string>()
const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
const pad3 = (n: number): string => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`)

/**
 * `new Date(ms).toISOString()`, byte for byte, about five times faster: the date part is formatted once per day
 * and the time of day by arithmetic. Projections format tens of thousands of segment boundaries. A fractional
 * millisecond is truncated (as `Date` does), so the result is always a valid ISO time.
 */
export function iso(time: number): string {
  const ms = Math.trunc(time)
  const day = Math.floor(ms / DAY_MS)
  if (day < 0 || day > LAST_FOUR_DIGIT_DAY) return new Date(ms).toISOString()
  let prefix = dayPrefixes.get(day)
  if (prefix === undefined) {
    prefix = new Date(day * DAY_MS).toISOString().slice(0, 11)
    dayPrefixes.set(day, prefix)
  }
  const ofDay = ms - day * DAY_MS
  const hours = Math.floor(ofDay / 3_600_000)
  const minutes = Math.floor((ofDay % 3_600_000) / 60_000)
  const seconds = Math.floor((ofDay % 60_000) / 1000)
  return `${prefix}${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(ofDay % 1000)}Z`
}

/**
 * A tally of interval work: intervals visited by `union`, `length`, `subtract` (and its binary search) and `classify`,
 * and `clip` calls. A caller that passes one gets the work counted into it; tests use it to show the projection's work
 * grows linearly with its input.
 */
export interface IntervalWork {
  steps: number
}

function tally(work: IntervalWork | undefined, steps: number): void {
  if (work !== undefined) work.steps += steps
}

/** Sorted, merged, non-empty intervals. */
export function union(intervals: readonly Interval[], work?: IntervalWork): Interval[] {
  tally(work, intervals.length)
  const sorted = intervals.filter((iv) => iv.end > iv.start).sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Interval[] = []
  for (const iv of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end)
    } else {
      merged.push({ start: iv.start, end: iv.end })
    }
  }
  return merged
}

export function length(intervals: readonly Interval[], work?: IntervalWork): number {
  tally(work, intervals.length)
  return intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0)
}

export function clip(iv: Interval, window: Interval, work?: IntervalWork): Interval | null {
  tally(work, 1)
  const start = Math.max(iv.start, window.start)
  const end = Math.min(iv.end, window.end)
  return end > start ? { start, end } : null
}

/** The index of the first interval of `sorted` (sorted, merged) that ends after `at`. */
function firstEndingAfter(sorted: readonly Interval[], at: number, work: IntervalWork | undefined): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    tally(work, 1)
    const mid = (low + high) >>> 1
    if ((sorted[mid] as Interval).end <= at) low = mid + 1
    else high = mid
  }
  return low
}

/** `iv` minus every interval of `cuts` (sorted and merged); finds the first overlapping cut by binary search. */
export function subtract(iv: Interval, cuts: readonly Interval[], work?: IntervalWork): Interval[] {
  const pieces: Interval[] = []
  let cursor = iv.start
  for (let i = firstEndingAfter(cuts, iv.start, work); i < cuts.length && (cuts[i] as Interval).start < iv.end; i += 1) {
    tally(work, 1)
    const cut = cuts[i] as Interval
    if (cut.start > cursor) pieces.push({ start: cursor, end: cut.start })
    cursor = Math.max(cursor, cut.end)
  }
  if (cursor < iv.end) pieces.push({ start: cursor, end: iv.end })
  return pieces
}

/** The part of `iv` that `cuts` (sorted and merged) cover. */
export function overlap(iv: Interval, cuts: readonly Interval[], work?: IntervalWork): number {
  return iv.end - iv.start - length(subtract(iv, cuts, work), work)
}

// ---------------------------------------------------------------------------------------------------------------
// Classification

export interface Label {
  class: TimingClass
  reason: SegmentReason
  evidence: SegmentEvidence
}

/** An interval that claims a label; where layers overlap, the higher priority wins. */
export interface Layer extends Interval {
  priority: number
  label: Label
}

const labelKey = (label: Label): string => `${label.class}|${label.reason}|${label.evidence}`

/** A classified stretch in epoch milliseconds; `toTimingSegments` gives the ISO form. `key` names its label. */
export interface Segment extends Interval {
  label: Label
  key: string
}

/** The layers sharing one priority and label, with how many of them cover the current point. */
interface Group {
  key: string
  priority: number
  label: Label
  count: number
}

interface Edge {
  at: number
  delta: 1 | -1
  group: Group
}

/** Each layer's start and end inside the window, ends before starts at one instant; the distinct groups. */
function edgesOf(window: Interval, layers: readonly Layer[], work: IntervalWork | undefined): { edges: Edge[]; groups: Group[] } {
  const byKey = new Map<string, Group>()
  const edges: Edge[] = []
  for (const layer of layers) {
    const iv = clip(layer, window, work)
    if (iv === null) continue
    const key = labelKey(layer.label)
    const groupKey = `${layer.priority}|${key}`
    let group = byKey.get(groupKey)
    if (group === undefined) {
      group = { key, priority: layer.priority, label: layer.label, count: 0 }
      byKey.set(groupKey, group)
    }
    edges.push({ at: iv.start, delta: 1, group }, { at: iv.end, delta: -1, group })
  }
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta)
  return { edges, groups: [...byKey.values()].sort((a, b) => b.priority - a.priority) }
}

/** The highest-priority group covering the current point (groups are sorted by priority, and few). */
function winner(groups: readonly Group[]): Group | null {
  for (const group of groups) if (group.count > 0) return group
  return null
}

/**
 * Splits `window` into segments, each taking the label of the highest-priority layer covering it (`fallback`
 * where none does). The segments cover the window exactly once, so their lengths add up to the window's.
 * One sort of the layer edges, then one pass.
 */
export function classify(window: Interval, layers: readonly Layer[], fallback: Label, work?: IntervalWork): Segment[] {
  if (window.end <= window.start) return []
  const { edges, groups } = edgesOf(window, layers, work)
  const fallbackKey = labelKey(fallback)
  const segments: Segment[] = []
  let i = 0
  for (let from = window.start; from < window.end; ) {
    tally(work, 1)
    while (i < edges.length && (edges[i] as Edge).at <= from) {
      const edge = edges[i] as Edge
      edge.group.count += edge.delta
      i += 1
    }
    const to = Math.min(i < edges.length ? (edges[i] as Edge).at : window.end, window.end)
    const best = winner(groups)
    const key = best === null ? fallbackKey : best.key
    const last = segments[segments.length - 1]
    if (last !== undefined && last.key === key) last.end = to
    else segments.push({ start: from, end: to, label: best === null ? fallback : best.label, key })
    from = to
  }
  return segments
}

/** Appends a segment, extending the previous one when it has the same label. */
export function appendSegment(segments: Segment[], segment: Segment): void {
  const last = segments[segments.length - 1]
  if (last !== undefined && last.key === segment.key && last.end === segment.start) last.end = segment.end
  else segments.push({ ...segment })
}

/** The part of `segments` inside `window`. */
export function within(segments: readonly Segment[], window: Interval, work?: IntervalWork): Segment[] {
  const out: Segment[] = []
  for (const segment of segments) {
    const iv = clip(segment, window, work)
    if (iv !== null) out.push({ ...segment, start: iv.start, end: iv.end })
  }
  return out
}

export function toTimingSegments(segments: readonly Segment[]): TimingSegment[] {
  return segments.map(({ start, end, label }) => ({ class: label.class, reason: label.reason, evidence: label.evidence, start: iso(start), end: iso(end), ms: end - start }))
}

export type ClassTotals = Record<TimingClass, number>

export function classTotals(segments: readonly Segment[]): ClassTotals {
  const totals: ClassTotals = { active: 0, queue: 0, build_test: 0, blocked: 0, review: 0, human_approval: 0, unknown: 0 }
  for (const segment of segments) totals[segment.label.class] += segment.end - segment.start
  return totals
}

// ---------------------------------------------------------------------------------------------------------------
// Quantities

interface QuantityParts {
  aggregation: TimingAggregation
  /** Null (or state `missing`) makes the quantity missing: no number, nothing covered. */
  ms: number | null
  state: TimingState
  coverage: TimingCoverage
  open: boolean
}

export function quantity<K extends TimingQuantityKind>(kind: K, parts: QuantityParts): TimingQuantity<K> {
  const { aggregation, ms, state, coverage, open } = parts
  if (ms === null || state === 'missing') {
    return { quantity: kind, unit: 'milliseconds', aggregation, ms: null, state: 'missing', coverage: { ...coverage, covered: 0 }, open }
  }
  return { quantity: kind, unit: 'milliseconds', aggregation, ms: Math.max(0, ms), state, coverage, open }
}

/** A quantity with nothing to measure it by: never zero, never covered. */
export function missing<K extends TimingQuantityKind>(kind: K, unit: TimingCoverage['unit'], aggregation: TimingAggregation = 'single'): TimingQuantity<K> {
  return quantity(kind, { aggregation, ms: null, state: 'missing', coverage: { covered: 0, of: 0, unit }, open: false })
}

/** Classified milliseconds of a window `of` milliseconds long. */
export function msCoverage(totals: ClassTotals, of: number): TimingCoverage {
  return { covered: Math.max(0, of - totals.unknown), of, unit: 'milliseconds' }
}

/**
 * One quantity per wait class, plus the unknown time, over windows `of` milliseconds long in all. With no window
 * (`of` 0) there is nothing classified, so every one is missing rather than a covered zero.
 */
export function classified(totals: ClassTotals, of: number, aggregation: TimingAggregation, open: boolean): { waits: WaitTotals; unknown: TimingQuantity<'unclassified'> } {
  const coverage = msCoverage(totals, of)
  const state = of === 0 ? 'missing' : 'observed'
  const waits = {} as WaitTotals
  for (const kind of WAIT_CLASSES) {
    waits[kind] = quantity('classified_wait', { aggregation, ms: totals[kind], state, coverage, open })
  }
  return { waits, unknown: quantity('unclassified', { aggregation, ms: totals.unknown, state, coverage, open }) }
}
