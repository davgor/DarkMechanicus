import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { MetricObservation, UsageScope } from '../../shared/domain/space'
import {
  type AttemptTiming,
  type RunTiming,
  type TimingQuantity,
  type TimingSegment,
  WAIT_CLASSES
} from '../../shared/domain/timing'
import { projectTiming, type TimingEvent, type TimingInput } from './timing'
import type { IntervalWork } from './timingIntervals'

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/timing/', import.meta.url))
const MIN = 60_000
const RUN = 'rn_01m7gdve7p0000000000000001'
const SPRINT = 'sp_1'

interface Fixture {
  name: string
  description: string
  input: TimingInput
  expect: { path: string; equals: unknown }[]
}

/** Every checked-in timing fixture, read fresh for each caller so no test can change another's input. */
function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ name: file.replace(/\.json$/, ''), ...(JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as Omit<Fixture, 'name'>) }))
}

function fixture(name: string): Fixture {
  const found = loadFixtures().find((f) => f.name === name)
  if (found === undefined) throw new Error(`no timing fixture ${name}`)
  return found
}

const FIXTURE_NAMES = loadFixtures().map((f) => f.name)

/** Reads `a.b[0].c` paths; `anomalyCounts` is the anomalies counted by kind. */
function at(timing: RunTiming, path: string): unknown {
  if (path === 'anomalyCounts') {
    const counts: Record<string, number> = {}
    for (const anomaly of timing.anomalies) counts[anomaly.kind] = (counts[anomaly.kind] ?? 0) + 1
    return counts
  }
  let value: unknown = timing
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    value = value === null || value === undefined ? undefined : (value as Record<string, unknown>)[part]
  }
  return value
}

/** Every number in the projection, with its path. */
function numbers(value: unknown, path = ''): { path: string; value: number }[] {
  if (typeof value === 'number') return [{ path, value }]
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => numbers(child, path === '' ? key : `${path}.${key}`))
}

