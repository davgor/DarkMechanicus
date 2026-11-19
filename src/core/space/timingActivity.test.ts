import { describe, expect, it } from 'vitest'
import type { MetricObservation } from '../../shared/domain/space'
import type { TimingAnomaly } from '../../shared/domain/timing'
import { effortOf, type Placed, prepareSpans, type Span } from './timingActivity'

const T = (hm: string): string => `2026-11-01T${hm}:00.000Z`
const ms = (hm: string): number => Date.parse(T(hm))
const MIN = 60_000
const AS_OF = ms('12:00')

type Edit = Omit<Partial<MetricObservation>, 'scope' | 'source'> & { scope?: Partial<MetricObservation['scope']>; source?: Partial<MetricObservation['source']> }

/** A host `active_ms` event over `from`..`to` for attempt `a1`, with any field replaced. */
function observation(id: string, from: string, to: string, edit: Edit = {}): MetricObservation {
  const { scope, source, ...rest } = edit
  return {
    observationId: id,
    metric: 'active_ms',
    unit: 'milliseconds',
    scope: { level: 'attempt', epicId: 'ep_1', sprintId: null, runId: 'rn_1', ticketId: 'tk1', attemptId: 'a1', ...scope },
    source: { kind: 'host', actor: 'adapter', ...source },
    measurement: { state: 'observed', value: ms(to) - ms(from) },
    accumulation: 'event',
    sequence: null,
    observedAt: T(to),
    recordedAt: T(to),
    attributes: { spanStart: T(from) },
    evidence: [],
    ...rest
  }
}

function prepare(activity: MetricObservation[]): { spans: Span[]; anomalies: TimingAnomaly[] } {
  const anomalies: TimingAnomaly[] = []
  return { spans: prepareSpans(activity, AS_OF, anomalies), anomalies }
}

const kinds = (anomalies: readonly TimingAnomaly[]): string[] => anomalies.map((a) => a.kind)

describe('DM-172 c1: activity spans are placed or refused, never guessed', () => {
  it('a host event becomes a worker span of its attempt with its own identity and stream', () => {
    const { spans, anomalies } = prepare([observation('mo_1', '10:00', '10:30')])
    expect(anomalies).toEqual([])
    expect(spans).toEqual([
      {
        start: ms('10:00'),
        end: ms('10:30'),
        covers: { start: ms('10:00'), end: ms('10:30') },
        observationId: 'mo_1',
        metric: 'active_ms',
        identity: 'attempt:a1',
        stream: 'host|adapter|attempt:a1',
        actor: 'adapter',
        role: 'worker',
        evidence: 'host',
        estimated: false,
        waitKind: null,
        attemptId: 'a1',
        ticketId: 'tk1',
        sprintId: null,
        inclusive: false,
        parentActor: null
      }
    ])
  })

  it('a stated role and handle decide the identity; an unknown role falls back to the scope', () => {
    const { spans } = prepare([
      observation('mo_1', '10:00', '10:10', { attributes: { spanStart: T('10:00'), role: 'reviewer', handle: 'rv-1' } }),
      observation('mo_2', '10:00', '10:10', { attributes: { spanStart: T('10:00'), role: 'orchestrator' }, scope: { attemptId: null } }),
      observation('mo_3', '10:00', '10:10', { attributes: { spanStart: T('10:00'), role: 'boss' }, scope: { attemptId: null } }),
      observation('mo_4', '10:00', '10:10', { attributes: { spanStart: T('10:00'), role: 'boss' }, source: { kind: 'agent' } })
    ])
    expect(spans.map((s) => [s.role, s.identity, s.evidence])).toEqual([
      ['reviewer', 'handle:rv-1', 'host'],
      ['orchestrator', 'role:orchestrator', 'host'],
      ['other', 'role:other', 'host'],
      ['worker', 'attempt:a1', 'agent']
    ])
  })
})

