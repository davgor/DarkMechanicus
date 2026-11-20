/**
 * Pure timing projection: lifecycle events and host activity spans in, classified intervals and totals out.
 *
 * Rules (docs/space-grading.md, "Time and effort"):
 * - Lifecycle events are the server's record and the only source of elapsed time. Claim to submit is elapsed
 *   time only: it becomes active time only where an activity span covers it.
 * - Inputs may arrive duplicated or out of order. Events are ordered by time (then `seq`); an exact repeat is
 *   dropped, the first terminal event of an attempt wins, and anything that cannot be placed or attributed is
 *   listed as an anomaly instead of being guessed at. Nothing is counted after the cutoff, and nothing is negative.
 * - A missing stop event never invents time: an attempt without an end runs to the run's end, else to the
 *   cutoff (marked open); a pause without a resume likewise. A lease that expired ends the attempt at its
 *   deadline, and the time after the last sign of life stays `unknown` (`after_last_signal`); a submission the
 *   orchestrator later recovers from it (reconcile `resubmit`) is reviewed like any other.
 * - Inside an attempt, precedence is: the worker's host-reported activity, then a host-reported wait, then the
 *   agent's self-reported activity and waits (which count only where the host reported nothing), then a run pause
 *   (`blocked`), then `unknown`. Overlapping spans of one stream count once; different streams add up in effort.
 * - Effort is summed over actors; wall clock is a union. Failed, rejected, canceled, expired and superseded
 *   attempts keep their elapsed time, effort and unknown time; carried-forward tickets (earlier runs' work) are
 *   listed and never accrue time here.
 * - One sprint rule for every total: a ticket and everything about it belongs to the sprint holding it in the
 *   run's current plan (older sprint ids mapped through `sprintAliases`).
 */
import type { MetricObservation } from '../../shared/domain/space'
import type {
  AttemptTiming,
  AttemptTimingOutcome,
  OutcomeEffort,
  OutcomeEffortTotals,
  RunTiming,
  SprintTiming,
  TicketTiming,
  TimingAnomaly,
  TimingState,
  WaitClass,
  WindowEnd
} from '../../shared/domain/timing'
import { fail } from '../errors'
import { type Effort, type EffortScope, effortOf, type Placed, prepareSpans, type Span } from './timingActivity'
import {
  appendSegment,
  type ClassTotals,
  classified,
  classify,
  classTotals,
  clip,
  type Interval,
  type IntervalWork,
  iso,
  type Label,
  type Layer,
  length,
  missing,
  msCoverage,
  quantity,
  type Segment,
  toTimingSegments,
  union,
  within
} from './timingIntervals'

// ---------------------------------------------------------------------------------------------------------------
// Input

interface EventBase {
  /** Server time (ISO-8601). */
  at: string
  /** Tie-break for events at the same instant (the event log's `seq`). */
  seq?: number
}

type RunEventKind = 'run_started' | 'run_paused' | 'run_resumed' | 'run_ended'
type SprintEventKind = 'sprint_activated' | 'sprint_report_submitted' | 'checkpoint_approved'
/** `retry_granted` is the person's grant; `auto_retry_granted` the orchestrator's own retry (`retry_ticket`). */
type TicketEventKind = 'ticket_ready' | 'retry_granted' | 'auto_retry_granted'
type AttemptEventKind =
  | 'attempt_signal'
  | 'attempt_submitted'
  | 'attempt_accepted'
  | 'attempt_rejected'
  | 'attempt_failed'
  | 'attempt_canceled'
  | 'attempt_lease_expired'
  | 'attempt_reconciled'
  | 'attempt_superseded'

interface AttemptClaimedEvent extends EventBase {
  kind: 'attempt_claimed'
  attemptId: string
  ticketId: string
  /** The ticket's sprint in the plan revision the attempt ran under. */
  sprintId: string | null
  number: number
  /** A carry-forward record of work accepted in an earlier run. */
  carriedForward: boolean
}

/** One lifecycle fact from the server's records. */
export type TimingEvent =
  | (EventBase & { kind: RunEventKind })
  | (EventBase & { kind: SprintEventKind; sprintId: string })
  | (EventBase & { kind: TicketEventKind; ticketId: string })
  | AttemptClaimedEvent
  | (EventBase & { kind: AttemptEventKind; attemptId: string })

export interface TimingInput {
  runId: string
  /** The cutoff: records after it are ignored and open intervals end here. */
  asOf: string
  events: readonly TimingEvent[]
  /** `active_ms` and `wait_ms` observations, in ledger order (the first delivery of an id wins). */
  activity: readonly MetricObservation[]
  /** Each ticket of the run's current plan with its sprint there. */
  tickets?: readonly { ticketId: string; sprintId: string | null }[]
  /**
   * Older revisions' sprint ids mapped to the current plan's (null: no counterpart). Ids not listed are already
   * current. Applied to every sprint id in events and observation scopes.
   */
  sprintAliases?: Readonly<Record<string, string | null>>
  /** What the feed itself had to estimate from the records (`estimated_time`), listed first among the anomalies. */
  feedAnomalies?: readonly TimingAnomaly[]
}

// ---------------------------------------------------------------------------------------------------------------
// Lifecycle

interface Ordered {
  event: TimingEvent
  ms: number
  index: number
}

function subjectOf(event: TimingEvent): string {
  if ('attemptId' in event) return event.attemptId
  if ('ticketId' in event) return event.ticketId
  if ('sprintId' in event) return event.sprintId
  return 'run'
}

/** Events by time, then `seq`, then input order; exact repeats and unparseable times are listed and dropped. */
function orderEvents(events: readonly TimingEvent[], asOf: number, anomalies: TimingAnomaly[]): Ordered[] {
  const seen = new Set<string>()
  const ordered: Ordered[] = []
  events.forEach((event, index) => {
    const ms = Date.parse(event.at)
    const key = `${event.kind}|${subjectOf(event)}|${ms}`
    if (Number.isNaN(ms)) {
      anomalies.push({ kind: 'invalid_time', subject: subjectOf(event), detail: `${event.kind} at ${String(event.at)}` })
    } else if (seen.has(key)) {
      anomalies.push({ kind: 'duplicate_event', subject: subjectOf(event), detail: `${event.kind} at ${event.at}` })
    } else if (ms <= asOf) {
      seen.add(key)
      ordered.push({ event, ms, index })
    }
  })
  return ordered.sort((a, b) => a.ms - b.ms || (a.event.seq ?? 0) - (b.event.seq ?? 0) || a.index - b.index)
}

