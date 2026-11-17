/**
 * Attributes a host transcript's usage (`hostTranscripts.ts`) to the run's buckets: the attempt each thread worked
 * for, the run's orchestration overhead, or its `unattributed` overhead bucket.
 *
 * The rules, all drawn from session links in the transcript itself:
 * - The session must be linked to the run: its main thread completed a `start_run` (by its answer), `takeover_run` or
 *   `claim_ticket` naming the run. Without that link nothing is attributed.
 * - The main thread orchestrates the run within the run's window: from its first link to the run until the first link
 *   to a later run (a session that canceled one run and started another orchestrates each in turn). Its usage in that
 *   window is `orchestration` overhead, whatever claims pass through it; outside it, it belongs to another run.
 * - A subagent thread works for the attempt of the claim it holds at each moment: the claim it was spawned with, then
 *   each claim token handed to it later (a retry) or presented in an attempt call the server answered. A thread holding
 *   no claim of its own works for the attempt its parent held when it started it (a worker's helpers).
 * - A thread with no claim started in the run's window (a reviewer), a claim of one of the run's carry-forward attempts
 *   (which ran nothing), and a claim of an attempt outside the run held by a thread that started in the window, at a
 *   sample in the window (a reviewer quoting a token), go to the run's `unattributed` bucket: counted once in the totals
 *   and shown, never charged to a guessed attempt. Such usage is left out otherwise: a thread started before the window
 *   still works for an earlier run (its own claim keeps it there), and a sample after the window belongs to a later run.
 *
 * Every sample lands in at most one run's bucket, decided only by what the transcript held up to that sample, so a
 * later read never moves usage already reported. Per bucket and thread, tokens are one cumulative stream; while the
 * thread is still working (a span open or not yet settled, or a message still being written) a read reports the
 * number so far and then a `missing` (`partial_coverage`) gap, so the cell keeps the number as a lower bound and reads
 * `partial`; the read after it settles reports the number alone (sequences `3n`, `3n + 1` and `3n + 2` for `n`
 * samples, so each later read supersedes the earlier). Active time is reported as closed spans only (`active_ms`
 * deltas with `spanStart`): a span is the union of
 * the thread's activity intervals, joined across gaps shorter than `gapToleranceMs`, closed once a later span began or
 * the thread has been quiet for `settleMs` with nothing running. A span is cut where the claim or the run window
 * changes.
 */
import type { UsageBilling } from '../../shared/domain/hostUsage'
import type { MetricReport, OverheadKind } from '../../shared/domain/metrics'
import { addSample, emptyAggregate, tokenReports, type UsageAggregate, type UsageStreamIdentity } from './hostUsage'
import type { HostThread, HostTranscript } from './hostTranscripts'

interface RunAttemptSet {
  runId: string
  /** Attempts that executed (any state). */
  executing: ReadonlySet<string>
  /** Carry-forward attempts: they ran nothing and take no usage. */
  carriedForward: ReadonlySet<string>
}

interface AttributionOptions {
  /** The read time, in epoch milliseconds. */
  asOf: number
  settleMs: number
  gapToleranceMs: number
  billing: UsageBilling
}

type UsageBucket = { kind: 'attempt'; attemptId: string } | { kind: 'overhead'; overhead: OverheadKind }

interface BucketReports {
  bucket: UsageBucket
  reports: MetricReport[]
}

/** What one thread contributed to one bucket, for people reading the result. */
export interface ThreadShare {
  actor: string
  bucket: UsageBucket
  samples: number
  tokensTotal: number | null
  activeMs: number
  /** False while the thread still works in this bucket: its tokens are reported as a gap and its last span waits. */
  settled: boolean
}

interface HostAttribution {
  /** Whether the transcript is linked to the run (nothing is attributed otherwise). */
  linked: boolean
  buckets: BucketReports[]
  shares: ThreadShare[]
  /** Claims the transcript holds for attempts that cannot take usage, and why. */
  notes: string[]
}

