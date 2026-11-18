/**
 * Feeds the pure timing projection (`src/core/space/timing.ts`) one run's records: the attempt, run, report,
 * approval and checkpoint rows (portable, so a run imported from another machine still projects), the local event
 * log where it adds detail the rows lack (pauses, progress notes, retry grants, exact failure and cancel times),
 * and the run's host and agent activity observations from the metric ledger. Reads only, apart from the lazy
 * lease expiry every run read model does first.
 */
import type { PlanBundle } from '../../shared/domain/bundle'
import type { AttemptState } from '../../shared/domain/status'
import type { RunTiming, TimingAnomaly } from '../../shared/domain/timing'
import type { AttemptDecision } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { fail } from '../errors'
import { projectTiming, type TimingEvent, type TimingInput } from '../space/timing'
import { type EventRow, toEventView } from './events'
import { type AttemptRow, expireLeases, loadBundle, requireRun, type RunRow } from './execution'
import { listObservations } from './observations'
import { cutoffOf } from './performance'

const TIMING_EVENT_KINDS = [
  'run.started',
  'run.paused',
  'run.resumed',
  'run.taken_over',
  'run.canceled',
  'run.failed',
  'checkpoint.advanced',
  'ticket.retry_granted',
  'attempt.running',
  'attempt.progress',
  'attempt.failed',
  'attempt.lease_expired',
  'run.revision_adopted'
]

interface LoggedEvent {
  seq: number
  at: string
  kind: string
  ticketId: string | null
  payload: Record<string, unknown>
}

function loggedEvents(ctx: Ctx, runId: string): LoggedEvent[] {
  const rows = ctx.db.all<EventRow>(
    `SELECT * FROM events WHERE run_id = ? AND kind IN (${TIMING_EVENT_KINDS.map(() => '?').join(', ')}) ORDER BY seq`,
    runId,
    ...TIMING_EVENT_KINDS
  )
  return rows.map(toEventView).map((event) => ({ seq: event.seq, at: event.at, kind: event.kind, ticketId: event.ticketId, payload: event.payload }))
}

function sprintOfTicket(bundle: PlanBundle, ticketId: string): string | null {
  return bundle.sprints.find((sprint) => sprint.ticketIds.includes(ticketId))?.id ?? null
}