/** Maps sprint ids of older revisions to the current plan's; an id with no counterpart is listed once and becomes null. */
class SprintMap {
  private readonly listed = new Set<string>()

  constructor(
    private readonly aliases: Readonly<Record<string, string | null>>,
    private readonly anomalies: TimingAnomaly[]
  ) {}

  map(sprintId: string | null, what: string): string | null {
    if (sprintId === null || !Object.hasOwn(this.aliases, sprintId)) return sprintId
    const mapped = this.aliases[sprintId] ?? null
    if (mapped === null && !this.listed.has(sprintId)) {
      this.listed.add(sprintId)
      this.anomalies.push({ kind: 'unattributed', subject: sprintId, detail: `${what}: sprint ${sprintId} has no counterpart in the current plan` })
    }
    return mapped
  }
}

/** The events with every sprint id mapped to the current plan; sprint events whose sprint has no counterpart are dropped (listed). */
function currentSprints(ordered: readonly Ordered[], sprints: SprintMap): Ordered[] {
  const out: Ordered[] = []
  for (const entry of ordered) {
    const { event } = entry
    if (event.kind === 'attempt_claimed') {
      out.push({ ...entry, event: { ...event, sprintId: sprints.map(event.sprintId, `attempt ${event.attemptId}`) } })
    } else if ('sprintId' in event) {
      const sprintId = sprints.map(event.sprintId, event.kind)
      if (sprintId !== null) out.push({ ...entry, event: { ...event, sprintId } })
    } else {
      out.push(entry)
    }
  }
  return out
}

interface RunFacts {
  startMs: number | null
  endMs: number | null
  pausedAt: number | null
  pauses: (Interval & { open: boolean })[]
  activations: { sprintId: string; ms: number }[]
  reports: { sprintId: string; ms: number }[]
  approvals: { sprintId: string; ms: number }[]
  ready: Map<string, number>
  retryGrants: Map<string, number[]>
  /** The orchestrator's own retries: the wait before one is orchestration, never a person's approval. */
  autoRetryGrants: Map<string, number[]>
}

type Handler<F, E> = (facts: F, event: E, ms: number, anomalies: TimingAnomaly[]) => void
type RunLevelKind = RunEventKind | SprintEventKind | TicketEventKind

function outOfPlace(anomalies: TimingAnomaly[], event: TimingEvent, why: string): void {
  anomalies.push({ kind: 'event_out_of_place', subject: subjectOf(event), detail: `${event.kind} at ${event.at}: ${why}` })
}

function closePause(facts: RunFacts, ms: number): void {
  if (facts.pausedAt !== null) facts.pauses.push({ start: facts.pausedAt, end: ms, open: false })
  facts.pausedAt = null
}

/** The member of `TimingEvent` with kind `K` (members share a kind union, so `Extract` would find none). */
type EventOf<K extends TimingEvent['kind']> = TimingEvent & { kind: K }

const RUN_HANDLERS: { [K in RunLevelKind]: Handler<RunFacts, EventOf<K>> } = {
  run_started: (facts, _event, ms) => {
    facts.startMs ??= ms
  },
  run_ended: (facts, _event, ms) => {
    if (facts.endMs !== null) return
    facts.endMs = ms
    closePause(facts, ms)
  },
  run_paused: (facts, event, ms, anomalies) => {
    if (facts.endMs !== null) outOfPlace(anomalies, event, 'the run had ended')
    else facts.pausedAt ??= ms
  },
  run_resumed: (facts, event, ms, anomalies) => {
    if (facts.pausedAt === null) outOfPlace(anomalies, event, 'no open pause')
    else closePause(facts, ms)
  },
  sprint_activated: (facts, event, ms) => facts.activations.push({ sprintId: event.sprintId, ms }),
  sprint_report_submitted: (facts, event, ms) => facts.reports.push({ sprintId: event.sprintId, ms }),
  checkpoint_approved: (facts, event, ms) => facts.approvals.push({ sprintId: event.sprintId, ms }),
  ticket_ready: (facts, event, ms) => {
    if (!facts.ready.has(event.ticketId)) facts.ready.set(event.ticketId, ms)
  },
  retry_granted: (facts, event, ms) => pushGrant(facts.retryGrants, event.ticketId, ms),
  auto_retry_granted: (facts, event, ms) => pushGrant(facts.autoRetryGrants, event.ticketId, ms)
}

function pushGrant(grants: Map<string, number[]>, ticketId: string, ms: number): void {
  const times = grants.get(ticketId)
  if (times === undefined) grants.set(ticketId, [ms])
  else times.push(ms)
}

function runFacts(ordered: readonly Ordered[], asOf: number, anomalies: TimingAnomaly[]): RunFacts {
  const facts: RunFacts = { startMs: null, endMs: null, pausedAt: null, pauses: [], activations: [], reports: [], approvals: [], ready: new Map(), retryGrants: new Map(), autoRetryGrants: new Map() }
  const handlers = RUN_HANDLERS as unknown as Partial<Record<string, Handler<RunFacts, TimingEvent>>>
  for (const { event, ms } of ordered) handlers[event.kind]?.(facts, event, ms, anomalies)
  if (facts.pausedAt !== null) facts.pauses.push({ start: facts.pausedAt, end: asOf, open: true })
  return facts
}

type Decision = 'accepted' | 'rejected' | 'failed' | 'canceled'

interface AttemptFacts {
  claim: AttemptClaimedEvent
  claimMs: number
  superseded: boolean
  signals: number[]
  endMs: number | null
  endedBy: WindowEnd | null
  submittedMs: number | null
  decision: { kind: Decision; ms: number } | null
  reconciledMs: number | null
}

/** Ends the attempt's elapsed window unless an earlier event already did. */
function endAttempt(facts: AttemptFacts, ms: number, by: WindowEnd): boolean {
  if (facts.endMs !== null) return false
  facts.endMs = ms
  facts.endedBy = by
  return true
}

function decide(facts: AttemptFacts, event: TimingEvent, ms: number, anomalies: TimingAnomaly[]): void {
  if (facts.submittedMs === null || facts.decision !== null) outOfPlace(anomalies, event, 'no undecided submission')
  else facts.decision = { kind: event.kind === 'attempt_accepted' ? 'accepted' : 'rejected', ms }
}