const ORCHESTRATION: UsageBucket = { kind: 'overhead', overhead: 'orchestration' }
const UNATTRIBUTED: UsageBucket = { kind: 'overhead', overhead: 'unattributed' }

function bucketKey(bucket: UsageBucket): string {
  return bucket.kind === 'attempt' ? `attempt:${bucket.attemptId}` : `overhead:${bucket.overhead}`
}

function iso(ms: number): string {
  return new Date(Math.trunc(ms)).toISOString()
}

/** The claim a thread holds at `at`: its own latest, else the one its parent held when it started it. */
function claimAt(thread: HostThread, at: number, byName: ReadonlyMap<string, HostThread>, seen: Set<string> = new Set()): string | null {
  if (thread.name === 'main' || seen.has(thread.name)) {
    return null
  }
  seen.add(thread.name)
  let own: string | null = null
  for (const claim of thread.claims) {
    if (claim.at > at) break
    own = claim.attemptId
  }
  if (own !== null) {
    return own
  }
  const parent = thread.parent === null ? undefined : byName.get(thread.parent)
  return parent === undefined ? null : claimAt(parent, thread.startedAt, byName, seen)
}

interface Span {
  start: number
  end: number
  open: boolean
}

/** The thread's activity as spans: intervals joined across gaps under the tolerance; a span holding a running interval is open. */
function spansOf(thread: HostThread, gapToleranceMs: number): Span[] {
  const spans: Span[] = []
  for (const interval of thread.activity) {
    const end = interval.end ?? interval.start
    const current = spans.at(-1)
    if (current !== undefined && interval.start <= current.end + gapToleranceMs) {
      current.end = Math.max(current.end, end)
      current.open ||= interval.end === null
    } else {
      spans.push({ start: interval.start, end, open: interval.end === null })
    }
  }
  return spans
}

/** The part of the session's main thread that orchestrates the run: from its first link to the next run's. */
interface RunWindow {
  start: number
  end: number
}

/** What one attribution pass works with and collects. */
interface Pass {
  transcript: HostTranscript
  run: RunAttemptSet
  options: AttributionOptions
  window: RunWindow
  byName: ReadonlyMap<string, HostThread>
  reports: Map<string, BucketReports>
  shares: Map<string, ThreadShare>
  notes: Set<string>
}

function actorOf(transcript: HostTranscript, name: string): string {
  return name === 'main' ? `${transcript.host}:${transcript.sessionId}` : `${transcript.host}:${transcript.sessionId}/${name}`
}

function inWindow(pass: Pass, at: number): boolean {
  return at >= pass.window.start && at < pass.window.end
}

/** The bucket a thread's usage at `at` belongs to in this run, or null when it is another run's. */
function bucketAt(pass: Pass, thread: HostThread, at: number): UsageBucket | null {
  if (thread.name === 'main') return inWindow(pass, at) ? ORCHESTRATION : null
  const attemptId = claimAt(thread, at, pass.byName)
  if (attemptId === null) return inWindow(pass, thread.startedAt) ? UNATTRIBUTED : null
  if (pass.run.executing.has(attemptId)) return { kind: 'attempt', attemptId }
  if (pass.run.carriedForward.has(attemptId)) {
    pass.notes.add(`Attempt ${attemptId} is a carry-forward attempt, which runs nothing: its thread's usage is unattributed.`)
    return UNATTRIBUTED
  }
  if (inWindow(pass, thread.startedAt) && inWindow(pass, at)) {
    pass.notes.add(`Attempt ${attemptId} is not an attempt of run ${pass.run.runId}; its thread started and worked in the run's window, so its usage is unattributed.`)
    return UNATTRIBUTED
  }
  return null
}

function addReport(pass: Pass, bucket: UsageBucket, report: MetricReport): void {
  const key = bucketKey(bucket)
  const held = pass.reports.get(key)
  if (held === undefined) pass.reports.set(key, { bucket, reports: [report] })
  else held.reports.push(report)
}