describe('DM-172 c1: where an activity span is placed', () => {
  it('a delta with a start is a span; a delta without one and a cumulative value are listed as not intervals', () => {
    const { spans, anomalies } = prepare([
      observation('mo_1', '10:00', '10:10', { accumulation: 'delta' }),
      observation('mo_2', '10:00', '10:10', { accumulation: 'delta', attributes: {} }),
      observation('mo_3', '10:00', '10:10', { accumulation: 'delta', attributes: { spanStart: null } }),
      observation('mo_4', '10:00', '10:10', { accumulation: 'cumulative' })
    ])
    expect(spans.map((s) => s.observationId)).toEqual(['mo_1'])
    expect(anomalies.map((a) => [a.kind, a.subject])).toEqual([
      ['not_an_interval', 'mo_2'],
      ['not_an_interval', 'mo_3'],
      ['not_an_interval', 'mo_4']
    ])
  })

  it('an event without a start is placed its value before it was observed', () => {
    const { spans } = prepare([observation('mo_1', '10:00', '10:30', { attributes: {} })])
    expect([spans[0]?.start, spans[0]?.end]).toEqual([ms('10:00'), ms('10:30')])
  })

  it('a missing measurement is skipped without an anomaly', () => {
    const { spans, anomalies } = prepare([observation('mo_1', '10:00', '10:10', { measurement: { state: 'missing', reason: 'not_reported' } })])
    expect(spans).toEqual([])
    expect(anomalies).toEqual([])
  })
})

describe('DM-172 c1: activity spans that are refused', () => {
  it('a span that disagrees with its value by more than a second is refused; exactly a second is accepted', () => {
    const { spans, anomalies } = prepare([
      observation('mo_1', '10:00', '10:10', { measurement: { state: 'observed', value: 10 * MIN + 1000 } }),
      observation('mo_2', '10:00', '10:10', { measurement: { state: 'observed', value: 10 * MIN + 1001 } }),
      observation('mo_3', '10:00', '10:10', { measurement: { state: 'observed', value: 10 * MIN - 1001 } })
    ])
    expect(spans.map((s) => s.observationId)).toEqual(['mo_1'])
    expect(anomalies.map((a) => [a.kind, a.subject])).toEqual([
      ['inconsistent_span', 'mo_2'],
      ['inconsistent_span', 'mo_3']
    ])
  })

  it('an inverted span and an unparseable time are refused', () => {
    const { spans, anomalies } = prepare([
      observation('mo_1', '10:00', '10:10', { attributes: { spanStart: T('10:20') } }),
      observation('mo_2', '10:00', '10:10', { attributes: { spanStart: 'yesterday' } }),
      observation('mo_3', '10:00', '10:10', { observedAt: 'later' })
    ])
    expect(spans).toEqual([])
    expect(kinds(anomalies)).toEqual(['negative_span', 'invalid_time', 'invalid_time'])
  })

  it('a wait span takes its known wait kind; an unknown kind is listed and dropped', () => {
    const { spans, anomalies } = prepare([
      observation('mo_1', '10:00', '10:10', { metric: 'wait_ms', attributes: { spanStart: T('10:00'), waitKind: 'build_test' } }),
      observation('mo_2', '10:00', '10:10', { metric: 'wait_ms', attributes: { spanStart: T('10:00'), waitKind: 'coffee' } })
    ])
    expect(spans.map((s) => [s.observationId, s.waitKind])).toEqual([['mo_1', 'build_test']])
    expect(anomalies.map((a) => [a.kind, a.subject])).toEqual([['unknown_wait_kind', 'mo_2']])
  })
})

describe('DM-172 c1: which records are activity', () => {
  it('records stored after the cutoff, server and human records and other metrics are not activity', () => {
    const { spans, anomalies } = prepare([
      observation('mo_1', '11:50', '12:10'),
      observation('mo_2', '10:00', '10:10', { source: { kind: 'server', actor: null } }),
      observation('mo_3', '10:00', '10:10', { source: { kind: 'human' } }),
      observation('mo_4', '10:00', '10:10', { metric: 'tokens_input' })
    ])
    expect(spans).toEqual([])
    expect(anomalies).toEqual([])
  })

  it('a span stored by the cutoff but running past it ends at the cutoff', () => {
    const { spans } = prepare([observation('mo_1', '11:50', '12:10', { recordedAt: T('11:55') })])
    expect([spans[0]?.end, spans[0]?.covers.end]).toEqual([AS_OF, AS_OF])
  })

  it('the first delivery of an id wins; a repeat is a duplicate and a different payload a conflict', () => {
    const first = observation('mo_1', '10:00', '10:10')
    const { spans, anomalies } = prepare([first, { ...first, recordedAt: T('11:00') }, observation('mo_1', '10:00', '10:20')])
    expect(spans.map((s) => s.end)).toEqual([ms('10:10')])
    expect(kinds(anomalies)).toEqual(['duplicate_event', 'conflicting_delivery'])
  })
})