/** A failure or cancel ends a running attempt, or ends the review of a submitted one. */
function stop(facts: AttemptFacts, event: TimingEvent, ms: number, anomalies: TimingAnomaly[]): void {
  const kind = event.kind === 'attempt_failed' ? 'failed' : 'canceled'
  const ends = endAttempt(facts, ms, kind)
  if (ends || (facts.submittedMs !== null && facts.decision === null)) facts.decision = { kind, ms }
  else outOfPlace(anomalies, event, 'the attempt had already ended')
}

/**
 * A submit ends a running attempt. After an expired lease it is the orchestrator recovering the worker's outputs
 * (reconcile `resubmit`): the attempt still ended at its deadline, and the submission waits for review from now.
 */
function submit(facts: AttemptFacts, event: TimingEvent, ms: number, anomalies: TimingAnomaly[]): void {
  if (endAttempt(facts, ms, 'submitted')) facts.submittedMs = ms
  else if (facts.endedBy === 'lease_expired' && facts.submittedMs === null) facts.submittedMs = ms
  else outOfPlace(anomalies, event, 'the attempt had already ended')
}

const ATTEMPT_HANDLERS: Record<AttemptEventKind, Handler<AttemptFacts, TimingEvent>> = {
  attempt_signal: (facts, _event, ms) => facts.signals.push(ms),
  attempt_superseded: (facts) => {
    facts.superseded = true
  },
  attempt_submitted: submit,
  attempt_accepted: decide,
  attempt_rejected: decide,
  attempt_failed: stop,
  attempt_canceled: stop,
  attempt_lease_expired: (facts, event, ms, anomalies) => {
    if (!endAttempt(facts, ms, 'lease_expired')) outOfPlace(anomalies, event, 'the attempt had already ended')
  },
  attempt_reconciled: (facts, event, ms, anomalies) => {
    if (facts.endedBy !== 'lease_expired' || facts.reconciledMs !== null) outOfPlace(anomalies, event, 'no expired lease to reconcile')
    else facts.reconciledMs = ms
  }
}

function claimsOf(ordered: readonly Ordered[], anomalies: TimingAnomaly[]): Map<string, AttemptFacts> {
  const attempts = new Map<string, AttemptFacts>()
  for (const { event, ms } of ordered) {
    if (event.kind !== 'attempt_claimed') continue
    if (attempts.has(event.attemptId)) outOfPlace(anomalies, event, 'a second claim of the same attempt')
    else attempts.set(event.attemptId, { claim: event, claimMs: ms, superseded: false, signals: [ms], endMs: null, endedBy: null, submittedMs: null, decision: null, reconciledMs: null })
  }
  return attempts
}

/**
 * Applies each attempt's events after its claim. A carried-forward attempt is a record of earlier work: only its
 * supersession applies, and its other events (the earlier acceptance) are not part of this run. `unclaimed` counts
 * the attempts with events but no claim on record: their windows cannot be placed, so run totals must not read as
 * covering them.
 */
function attemptFacts(ordered: readonly Ordered[], anomalies: TimingAnomaly[]): { attempts: AttemptFacts[]; unclaimed: number } {
  const attempts = claimsOf(ordered, anomalies)
  const unclaimed = new Set<string>()
  for (const { event, ms } of ordered) {
    if (!('attemptId' in event) || event.kind === 'attempt_claimed') continue
    const facts = attempts.get(event.attemptId)
    if (facts === undefined && !unclaimed.has(event.attemptId)) {
      unclaimed.add(event.attemptId)
      anomalies.push({ kind: 'attempt_without_claim', subject: event.attemptId, detail: `${event.kind} at ${event.at} with no claim on record` })
    } else if (facts === undefined || (facts.claim.carriedForward && event.kind !== 'attempt_superseded')) {
      continue
    } else if (ms < facts.claimMs) {
      outOfPlace(anomalies, event, 'before the claim')
    } else {
      ATTEMPT_HANDLERS[event.kind](facts, event, ms, anomalies)
    }
  }
  return { attempts: [...attempts.values()], unclaimed: unclaimed.size }
}

// ---------------------------------------------------------------------------------------------------------------
// Attempts

const PRIORITY = { active: 100, hostWait: 95, agentActive: 90, agentWait: 85, attemptPause: 80, attempt: 70, review: 60, reconciliation: 50, retryGrant: 40, pause: 30 } as const

const PAUSED: Label = { class: 'blocked', reason: 'run_paused', evidence: 'lifecycle' }

function pauseLayers(pauses: RunFacts['pauses'], priority: number): Layer[] {
  return pauses.map((pause) => ({ start: pause.start, end: pause.end, priority, label: PAUSED }))
}

function outcomeOf(facts: AttemptFacts): AttemptTimingOutcome {
  if (facts.decision !== null) return facts.decision.kind
  if (facts.submittedMs !== null) return 'awaiting_review'
  return facts.endedBy === 'lease_expired' ? 'lease_expired' : 'open'
}

interface Context {
  run: RunFacts
  asOf: number
  anomalies: TimingAnomaly[]
  /** Where interval work is tallied, when the caller asked for it. */
  work: IntervalWork | undefined
}

interface AttemptWindow {
  window: Interval
  endedBy: WindowEnd
  open: boolean
}

/** Claim to the attempt's own end; without one, to the run's end; without that, to the cutoff (open). */
function attemptWindow(facts: AttemptFacts, context: Context): AttemptWindow {
  if (facts.endMs !== null) return { window: { start: facts.claimMs, end: facts.endMs }, endedBy: facts.endedBy ?? 'cutoff', open: false }
  const runEnd = context.run.endMs
  if (runEnd !== null && runEnd >= facts.claimMs) return { window: { start: facts.claimMs, end: runEnd }, endedBy: 'run_ended', open: false }
  return { window: { start: facts.claimMs, end: context.asOf }, endedBy: 'cutoff', open: true }
}

/** Claim to the end of review or reconciliation: spans scoped to the attempt count as its effort in this window. */
function effortWindowOf(facts: AttemptFacts, window: Interval, context: Context): Interval {
  const reviewEnd = facts.submittedMs === null ? null : (facts.decision?.ms ?? context.run.endMs ?? context.asOf)
  return { start: facts.claimMs, end: Math.max(window.end, reviewEnd ?? 0, facts.reconciledMs ?? 0) }
}

