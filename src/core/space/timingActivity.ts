/**
 * Activity spans for the timing projection (`./timing.ts`): host and agent `active_ms`/`wait_ms` events turned into
 * placed intervals, with nested usage removed from the parent that already counts it, and effort summed over
 * streams.
 */
import type { MetricObservation } from '../../shared/domain/space'
import { ACTIVITY_ROLES, type ActivityRole, type EffortTotals, type TimingAnomaly, type TimingState, WAIT_CLASSES, type WaitClass } from '../../shared/domain/timing'
import { type Interval, type IntervalWork, iso, length, overlap, quantity, subtract, union } from './timingIntervals'

export interface Span extends Interval {
  observationId: string
  metric: 'active_ms' | 'wait_ms'
  /** Whose work it is, whatever reported it: `handle:…`, else `attempt:…` for a worker, else `role:…`. */
  identity: string
  /** Source, actor and identity: one stream's overlapping spans count once. */
  stream: string
  actor: string
  role: ActivityRole
  evidence: 'host' | 'agent'
  estimated: boolean
  /** Set on `wait_ms` spans only. */
  waitKind: WaitClass | null
  attemptId: string | null
  ticketId: string | null
  sprintId: string | null
  inclusive: boolean
  parentActor: string | null
  /**
   * The time the span shows its actor active, nested usage included: an inclusive span keeps its whole interval here
   * when its descendants' time is removed from `start`..`end` (effort), so its attempt's measured activity has no hole
   * where a descendant worked outside the attempt's scope.
   */
  covers: Interval
}

/** Spans that disagree with their own value by more than this are refused rather than guessed at. */
const SPAN_TOLERANCE_MS = 1_000

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function roleOf(observation: MetricObservation): ActivityRole {
  const stated = text(observation.attributes.role)
  if (stated !== null && (ACTIVITY_ROLES as readonly string[]).includes(stated)) return stated as ActivityRole
  return observation.scope.attemptId === null ? 'other' : 'worker'
}

/**
 * Whose work a span is: its `handle` attribute; without one, a worker span belongs to its attempt (parallel workers
 * may share an adapter name) and any other role to the role across the run, so an orchestrator that reports one
 * interval under two attempts is counted once in run totals.
 */
function identityOf(observation: MetricObservation, role: ActivityRole): string {
  const handle = text(observation.attributes.handle)
  const { attemptId, ticketId } = observation.scope
  if (handle !== null) return `handle:${handle}`
  return role === 'worker' ? `attempt:${attemptId ?? ticketId ?? 'run'}` : `role:${role}`
}

function refuse(anomalies: TimingAnomaly[], kind: TimingAnomaly['kind'], subject: string, detail: string): null {
  anomalies.push({ kind, subject, detail })
  return null
}

/**
 * `[spanStart or observedAt − value, observedAt]`, refused when a time does not parse, is inverted or disagrees with the
 * value. A fractional value is truncated to whole milliseconds, so every boundary is an exact ISO time.
 */
function intervalOf(observation: MetricObservation, value: number, anomalies: TimingAnomaly[]): Interval | null {
  const id = observation.observationId
  const end = Date.parse(observation.observedAt)
  const stated = observation.attributes.spanStart
  const start = stated === undefined || stated === null ? end - Math.trunc(value) : Date.parse(String(stated))
  if (Number.isNaN(end) || Number.isNaN(start)) return refuse(anomalies, 'invalid_time', id, `span ${String(stated)} to ${observation.observedAt}`)
  if (start > end) return refuse(anomalies, 'negative_span', id, `starts ${iso(start)} after it ends ${iso(end)}`)
  if (Math.abs(end - start - value) > SPAN_TOLERANCE_MS) return refuse(anomalies, 'inconsistent_span', id, `${end - start} ms between its ends, ${value} ms reported`)
  return { start, end }
}

/** A wait span's class; `undefined` when the wait kind is not one the projection knows (listed as an anomaly). */
function waitKindOf(observation: MetricObservation, anomalies: TimingAnomaly[]): WaitClass | null | undefined {
  if (observation.metric !== 'wait_ms') return null
  const kind = text(observation.attributes.waitKind)
  if (kind !== null && (WAIT_CLASSES as readonly string[]).includes(kind)) return kind as WaitClass
  refuse(anomalies, 'unknown_wait_kind', observation.observationId, `waitKind ${String(kind)}`)
  return undefined
}