/** The string ids a logged event lists under `key` (`canceledAttempts`, `expiredAttempts`). */
function listed(event: LoggedEvent, key: string): string[] {
  const value = event.payload[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function payloadText(event: LoggedEvent | undefined, key: string): string | null {
  const value = event?.payload[key]
  return typeof value === 'string' ? value : null
}

// ---------------------------------------------------------------------------------------------------------------
// Run and sprint events

/** Start (activating the logged first sprint, else the plan's first) and end, from the run row. */
function startAndEnd(run: RunRow, bundle: PlanBundle, log: readonly LoggedEvent[]): TimingEvent[] {
  const events: TimingEvent[] = []
  if (run.ended_at !== null) events.push({ kind: 'run_ended', at: run.ended_at })
  if (run.started_at === null) return events
  const first = [...bundle.sprints].sort((a, b) => a.ordinal - b.ordinal)[0]
  const sprintId = payloadText(log.find((event) => event.kind === 'run.started'), 'activeSprintId') ?? first?.id ?? null
  events.push({ kind: 'run_started', at: run.started_at })
  if (sprintId !== null) events.push({ kind: 'sprint_activated', sprintId, at: run.started_at })
  return events
}

const FROM_LOG: Readonly<Record<string, (event: LoggedEvent) => TimingEvent | null>> = {
  'run.paused': (event) => ({ kind: 'run_paused', at: event.at, seq: event.seq }),
  'run.taken_over': (event) => ({ kind: 'run_paused', at: event.at, seq: event.seq }),
  'run.resumed': (event) => ({ kind: 'run_resumed', at: event.at, seq: event.seq }),
  'ticket.retry_granted': (event) => (event.ticketId === null ? null : { kind: 'retry_granted', ticketId: event.ticketId, at: event.at, seq: event.seq })
}

/** Pauses, resumes and retry grants, which only the log records. A run paused elsewhere still has its row's `paused_at`. */
function pausesAndGrants(run: RunRow, log: readonly LoggedEvent[]): TimingEvent[] {
  const events = log.map((event) => FROM_LOG[event.kind]?.(event) ?? null).filter((event): event is TimingEvent => event !== null)
  const pauseLogged = events.some((event) => event.kind === 'run_paused')
  if (!pauseLogged && run.state === 'paused' && run.paused_at !== null) events.push({ kind: 'run_paused', at: run.paused_at })
  return events
}

/** The sprint after `sprintId` in the revision that holds it (any revision the run used). */
function nextSprint(bundles: readonly PlanBundle[], sprintId: string): string | null {
  for (const bundle of bundles) {
    const from = bundle.sprints.find((sprint) => sprint.id === sprintId)
    if (from !== undefined) return bundle.sprints.find((sprint) => sprint.ordinal === from.ordinal + 1)?.id ?? null
  }
  return null
}

/** Each advancing checkpoint activates the next sprint (the logged one, else the next by ordinal in its revision). */
function advancements(ctx: Ctx, run: RunRow, bundles: readonly PlanBundle[], log: readonly LoggedEvent[]): TimingEvent[] {
  const rows = ctx.db.all<{ id: string; sprint_id: string; decided_at: string }>(
    "SELECT id, sprint_id, decided_at FROM checkpoints WHERE run_id = ? AND outcome = 'advanced' ORDER BY decided_at, id",
    run.id
  )
  const events: TimingEvent[] = []
  for (const row of rows) {
    const logged = log.find((event) => event.kind === 'checkpoint.advanced' && event.payload.checkpointId === row.id)
    const sprintId = payloadText(logged, 'toSprintId') ?? nextSprint(bundles, row.sprint_id)
    if (sprintId !== null) events.push({ kind: 'sprint_activated', sprintId, at: logged?.at ?? row.decided_at })
  }
  return events
}

/** A sprint's first report (the checkpoint wait starts) and first approval (a person answered). */
function checkpointEvents(ctx: Ctx, runId: string): TimingEvent[] {
  const reports = ctx.db.all<{ sprint_id: string; at: string }>('SELECT sprint_id, MIN(created_at) AS at FROM sprint_reports WHERE run_id = ? GROUP BY sprint_id', runId)
  const approvals = ctx.db.all<{ sprint_id: string; at: string }>('SELECT sprint_id, MIN(issued_at) AS at FROM approvals WHERE run_id = ? GROUP BY sprint_id', runId)
  return [
    ...reports.map((row): TimingEvent => ({ kind: 'sprint_report_submitted', sprintId: row.sprint_id, at: row.at })),
    ...approvals.map((row): TimingEvent => ({ kind: 'checkpoint_approved', sprintId: row.sprint_id, at: row.at }))
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Attempt events

/** Heartbeats and progress notes: the first heartbeat and notes from the log, the latest heartbeat from the row. */
function signals(row: AttemptRow, mine: readonly LoggedEvent[]): TimingEvent[] {
  const logged = mine.filter((event) => event.kind === 'attempt.running' || event.kind === 'attempt.progress')
  const events: TimingEvent[] = logged.map((event) => ({ kind: 'attempt_signal', attemptId: row.id, at: event.at, seq: event.seq }))
  const heartbeat = row.heartbeat_at
  if (heartbeat !== null && !logged.some((event) => event.at === heartbeat)) events.push({ kind: 'attempt_signal', attemptId: row.id, at: heartbeat })
  return events
}

function submissionAndDecision(row: AttemptRow): TimingEvent[] {
  const events: TimingEvent[] = []
  if (row.submitted_at !== null) events.push({ kind: 'attempt_submitted', attemptId: row.id, at: row.submitted_at })
  const decision = parseJson<AttemptDecision | null>(row.decision_json, null)
  if (row.decided_at !== null && decision !== null) {
    events.push({ kind: decision.outcome === 'accepted' ? 'attempt_accepted' : 'attempt_rejected', attemptId: row.id, at: row.decided_at })
  }
  return events
}

interface EndSources {
  row: AttemptRow
  run: RunRow
  log: readonly LoggedEvent[]
  mine: readonly LoggedEvent[]
  /** What the feed itself had to estimate, listed with the projection's anomalies. */
  notes: TimingAnomaly[]
}

function earliest(...times: (string | null | undefined)[]): string | null {
  const known = times.filter((at): at is string => typeof at === 'string' && !Number.isNaN(Date.parse(at)))
  return known.length === 0 ? null : known.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a))
}

/** The deadline the records show for an expired lease: the logged deadline, else the row's, else the takeover's. */
function recordedDeadline({ row, log, mine }: EndSources): string | null {
  const takeover = log.find((event) => event.kind === 'run.taken_over' && listed(event, 'expiredAttempts').includes(row.id))
  const logged = mine.find((event) => event.kind === 'attempt.lease_expired')
  const rowDeadline = row.state === 'lease_expired' ? row.lease_expires_at : null
  return earliest(payloadText(logged, 'leaseExpiresAt') ?? rowDeadline, takeover?.at) ?? logged?.at ?? null
}

function leaseExpired({ row, log, mine }: EndSources): boolean {
  if (row.state === 'lease_expired' || row.reconciled_at !== null) return true
  return mine.some((event) => event.kind === 'attempt.lease_expired') || log.some((event) => event.kind === 'run.taken_over' && listed(event, 'expiredAttempts').includes(row.id))
}

/**
 * The lease deadline of an attempt whose lease expired, whatever its state now (a reconcile `resubmit` moves it on
 * to submitted and clears the row's lease): the logged deadline, else the row's, else the takeover that expired it,
 * whichever came first. Null when nothing shows the lease expired. A resubmitted attempt with no log (a run imported
 * from another machine) ends at its last heartbeat, the latest time the records show it alive: an estimate, listed
 * as an `estimated_time` anomaly so it is never read as observed.
 */
function leaseDeadline(sources: EndSources): string | null {
  if (!leaseExpired(sources)) return null
  const known = recordedDeadline(sources)
  if (known !== null) return known
  const { row, notes } = sources
  const estimate = row.heartbeat_at ?? row.created_at
  notes.push({
    kind: 'estimated_time',
    subject: row.id,
    detail: `no record of the lease deadline: the lease expiry is placed at the attempt's ${row.heartbeat_at === null ? 'claim' : 'last heartbeat'} (${estimate}), an estimate`
  })
  return estimate
}

/**
 * How a failure or cancel is timed: its logged time (the row's `updated_at` is later overwritten by supersession or
 * reconciliation, so it is only the fallback; a cancel falls back to the run's end first).
 */
const ENDINGS: Partial<Record<AttemptState, (sources: EndSources) => TimingEvent>> = {
  failed: ({ row, mine }) => ({ kind: 'attempt_failed', attemptId: row.id, at: mine.find((event) => event.kind === 'attempt.failed')?.at ?? row.updated_at }),
  canceled: ({ row, run, log }) => {
    const logged = log.find((event) => (event.kind === 'run.canceled' || event.kind === 'run.failed') && listed(event, 'canceledAttempts').includes(row.id))
    return { kind: 'attempt_canceled', attemptId: row.id, at: logged?.at ?? run.ended_at ?? row.updated_at }
  }
}

function endings(sources: EndSources): TimingEvent[] {
  const { row } = sources
  const deadline = leaseDeadline(sources)
  const ending = ENDINGS[row.state]?.(sources)
  return [
    ...(deadline === null ? [] : [{ kind: 'attempt_lease_expired', attemptId: row.id, at: deadline } as const]),
    ...(ending === undefined ? [] : [ending]),
    ...(row.reconciled_at === null ? [] : [{ kind: 'attempt_reconciled', attemptId: row.id, at: row.reconciled_at } as const])
  ]
}

/** What every attempt's events are read against: its run, the run's log, and the anomalies the feed records. */
type EventSources = Pick<EndSources, 'run' | 'log' | 'notes'>

/**
 * One attempt's events. A carry-forward record is only its claim (and a later supersession): the acceptance it
 * records happened in an earlier run.
 */
function attemptEvents(row: AttemptRow, sprintId: string | null, sources: EventSources): TimingEvent[] {
  const carriedForward = row.kind === 'carry_forward'
  const events: TimingEvent[] = [{ kind: 'attempt_claimed', attemptId: row.id, ticketId: row.ticket_id, sprintId, number: row.number, carriedForward, at: row.created_at }]
  if (!carriedForward) {
    const mine = sources.log.filter((event) => event.payload.attemptId === row.id)
    events.push(...signals(row, mine), ...submissionAndDecision(row), ...endings({ ...sources, row, mine }))
  }
  if (row.superseded_at !== null) events.push({ kind: 'attempt_superseded', attemptId: row.id, at: row.superseded_at })
  return events
}

// ---------------------------------------------------------------------------------------------------------------
// Sprint ids across adoptions

/**
 * Every sprint id of an older revision the run used, mapped to the current plan's the way adoption maps the active
 * sprint: the same id if it survives, else the sprint with the same ordinal, else none (null).
 */
function sprintAliases(current: PlanBundle, bundles: Iterable<PlanBundle>): Record<string, string | null> {
  const kept = new Set(current.sprints.map((sprint) => sprint.id))
  const aliases: Record<string, string | null> = {}
  for (const bundle of bundles) {
    for (const sprint of bundle.sprints.filter((s) => !kept.has(s.id))) {
      aliases[sprint.id] = current.sprints.find((s) => s.ordinal === sprint.ordinal)?.id ?? null
    }
  }
  return aliases
}

/** The plan revisions the run has used, each loaded once: `of` reads any revision, `all` lists the used ones. */
interface KnownBundles {
  of(revisionId: string): PlanBundle
  /** Its current one, the ones its attempts ran under and the logged adoptions'. */
  all: PlanBundle[]
}

function knownBundles(ctx: Ctx, run: RunRow, attempts: readonly AttemptRow[], log: readonly LoggedEvent[]): KnownBundles {
  const loaded = new Map<string, PlanBundle>()
  const of = (revisionId: string): PlanBundle => {
    const held = loaded.get(revisionId)
    if (held !== undefined) return held
    const bundle = loadBundle(ctx, revisionId)
    loaded.set(revisionId, bundle)
    return bundle
  }
  const ids = new Set([run.revision_id, ...attempts.map((a) => a.revision_id)])
  for (const event of log.filter((e) => e.kind === 'run.revision_adopted')) {
    for (const key of ['from', 'to']) {
      const id = payloadText(event, key)
      if (id !== null) ids.add(id)
    }
  }
  return { of, all: [...ids].map(of) }
}

// ---------------------------------------------------------------------------------------------------------------
// Readiness

function firstActivations(events: readonly TimingEvent[], aliases: Readonly<Record<string, string | null>>): Map<string, string> {
  const activated = new Map<string, string>()
  for (const event of events) {
    if (event.kind !== 'sprint_activated') continue
    const sprintId = Object.hasOwn(aliases, event.sprintId) ? aliases[event.sprintId] : event.sprintId
    if (sprintId !== null && sprintId !== undefined && !activated.has(sprintId)) activated.set(sprintId, event.at)
  }
  return activated
}

/** Each ticket's earliest acceptance that still counts (a carried-forward acceptance counts from its record). */
function acceptances(attempts: readonly AttemptRow[]): Map<string, string> {
  const accepted = new Map<string, string>()
  for (const row of attempts.filter((a) => a.state === 'accepted' && a.superseded_at === null)) {
    const at = row.kind === 'carry_forward' ? row.created_at : row.decided_at
    const known = accepted.get(row.ticket_id)
    if (at !== null && (known === undefined || Date.parse(at) < Date.parse(known))) accepted.set(row.ticket_id, at)
  }
  return accepted
}

interface ReadyInputs {
  bundle: PlanBundle
  bundles: KnownBundles
  attempts: readonly AttemptRow[]
  events: readonly TimingEvent[]
  aliases: Readonly<Record<string, string | null>>
}

/**
 * The sprint whose activation made a ticket claimable: the one holding it in the revision its first claim ran under
 * (mapped to the current plan's id), else the one holding it now. A ticket an adoption later moved to another sprint
 * keeps the readiness it had when it was claimed.
 */
function readinessSprint({ bundle, bundles, attempts, aliases }: ReadyInputs, ticketId: string): string | null {
  const first = attempts.find((row) => row.ticket_id === ticketId && row.kind !== 'carry_forward')
  const claimed = first === undefined ? null : sprintOfTicket(bundles.of(first.revision_id), ticketId)
  if (claimed === null) return sprintOfTicket(bundle, ticketId)
  return Object.hasOwn(aliases, claimed) ? (aliases[claimed] ?? null) : claimed
}

/**
 * When each ticket became claimable, where the records show it: the activation of the sprint that held it when first
 * claimed (else its current sprint; an older sprint id mapped to it counts) and the acceptance of every ticket it
 * depends on, whichever came last. A ticket with any of those unknown gets no readiness.
 */
function readyEvents(inputs: ReadyInputs): TimingEvent[] {
  const { bundle, attempts, events, aliases } = inputs
  const activated = firstActivations(events, aliases)
  const accepted = acceptances(attempts)
  const ready: TimingEvent[] = []
  for (const ticket of bundle.tickets) {
    const sprintId = readinessSprint(inputs, ticket.id)
    const gates = [activated.get(sprintId ?? ''), ...bundle.edges.filter((edge) => edge.to === ticket.id).map((edge) => accepted.get(edge.from))]
    const known = gates.filter((at): at is string => at !== undefined)
    if (known.length === gates.length) {
      ready.push({ kind: 'ticket_ready', ticketId: ticket.id, at: known.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) })
    }
  }
  return ready
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * The pure projection's input for one run as of `asOf` (default now, and never later than now), including the sprint
 * aliases it maps older revisions' sprint ids by. Settles expired leases first, like every run read model, unless
 * `settleLeases` is false (a read of another run's history must not change it); call it inside a transaction.
 */
export function runTimingInput(ctx: Ctx, input: { runId: string; asOf?: string; settleLeases?: boolean }): TimingInput {
  if (input.settleLeases !== false) expireLeases(ctx, input.runId)
  const run = requireRun(ctx, input.runId)
  const log = loggedEvents(ctx, run.id)
  const attempts = ctx.db.all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at, rowid', run.id)
  const bundles = knownBundles(ctx, run, attempts, log)
  const bundle = bundles.of(run.revision_id)
  const aliases = sprintAliases(bundle, bundles.all)
  const events = [...startAndEnd(run, bundle, log), ...pausesAndGrants(run, log), ...advancements(ctx, run, bundles.all, log), ...checkpointEvents(ctx, run.id)]
  const notes: TimingAnomaly[] = []
  for (const row of attempts) {
    events.push(...attemptEvents(row, sprintOfTicket(bundles.of(row.revision_id), row.ticket_id), { run, log, notes }))
  }
  events.push(...readyEvents({ bundle, bundles, attempts, events, aliases }))
  const activity = listObservations(ctx.db, { runId: run.id }).filter((o) => o.metric === 'active_ms' || o.metric === 'wait_ms')
  const now = ctx.clock.nowIso()
  const asOf = input.asOf === undefined || Date.parse(input.asOf) > Date.parse(now) ? now : input.asOf
  return {
    runId: run.id,
    asOf,
    events,
    activity,
    tickets: bundle.tickets.map((ticket) => ({ ticketId: ticket.id, sprintId: sprintOfTicket(bundle, ticket.id) })),
    sprintAliases: aliases,
    feedAnomalies: notes
  }
}

/**
 * The run's timing as of `asOf` (default now, and never later than now): attempt elapsed and classified time,
 * ticket cycle and lead times, sprint and run totals with summed effort beside wall-clock unions. See
 * `projectTiming` for the rules.
 */
export function projectRunTiming(ctx: Ctx, input: { runId: string; asOf?: string }): RunTiming {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => projectTiming(runTimingInput(ctx, input)))
}

/**
 * The run's timing read (`getRunTiming`): `projectRunTiming` as of `cutoff` (default now, never later than now; a
 * malformed time is `invalid_input`), returned unchanged except that `ticketId` keeps only that ticket's entry
 * (`not_found` when the run holds no such ticket). Like every run read model it settles this run's expired leases first.
 */
export function getRunTiming(ctx: Ctx, input: { runId: string; ticketId?: string; cutoff?: string }): RunTiming {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => {
    const timing = projectTiming(runTimingInput(ctx, { runId: input.runId, asOf: cutoffOf(ctx, input.cutoff) }))
    if (input.ticketId === undefined) {
      return timing
    }
    const tickets = timing.tickets.filter((ticket) => ticket.ticketId === input.ticketId)
    if (tickets.length === 0) {
      fail('not_found', `Ticket ${input.ticketId} is not a ticket of run ${input.runId}.`, { ticketId: input.ticketId })
    }
    return { ...timing, tickets }
  })
}