interface WorkerEvidence {
  active: Interval[]
  layers: Layer[]
  reported: boolean
  estimated: boolean
}

/** Clipped to `window` and unioned. */
function inside(intervals: readonly Interval[], window: Interval, work: IntervalWork | undefined): Interval[] {
  return union(intervals.map((iv) => clip(iv, window, work)).filter((iv): iv is Interval => iv !== null), work)
}

/**
 * The attempt's worker spans as classification layers, each labelled with the source that reported it: host activity,
 * then host waits, then agent activity, then agent waits, so an agent's self-report never overrides what the host saw.
 */
function workerEvidence(mine: readonly Span[], window: Interval, work: IntervalWork | undefined): WorkerEvidence {
  const worker = mine.filter((span) => span.role === 'worker')
  const activeSpans = worker.filter((span) => span.metric === 'active_ms')
  const layers: Layer[] = []
  for (const evidence of ['host', 'agent'] as const) {
    const priority = evidence === 'host' ? PRIORITY.active : PRIORITY.agentActive
    for (const iv of inside(activeSpans.filter((span) => span.evidence === evidence).map((span) => span.covers), window, work)) {
      layers.push({ ...iv, priority, label: { class: 'active', reason: 'activity_span', evidence } })
    }
  }
  for (const span of worker.filter((s) => s.waitKind !== null)) {
    const priority = span.evidence === 'host' ? PRIORITY.hostWait : PRIORITY.agentWait
    layers.push({ start: span.start, end: span.end, priority, label: { class: span.waitKind as WaitClass, reason: 'host_wait', evidence: span.evidence } })
  }
  const active = inside(activeSpans.map((span) => span.covers), window, work)
  return { active, layers, reported: activeSpans.length > 0, estimated: worker.some((span) => span.estimated) }
}

/** The last sign of life inside the window: claim, heartbeats, progress notes, submit, the end of an activity span. */
function lastSignalOf(facts: AttemptFacts, window: Interval, active: readonly Interval[]): number {
  let last = facts.claimMs
  const candidates = [...facts.signals, ...(facts.submittedMs === null ? [] : [facts.submittedMs]), ...active.map((iv) => iv.end)]
  for (const ms of candidates) if (ms <= window.end && ms > last) last = ms
  return last
}

interface BuiltAttempt {
  timing: AttemptTiming
  facts: AttemptFacts
  window: Interval
  effortWindow: Interval
  open: boolean
  reported: boolean
  reviewed: boolean
  /** The classified attempt window, in milliseconds. */
  segments: Segment[]
}

function activeQuantity(totals: ClassTotals, evidence: WorkerEvidence, open: boolean): AttemptTiming['active'] {
  const state: TimingState = evidence.estimated ? 'estimated' : 'observed'
  const coverage = { covered: evidence.reported ? 1 : 0, of: 1, unit: 'attempts' } as const
  return quantity('measured_active', { aggregation: 'single', ms: evidence.reported ? totals.active : null, state, coverage, open })
}

const bucketOf = (attempt: { superseded: boolean; outcome: AttemptTimingOutcome }): string => (attempt.superseded ? 'superseded' : attempt.outcome)

function buildAttempt(facts: AttemptFacts, mine: readonly Span[], context: Context): BuiltAttempt {
  const { window, endedBy, open } = attemptWindow(facts, context)
  const evidence = workerEvidence(mine, window, context.work)
  const lastSignal = lastSignalOf(facts, window, evidence.active)
  const layers: Layer[] = [
    ...evidence.layers,
    ...pauseLayers(context.run.pauses, PRIORITY.attemptPause),
    { start: lastSignal, end: window.end, priority: 1, label: { class: 'unknown', reason: 'after_last_signal', evidence: 'none' } }
  ]
  const segments = classify(window, layers, { class: 'unknown', reason: 'no_activity_evidence', evidence: 'none' }, context.work)
  const totals = classTotals(segments)
  const elapsedMs = window.end - window.start
  const effortWindow = effortWindowOf(facts, window, context)
  const decidedMs = facts.submittedMs === null ? null : (facts.decision?.ms ?? null)
  const reviewed = facts.submittedMs !== null
  const scope: EffortScope = { attempts: 1, reporting: evidence.reported ? 1 : 0, reviewed: new Set(reviewed ? [facts.claim.attemptId] : []) }
  const timing: AttemptTiming = {
    attemptId: facts.claim.attemptId,
    ticketId: facts.claim.ticketId,
    sprintId: facts.claim.sprintId,
    number: facts.claim.number,
    outcome: outcomeOf(facts),
    superseded: facts.superseded,
    claimedAt: iso(facts.claimMs),
    endedAt: open ? null : iso(window.end),
    endedBy,
    submittedAt: facts.submittedMs === null ? null : iso(facts.submittedMs),
    decidedAt: decidedMs === null ? null : iso(decidedMs),
    lastSignalAt: iso(lastSignal),
    elapsed: quantity('attempt_elapsed', { aggregation: 'single', ms: elapsedMs, state: 'observed', coverage: msCoverage(totals, elapsedMs), open }),
    active: activeQuantity(totals, evidence, open),
    ...classified(totals, elapsedMs, 'single', open),
    effort: effortOf(mine.map((span) => ({ span, piece: clip(span, effortWindow, context.work), bucket: 'attempt' })), scope, context.work).totals,
    segments: toTimingSegments(segments)
  }
  return { timing, facts, window, effortWindow, open, reported: evidence.reported, reviewed, segments }
}

// ---------------------------------------------------------------------------------------------------------------
// Tickets

/** Counts, elapsed and unknown time by bucket from the attempts; each bucket's effort share from `effort`. */
function outcomeBuckets(attempts: readonly BuiltAttempt[], effort: Effort): OutcomeEffortTotals {
  const buckets = new Map<string, OutcomeEffort>()
  const bucket = (key: string): OutcomeEffort => {
    const known = buckets.get(key) ?? { attempts: 0, elapsedMs: 0, effortMs: 0, unreported: 0, unknownMs: 0 }
    buckets.set(key, known)
    return known
  }
  for (const { timing, reported } of attempts) {
    const entry = bucket(bucketOf(timing))
    entry.attempts += 1
    entry.elapsedMs += timing.elapsed.ms ?? 0
    entry.unreported += reported ? 0 : 1
    entry.unknownMs += timing.unknown.ms ?? 0
  }
  for (const [key, ms] of effort.byBucket) bucket(key).effortMs += ms
  return Object.fromEntries(buckets) as OutcomeEffortTotals
}