function usageOf(observation: MetricObservation): Pick<Span, 'inclusive' | 'parentActor'> {
  const usage = observation.usage
  return usage === undefined ? { inclusive: false, parentActor: null } : { inclusive: usage.coverage === 'inclusive', parentActor: usage.parentActor }
}

/**
 * An event is a span; so is a delta that states where it started (host adapters report closed spans that way). A
 * cumulative value, or a delta with no start (absent or null), is an amount with no place in time.
 */
function isPlaced(observation: MetricObservation): boolean {
  const start = observation.attributes.spanStart
  return observation.accumulation === 'event' || (observation.accumulation === 'delta' && start !== undefined && start !== null)
}

function spanOf(observation: MetricObservation, asOf: number, anomalies: TimingAnomaly[]): Span | null {
  const { measurement, scope, source } = observation
  if (!isPlaced(observation)) {
    return refuse(anomalies, 'not_an_interval', observation.observationId, `${observation.accumulation} ${observation.metric} has no place in time`)
  }
  if (measurement.state === 'missing') return null
  const iv = intervalOf(observation, measurement.value, anomalies)
  const waitKind = iv === null ? undefined : waitKindOf(observation, anomalies)
  if (iv === null || waitKind === undefined) return null
  const role = roleOf(observation)
  const identity = identityOf(observation, role)
  const end = Math.min(iv.end, asOf)
  return {
    start: iv.start,
    end,
    observationId: observation.observationId,
    metric: observation.metric as Span['metric'],
    identity,
    stream: `${source.kind}|${source.actor ?? ''}|${identity}`,
    actor: source.actor ?? '',
    role,
    evidence: source.kind === 'host' ? 'host' : 'agent',
    estimated: measurement.state === 'estimated',
    waitKind,
    attemptId: scope.attemptId,
    ticketId: scope.ticketId,
    sprintId: scope.sprintId,
    ...usageOf(observation),
    covers: { start: iv.start, end }
  }
}

/** The first delivery of each observation id, in input (ledger) order; later deliveries are listed, never used. */
function firstDeliveries(activity: readonly MetricObservation[], anomalies: TimingAnomaly[]): MetricObservation[] {
  const firsts = new Map<string, MetricObservation>()
  for (const observation of activity) {
    const seen = firsts.get(observation.observationId)
    if (seen === undefined) {
      firsts.set(observation.observationId, observation)
      continue
    }
    const same = JSON.stringify({ ...seen, recordedAt: '' }) === JSON.stringify({ ...observation, recordedAt: '' })
    anomalies.push({
      kind: same ? 'duplicate_event' : 'conflicting_delivery',
      subject: observation.observationId,
      detail: same ? 'delivered again' : 'delivered again with a different payload; the first delivery is kept'
    })
  }
  return [...firsts.values()]
}

/** Host or agent activity recorded by the cutoff. Server and human records are not activity (server waits are this projection's output). */
function isActivity(observation: MetricObservation, asOf: number): boolean {
  const metric = observation.metric === 'active_ms' || observation.metric === 'wait_ms'
  const source = observation.source.kind === 'host' || observation.source.kind === 'agent'
  return metric && source && Date.parse(observation.recordedAt) <= asOf
}

/**
 * The keys a span claims, whatever its metric: its identity, and for work scoped to no attempt also its named actor
 * (roles may be unlabelled; an unnamed actor is nobody in particular, so it matches no other record).
 */
function keysOf(identity: string, attemptId: string | null, actor: string): string[] {
  return attemptId === null && actor !== '' ? [identity, `actor:${actor}`] : [identity]
}

/**
 * The keys an activity record claims, whatever its source and metric: a host record with one of them takes its time
 * from the agent's records with the same key. Two records sharing a key can change each other's counted time (one
 * stream, or host over agent).
 */