describe('DM-172 c1/c3: host and agent reports of the same work', () => {
  it('an agent span loses only the time the host reports for the same identity', () => {
    const { spans, anomalies } = prepare([
      observation('mo_h', '10:00', '10:30'),
      observation('mo_a', '10:20', '11:00', { source: { kind: 'agent' } }),
      observation('mo_b', '11:10', '11:20', { source: { kind: 'agent' } })
    ])
    expect(spans.map((s) => [s.observationId, s.start, s.end, s.covers.start])).toEqual([
      ['mo_h', ms('10:00'), ms('10:30'), ms('10:00')],
      ['mo_a', ms('10:30'), ms('11:00'), ms('10:30')],
      ['mo_b', ms('11:10'), ms('11:20'), ms('11:10')]
    ])
    expect(anomalies.map((a) => [a.kind, a.subject])).toEqual([['duplicate_source', 'attempt:a1']])
  })

  it('an agent span fully covered by the host is dropped, listed once per identity', () => {
    const { spans, anomalies } = prepare([
      observation('mo_h', '10:00', '11:00'),
      observation('mo_a', '10:00', '10:30', { source: { kind: 'agent' } }),
      observation('mo_b', '10:30', '11:00', { source: { kind: 'agent' } })
    ])
    expect(spans.map((s) => s.observationId)).toEqual(['mo_h'])
    expect(kinds(anomalies)).toEqual(['duplicate_source'])
  })

  it('outside an attempt, the host reporting the same actor under another role still wins', () => {
    const run = { attemptId: null, ticketId: null }
    const { spans, anomalies } = prepare([
      observation('mo_h', '10:00', '10:30', { scope: run }),
      observation('mo_a', '10:00', '10:30', { scope: run, source: { kind: 'agent' }, attributes: { spanStart: T('10:00'), role: 'orchestrator' } })
    ])
    expect(spans.map((s) => s.observationId)).toEqual(['mo_h'])
    expect(anomalies.map((a) => a.detail)).toEqual(["active_ms overlaps what the host reported (actor:adapter); the agent's report counts only where the host reported nothing"])
  })

  it('an agent span of another identity is kept whole', () => {
    const { spans, anomalies } = prepare([observation('mo_h', '10:00', '11:00'), observation('mo_a', '10:00', '11:00', { source: { kind: 'agent' }, scope: { attemptId: 'a2' } })])
    expect(spans.map((s) => s.observationId)).toEqual(['mo_h', 'mo_a'])
    expect(anomalies).toEqual([])
  })
})

describe('DM-172 c1/c3: nested usage', () => {
  const inclusive = { coverage: 'inclusive', parentActor: null } as const

  it('an inclusive parent keeps only the time no descendant was active, and covers its whole span', () => {
    const { spans } = prepare([
      observation('mo_p', '10:00', '11:00', { source: { actor: 'parent' }, usage: inclusive }),
      observation('mo_c', '10:10', '10:20', { source: { actor: 'child' }, usage: { coverage: 'self', parentActor: 'parent' } }),
      observation('mo_g', '10:40', '10:50', { source: { actor: 'grandchild' }, usage: { coverage: 'self', parentActor: 'child' } })
    ])
    const parent = spans.filter((s) => s.observationId === 'mo_p')
    expect(parent.map((s) => [s.start, s.end])).toEqual([
      [ms('10:00'), ms('10:10')],
      [ms('10:20'), ms('10:40')],
      [ms('10:50'), ms('11:00')]
    ])
    expect(parent.map((s) => s.covers)).toEqual(Array(3).fill({ start: ms('10:00'), end: ms('11:00') }))
  })

  it('a self-reporting parent is not cut by its children', () => {
    const { spans } = prepare([
      observation('mo_p', '10:00', '11:00', { source: { actor: 'parent' }, usage: { coverage: 'self', parentActor: null } }),
      observation('mo_c', '10:10', '10:20', { source: { actor: 'child' }, usage: { coverage: 'self', parentActor: 'parent' } })
    ])
    expect(spans.filter((s) => s.observationId === 'mo_p').map((s) => [s.start, s.end])).toEqual([[ms('10:00'), ms('11:00')]])
  })

  it('a parent cycle is cut, not followed forever', () => {
    const { spans } = prepare([
      observation('mo_a', '10:00', '11:00', { source: { actor: 'a' }, usage: { coverage: 'inclusive', parentActor: 'b' } }),
      observation('mo_b', '10:30', '10:40', { source: { actor: 'b' }, usage: { coverage: 'inclusive', parentActor: 'a' } })
    ])
    expect(spans.map((s) => [s.observationId, s.start, s.end])).toEqual([
      ['mo_a', ms('10:00'), ms('10:30')],
      ['mo_a', ms('10:40'), ms('11:00')],
      ['mo_b', ms('10:30'), ms('10:40')]
    ])
  })
})