function reviewLayers(facts: AttemptFacts, next: number): Layer[] {
  if (facts.submittedMs === null) return []
  return [{ start: facts.submittedMs, end: facts.decision?.ms ?? next, priority: PRIORITY.review, label: { class: 'review', reason: 'awaiting_review', evidence: 'lifecycle' } }]
}

function reconciliationLayers(facts: AttemptFacts, next: number): Layer[] {
  if (facts.endedBy !== 'lease_expired' || facts.endMs === null) return []
  return [{ start: facts.endMs, end: facts.reconciledMs ?? next, priority: PRIORITY.reconciliation, label: { class: 'queue', reason: 'awaiting_reconciliation', evidence: 'lifecycle' } }]
}

const AWAITING_PERSON_GRANT: Label = { class: 'human_approval', reason: 'awaiting_retry_grant', evidence: 'lifecycle' }
const AWAITING_ORCHESTRATOR_RETRY: Label = { class: 'queue', reason: 'awaiting_orchestrator_retry', evidence: 'lifecycle' }

/**
 * The first retry grant between the attempt's close and the next claim, and what the time before it waited on: a
 * person for their grant, the orchestrator (orchestration time, never a person's approval) for its own retry.
 */
function retryGrantLayers(facts: AttemptFacts, next: number, run: RunFacts): Layer[] {
  const closed = facts.decision?.ms ?? facts.reconciledMs ?? facts.endMs ?? next
  const grant = firstGrant(run, facts.claim.ticketId, (ms) => ms >= closed && ms <= next)
  if (grant === null) return []
  return [{ start: closed, end: grant.ms, priority: PRIORITY.retryGrant, label: grant.byOrchestrator ? AWAITING_ORCHESTRATOR_RETRY : AWAITING_PERSON_GRANT }]
}

/** The earliest grant of the ticket that `within` takes, the person's or the orchestrator's; null when there is none. */
function firstGrant(run: RunFacts, ticketId: string, within: (ms: number) => boolean): { ms: number; byOrchestrator: boolean } | null {
  const person = (run.retryGrants.get(ticketId) ?? []).find(within)
  const orchestrator = (run.autoRetryGrants.get(ticketId) ?? []).find(within)
  if (orchestrator !== undefined && (person === undefined || orchestrator < person)) return { ms: orchestrator, byOrchestrator: true }
  return person === undefined ? null : { ms: person, byOrchestrator: false }
}

/** Marks where an attempt was open in the ticket's timeline; replaced by that attempt's own segments. */
const IN_ATTEMPT: Label = { class: 'unknown', reason: 'no_lifecycle_evidence', evidence: 'none' }

function ticketLayers(attempts: readonly BuiltAttempt[], run: RunFacts, end: number): Layer[] {
  const layers = pauseLayers(run.pauses, PRIORITY.pause)
  attempts.forEach((attempt, i) => {
    const { facts } = attempt
    const next = attempts[i + 1]?.facts.claimMs ?? end
    layers.push({ ...attempt.window, priority: PRIORITY.attempt, label: IN_ATTEMPT })
    layers.push(...reviewLayers(facts, next), ...reconciliationLayers(facts, next), ...retryGrantLayers(facts, next, run))
  })
  return layers
}

/**
 * The ticket's timeline: its own classification outside attempts, and inside each attempt window the attempt's
 * segments (the earlier claim's where attempts overlap), merged where labels meet.
 */
function ticketSegments(window: Interval, attempts: readonly BuiltAttempt[], run: RunFacts, work: IntervalWork | undefined): Segment[] {
  const fallback: Label = { class: 'queue', reason: 'ready_unclaimed', evidence: 'lifecycle' }
  const outline = classify(window, ticketLayers(attempts, run, window.end), fallback, work)
  const inner = attempts.flatMap((a) => a.segments).sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  let j = 0
  for (const part of outline) {
    if (part.label !== IN_ATTEMPT) {
      appendSegment(out, part)
      continue
    }
    let cursor = part.start
    while (j < inner.length && (inner[j] as Segment).end <= cursor) j += 1
    for (let k = j; k < inner.length && (inner[k] as Segment).start < part.end; k += 1) {
      const piece = clip(inner[k] as Segment, { start: cursor, end: part.end }, work)
      if (piece === null) continue
      appendSegment(out, { ...(inner[k] as Segment), start: piece.start, end: piece.end })
      cursor = piece.end
    }
  }
  return out
}

/** When the ticket became ready; a readiness after its first claim contradicts the record and is dropped. */
function readinessOf(ticketId: string, firstClaim: number | null, context: Context): number | null {
  const ready = context.run.ready.get(ticketId) ?? null
  if (ready === null || firstClaim === null || ready <= firstClaim) return ready
  context.anomalies.push({ kind: 'event_out_of_place', subject: ticketId, detail: `ready at ${iso(ready)}, after its first claim` })
  return null
}

interface TicketEnd {
  end: number
  endedBy: WindowEnd
  open: boolean
  accepted: number | null
}

/** The latest acceptance that was not superseded, else the run's end, else the cutoff (open). */
function ticketEndOf(attempts: readonly BuiltAttempt[], context: Context): TicketEnd {
  const accepted = attempts.filter((a) => a.facts.decision?.kind === 'accepted' && !a.facts.superseded).at(-1)?.facts.decision?.ms ?? null
  if (accepted !== null) return { end: accepted, endedBy: 'accepted', open: false, accepted }
  if (context.run.endMs !== null) return { end: context.run.endMs, endedBy: 'run_ended', open: false, accepted }
  return { end: context.asOf, endedBy: 'cutoff', open: true, accepted }
}

interface BuiltTicket {
  timing: TicketTiming
  attempts: BuiltAttempt[]
  /** Every class over the ticket's whole window (readiness, or first claim, to its end). */
  totals: ClassTotals
  windowMs: number
  open: boolean
}

interface TicketWindows {
  ready: number | null
  firstClaim: number | null
  ending: TicketEnd
  /** Readiness (else first claim) to the end; null when neither is known, or for a carried-forward ticket. */
  whole: Interval | null
  /** First claim to the end; null without a claim. */
  cycle: Interval | null
}