export function claimKeys(observation: MetricObservation): string[] {
  return keysOf(identityOf(observation, roleOf(observation)), observation.scope.attemptId, observation.source.actor ?? '')
}

/** A host record's span (null: refused or valueless) and the anomalies reading it listed. */
interface HostRead {
  span: Span | null
  anomalies: TimingAnomaly[]
}

/** The host's records, read before any agent record: each one's read, and the host's placed spans by claim key. */
interface HostCover {
  /** The cutoff the host records were read at, and the agent records are read at. */
  asOf: number
  reads: Map<MetricObservation, HostRead>
  hosted: Map<string, Interval[]>
  /** The union of the host spans under `keys`, memoised per key set so each agent span costs a binary search. */
  coverOf: (keys: readonly string[]) => Interval[]
  /** Where the interval work of reading agent records against this cover is tallied. */
  work: IntervalWork | undefined
}

function hostCover(firsts: readonly MetricObservation[], asOf: number, work: IntervalWork | undefined): HostCover {
  const reads = new Map<MetricObservation, HostRead>()
  const hosted = new Map<string, Interval[]>()
  for (const observation of firsts) {
    if (observation.source.kind !== 'host') continue
    const own: TimingAnomaly[] = []
    const span = spanOf(observation, asOf, own)
    reads.set(observation, { span, anomalies: own })
    if (span === null) continue
    for (const key of keysOf(span.identity, span.attemptId, span.actor)) {
      const known = hosted.get(key)
      if (known === undefined) hosted.set(key, [span])
      else known.push(span)
    }
  }
  const covers = new Map<string, Interval[]>()
  const coverOf = (keys: readonly string[]): Interval[] => {
    const id = keys.join('\n')
    let cover = covers.get(id)
    if (cover === undefined) {
      cover = union(keys.flatMap((key) => hosted.get(key) ?? []), work)
      covers.set(id, cover)
    }
    return cover
  }
  return { asOf, reads, hosted, coverOf, work }
}

/** Lists a `duplicate_source` anomaly once per claim key. */
type ListDuplicate = (key: string, subject: string, detail: string) => void

/**
 * An agent record's spans: whole when the host claims none of its keys or reported nothing over it; else only the
 * time outside the host's cover of those keys, and nothing when the projection cannot place it.
 */
function agentSpans(observation: MetricObservation, host: HostCover, list: ListDuplicate, anomalies: TimingAnomaly[]): Span[] {
  const keys = claimKeys(observation).filter((candidate) => host.hosted.has(candidate))
  if (keys.length === 0) {
    const span = spanOf(observation, host.asOf, anomalies)
    return span === null ? [] : [span]
  }
  const span = spanOf(observation, host.asOf, [])
  if (span === null) {
    list(keys[0], identityOf(observation, roleOf(observation)), `${observation.metric} also reported by the host (${keys[0]}); the agent's report is not counted`)
    return []
  }
  const key = keys.find((candidate) => overlap(span, host.coverOf([candidate]), host.work) > 0)
  if (key === undefined) return [span]
  list(key, span.identity, `${span.metric} overlaps what the host reported (${key}); the agent's report counts only where the host reported nothing`)
  return subtract(span, host.coverOf(keys), host.work).map((piece) => ({ ...span, start: piece.start, end: piece.end, covers: piece }))
}

/**
 * The host's telemetry wins over an agent's self-report of the same work. Host records are read first; an agent
 * record of an identity the host reports placed spans for then keeps only the time the host reported nothing for that
 * identity (no host activity span and no host wait span), so one worker's hour is never counted twice and a
 * host-reported wait is never read as agent activity. Such an agent record the projection cannot place is dropped
 * unread: it is no gap the host already covers. The dropped time is listed once per key. Outside an attempt the host
 * often cannot label a role (a run-level delta reads `other` while the agent says `orchestrator`), so there an agent
 * record also loses the time the host reports for the same named actor.
 */