function shareOf(pass: Pass, thread: HostThread, bucket: UsageBucket): ThreadShare {
  const key = `${thread.name}\u0000${bucketKey(bucket)}`
  const held = pass.shares.get(key) ?? { actor: actorOf(pass.transcript, thread.name), bucket, samples: 0, tokensTotal: null, activeMs: 0, settled: true }
  pass.shares.set(key, held)
  return held
}

interface Stream {
  bucket: UsageBucket
  aggregates: Map<string, UsageAggregate>
  lastAt: number
}

/** The thread's samples in this run added up per bucket (and per format, when a thread switched provider). */
function streamsOf(pass: Pass, thread: HostThread): Stream[] {
  const streams = new Map<string, Stream>()
  for (const sample of thread.usage) {
    const bucket = bucketAt(pass, thread, sample.at)
    if (bucket === null) continue
    const stream = streams.get(bucketKey(bucket)) ?? { bucket, aggregates: new Map(), lastAt: sample.at }
    const aggregate = stream.aggregates.get(sample.breakdown.format) ?? emptyAggregate(sample.breakdown.format)
    addSample(aggregate, sample.breakdown, sample.model)
    stream.aggregates.set(sample.breakdown.format, aggregate)
    stream.lastAt = Math.max(stream.lastAt, sample.at)
    streams.set(bucketKey(bucket), stream)
  }
  return [...streams.values()]
}

/** A report of a stream still growing: its numbers are only a lower bound until the thread settles. */
function unsettledReport(report: MetricReport): MetricReport {
  return report.measurement.state === 'missing' ? report : { ...report, measurement: { state: 'missing', reason: 'partial_coverage' } }
}

/**
 * The thread's token reports: one cumulative stream per bucket. For `n` samples, a settled read reports the number at
 * sequence `3n + 2`. The bucket the thread is still working in (`tail`, null when it has settled) reports the number
 * so far at `3n` and a gap at `3n + 1`, so the cell keeps the number as a lower bound and reads `partial` until a later
 * read finds the thread settled; every later read's sequences are higher, so nothing is sent twice with another value.
 */
function threadTokens(pass: Pass, thread: HostThread, identity: UsageStreamIdentity, tail: string | null): void {
  for (const stream of streamsOf(pass, thread)) {
    const aggregates = [...stream.aggregates.values()]
    const growing = bucketKey(stream.bucket) === tail
    for (const aggregate of aggregates) {
      const actor = aggregates.length === 1 ? identity.actor : `${identity.actor}#${aggregate.format}`
      const at = (offset: number) => ({ accumulation: 'cumulative' as const, sequence: 3 * aggregate.samples + offset, observedAt: iso(stream.lastAt) })
      const reports = growing
        ? [...tokenReports(aggregate, { ...identity, actor }, at(0)), ...tokenReports(aggregate, { ...identity, actor }, at(1)).map(unsettledReport)]
        : tokenReports(aggregate, { ...identity, actor }, at(2))
      for (const report of reports) addReport(pass, stream.bucket, report)
      const share = shareOf(pass, thread, stream.bucket)
      const total = aggregate.categories.total
      share.samples += aggregate.samples
      share.tokensTotal = total.reported === aggregate.samples ? (share.tokensTotal ?? 0) + total.value : share.tokensTotal
      share.settled &&= !growing
    }
  }
}

/** A closed span cut where the thread's claim changes, or (the main thread) where the run's window starts or ends. */
function piecesOf(pass: Pass, thread: HostThread, span: Span): [number, number][] {
  const edges = thread.name === 'main' ? [pass.window.start, pass.window.end] : thread.claims.map((claim) => claim.at)
  const cuts = edges.filter((at) => at > span.start && at < span.end)
  const all = [span.start, ...cuts, span.end].map(Math.trunc)
  return all.slice(1).flatMap((end, index): [number, number][] => {
    const start = all[index] ?? end
    return end > start ? [[start, end]] : []
  })
}