function ticketWindows(ticketId: string, attempts: readonly BuiltAttempt[], carried: boolean, context: Context): TicketWindows {
  const firstClaim = attempts[0]?.facts.claimMs ?? null
  const ending = ticketEndOf(attempts, context)
  const ready = carried ? null : readinessOf(ticketId, firstClaim, context)
  const start = ready ?? firstClaim
  const whole = start === null ? null : { start, end: Math.max(start, ending.end) }
  const cycle = firstClaim === null ? null : { start: firstClaim, end: Math.max(firstClaim, ending.end) }
  return { ready, firstClaim, ending, whole, cycle }
}

function activeOfTicket(attempts: readonly BuiltAttempt[], cycleTotals: ClassTotals, open: boolean): TicketTiming['active'] {
  const reporting = attempts.filter((a) => a.reported).length
  const estimated = attempts.some((a) => a.timing.active.state === 'estimated')
  const state: TimingState = reporting < attempts.length ? 'partial' : estimated ? 'estimated' : 'observed'
  const coverage = { covered: reporting, of: attempts.length, unit: 'attempts' } as const
  return quantity('measured_active', { aggregation: 'union', ms: reporting === 0 ? null : cycleTotals.active, state, coverage, open })
}

/** Ready to first claim (queue or blocked); missing when readiness is unknown. */
function waitBeforeDispatch(windows: TicketWindows, segments: readonly Segment[], work: IntervalWork | undefined): TicketTiming['waitBeforeDispatch'] {
  const { ready, firstClaim, whole, ending } = windows
  if (ready === null || whole === null) return missing('classified_wait', 'milliseconds')
  const to = firstClaim ?? whole.end
  const before = classTotals(within(segments, { start: ready, end: to }, work))
  const ms = to - ready - before.unknown - before.active
  const state = to > ready ? 'observed' : 'missing'
  return quantity('classified_wait', { aggregation: 'single', ms, state, coverage: msCoverage(before, to - ready), open: firstClaim === null && ending.open })
}

interface TicketInput {
  ticketId: string
  sprintId: string | null
  attempts: BuiltAttempt[]
  /** Accepted in an earlier run and carried forward (not superseded since). */
  carried: boolean
}

/** Cycle and lead time: missing without a first claim, or without known readiness. */
function ticketSpans(windows: TicketWindows, segments: readonly Segment[], cycleTotals: ClassTotals, work: IntervalWork | undefined): Pick<TicketTiming, 'cycleTime' | 'leadTime'> {
  const { whole, cycle, ending, ready } = windows
  const cycleMs = cycle === null ? 0 : length([cycle], work)
  const wholeMs = whole === null ? 0 : length([whole], work)
  const open = ending.open
  return {
    cycleTime: cycle === null ? missing('ticket_cycle_time', 'milliseconds') : quantity('ticket_cycle_time', { aggregation: 'single', ms: cycleMs, state: 'observed', coverage: msCoverage(cycleTotals, cycleMs), open }),
    leadTime: ready === null || whole === null ? missing('ticket_lead_time', 'milliseconds') : quantity('ticket_lead_time', { aggregation: 'single', ms: wholeMs, state: 'observed', coverage: msCoverage(classTotals(segments), wholeMs), open })
  }
}

function buildTicket(input: TicketInput, context: Context): BuiltTicket {
  const { ticketId, attempts, carried } = input
  const windows = ticketWindows(ticketId, attempts, carried, context)
  const { whole, cycle, ending, ready } = windows
  const segments = whole === null ? [] : ticketSegments(whole, attempts, context.run, context.work)
  const cycleTotals = classTotals(cycle === null ? [] : within(segments, cycle, context.work))
  const cycleMs = cycle === null ? 0 : length([cycle], context.work)
  const wholeMs = whole === null ? 0 : length([whole], context.work)
  for (const attempt of attempts) attempt.timing.sprintId = input.sprintId
  const timing: TicketTiming = {
    ticketId,
    sprintId: input.sprintId,
    carriedForward: carried,
    readyAt: ready === null ? null : iso(ready),
    firstClaimAt: windows.firstClaim === null ? null : iso(windows.firstClaim),
    acceptedAt: ending.accepted === null ? null : iso(ending.accepted),
    endedBy: ending.endedBy,
    ...ticketSpans(windows, segments, cycleTotals, context.work),
    ...classified(cycleTotals, cycleMs, 'single', ending.open),
    active: activeOfTicket(attempts, cycleTotals, ending.open),
    waitBeforeDispatch: waitBeforeDispatch(windows, segments, context.work),
    effort: effortOf([], { attempts: 0, reporting: 0, reviewed: new Set() }, context.work).totals,
    effortByOutcome: {},
    attempts: attempts.map((a) => a.timing),
    segments: toTimingSegments(segments)
  }
  return { timing, attempts: [...attempts], totals: classTotals(segments), windowMs: wholeMs, open: ending.open }
}

// ---------------------------------------------------------------------------------------------------------------
// Windows (sprints and the run)

interface WindowParts {
  window: Interval | null
  endedBy: WindowEnd
  attempts: readonly BuiltAttempt[]
  tickets: readonly BuiltTicket[]
  placed: readonly Placed[]
  /** Human-approval wait at this level (sprint checkpoints), added to the tickets' waits. */
  approvalMs: number
  /**
   * Attempts with events but no claim on record (only the run knows them): their windows cannot be placed, so they are
   * counted in the attempt coverage of the wall clocks and effort and never covered, and those totals are partial.
   */
  unclaimed: number
  work: IntervalWork | undefined
}

/** The tickets' classified time summed (ticket-milliseconds), plus this level's checkpoint wait. */
function summedTotals(tickets: readonly BuiltTicket[], approvalMs: number): { totals: ClassTotals; of: number } {
  const totals = classTotals([])
  let of = approvalMs
  for (const ticket of tickets) {
    for (const kind of Object.keys(totals) as (keyof ClassTotals)[]) totals[kind] += ticket.totals[kind]
    of += ticket.windowMs
  }
  totals.human_approval += approvalMs
  return { totals, of }
}

function scopeOf(attempts: readonly BuiltAttempt[], unclaimed = 0): EffortScope {
  return {
    attempts: attempts.length + unclaimed,
    reporting: attempts.filter((a) => a.reported).length,
    reviewed: new Set(attempts.filter((a) => a.reviewed).map((a) => a.facts.claim.attemptId))
  }
}