function preferHost(firsts: readonly MetricObservation[], asOf: number, anomalies: TimingAnomaly[], work: IntervalWork | undefined): Span[] {
  const host = hostCover(firsts, asOf, work)
  const listed = new Set<string>()
  const list: ListDuplicate = (key, subject, detail) => {
    if (listed.has(key)) return
    listed.add(key)
    anomalies.push({ kind: 'duplicate_source', subject, detail })
  }
  return firsts.flatMap((observation) => {
    const read = host.reads.get(observation)
    if (read === undefined) return agentSpans(observation, host, list, anomalies)
    anomalies.push(...read.anomalies)
    return read.span === null ? [] : [read.span]
  })
}

interface Nesting {
  childrenOf: Map<string, Set<string>>
  ownSpans: Map<string, Interval[]>
}

function nestingOf(spans: readonly Span[]): Nesting {
  const childrenOf = new Map<string, Set<string>>()
  const ownSpans = new Map<string, Interval[]>()
  const parentOf = new Map<string, string>()
  for (const span of spans.filter((s) => s.metric === 'active_ms')) {
    const own = ownSpans.get(span.actor)
    if (own === undefined) ownSpans.set(span.actor, [span])
    else own.push(span)
    if (span.parentActor === null || span.parentActor === span.actor || parentOf.has(span.actor)) continue
    parentOf.set(span.actor, span.parentActor)
    const children = childrenOf.get(span.parentActor)
    if (children === undefined) childrenOf.set(span.parentActor, new Set([span.actor]))
    else children.add(span.actor)
  }
  return { childrenOf, ownSpans }
}

/** A walk of the nesting: covers memoised per actor, the actors on the current path, and where work is tallied. */
interface Walk {
  memo: Map<string, Interval[]>
  visiting: Set<string>
  work: IntervalWork | undefined
}

/** Every descendant's activity under `actor` (usage `parentActor` chains), unioned; memoised per actor, cycles cut. */
function descendantCover(actor: string, nesting: Nesting, walk: Walk): Interval[] {
  const known = walk.memo.get(actor)
  if (known !== undefined) return known
  walk.visiting.add(actor)
  const parts: Interval[] = []
  for (const child of nesting.childrenOf.get(actor) ?? []) {
    if (walk.visiting.has(child)) continue
    parts.push(...(nesting.ownSpans.get(child) ?? []), ...descendantCover(child, nesting, walk))
  }
  walk.visiting.delete(actor)
  const cover = union(parts, walk.work)
  walk.memo.set(actor, cover)
  return cover
}

/**
 * An `inclusive` span already contains its descendants' activity (usage `parentActor` chains). The descendants keep
 * their own spans, so their time is removed from the inclusive parent span instead: the parent keeps only the time
 * no descendant was active, and nothing is counted twice in effort. Each piece keeps the whole span as `covers`: an
 * inclusive worker was active over all of it, whatever scope its descendants reported under.
 */
function withoutNestedTime(spans: readonly Span[], work: IntervalWork | undefined): Span[] {
  const nesting = nestingOf(spans)
  const walk: Walk = { memo: new Map(), visiting: new Set(), work }
  return spans.flatMap((span) => {
    if (!span.inclusive || span.metric !== 'active_ms' || !nesting.childrenOf.has(span.actor)) return [span]
    const cover = descendantCover(span.actor, nesting, walk)
    return subtract(span, cover, work).map((piece) => ({ ...span, start: piece.start, end: piece.end }))
  })
}

/**
 * Host and agent `active_ms`/`wait_ms` events as spans. The first delivery of an observation id wins; a later one
 * with another payload is listed as a conflict and ignored, never read as a second observation. Interval work is
 * tallied into `work` when given.
 */
export function prepareSpans(activity: readonly MetricObservation[], asOf: number, anomalies: TimingAnomaly[], work?: IntervalWork): Span[] {
  const firsts = firstDeliveries(activity, anomalies).filter((observation) => isActivity(observation, asOf))
  return withoutNestedTime(preferHost(firsts, asOf, anomalies, work), work)
}

// ---------------------------------------------------------------------------------------------------------------
// Effort

export interface Placed {
  span: Span
  /** The span clipped to the window of what it is scoped to; null when nothing of it falls inside. */
  piece: Interval | null
  /** The effort bucket it counts in (`OutcomeBucket`). */
  bucket: string
}