/** Each span placed whole in the `accepted` bucket. */
const placedOf = (activity: MetricObservation[]): Placed[] => prepare(activity).spans.map((span) => ({ span, piece: { start: span.start, end: span.end }, bucket: 'accepted' }))

describe('DM-172 c3/c4: effort sums streams and keeps missing apart from zero', () => {
  it('no span is missing effort, never zero', () => {
    const { totals, byBucket } = effortOf([], { attempts: 1, reporting: 0, reviewed: new Set() })
    expect(totals.total).toMatchObject({ ms: null, state: 'missing', coverage: { covered: 0, of: 1, unit: 'attempts' } })
    expect(totals.overhead).toMatchObject({ ms: null, state: 'missing' })
    expect(totals.byRole).toEqual({ worker: 0, orchestrator: 0, reviewer: 0, other: 0 })
    expect(byBucket.size).toBe(0)
  })

  it('two parallel streams add up; one stream overlapping itself counts once', () => {
    const placed = placedOf([
      observation('mo_1', '10:00', '11:00'),
      observation('mo_2', '10:30', '10:45'),
      observation('mo_3', '10:30', '11:30', { scope: { attemptId: 'a2' } })
    ])
    const { totals } = effortOf(placed, { attempts: 2, reporting: 2, reviewed: new Set() })
    expect(totals.total).toMatchObject({ ms: 120 * MIN, state: 'observed', aggregation: 'sum', coverage: { covered: 2, of: 2 } })
    expect(totals.byRole.worker).toBe(120 * MIN)
  })

  it('effort is partial when an attempt in scope reported nothing, estimated when a span was estimated', () => {
    const partial = effortOf(placedOf([observation('mo_1', '10:00', '10:10')]), { attempts: 2, reporting: 1, reviewed: new Set() })
    expect(partial.totals.total.state).toBe('partial')
    const estimated = effortOf(placedOf([observation('mo_1', '10:00', '10:10', { measurement: { state: 'estimated', value: 10 * MIN, method: 'transcript' } })]), { attempts: 1, reporting: 1, reviewed: new Set() })
    expect(estimated.totals.total.state).toBe('estimated')
  })

  it('span time outside its window is reported apart and not counted', () => {
    const span = prepare([observation('mo_1', '10:00', '11:00')]).spans[0] as Span
    const { totals, byBucket } = effortOf([{ span, piece: { start: ms('10:00'), end: ms('10:20') }, bucket: 'failed' }], { attempts: 1, reporting: 1, reviewed: new Set() })
    expect(totals.total.ms).toBe(20 * MIN)
    expect(totals.outsideWindowMs).toBe(40 * MIN)
    expect([...byBucket]).toEqual([['failed', 20 * MIN]])
  })
})

describe('DM-172 c3/c4: effort shares and overhead', () => {
  it('a span reported under two buckets is credited once, to the earliest piece', () => {
    const span = prepare([observation('mo_1', '10:00', '11:00')]).spans[0] as Span
    const { totals, byBucket } = effortOf(
      [
        { span, piece: { start: ms('10:00'), end: ms('11:00') }, bucket: 'rejected' },
        { span, piece: { start: ms('10:30'), end: ms('11:00') }, bucket: 'accepted' }
      ],
      { attempts: 2, reporting: 2, reviewed: new Set() }
    )
    expect(totals.total.ms).toBe(60 * MIN)
    expect([...byBucket]).toEqual([['rejected', 60 * MIN]])
  })

  it('overhead covers the reviewed attempts that have an overhead span: 1 of 2 is partial', () => {
    const placed = placedOf([
      observation('mo_w', '10:00', '11:00'),
      observation('mo_r', '11:00', '11:10', { attributes: { spanStart: T('11:00'), role: 'reviewer' } })
    ])
    const { totals } = effortOf(placed, { attempts: 2, reporting: 2, reviewed: new Set(['a1', 'a2']) })
    expect(totals.overhead).toMatchObject({ ms: 10 * MIN, state: 'partial', coverage: { covered: 1, of: 2, unit: 'attempts' } })
    expect(totals.byRole).toEqual({ worker: 60 * MIN, orchestrator: 0, reviewer: 10 * MIN, other: 0 })
    const all = effortOf(placed, { attempts: 1, reporting: 1, reviewed: new Set(['a1']) })
    expect(all.totals.overhead).toMatchObject({ state: 'observed', coverage: { covered: 1, of: 1 } })
  })
})