/** Wall clocks and the attempt elapsed sum; with no attempt they are missing, not zero; an unclaimed attempt makes them partial. */
function wallClocks(parts: WindowParts, open: boolean): Pick<SprintTiming, 'inFlight' | 'activeWallClock' | 'attemptElapsedSum'> {
  const { attempts, placed, unclaimed, work } = parts
  const reporting = attempts.filter((a) => a.reported).length
  const counted = attempts.length + unclaimed
  const placedState: TimingState = attempts.length === 0 ? 'missing' : unclaimed > 0 ? 'partial' : 'observed'
  const anyAttemptOpen = attempts.some((a) => a.open)
  const active = union(placed.flatMap((p) => (p.span.metric === 'active_ms' && p.piece !== null ? [p.piece] : [])), work)
  const activeState: TimingState = active.length === 0 ? 'missing' : reporting < counted ? 'partial' : 'observed'
  const elapsedSum = attempts.reduce((sum, a) => sum + length([a.window], work), 0)
  const unknownSum = attempts.reduce((sum, a) => sum + (a.timing.unknown.ms ?? 0), 0)
  return {
    inFlight: quantity('in_flight_wall_clock', { aggregation: 'union', ms: length(union(attempts.map((a) => a.window), work), work), state: placedState, coverage: { covered: attempts.length, of: counted, unit: 'attempts' }, open: anyAttemptOpen }),
    activeWallClock: quantity('active_wall_clock', { aggregation: 'union', ms: length(active, work), state: activeState, coverage: { covered: reporting, of: counted, unit: 'attempts' }, open }),
    attemptElapsedSum: quantity('attempt_elapsed', { aggregation: 'sum', ms: elapsedSum, state: placedState, coverage: { covered: elapsedSum - unknownSum, of: elapsedSum, unit: 'milliseconds' }, open: anyAttemptOpen })
  }
}

type WindowTotals = Omit<SprintTiming, 'sprintId' | 'membership' | 'ticketIds' | 'checkpointWait' | 'unattributedOverhead'>

function windowTiming(parts: WindowParts): WindowTotals {
  const { window, attempts, tickets, placed, endedBy, work } = parts
  const open = endedBy === 'cutoff'
  const { totals, of } = summedTotals(tickets, parts.approvalMs)
  const anyOpen = open || tickets.some((t) => t.open)
  const elapsedMs = window === null ? 0 : length([window], work)
  const effort = effortOf(placed, scopeOf(attempts, parts.unclaimed), work)
  return {
    elapsed: window === null ? missing('window_elapsed', 'milliseconds') : quantity('window_elapsed', { aggregation: 'single', ms: elapsedMs, state: 'observed', coverage: { covered: elapsedMs, of: elapsedMs, unit: 'milliseconds' }, open }),
    startedAt: window === null ? null : iso(window.start),
    endedAt: window === null || open ? null : iso(window.end),
    endedBy,
    ...wallClocks(parts, anyOpen),
    effort: effort.totals,
    ...classified(totals, of, 'sum', anyOpen),
    effortByOutcome: outcomeBuckets(attempts, effort)
  }
}

type PlacedSpan = Placed & { sprintId: string | null; ticketId: string | null }

interface Projection {
  context: Context
  attempts: BuiltAttempt[]
  tickets: BuiltTicket[]
  placed: PlacedSpan[]
}

/** Report submitted to the first approval after it (else the next sprint, the run's end, the cutoff). */
function checkpointWait(sprintId: string, next: number | undefined, context: Context): SprintTiming['checkpointWait'] {
  const { run, asOf } = context
  const report = run.reports.find((r) => r.sprintId === sprintId)
  if (report === undefined) return missing('classified_wait', 'milliseconds')
  const approval = run.approvals.find((a) => a.sprintId === sprintId && a.ms >= report.ms)
  const end = approval?.ms ?? next ?? run.endMs ?? asOf
  const ms = Math.max(0, end - report.ms)
  const open = approval === undefined && next === undefined && run.endMs === null
  return quantity('classified_wait', { aggregation: 'single', ms, state: 'observed', coverage: { covered: ms, of: ms, unit: 'milliseconds' }, open })
}

/** Run-scoped spans (in no sprint) inside the sprint's window: shown beside it, never in its effort. */
function unattributedOverhead(window: Interval | null, projection: Projection): SprintTiming['unattributedOverhead'] {
  if (window === null) return missing('resource_effort', 'attempts', 'sum')
  const { work } = projection.context
  const inside = projection.placed
    .filter((p) => p.sprintId === null)
    .map((p) => ({ ...p, piece: p.piece === null ? null : clip(p.piece, window, work) }))
    .filter((p) => p.piece !== null)
  return effortOf(inside, { attempts: 0, reporting: 0, reviewed: new Set() }, work).totals.total
}

/** A sprint from its activation to the next sprint's, the run's end or the cutoff; every total by current-plan membership. */
function sprintTiming(sprintId: string, projection: Projection): SprintTiming {
  const { run, asOf } = projection.context
  const activation = run.activations.find((a) => a.sprintId === sprintId)
  const next = activation === undefined ? undefined : run.activations.find((a) => a.ms > activation.ms && a.sprintId !== sprintId)?.ms
  const endedBy: WindowEnd = next !== undefined ? 'next_sprint' : run.endMs !== null ? 'run_ended' : 'cutoff'
  const end = next ?? run.endMs ?? asOf
  const window = activation === undefined ? null : { start: activation.ms, end: Math.max(activation.ms, end) }
  const members = projection.tickets.filter((t) => t.timing.sprintId === sprintId)
  const wait = checkpointWait(sprintId, next, projection.context)
  return {
    sprintId,
    membership: 'current_plan',
    ticketIds: members.map((t) => t.timing.ticketId),
    checkpointWait: wait,
    unattributedOverhead: unattributedOverhead(window, projection),
    ...windowTiming({
      window,
      endedBy,
      attempts: members.flatMap((t) => t.attempts),
      tickets: members,
      placed: projection.placed.filter((p) => p.sprintId === sprintId),
      approvalMs: wait.ms ?? 0,
      unclaimed: 0,
      work: projection.context.work
    })
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group === undefined) groups.set(k, [item])
    else group.push(item)
  }
  return groups
}

/**
 * Tickets of the current plan, with attempts, or that became ready. A ticket's sprint is the one holding it in the
 * current plan, else its last attempt's (mapped); a ticket in neither is listed as unattributed.
 */