/** What the effort covers: attempts in scope, those whose worker reported, and the reviewed (submitted) ones. */
export interface EffortScope {
  attempts: number
  reporting: number
  reviewed: ReadonlySet<string>
}

export interface Effort {
  totals: EffortTotals
  /** Each bucket's share of the total; the shares add up to it. */
  byBucket: Map<string, number>
}

interface Stream {
  role: ActivityRole
  raw: Interval[]
  pieces: { piece: Interval; bucket: string }[]
  estimated: boolean
}

function streamsOf(placed: readonly Placed[]): Stream[] {
  const streams = new Map<string, Stream>()
  for (const { span, piece, bucket } of placed) {
    if (span.metric !== 'active_ms') continue
    const entry = streams.get(span.stream) ?? { role: span.role, raw: [], pieces: [], estimated: false }
    entry.raw.push(span)
    if (piece !== null) entry.pieces.push({ piece, bucket })
    entry.estimated ||= span.estimated
    streams.set(span.stream, entry)
  }
  return [...streams.values()]
}

/**
 * A stream's union, each part credited to the bucket of the first piece (by start, then bucket) that covers it, so
 * a span reported under two attempts counts once and the bucket shares add up to the union.
 */
function allocate(stream: Stream, byBucket: Map<string, number>): number {
  const sorted = [...stream.pieces].sort((a, b) => a.piece.start - b.piece.start || a.bucket.localeCompare(b.bucket))
  let cursor = Number.NEGATIVE_INFINITY
  let counted = 0
  for (const { piece, bucket } of sorted) {
    const share = Math.max(0, piece.end - Math.max(piece.start, cursor))
    cursor = Math.max(cursor, piece.end)
    counted += share
    if (share > 0) byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + share)
  }
  return counted
}

function totalState(streams: readonly Stream[], scope: EffortScope): TimingState {
  if (streams.length === 0) return 'missing'
  if (scope.reporting < scope.attempts) return 'partial'
  return streams.some((s) => s.estimated) ? 'estimated' : 'observed'
}

/** Overhead covers the reviewed attempts that have an overhead span scoped to them. */
function overheadOf(placed: readonly Placed[], streams: readonly Stream[], scope: EffortScope, ms: number): EffortTotals['overhead'] {
  const overhead = streams.filter((s) => s.role !== 'worker')
  const covered = new Set(placed.filter((p) => p.span.role !== 'worker' && p.span.metric === 'active_ms' && scope.reviewed.has(p.span.attemptId ?? '')).map((p) => p.span.attemptId)).size
  const coverage = { covered, of: scope.reviewed.size, unit: 'attempts' } as const
  const state: TimingState = overhead.length === 0 ? 'missing' : covered < scope.reviewed.size ? 'partial' : overhead.some((s) => s.estimated) ? 'estimated' : 'observed'
  return quantity('resource_effort', { aggregation: 'sum', ms, state, coverage, open: false })
}

/**
 * Effort over `placed` spans: each stream's spans unioned (a re-reported or overlapping span counts once), then
 * summed across streams. No span at all is `missing`, never zero. Interval work is tallied into `work` when given.
 */
export function effortOf(placed: readonly Placed[], scope: EffortScope, work?: IntervalWork): Effort {
  const streams = streamsOf(placed)
  const byRole: Record<ActivityRole, number> = { worker: 0, orchestrator: 0, reviewer: 0, other: 0 }
  const byBucket = new Map<string, number>()
  let outsideWindowMs = 0
  for (const stream of streams) {
    const counted = allocate(stream, byBucket)
    byRole[stream.role] += counted
    outsideWindowMs += length(union(stream.raw, work), work) - counted
  }
  const totalMs = byRole.worker + byRole.orchestrator + byRole.reviewer + byRole.other
  const coverage = { covered: scope.reporting, of: scope.attempts, unit: 'attempts' } as const
  const totals: EffortTotals = {
    total: quantity('resource_effort', { aggregation: 'sum', ms: totalMs, state: totalState(streams, scope), coverage, open: false }),
    byRole,
    overhead: overheadOf(placed, streams, scope, totalMs - byRole.worker),
    outsideWindowMs
  }
  return { totals, byBucket }
}