/** Every timing quantity in the projection, with its path. */
function quantities(value: unknown, path = ''): { path: string; q: TimingQuantity }[] {
  if (value === null || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (typeof record.quantity === 'string' && record.unit !== undefined) return [{ path, q: value as TimingQuantity }]
  return Object.entries(record).flatMap(([key, child]) => quantities(child, path === '' ? key : `${path}.${key}`))
}

/** A deterministic shuffle (mulberry32). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed
  const random = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let x = Math.imul(state ^ (state >>> 15), 1 | state)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/** Shuffles events freely; keeps each observation id's deliveries in their order (the first delivery wins by rule). */
function reorder(input: TimingInput, seed: number): TimingInput {
  const activity = shuffled(input.activity, seed)
  const byId = new Map<string, MetricObservation[]>()
  for (const o of input.activity) byId.set(o.observationId, [...(byId.get(o.observationId) ?? []), o])
  const next = new Map<string, number>()
  const stable = activity.map((o) => {
    const i = next.get(o.observationId) ?? 0
    next.set(o.observationId, i + 1)
    return (byId.get(o.observationId) ?? [])[i] ?? o
  })
  return { ...input, events: shuffled(input.events, seed * 7 + 1), activity: stable }
}

const canonical = (timing: RunTiming): RunTiming => ({ ...timing, anomalies: [...timing.anomalies].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })

/** Segment boundaries are contiguous from `start` to `end`, each positive and as long as its ISO ends say. */
function gaps(segments: readonly TimingSegment[], start: string, end: string): string[] {
  const problems: string[] = []
  if (segments.length === 0) return start === end ? [] : [`no segment covers ${start}..${end}`]
  if (segments[0]?.start !== start) problems.push(`starts at ${segments[0]?.start}, not ${start}`)
  if (segments.at(-1)?.end !== end) problems.push(`ends at ${segments.at(-1)?.end}, not ${end}`)
  segments.forEach((s, i) => {
    if (s.ms !== Date.parse(s.end) - Date.parse(s.start) || s.ms <= 0) problems.push(`segment ${i} is ${s.ms} ms over ${s.start}..${s.end}`)
    if (i > 0 && segments[i - 1]?.end !== s.start) problems.push(`gap or overlap before segment ${i}`)
  })
  return problems
}

function attemptParts(attempt: AttemptTiming): number {
  const waits = WAIT_CLASSES.reduce((sum, kind) => sum + (attempt.waits[kind].ms ?? 0), 0)
  return (attempt.active.ms ?? 0) + waits + (attempt.unknown.ms ?? 0)
}

// ---------------------------------------------------------------------------------------------------------------
// Inline inputs

const T = (hm: string): string => `2026-11-01T${hm}:00.000Z`

interface SpanOptions {
  attemptId?: string | null
  ticketId?: string | null
  kind?: 'host' | 'agent'
  actor?: string
  role?: string
  usage?: UsageScope
  /** The reported value; defaults to the span's length. */
  value?: number
  /** Leave out `spanStart`: the span is placed `value` before it was observed. */
  noStart?: boolean
  /** Makes it a `wait_ms` span of this kind. */
  waitKind?: string
}

/** The metric, attributes and usage a span's options ask for. */
function extrasOf(options: SpanOptions, from: string): Pick<MetricObservation, 'metric' | 'attributes' | 'usage'> {
  return {
    metric: options.waitKind === undefined ? 'active_ms' : 'wait_ms',
    attributes: { ...(options.noStart === true ? {} : { spanStart: from }), ...(options.role === undefined ? {} : { role: options.role }), ...(options.waitKind === undefined ? {} : { waitKind: options.waitKind }) },
    ...(options.usage === undefined ? {} : { usage: options.usage })
  }
}

/** A host (or agent) `active_ms` (or `wait_ms`) event over `from`..`to`, scoped to attempt `a1` of `tk1` unless told otherwise. */
function span(id: string, from: string, to: string, options: SpanOptions = {}): MetricObservation {
  const o = { attemptId: 'a1', kind: 'host' as const, actor: 'adapter', ...options }
  const attemptId = o.attemptId ?? null
  const ticketId = 'ticketId' in options ? (options.ticketId ?? null) : attemptId === null ? null : 'tk1'
  return {
    observationId: id,
    unit: 'milliseconds',
    scope: { level: attemptId === null ? 'run' : 'attempt', epicId: 'ep_1', sprintId: null, runId: RUN, ticketId, attemptId },
    source: { kind: o.kind, actor: o.actor },
    measurement: { state: 'observed', value: o.value ?? Date.parse(to) - Date.parse(from) },
    accumulation: 'event',
    sequence: null,
    observedAt: to,
    recordedAt: to,
    evidence: [],
    ...extrasOf(options, from)
  }
}

function claimed(attemptId: string, ticketId: string, when: string, number = 1): TimingEvent {
  return { kind: 'attempt_claimed', attemptId, ticketId, sprintId: SPRINT, number, carriedForward: false, at: when }
}

function input(parts: { events: TimingEvent[]; activity?: MetricObservation[]; tickets?: string[]; asOf?: string; start?: string }): TimingInput {
  const start = parts.start ?? T('09:00')
  return {
    runId: RUN,
    asOf: parts.asOf ?? T('12:00'),
    events: [{ kind: 'run_started', at: start }, { kind: 'sprint_activated', sprintId: SPRINT, at: start }, ...parts.events],
    activity: parts.activity ?? [],
    tickets: (parts.tickets ?? ['tk1']).map((ticketId) => ({ ticketId, sprintId: SPRINT }))
  }
}

/** `class/reason HH:MM-HH:MM`, so a whole timeline is one exact assertion. */
const outline = (segments: readonly TimingSegment[]): string[] => segments.map((s) => `${s.class}/${s.reason} ${s.start.slice(11, 16)}-${s.end.slice(11, 16)}`)

/** `class/evidence HH:MM-HH:MM`: which source each stretch of the timeline came from. */
const sources = (segments: readonly TimingSegment[]): string[] => segments.map((s) => `${s.class}/${s.evidence} ${s.start.slice(11, 16)}-${s.end.slice(11, 16)}`)

const onlyAttempt = (timing: RunTiming): AttemptTiming => {
  const attempt = timing.tickets[0]?.attempts[0]
  if (attempt === undefined) throw new Error('no attempt projected')
  return attempt
}

// ---------------------------------------------------------------------------------------------------------------

describe('DM-172 c1: interval projection on the checked-in deterministic clock fixtures', () => {
  it('loads every fixture the criterion names', () => {
    expect(FIXTURE_NAMES).toEqual([
      'carried-forward',
      'duplicates-out-of-order',
      'host-and-agent',
      'inclusive-parent-worker',
      'lease-expiry',
      'lease-resubmit',
      'missing-stop-run-ended',
      'missing-stop',
      'nested-usage',
      'overlapping-workers',
      'pause-resume',
      'renamed-sprint',
      'retries-and-unknown'
    ])
  })

  it.each(FIXTURE_NAMES)('%s: projects every checked-in expectation exactly', (name) => {
    const { input: given, expect: expectations } = fixture(name)
    const timing = projectTiming(given)
    const mismatches = expectations.filter((e) => !isDeepStrictEqual(at(timing, e.path), e.equals)).map((e) => `${e.path}: ${JSON.stringify(at(timing, e.path))}`)
    expect(mismatches).toEqual([])
    expect(expectations.length).toBeGreaterThan(2)
  })

  it.each(FIXTURE_NAMES)('%s: no negative number, and each attempt window is covered once by active, waits and unknown', (name) => {
    const timing = projectTiming(fixture(name).input)
    expect(numbers(timing).filter((n) => n.value < 0)).toEqual([])
    for (const ticket of timing.tickets) {
      for (const attempt of ticket.attempts) {
        expect(gaps(attempt.segments, attempt.claimedAt, attempt.endedAt ?? timing.asOf)).toEqual([])
        expect(attemptParts(attempt)).toBe(attempt.elapsed.ms)
        expect(attempt.active.ms ?? 0).toBeLessThanOrEqual(attempt.elapsed.ms ?? 0)
      }
      const first = ticket.segments[0]
      const last = ticket.segments.at(-1)
      if (first !== undefined && last !== undefined) expect(gaps(ticket.segments, first.start, last.end)).toEqual([])
    }
  })

  it.each(FIXTURE_NAMES)('%s: five shuffled arrival orders give the same projection', (name) => {
    const given = fixture(name).input
    const expected = canonical(projectTiming(given))
    for (const seed of [1, 2, 3, 4, 5]) expect(canonical(projectTiming(reorder(given, seed)))).toEqual(expected)
  })
})

describe('DM-172 c1: pause boundaries', () => {
  const paused = (activity: MetricObservation[]): TimingInput =>
    input({
      events: [claimed('a1', 'tk1', T('10:00')), { kind: 'run_paused', at: T('10:20') }, { kind: 'run_resumed', at: T('10:40') }, { kind: 'attempt_submitted', attemptId: 'a1', at: T('11:00') }],
      activity
    })

  it('a span starting at the exact instant a pause begins is not cut: all of it stays active, the rest of the pause is blocked', () => {
    const attempt = onlyAttempt(projectTiming(paused([span('mo_1', T('10:20'), T('10:25'))])))
    expect(outline(attempt.segments)).toEqual([
      'unknown/no_activity_evidence 10:00-10:20',
      'active/activity_span 10:20-10:25',
      'blocked/run_paused 10:25-10:40',
      'unknown/no_activity_evidence 10:40-11:00'
    ])
    expect(attempt.active.ms).toBe(5 * MIN)
    expect(attempt.waits.blocked.ms).toBe(15 * MIN)
  })

  it('a span starting inside a pause runs uncut past the resume to its own end', () => {
    const attempt = onlyAttempt(projectTiming(paused([span('mo_1', T('10:30'), T('10:50'))])))
    expect(outline(attempt.segments)).toEqual([
      'unknown/no_activity_evidence 10:00-10:20',
      'blocked/run_paused 10:20-10:30',
      'active/activity_span 10:30-10:50',
      'unknown/no_activity_evidence 10:50-11:00'
    ])
    expect(attempt.active.ms).toBe(20 * MIN)
    expect(attempt.waits.blocked.ms).toBe(10 * MIN)
  })

  it('a resume with no open pause is listed and classifies nothing as blocked', () => {
    const timing = projectTiming(input({ events: [claimed('a1', 'tk1', T('10:00')), { kind: 'run_resumed', at: T('10:20') }, { kind: 'attempt_submitted', attemptId: 'a1', at: T('11:00') }] }))
    expect(onlyAttempt(timing).waits.blocked.ms).toBe(0)
    expect(timing.anomalies.map((a) => a.kind)).toEqual(['event_out_of_place'])
  })
})

describe('DM-172 c1: missing stops, lease expiry, duplicates and overlap', () => {
  it('an attempt with no stop event runs to the cutoff, open, and its unreported time stays unknown, never active', () => {
    const attempt = onlyAttempt(projectTiming(input({ events: [claimed('a1', 'tk1', T('10:00'))], asOf: T('10:30') })))
    expect(attempt.endedAt).toBeNull()
    expect(attempt.endedBy).toBe('cutoff')
    expect(attempt.elapsed).toMatchObject({ ms: 30 * MIN, open: true })
    expect(attempt.active).toMatchObject({ ms: null, state: 'missing' })
    expect(attempt.unknown.ms).toBe(30 * MIN)
  })

  it('a lease expiry ends the attempt at its deadline; the time after the last signal is unknown', () => {
    const timing = projectTiming(
      input({
        events: [claimed('a1', 'tk1', T('10:00')), { kind: 'attempt_signal', attemptId: 'a1', at: T('10:05') }, { kind: 'attempt_lease_expired', attemptId: 'a1', at: T('10:25') }],
        activity: [span('mo_1', T('10:00'), T('10:10'))]
      })
    )
    const attempt = onlyAttempt(timing)
    expect(attempt.endedAt).toBe(T('10:25'))
    expect(attempt.outcome).toBe('lease_expired')
    expect(attempt.lastSignalAt).toBe(T('10:10'))
    expect(outline(attempt.segments)).toEqual(['active/activity_span 10:00-10:10', 'unknown/after_last_signal 10:10-10:25'])
  })

  it('a repeated terminal event is listed and the first one ends the attempt', () => {
    const timing = projectTiming(
      input({ events: [claimed('a1', 'tk1', T('10:00')), { kind: 'attempt_submitted', attemptId: 'a1', at: T('10:40') }, { kind: 'attempt_submitted', attemptId: 'a1', at: T('10:50') }] })
    )
    expect(onlyAttempt(timing).elapsed.ms).toBe(40 * MIN)
    expect(timing.anomalies.map((a) => a.kind)).toEqual(['event_out_of_place'])
  })
})

describe('DM-172 c1: duplicate, overlapping and inverted inputs', () => {
  it('an exact repeat of an event is dropped as a duplicate', () => {
    const submit: TimingEvent = { kind: 'attempt_submitted', attemptId: 'a1', at: T('10:40') }
    const timing = projectTiming(input({ events: [claimed('a1', 'tk1', T('10:00')), submit, submit] }))
    expect(onlyAttempt(timing).submittedAt).toBe(T('10:40'))
    expect(timing.anomalies).toEqual([{ kind: 'duplicate_event', subject: 'a1', detail: `attempt_submitted at ${T('10:40')}` }])
  })

  it('overlapping spans of one stream count once in active time and in effort', () => {
    const timing = projectTiming(
      input({
        events: [claimed('a1', 'tk1', T('10:00')), { kind: 'attempt_submitted', attemptId: 'a1', at: T('11:00') }],
        activity: [span('mo_1', T('10:00'), T('10:40')), span('mo_2', T('10:20'), T('10:50'))]
      })
    )
    expect(onlyAttempt(timing).active.ms).toBe(50 * MIN)
    expect(timing.effort.total.ms).toBe(50 * MIN)
  })

  it('an inverted span is refused, not read as negative time', () => {
    const inverted = span('mo_1', T('10:30'), T('10:10'), { value: 20 * MIN })
    const timing = projectTiming(input({ events: [claimed('a1', 'tk1', T('10:00')), { kind: 'attempt_submitted', attemptId: 'a1', at: T('11:00') }], activity: [inverted] }))
    expect(onlyAttempt(timing).active.state).toBe('missing')
    expect(timing.effort.total.ms).toBeNull()
    expect(timing.anomalies.map((a) => a.kind)).toEqual(['negative_span'])
  })
})

describe('DM-172 c1: an adoption that renames the active sprint (renamed-sprint fixture)', () => {
  it('the time tickets waited under the old sprint id lands in the renamed sprint, none in no window', () => {
    const timing = projectTiming(fixture('renamed-sprint').input)
    const renamed = timing.sprints[0]
    expect(timing.sprints.map((s) => s.sprintId)).toEqual(['sp_01m452vt120000000000000005', 'sp_01m452vt120000000000000002'])
    expect(renamed?.startedAt).toBe('2026-11-01T09:00:00.000Z')
    const ticketQueue = timing.tickets.reduce((sum, t) => sum + (t.segments.filter((s) => s.class === 'queue').reduce((n, s) => n + s.ms, 0)), 0)
    expect(ticketQueue).toBe(630 * MIN)
    expect(renamed?.waits.queue.ms).toBe(630 * MIN)
    expect(timing.waits.queue.ms).toBe(630 * MIN)
    expect(timing.tickets.slice(0, 3).map((t) => t.sprintId)).toEqual(Array(3).fill('sp_01m452vt120000000000000005'))
  })

  it('without the alias, the old sprint id would be its own sprint: the mapping is what moves the time', () => {
    const given = fixture('renamed-sprint').input
    const timing = projectTiming({ ...given, sprintAliases: {} })
    expect(timing.sprints.map((s) => s.sprintId)).toContain('sp_01m452vt120000000000000001')
  })
})

/** The quantity kind each field of the projection holds (wait classes and attempt `elapsed` are decided by path). */
const KIND_OF_FIELD: Record<string, string> = {
  cycleTime: 'ticket_cycle_time',
  leadTime: 'ticket_lead_time',
  elapsed: 'window_elapsed',
  active: 'measured_active',
  unknown: 'unclassified',
  waitBeforeDispatch: 'classified_wait',
  checkpointWait: 'classified_wait',
  inFlight: 'in_flight_wall_clock',
  activeWallClock: 'active_wall_clock',
  attemptElapsedSum: 'attempt_elapsed',
  total: 'resource_effort',
  overhead: 'resource_effort',
  unattributedOverhead: 'resource_effort'
}

function kindProblems(path: string, q: TimingQuantity): string[] {
  const field = path.split('.').at(-1) ?? ''
  const want = /attempts\.\d+\.elapsed$/.test(path) ? 'attempt_elapsed' : (WAIT_CLASSES as readonly string[]).includes(field) ? 'classified_wait' : KIND_OF_FIELD[field]
  return q.quantity === want && q.unit === 'milliseconds' ? [] : [`${path}: ${q.quantity} in ${q.unit}, expected ${want}`]
}

function stateProblems(path: string, q: TimingQuantity): string[] {
  const consistent = q.state === 'missing' ? q.ms === null && q.coverage.covered === 0 : q.ms !== null && q.coverage.covered <= q.coverage.of
  return consistent ? [] : [`${path}: ${q.state} with ms ${q.ms}, covered ${q.coverage.covered}/${q.coverage.of}`]
}

describe('DM-172 c2: units and coverage keep cycle, elapsed, active and wait time apart', () => {
  it('the four named measures are four distinct quantity kinds with their own coverage units (lease-expiry)', () => {
    const timing = projectTiming(fixture('lease-expiry').input)
    const ticket = timing.tickets[0]
    const attempt = ticket?.attempts[0]
    expect([ticket?.cycleTime.quantity, attempt?.elapsed.quantity, attempt?.active.quantity, ticket?.waits.queue.quantity]).toEqual([
      'ticket_cycle_time',
      'attempt_elapsed',
      'measured_active',
      'classified_wait'
    ])
    expect([attempt?.elapsed.coverage.unit, ticket?.waits.queue.coverage.unit, attempt?.active.coverage.unit]).toEqual(['milliseconds', 'milliseconds', 'attempts'])
    expect(attempt?.elapsed.coverage).toEqual({ covered: 10 * MIN, of: 25 * MIN, unit: 'milliseconds' })
    expectTypeOf<TimingQuantity<'attempt_elapsed'>>().not.toEqualTypeOf<TimingQuantity<'measured_active'>>()
    expectTypeOf<TimingQuantity<'ticket_cycle_time'>>().not.toMatchTypeOf<TimingQuantity<'classified_wait'>>()
    expectTypeOf<TimingQuantity<'resource_effort'>>().not.toMatchTypeOf<TimingQuantity<'in_flight_wall_clock'>>()
    expectTypeOf<TimingQuantity<'measured_active'>['unit']>().toEqualTypeOf<'milliseconds'>()
  })

  it.each(FIXTURE_NAMES)('%s: every quantity names the kind its field holds, in milliseconds; missing ones are null and cover nothing', (name) => {
    const found = quantities(projectTiming(fixture(name).input))
    expect(found.length).toBeGreaterThan(10)
    expect(found.flatMap(({ path, q }) => [...kindProblems(path, q), ...stateProblems(path, q)])).toEqual([])
  })
})

describe('DM-172 c2/c4: missing measures stay missing', () => {
  it('with no readiness and no activity, lead time, active time, effort and overhead are missing with nothing covered', () => {
    const timing = projectTiming({ runId: RUN, asOf: T('12:00'), events: [claimed('a1', 'tk1', T('10:00'))], activity: [] })
    const ticket = timing.tickets[0]
    for (const q of [ticket?.leadTime, ticket?.active, ticket?.effort.total, timing.effort.overhead]) {
      expect(q).toMatchObject({ state: 'missing', ms: null, coverage: { covered: 0 } })
    }
  })

  it('with no attempt at all, effort, wall clocks, elapsed sum and an unclaimed ticket\'s cycle waits are missing, never an observed 0', () => {
    const timing = projectTiming(input({ events: [] }))
    const ticket = timing.tickets[0]
    for (const q of [timing.effort.total, timing.effort.overhead, timing.inFlight, timing.activeWallClock, timing.attemptElapsedSum, ticket?.effort.total, ticket?.cycleTime, ticket?.waits.queue, ticket?.unknown]) {
      expect(q).toMatchObject({ state: 'missing', ms: null })
    }
  })
})

describe('DM-172 c2 (review #18): a missing measure never reads as fully covered', () => {
  const claimless = (): TimingInput =>
    input({
      events: [
        claimed('a1', 'tk1', T('10:00')),
        { kind: 'attempt_submitted', attemptId: 'a1', at: T('10:30') },
        { kind: 'attempt_rejected', attemptId: 'a1', at: T('10:40') },
        { kind: 'attempt_submitted', attemptId: 'ghost', at: T('10:50') },
        { kind: 'run_ended', at: T('11:00') }
      ],
      activity: [span('mo_1', T('10:00'), T('10:30'))]
    })

  it('an attempt with events but no claim leaves the run wall clocks, elapsed sum and effort partial: covered 1 of 2 attempts', () => {
    const timing = projectTiming(claimless())
    expect(timing.inFlight).toMatchObject({ ms: 30 * MIN, state: 'partial', coverage: { covered: 1, of: 2, unit: 'attempts' } })
    expect(timing.activeWallClock).toMatchObject({ ms: 30 * MIN, state: 'partial', coverage: { covered: 1, of: 2, unit: 'attempts' } })
    expect(timing.attemptElapsedSum).toMatchObject({ ms: 30 * MIN, state: 'partial' })
    expect(timing.effort.total).toMatchObject({ ms: 30 * MIN, state: 'partial', coverage: { covered: 1, of: 2, unit: 'attempts' } })
    expect(timing.anomalies.map((a) => [a.kind, a.subject])).toEqual([['attempt_without_claim', 'ghost']])
  })

  it('the sprint, which cannot hold the claimless attempt, stays fully covered by its one claimed attempt', () => {
    const sprint = projectTiming(claimless()).sprints[0]
    expect(sprint?.inFlight).toMatchObject({ state: 'observed', coverage: { covered: 1, of: 1 } })
  })

  it('with only a claimless attempt, the in-flight wall clock is missing and reports 0 of 1 attempts covered', () => {
    const timing = projectTiming(input({ events: [{ kind: 'attempt_submitted', attemptId: 'ghost', at: T('10:50') }] }))
    expect(timing.inFlight).toEqual({ quantity: 'in_flight_wall_clock', unit: 'milliseconds', aggregation: 'union', ms: null, state: 'missing', coverage: { covered: 0, of: 1, unit: 'attempts' }, open: false })
  })

  it('the cycle time of a ticket the ended run never finished ends with the run and counts its unknown time as uncovered', () => {
    const base = claimless()
    const ticket = projectTiming({ ...base, activity: [] }).tickets[0]
    expect(ticket?.endedBy).toBe('run_ended')
    expect(ticket?.acceptedAt).toBeNull()
    expect(ticket?.cycleTime).toMatchObject({ ms: 60 * MIN, open: false, coverage: { covered: 30 * MIN, of: 60 * MIN } })
    expect(ticket?.unknown.ms).toBe(30 * MIN)
  })
})

describe('DM-172 c1: fractional milliseconds', () => {
  it('a fractional active_ms with no start is placed on whole milliseconds and gives valid ISO times', () => {
    const fractional = span('mo_1', T('10:00'), '2026-11-01T10:01:30.000Z', { value: 90_000.75, noStart: true })
    const attempt = onlyAttempt(projectTiming(input({ events: [claimed('a1', 'tk1', T('10:00')), { kind: 'attempt_submitted', attemptId: 'a1', at: T('10:05') }], activity: [fractional] })))
    expect(attempt.segments[0]).toEqual({ class: 'active', reason: 'activity_span', evidence: 'host', start: '2026-11-01T10:00:00.000Z', end: '2026-11-01T10:01:30.000Z', ms: 90_000 })
    expect(attempt.active.ms).toBe(90_000)
    expect(attempt.segments.flatMap((s) => [s.start, s.end]).filter((iso) => new Date(iso).toISOString() !== iso)).toEqual([])
  })

  it('a fractional value with a stated start keeps the stated boundaries', () => {
    const fractional = span('mo_1', '2026-11-01T10:00:00.250Z', '2026-11-01T10:01:30.500Z', { value: 90_250.4 })
    const attempt = onlyAttempt(projectTiming(input({ events: [claimed('a1', 'tk1', T('10:00')), { kind: 'attempt_submitted', attemptId: 'a1', at: T('10:05') }], activity: [fractional] })))
    expect(attempt.segments[1]).toMatchObject({ class: 'active', start: '2026-11-01T10:00:00.250Z', end: '2026-11-01T10:01:30.500Z', ms: 90_250 })
  })
})

describe('DM-172 c1/c3: host and agent spans of one attempt', () => {
  const run = (activity: MetricObservation[]): RunTiming =>
    projectTiming(input({ events: [claimed('a1', 'tk1', T('10:00')), { kind: 'attempt_submitted', attemptId: 'a1', at: T('11:00') }], activity }))

  it('host 10:00-10:10 and agent 10:20-11:00 do not overlap: both count, 50 minutes, the gap is not merged', () => {
    const timing = run([span('mo_h', T('10:00'), T('10:10')), span('mo_a', T('10:20'), T('11:00'), { kind: 'agent' })])
    const attempt = onlyAttempt(timing)
    expect(attempt.active.ms).toBe(50 * MIN)
    expect(sources(attempt.segments)).toEqual(['active/host 10:00-10:10', 'unknown/none 10:10-10:20', 'active/agent 10:20-11:00'])
    expect(timing.effort.total.ms).toBe(50 * MIN)
    expect(timing.anomalies.filter((a) => a.kind === 'duplicate_source')).toEqual([])
  })

  it('where the agent overlaps the host, only the agent time the host does not cover counts, listed once', () => {
    const timing = run([span('mo_h', T('10:00'), T('10:30')), span('mo_a', T('10:20'), T('11:00'), { kind: 'agent' })])
    expect(sources(onlyAttempt(timing).segments)).toEqual(['active/host 10:00-10:30', 'active/agent 10:30-11:00'])
    expect(onlyAttempt(timing).active.ms).toBe(60 * MIN)
    expect(timing.effort.total.ms).toBe(60 * MIN)
    expect(timing.anomalies.filter((a) => a.kind === 'duplicate_source').map((a) => a.subject)).toEqual(['attempt:a1'])
  })
})

describe('DM-172 c1/c3: an agent self-report fills only time the host reported nothing for (review P1-P3)', () => {
  const halfHour = (activity: MetricObservation[]): RunTiming =>
    projectTiming(input({ events: [claimed('a1', 'tk1', T('10:00')), { kind: 'attempt_submitted', attemptId: 'a1', at: T('10:30') }], activity }))

  it('P1: a host-reported wait wins over the agent\'s activity: 20 active minutes, the 10-minute wait stays a wait', () => {
    const timing = halfHour([
      span('mo_h1', T('10:00'), T('10:10')),
      span('mo_w', T('10:10'), T('10:20'), { waitKind: 'queue' }),
      span('mo_h2', T('10:20'), T('10:30')),
      span('mo_a', T('10:00'), T('10:30'), { kind: 'agent' })
    ])
    const attempt = onlyAttempt(timing)
    expect(sources(attempt.segments)).toEqual(['active/host 10:00-10:10', 'queue/host 10:10-10:20', 'active/host 10:20-10:30'])
    expect(attempt.active.ms).toBe(20 * MIN)
    expect(attempt.waits.queue.ms).toBe(10 * MIN)
    expect(timing.effort.total.ms).toBe(20 * MIN)
  })

  it('P2: host turns with idle gaps; the agent fills only the gaps the host left unreported, labelled agent', () => {
    const timing = halfHour([span('mo_h1', T('10:00'), T('10:05')), span('mo_h2', T('10:20'), T('10:25')), span('mo_a', T('10:00'), T('10:30'), { kind: 'agent' })])
    const attempt = onlyAttempt(timing)
    expect(sources(attempt.segments)).toEqual(['active/host 10:00-10:05', 'active/agent 10:05-10:20', 'active/host 10:20-10:25', 'active/agent 10:25-10:30'])
    expect(attempt.active.ms).toBe(30 * MIN)
    expect(timing.effort.byRole.worker).toBe(30 * MIN)
  })

  it('P3: an inclusive agent worker around a host middle, with an unscoped sub-agent: 30 active minutes, effort counted once', () => {
    const timing = halfHour([
      span('mo_a', T('10:00'), T('10:30'), { kind: 'agent', actor: 'worker', usage: { coverage: 'inclusive', parentActor: null } }),
      span('mo_h', T('10:10'), T('10:20'), { actor: 'worker' }),
      span('mo_s', T('10:22'), T('10:28'), { actor: 'sub', attemptId: null, usage: { coverage: 'self', parentActor: 'worker' } })
    ])
    const attempt = onlyAttempt(timing)
    expect(sources(attempt.segments)).toEqual(['active/agent 10:00-10:10', 'active/host 10:10-10:20', 'active/agent 10:20-10:30'])
    expect(attempt.active.ms).toBe(30 * MIN)
    expect(timing.effort.byRole).toEqual({ worker: 24 * MIN, orchestrator: 0, reviewer: 0, other: 6 * MIN })
    expect(timing.effort.total.ms).toBe(30 * MIN)
  })

  it('a host wait outranks another identity\'s agent activity in one attempt: 20 waiting minutes, then 10 agent-active ones', () => {
    const handled = (observation: MetricObservation, handle: string): MetricObservation => ({ ...observation, attributes: { ...observation.attributes, handle } })
    const timing = halfHour([
      handled(span('mo_w', T('10:00'), T('10:20'), { waitKind: 'queue' }), 'host-worker'),
      handled(span('mo_a', T('10:10'), T('10:30'), { kind: 'agent' }), 'agent-worker')
    ])
    const attempt = onlyAttempt(timing)
    expect(sources(attempt.segments)).toEqual(['queue/host 10:00-10:20', 'active/agent 10:20-10:30'])
    expect(attempt.waits.queue.ms).toBe(20 * MIN)
    expect(attempt.active.ms).toBe(10 * MIN)
    expect(timing.anomalies.filter((a) => a.kind === 'duplicate_source')).toEqual([])
  })
})

describe('DM-172 c1/c3: nested usage', () => {
  it('an inclusive worker with an unscoped sub-agent is active over its whole window (80 of 80 minutes), effort counted once', () => {
    const timing = projectTiming(
      input({
        events: [claimed('a1', 'tk1', T('10:00')), { kind: 'attempt_submitted', attemptId: 'a1', at: T('11:20') }],
        activity: [
          span('mo_w', T('10:00'), T('11:20'), { actor: 'worker', usage: { coverage: 'inclusive', parentActor: null } }),
          span('mo_s', T('10:30'), T('10:50'), { actor: 'sub', attemptId: null, usage: { coverage: 'self', parentActor: 'worker' } })
        ]
      })
    )
    const attempt = onlyAttempt(timing)
    expect(attempt.active.ms).toBe(80 * MIN)
    expect(attempt.unknown.ms).toBe(0)
    expect(timing.effort.byRole).toEqual({ worker: 60 * MIN, orchestrator: 0, reviewer: 0, other: 20 * MIN })
    expect(timing.effort.total.ms).toBe(80 * MIN)
  })
})

describe('DM-172 c3: overlapping workers', () => {
  it('summed effort, the wall clocks and the window are distinct numbers; reviewer and orchestrator overhead stay visible', () => {
    const timing = projectTiming(
      input({
        start: T('09:50'),
        tickets: ['tk1', 'tk2'],
        events: [
          claimed('a1', 'tk1', T('10:00')),
          claimed('a2', 'tk2', T('10:30')),
          { kind: 'attempt_submitted', attemptId: 'a1', at: T('11:00') },
          { kind: 'attempt_submitted', attemptId: 'a2', at: T('11:30') }
        ],
        activity: [
          span('mo_o', T('09:50'), T('10:00'), { attemptId: null, role: 'orchestrator', actor: 'orchestrator-chat' }),
          span('mo_1', T('10:00'), T('11:00')),
          span('mo_2', T('10:30'), T('11:30'), { attemptId: 'a2', ticketId: 'tk2' }),
          span('mo_r', T('11:00'), T('11:10'), { role: 'reviewer', actor: 'reviewer-chat' })
        ]
      })
    )
    expect(timing.effort.byRole).toEqual({ worker: 120 * MIN, orchestrator: 10 * MIN, reviewer: 10 * MIN, other: 0 })
    expect(timing.effort.total).toMatchObject({ ms: 140 * MIN, aggregation: 'sum' })
    expect(timing.inFlight).toMatchObject({ ms: 90 * MIN, aggregation: 'union' })
    expect(timing.activeWallClock).toMatchObject({ ms: 100 * MIN, aggregation: 'union' })
    expect(timing.attemptElapsedSum).toMatchObject({ ms: 120 * MIN, aggregation: 'sum' })
    expect(timing.elapsed).toMatchObject({ ms: 130 * MIN, open: true })
    expect(timing.effort.overhead).toMatchObject({ ms: 20 * MIN, state: 'partial', coverage: { covered: 1, of: 2, unit: 'attempts' } })
    const sprint = timing.sprints[0]
    expect(sprint?.effort.total.ms).toBe(130 * MIN)
    expect(sprint?.unattributedOverhead.ms).toBe(10 * MIN)
    expect(timing.unattributedEffort.total.ms).toBe(10 * MIN)
  })
})

describe('DM-172 c4: failed, retried and superseded attempts keep their effort; unknown stays unknown', () => {
  const retried = (superseded: boolean): TimingInput =>
    input({
      events: [
        claimed('a1', 'tk1', T('10:00')),
        { kind: 'attempt_failed', attemptId: 'a1', at: T('10:20') },
        ...(superseded ? [{ kind: 'attempt_superseded', attemptId: 'a1', at: T('10:25') } as const] : []),
        claimed('a2', 'tk1', T('10:30'), 2),
        { kind: 'attempt_submitted', attemptId: 'a2', at: T('11:00') },
        { kind: 'attempt_accepted', attemptId: 'a2', at: T('11:10') }
      ],
      activity: [span('mo_2', T('10:30'), T('11:00'), { attemptId: 'a2' })]
    })

  it('a failed attempt that reported nothing has missing effort (null, never 0) and keeps its 20 unknown minutes', () => {
    const ticket = projectTiming(retried(false)).tickets[0]
    const failed = ticket?.attempts[0]
    expect(failed?.outcome).toBe('failed')
    expect(failed?.effort.total).toMatchObject({ ms: null, state: 'missing' })
    expect(failed?.active).toMatchObject({ ms: null, state: 'missing' })
    expect(failed?.unknown.ms).toBe(20 * MIN)
    expect(ticket?.effortByOutcome).toEqual({
      failed: { attempts: 1, elapsedMs: 20 * MIN, effortMs: 0, unreported: 1, unknownMs: 20 * MIN },
      accepted: { attempts: 1, elapsedMs: 30 * MIN, effortMs: 30 * MIN, unreported: 0, unknownMs: 0 }
    })
    expect(ticket?.effort.total).toMatchObject({ ms: 30 * MIN, state: 'partial', coverage: { covered: 1, of: 2 } })
    expect(ticket?.unknown.ms).toBe(20 * MIN)
    expect(ticket?.waits.queue.ms).toBe(10 * MIN)
  })

  it('a superseded attempt counts in the superseded bucket with its elapsed and unknown time', () => {
    const timing = projectTiming(retried(true))
    expect(timing.tickets[0]?.attempts[0]?.superseded).toBe(true)
    expect(timing.effortByOutcome.superseded).toEqual({ attempts: 1, elapsedMs: 20 * MIN, effortMs: 0, unreported: 1, unknownMs: 20 * MIN })
    expect(timing.effortByOutcome.failed).toBeUndefined()
    expect(timing.unknown.ms).toBe(20 * MIN)
  })
})

const T0 = Date.parse('2026-11-01T00:00:00.000Z')
const stamp = (ms: number): string => new Date(ms).toISOString()
const PERF_AS_OF = stamp(T0 + 400 * 86_400_000)
const RUN_STARTED: TimingEvent = { kind: 'run_started', at: stamp(T0) }

/** `n` attempts, two per ticket, each claimed, submitted and rejected, each with one 900 ms span. */
function manyAttempts(n: number): TimingInput {
  const events: TimingEvent[] = [RUN_STARTED]
  const activity: MetricObservation[] = []
  for (let i = 0; i < n; i += 1) {
    const claim = T0 + i * 600_000
    const ticketId = `tk_${i % (n / 2)}`
    events.push(
      { kind: 'attempt_claimed', attemptId: `a_${i}`, ticketId, sprintId: SPRINT, number: 1, carriedForward: false, at: stamp(claim) },
      { kind: 'attempt_submitted', attemptId: `a_${i}`, at: stamp(claim + 500_000) },
      { kind: 'attempt_rejected', attemptId: `a_${i}`, at: stamp(claim + 550_000) }
    )
    activity.push(span(`mo_${i}`, stamp(claim), stamp(claim + 900), { attemptId: `a_${i}`, ticketId }))
  }
  return { runId: RUN, asOf: PERF_AS_OF, events, activity }
}

/** One open attempt with `n` disjoint one-second host spans, and the agent reporting each half a second later. */
function oneAttempt(n: number, agent: boolean): TimingInput {
  const events: TimingEvent[] = [RUN_STARTED, { kind: 'attempt_claimed', attemptId: 'a1', ticketId: 'tk1', sprintId: SPRINT, number: 1, carriedForward: false, at: stamp(T0) }]
  const host = Array.from({ length: n }, (_, j) => span(`mo_${j}`, stamp(T0 + j * 2000), stamp(T0 + j * 2000 + 1000)))
  const reported = agent ? Array.from({ length: n }, (_, j) => span(`mo_a${j}`, stamp(T0 + j * 2000 + 500), stamp(T0 + j * 2000 + 1500), { kind: 'agent' })) : []
  return { runId: RUN, asOf: PERF_AS_OF, events, activity: [...host, ...reported] }
}

/** `n` inclusive orchestrator spans, each with a nested sub-agent span half inside it. */
function nested(n: number): TimingInput {
  const activity = Array.from({ length: n }, (_, j) => [
    span(`mo_p${j}`, stamp(T0 + j * 4000), stamp(T0 + j * 4000 + 1000), { attemptId: null, actor: 'orch', role: 'orchestrator', usage: { coverage: 'inclusive', parentActor: null } }),
    span(`mo_c${j}`, stamp(T0 + j * 4000 + 500), stamp(T0 + j * 4000 + 2500), { attemptId: null, actor: 'sub', usage: { coverage: 'self', parentActor: 'orch' } })
  ]).flat()
  return { runId: RUN, asOf: PERF_AS_OF, events: [RUN_STARTED], activity }
}

describe('DM-172 performance: 20,000 spans project to exact totals', () => {
  it('20,000 attempts with one span each: effort, elapsed sum and in-flight time are exact', () => {
    const timing = projectTiming(manyAttempts(20_000))
    expect(timing.effort.total.ms).toBe(20_000 * 900)
    expect(timing.attemptElapsedSum.ms).toBe(20_000 * 500_000)
    expect(timing.inFlight.ms).toBe(20_000 * 500_000)
    expect(timing.effortByOutcome.rejected).toEqual({ attempts: 20_000, elapsedMs: 20_000 * 500_000, effortMs: 20_000 * 900, unreported: 0, unknownMs: 20_000 * (500_000 - 900) })
  })

  it('one attempt with 20,000 disjoint spans: active time is their exact sum', () => {
    const attempt = onlyAttempt(projectTiming(oneAttempt(20_000, false)))
    expect(attempt.active.ms).toBe(20_000_000)
    expect(attempt.segments.filter((s) => s.class === 'active')).toHaveLength(20_000)
  })

  it('20,000 host spans each half-overlapped by an agent span: the agent adds only the uncovered half seconds', () => {
    const attempt = onlyAttempt(projectTiming(oneAttempt(20_000, true)))
    expect(attempt.active.ms).toBe(20_000 * 1500)
    expect(attempt.segments.filter((s) => s.evidence === 'agent').reduce((sum, s) => sum + s.ms, 0)).toBe(20_000 * 500)
  })

  it('10,000 inclusive parent spans with 10,000 nested child spans: the parent keeps only the time no child was active', () => {
    const timing = projectTiming(nested(10_000))
    expect(timing.effort.byRole).toEqual({ worker: 0, orchestrator: 10_000 * 500, reviewer: 0, other: 10_000 * 2000 })
  })
})

describe('DM-172 performance: interval work grows linearly (operation counts, no clock)', () => {
  const workOf = (given: TimingInput): number => {
    const work: IntervalWork = { steps: 0 }
    projectTiming(given, work)
    return work.steps
  }

  it.each([
    ['attempts with one span each', manyAttempts],
    ['one attempt with many spans', (n: number) => oneAttempt(n, false)],
    ['host spans overlapped by agent spans', (n: number) => oneAttempt(n, true)],
    ['inclusive parents with nested children', nested]
  ])('%s: the work for 20,000 is at most 2.2 times the work for 10,000', (_shape, shape) => {
    const small = workOf(shape(10_000))
    const large = workOf(shape(20_000))
    expect(small).toBeGreaterThan(10_000)
    expect(large / small).toBeLessThanOrEqual(2.2)
  })
})