function buildTickets(input: TimingInput, built: readonly BuiltAttempt[], carried: readonly AttemptFacts[], context: Context): BuiltTicket[] {
  const planSprint = new Map((input.tickets ?? []).map((t) => [t.ticketId, t.sprintId]))
  const byTicket = groupBy(built, (a) => a.facts.claim.ticketId)
  const carriedTickets = new Set(carried.filter((c) => !c.superseded).map((c) => c.claim.ticketId))
  const ticketIds = new Set([...planSprint.keys(), ...byTicket.keys(), ...carriedTickets, ...context.run.ready.keys()])
  return [...ticketIds].map((ticketId) => {
    const attempts = byTicket.get(ticketId) ?? []
    const sprintId = planSprint.get(ticketId) ?? attempts.at(-1)?.facts.claim.sprintId ?? null
    if (sprintId === null) context.anomalies.push({ kind: 'unattributed', subject: ticketId, detail: 'the ticket is in no sprint of the current plan; its time counts only in run totals' })
    return buildTicket({ ticketId, sprintId, attempts, carried: carriedTickets.has(ticketId) && attempts.length === 0 }, context)
  })
}

/** Spans scoped to an attempt of this run count in its effort window, all others in the run's; each takes its ticket's sprint. */
function placeSpans(spans: readonly Span[], projection: Omit<Projection, 'placed'>, sprints: SprintMap): PlacedSpan[] {
  const { run, asOf, anomalies, work } = projection.context
  const byId = new Map(projection.attempts.map((a) => [a.facts.claim.attemptId, a]))
  const ticketSprint = new Map(projection.tickets.map((t) => [t.timing.ticketId, t.timing.sprintId]))
  const runWindow: Interval = { start: run.startMs ?? Number.NEGATIVE_INFINITY, end: run.endMs ?? asOf }
  return spans.map((span) => {
    const attempt = span.attemptId === null ? undefined : byId.get(span.attemptId)
    if (span.attemptId !== null && attempt === undefined) {
      anomalies.push({ kind: 'event_out_of_place', subject: span.observationId, detail: `scoped to attempt ${span.attemptId}, which has no claim counted in this run` })
    }
    const ticketId = attempt?.facts.claim.ticketId ?? span.ticketId
    const sprintId = ticketId === null || !ticketSprint.has(ticketId) ? sprints.map(span.sprintId, `span ${span.observationId}`) : (ticketSprint.get(ticketId) ?? null)
    return attempt === undefined
      ? { span, piece: clip(span, runWindow, work), bucket: 'unscoped', sprintId, ticketId }
      : { span, piece: clip(span, attempt.effortWindow, work), bucket: bucketOf(attempt.timing), sprintId, ticketId }
  })
}

function ticketEffort(projection: Projection): void {
  const placedByTicket = groupBy(projection.placed, (p) => p.ticketId ?? '')
  for (const ticket of projection.tickets) {
    const effort = effortOf(placedByTicket.get(ticket.timing.ticketId) ?? [], scopeOf(ticket.attempts), projection.context.work)
    ticket.timing.effort = effort.totals
    ticket.timing.effortByOutcome = outcomeBuckets(ticket.attempts, effort)
  }
}

function buildAttempts(facts: readonly AttemptFacts[], spans: readonly Span[], context: Context): BuiltAttempt[] {
  const spansByAttempt = groupBy(spans, (span) => span.attemptId ?? '')
  return facts
    .filter((f) => !f.claim.carriedForward)
    .sort((a, b) => a.claimMs - b.claimMs || a.claim.number - b.claim.number)
    .map((f) => buildAttempt(f, spansByAttempt.get(f.claim.attemptId) ?? [], context))
}

/**
 * Projects a run's timing as of `asOf`. Pure: the same input always gives the same output, whatever order the
 * events arrive in (observations keep ledger order only between deliveries of one id). Interval work is tallied into
 * `work` when given.
 */
export function projectTiming(input: TimingInput, work?: IntervalWork): RunTiming {
  const asOf = Date.parse(input.asOf)
  if (Number.isNaN(asOf)) fail('invalid_input', `asOf ${input.asOf} is not a time.`, { asOf: input.asOf })
  const anomalies: TimingAnomaly[] = [...(input.feedAnomalies ?? [])]
  const sprints = new SprintMap(input.sprintAliases ?? {}, anomalies)
  const ordered = currentSprints(orderEvents(input.events, asOf, anomalies), sprints)
  const context: Context = { run: runFacts(ordered, asOf, anomalies), asOf, anomalies, work }
  const spans = prepareSpans(input.activity, asOf, anomalies, work)
  const { attempts: facts, unclaimed } = attemptFacts(ordered, anomalies)
  const carried = facts.filter((f) => f.claim.carriedForward)
  const attempts = buildAttempts(facts, spans, context)
  const tickets = buildTickets(input, attempts, carried, context)
  const projection: Projection = { context, attempts, tickets, placed: [] }
  projection.placed = placeSpans(spans, projection, sprints)
  ticketEffort(projection)
  const sprintIds = new Set([...context.run.activations.map((a) => a.sprintId), ...tickets.map((t) => t.timing.sprintId), ...projection.placed.map((p) => p.sprintId)])
  const sprintTimings = [...sprintIds].filter((id): id is string => id !== null).map((id) => sprintTiming(id, projection))
  const runStart = context.run.startMs ?? ordered[0]?.ms ?? null
  const runEnd = context.run.endMs ?? asOf
  const noSprint = projection.placed.filter((p) => p.sprintId === null)
  return {
    runId: input.runId,
    asOf: iso(asOf),
    ...windowTiming({
      window: runStart === null ? null : { start: runStart, end: Math.max(runStart, runEnd) },
      endedBy: context.run.endMs === null ? 'cutoff' : 'run_ended',
      attempts,
      tickets,
      placed: projection.placed,
      approvalMs: sprintTimings.reduce((sum, s) => sum + (s.checkpointWait.ms ?? 0), 0),
      unclaimed,
      work
    }),
    sprints: sprintTimings,
    tickets: tickets.map((t) => t.timing),
    unattributedEffort: effortOf(noSprint, scopeOf(attempts.filter((a) => a.timing.sprintId === null)), work).totals,
    carriedForwardAttemptIds: carried.map((c) => c.claim.attemptId),
    anomalies
  }
}