/** Whether a span can no longer change: nothing in it is running, and a later span began or the thread has settled. */
function isClosed(pass: Pass, spans: readonly Span[], index: number): boolean {
  const span = spans[index]
  return span !== undefined && !span.open && (index < spans.length - 1 || pass.options.asOf - span.end >= pass.options.settleMs)
}

/** The thread's closed activity spans as `active_ms` deltas, each in the bucket of its claim. */
function threadSpans(pass: Pass, thread: HostThread, identity: UsageStreamIdentity, spans: readonly Span[]): void {
  const closed = spans.filter((_, index) => isClosed(pass, spans, index))
  for (const [start, end] of closed.flatMap((span) => piecesOf(pass, thread, span))) {
    const bucket = bucketAt(pass, thread, start)
    if (bucket === null) continue
    addReport(pass, bucket, {
      metric: 'active_ms',
      unit: 'milliseconds',
      source: { kind: 'host', actor: identity.actor },
      measurement: { state: 'observed', value: end - start },
      accumulation: 'delta',
      eventId: `span-${start}`,
      observedAt: iso(end),
      attributes: { spanStart: iso(start), activeBasis: pass.transcript.host === 'omp' ? 'requests_and_tools' : 'turn_lines' },
      usage: { coverage: identity.coverage, parentActor: identity.parentActor }
    })
    shareOf(pass, thread, bucket).activeMs += end - start
  }
}

/** The bucket the thread is still working in, or null when it has settled (its last span closed, no message pending). */
function tailBucket(pass: Pass, thread: HostThread, spans: readonly Span[]): string | null {
  const settled = !thread.pendingUsage && (spans.length === 0 || isClosed(pass, spans, spans.length - 1))
  if (settled) return null
  const last = Math.max(thread.usage.at(-1)?.at ?? 0, spans.at(-1)?.start ?? 0)
  const bucket = bucketAt(pass, thread, last)
  return bucket === null ? null : bucketKey(bucket)
}

/**
 * The run's window in the session: from the main thread's first link to the run until its first link to a later run.
 * The session's first run also owns what came before any link (the session reading the plan before claiming).
 */
function windowOf(main: HostThread | undefined, runId: string): RunWindow | null {
  const links = main?.runLinks ?? []
  const own = links.find((link) => link.runId === runId)
  if (own === undefined) return null
  const next = links.find((link) => link.runId !== runId && link.at > own.at)
  return { start: links[0] === own ? Number.NEGATIVE_INFINITY : own.at, end: next?.at ?? Number.POSITIVE_INFINITY }
}

export function attributeHostUsage(transcript: HostTranscript, run: RunAttemptSet, options: AttributionOptions): HostAttribution {
  const byName = new Map(transcript.threads.map((thread) => [thread.name, thread]))
  const window = windowOf(byName.get('main'), run.runId)
  if (window === null) {
    return { linked: false, buckets: [], shares: [], notes: [`The ${transcript.host} session ${transcript.sessionId} never named run ${run.runId} in a completed run call.`] }
  }
  const pass: Pass = { transcript, run, options, window, byName, reports: new Map(), shares: new Map(), notes: new Set() }
  for (const thread of transcript.threads) {
    const identity: UsageStreamIdentity = {
      actor: actorOf(transcript, thread.name),
      parentActor: thread.parent === null ? null : actorOf(transcript, thread.parent),
      coverage: 'self',
      billing: options.billing
    }
    const spans = spansOf(thread, options.gapToleranceMs)
    threadTokens(pass, thread, identity, tailBucket(pass, thread, spans))
    threadSpans(pass, thread, identity, spans)
  }
  return { linked: true, buckets: [...pass.reports.values()], shares: [...pass.shares.values()], notes: [...pass.notes] }
}
