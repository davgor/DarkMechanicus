import { describe, expect, it } from 'vitest'
import type { RunTiming, TicketTiming, TimingSegment } from '../../shared/domain/timing'
import { makeBundle, makeSprint, sid, tid } from '../../test/bundles'
import { attemptRow, claim, errorCode, type IssuedClaim, seedEpic, seedRevision, startedRun } from '../../test/execution'
import { createTestClock, createTestCtx, type TestClock, type TestCtx, withRole } from '../../test/testContext'
import { adoptRevision } from './adoption'
import { retryTicket } from './autoRetry'
import { acceptAttempt, failAttempt, heartbeatAttempt, reconcileAttempt, rejectAttempt, submitAttempt } from './attempts'
import { type ObservationInput, recordObservations } from './observations'
import { advanceSprint, approveCheckpoint, grantRetry } from './checkpoints'
import { submitSprintReport } from './reports'
import { cancelRun, pauseRun, queueRun, resumeRun, startRun, takeoverRun } from './runs'
import { getRunTiming, projectRunTiming, runTimingInput } from './timing'

const T = (hm: string): string => `2026-11-01T${hm}:00.000Z`
const MIN = 60_000

function ticketOf(timing: RunTiming, n: number): TicketTiming {
  const ticket = timing.tickets.find((t) => t.ticketId === tid(n))
  if (ticket === undefined) throw new Error(`ticket ${n} was not projected`)
  return ticket
}

const outline = (segments: readonly TimingSegment[]): string[] => segments.map((s) => `${s.class}/${s.reason} ${s.start.slice(11, 16)}-${s.end.slice(11, 16)}`)

function world(start: string): { clock: TestClock; ctx: TestCtx; worker: TestCtx } {
  const clock = createTestClock(start)
  const ctx = createTestCtx({ clock })
  return { clock, ctx, worker: withRole(ctx, 'worker') }
}

function submit(worker: TestCtx, claimed: IssuedClaim): void {
  submitAttempt(worker, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken, outputs: { summary: 'done' } })
}

describe('DM-172 c1: lifecycle records through the real services', () => {
  it('a lease expiry reconciled by resubmit ends the attempt at its deadline; the gap waits for reconciliation', () => {
    const { clock, ctx, worker } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    const c = claim(ctx, runId, 1)
    clock.set(T('10:05'))
    heartbeatAttempt(worker, { attemptId: c.attempt.id, claimToken: c.packet.claimToken })
    clock.set(T('12:00'))
    reconcileAttempt(ctx, { attemptId: c.attempt.id, resolution: 'resubmit', outputs: { summary: 'done anyway' } })
    clock.set(T('12:10'))
    acceptAttempt(ctx, { attemptId: c.attempt.id })
    clock.set(T('12:30'))
    const timing = projectRunTiming(ctx, { runId })
    const ticket = ticketOf(timing, 1)
    const attempt = ticket.attempts[0]
    expect(attempt?.endedBy).toBe('lease_expired')
    expect(attempt?.endedAt).toBe(T('10:20'))
    expect(attempt?.elapsed.ms).toBe(20 * MIN)
    expect(attempt?.outcome).toBe('accepted')
    expect(outline(attempt?.segments ?? [])).toEqual(['unknown/no_activity_evidence 10:00-10:05', 'unknown/after_last_signal 10:05-10:20'])
    expect(ticket.waits.review.ms).toBe(10 * MIN)
    expect(ticket.waits.queue.ms).toBe(100 * MIN)
    expect(timing.anomalies).toEqual([])
  })

  it('a ticket carried forward at run start accrues no queue time and raises no anomaly', () => {
    const { clock, ctx, worker } = world(T('09:00'))
    const seeded = seedEpic(ctx, { bundle: makeBundle([[1, 2]]) })
    ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    const run = startRun(withRole(ctx, 'orchestrator'), { epicId: seeded.epicId, carryForward: [{ ticketId: tid(1), note: 'done last run' }] })
    clock.set(T('09:10'))
    const c = claim(ctx, run.id, 2, { leaseSeconds: 7200 })
    clock.set(T('09:40'))
    submit(worker, c)
    clock.set(T('09:50'))
    acceptAttempt(ctx, { attemptId: c.attempt.id })
    clock.set(T('18:00'))
    const timing = projectRunTiming(ctx, { runId: run.id })
    const carried = ticketOf(timing, 1)
    expect(carried.carriedForward).toBe(true)
    expect(carried.segments).toEqual([])
    expect(carried.waitBeforeDispatch.state).toBe('missing')
    expect(timing.waits.queue.ms).toBe(10 * MIN)
    expect(timing.sprints[0]?.waits.queue.ms).toBe(10 * MIN)
    expect(timing.anomalies).toEqual([])
  })
})

describe('DM-172 c1: an adoption that renames the active sprint, through the real services', () => {
  it('after an adoption renames the active sprint, the time tickets waited under the old id lands in the renamed sprint, none in no window', () => {
    const { clock, ctx, worker } = world(T('09:00'))
    const bundle = makeBundle([[1, 2, 3], [4]])
    const { runId, epicId } = startedRun(ctx, { bundle })
    clock.set(T('10:00'))
    const c1 = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    clock.set(T('10:30'))
    submit(worker, c1)
    clock.set(T('11:00'))
    rejectAttempt(ctx, { attemptId: c1.attempt.id, reasons: ['no'] })
    clock.set(T('11:10'))
    pauseRun(ctx, { runId, reason: 'replan' })
    const revision = seedRevision(ctx, epicId, { ...bundle, sprints: [makeSprint(11, [1, 2, 3], { ordinal: 1 }), makeSprint(2, [4])] })
    clock.set(T('11:20'))
    adoptRevision(withRole(ctx, 'orchestrator'), { runId, revisionId: revision })
    clock.set(T('11:30'))
    resumeRun(ctx, { runId })
    clock.set(T('12:00'))
    const c2 = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    clock.set(T('12:30'))
    submit(worker, c2)
    clock.set(T('13:00'))
    acceptAttempt(ctx, { attemptId: c2.attempt.id })
    clock.set(T('13:30'))
    claim(ctx, runId, 2, { leaseSeconds: 7200 })
    clock.set(T('14:00'))
    const timing = projectRunTiming(ctx, { runId })
    const renamed = timing.sprints.find((s) => s.sprintId === sid(11))
    expect(timing.sprints.map((s) => s.sprintId)).not.toContain(sid(1))
    expect(renamed?.startedAt).toBe(T('09:00'))
    expect([1, 2, 3].map((n) => ticketOf(timing, n).readyAt)).toEqual([T('09:00'), T('09:00'), T('09:00')])
    expect(renamed?.ticketIds).toEqual([tid(1), tid(2), tid(3)])
    expect(renamed?.attemptElapsedSum.ms).toBe(90 * MIN)
    expect(renamed?.waits.queue.ms).toBe(630 * MIN)
    expect(timing.waits.queue.ms).toBe(630 * MIN)
    expect(timing.anomalies).toEqual([])
  })
})

describe('DM-172 c1: an adoption that moves a ticket to another sprint, through the real services', () => {
  it('an attempt keeps the sprint its own revision put the ticket in, after an adoption moved the ticket to another', () => {
    const { clock, ctx, worker } = world(T('09:00'))
    const bundle = makeBundle([[1, 2], [3]])
    const { runId, epicId } = startedRun(ctx, { bundle })
    clock.set(T('10:00'))
    const c1 = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    clock.set(T('10:30'))
    submit(worker, c1)
    clock.set(T('11:00'))
    rejectAttempt(ctx, { attemptId: c1.attempt.id, reasons: ['no'] })
    pauseRun(ctx, { runId, reason: 'replan' })
    const revision = seedRevision(ctx, epicId, { ...bundle, sprints: [makeSprint(1, [2]), makeSprint(2, [3, 1])] })
    clock.set(T('11:20'))
    adoptRevision(withRole(ctx, 'orchestrator'), { runId, revisionId: revision })
    const input = runTimingInput(ctx, { runId })
    const claimed = input.events.filter((event) => event.kind === 'attempt_claimed').map((event) => [event.attemptId, event.sprintId])
    expect(claimed).toEqual([[c1.attempt.id, sid(1)]])
    expect(input.tickets?.find((ticket) => ticket.ticketId === tid(1))?.sprintId).toBe(sid(2))
  })
})

describe('DM-172 c1: a canceled run and its readers', () => {
  it('a run canceled under open attempts ends them with the cancel; a cutoff after now is clamped to now', () => {
    const { clock, ctx, worker } = world(T('09:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2, 3]]) })
    clock.set(T('10:00'))
    claim(ctx, runId, 1, { leaseSeconds: 7200 })
    const c2 = claim(ctx, runId, 2, { leaseSeconds: 7200 })
    clock.set(T('10:30'))
    submit(worker, c2)
    clock.set(T('11:00'))
    cancelRun(ctx, { runId, reason: 'stop' })
    clock.set(T('12:00'))
    const timing = projectRunTiming(ctx, { runId, asOf: '2030-01-01T00:00:00.000Z' })
    const [open] = ticketOf(timing, 1).attempts
    const [submitted] = ticketOf(timing, 2).attempts
    expect(timing.asOf).toBe(T('12:00'))
    expect(open).toMatchObject({ endedAt: T('11:00'), endedBy: 'canceled', outcome: 'canceled' })
    expect(submitted).toMatchObject({ endedAt: T('10:30'), endedBy: 'submitted', outcome: 'canceled', decidedAt: T('11:00') })
    expect(ticketOf(timing, 2).waits.review.ms).toBe(30 * MIN)
  })

  it('reading timing needs the read capability', () => {
    const { ctx } = world(T('09:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    expect(errorCode(() => projectRunTiming(withRole(ctx, 'worker', { capabilities: [] }), { runId }))).toBe('unauthorized')
  })
})

interface Driven {
  ctx: TestCtx
  worker: TestCtx
  goTo: (hm: string) => void
  runId: string
  epicId: string
  /** Each claim by name, with its ticket number. */
  claims: Map<string, { claimed: IssuedClaim; ticket: number }>
}

function held(run: Driven, name: string): IssuedClaim {
  const found = run.claims.get(name)
  if (found === undefined) throw new Error(`no claim ${name}`)
  return found.claimed
}

function claimAs(run: Driven, name: string, ticket: number, extra: Parameters<typeof claim>[3] = {}): void {
  run.claims.set(name, { claimed: claim(run.ctx, run.runId, ticket, extra), ticket })
}

/** A host activity span over `window` (`HH:MM-HH:MM`) for the named claim (null: the run), recorded when it ends. */
function activity(run: Driven, name: string | null, window: string, { actor = 'claude-code-adapter', ...labels }: { actor?: string; role?: string; handle?: string } = {}): void {
  const [from, to] = window.split('-') as [string, string]
  run.goTo(to)
  const scoped = name === null ? undefined : run.claims.get(name)
  const attemptId = scoped?.claimed.attempt.id ?? null
  const observation: ObservationInput = {
    metric: 'active_ms',
    unit: 'milliseconds',
    scope: { level: attemptId === null ? 'run' : 'attempt', epicId: run.epicId, sprintId: attemptId === null ? null : sid(1), runId: run.runId, ticketId: scoped === undefined ? null : tid(scoped.ticket), attemptId },
    source: { kind: 'host', actor },
    measurement: { state: 'observed', value: Date.parse(T(to)) - Date.parse(T(from)) },
    accumulation: 'event',
    sequence: null,
    observedAt: T(to),
    attributes: { spanStart: T(from), ...labels },
    evidence: []
  }
  recordObservations(run.ctx, [observation])
}

/** 09:50-11:15: three parallel claims; ticket 1 accepted, ticket 3's first lease expires and is abandoned. */
function firstHour(run: Driven): void {
  const { ctx, worker, goTo } = run
  activity(run, null, '09:50-10:00', { actor: 'orchestrator-chat', role: 'orchestrator' })
  goTo('10:00')
  claimAs(run, 'A1', 1, { leaseSeconds: 7200 })
  goTo('10:05')
  claimAs(run, 'A4', 3)
  goTo('10:10')
  heartbeatAttempt(worker, { attemptId: held(run, 'A4').attempt.id, claimToken: held(run, 'A4').packet.claimToken })
  activity(run, 'A4', '10:05-10:10')
  goTo('10:30')
  claimAs(run, 'A2', 2, { leaseSeconds: 7200 })
  goTo('10:40')
  heartbeatAttempt(worker, { attemptId: held(run, 'A1').attempt.id, claimToken: held(run, 'A1').packet.claimToken })
  goTo('11:00')
  submit(worker, held(run, 'A1'))
  activity(run, 'A1', '10:00-11:00')
  goTo('11:05')
  reconcileAttempt(ctx, { attemptId: held(run, 'A4').attempt.id, resolution: 'abandon' })
  activity(run, 'A1', '11:00-11:10', { actor: 'reviewer-chat', role: 'reviewer', handle: 'rv-1' })
  goTo('11:10')
  claimAs(run, 'A5', 3, { worker: { label: 'worker-2' } })
  goTo('11:15')
  acceptAttempt(ctx, { attemptId: held(run, 'A1').attempt.id })
}

/** 11:20-12:30: ticket 3's retry fails, the run pauses, ticket 2 is rejected then accepted on its retry. */
function secondHour(run: Driven): void {
  const { ctx, worker, goTo, runId } = run
  goTo('11:20')
  failAttempt(worker, { attemptId: held(run, 'A5').attempt.id, claimToken: held(run, 'A5').packet.claimToken, failure: { reason: 'tests would not build', retryable: true } })
  pauseRun(ctx, { runId, reason: 'person away' })
  goTo('11:28')
  resumeRun(ctx, { runId })
  goTo('11:30')
  submit(worker, held(run, 'A2'))
  activity(run, 'A2', '10:30-11:30')
  goTo('11:45')
  rejectAttempt(ctx, { attemptId: held(run, 'A2').attempt.id, reasons: ['c2 unmet'] })
  goTo('11:50')
  claimAs(run, 'A3', 2, { leaseSeconds: 7200 })
  goTo('12:10')
  submit(worker, held(run, 'A3'))
  activity(run, 'A3', '11:50-12:10')
  goTo('12:15')
  acceptAttempt(ctx, { attemptId: held(run, 'A3').attempt.id })
  goTo('12:30')
}

/**
 * A run driven through the real services (claims, heartbeats, submit, review, lease expiry, reconcile, failure,
 * pause) plus host activity recorded in the metric ledger, as of 12:30.
 */
function drivenRun(): RunTiming {
  const { clock, ctx, worker } = world('2026-11-01T09:50:00.000Z')
  const { runId, epicId } = startedRun(ctx, { bundle: makeBundle([[1, 2, 3]]) })
  const run: Driven = { ctx, worker, goTo: (hm) => clock.set(T(hm)), runId, epicId, claims: new Map() }
  firstHour(run)
  secondHour(run)
  return projectRunTiming(ctx, { runId })
}

describe('DM-172 c3: parallel workers on real records', () => {
  it('worker effort sums both parallel workers: 60 + 60 + 20 + 5 = 145 minutes', () => {
    expect(drivenRun().effort.byRole.worker).toBe(145 * MIN)
  })

  it('effort, active wall clock, in-flight time, attempt elapsed sum and the sprint window are distinct numbers', () => {
    const timing = drivenRun()
    expect(timing.effort.total).toMatchObject({ ms: 165 * MIN, aggregation: 'sum' })
    expect(timing.activeWallClock).toMatchObject({ ms: 120 * MIN, aggregation: 'union' })
    expect(timing.inFlight).toMatchObject({ ms: 110 * MIN, aggregation: 'union' })
    expect(timing.attemptElapsedSum).toMatchObject({ ms: 170 * MIN, aggregation: 'sum' })
    expect(timing.sprints[0]?.elapsed).toMatchObject({ ms: 160 * MIN, open: true })
    expect(timing.sprints[0]?.membership).toBe('current_plan')
  })

  it('orchestrator and reviewer overhead stay visible; run-scoped orchestration sits beside the sprint, not in its effort', () => {
    const timing = drivenRun()
    expect(timing.effort.byRole.orchestrator).toBe(10 * MIN)
    expect(timing.effort.byRole.reviewer).toBe(10 * MIN)
    expect(timing.effort.overhead).toMatchObject({ ms: 20 * MIN, state: 'partial', coverage: { covered: 1, of: 3, unit: 'attempts' } })
    expect(timing.sprints[0]?.unattributedOverhead.ms).toBe(10 * MIN)
    expect(timing.sprints[0]?.effort.total.ms).toBe(155 * MIN)
    expect(timing.unattributedEffort.total.ms).toBe(10 * MIN)
  })

  it('the effort buckets add up to the effort total, for the run and the sprint', () => {
    const timing = drivenRun()
    const sum = (buckets: object): number => Object.values(buckets).reduce((total: number, b: { effortMs: number }) => total + b.effortMs, 0)
    expect(sum(timing.effortByOutcome)).toBe(165 * MIN)
    expect(sum(timing.sprints[0]?.effortByOutcome ?? {})).toBe(155 * MIN)
  })
})

describe('DM-172 c4: rejected, expired and failed attempts keep their effort; unknown stays unknown', () => {
  it('the rejected attempt keeps its 60 minutes beside the accepted retry; its review and retry waits are classified', () => {
    const ticket = ticketOf(drivenRun(), 2)
    expect(ticket.effortByOutcome.rejected?.effortMs).toBe(60 * MIN)
    expect(ticket.effortByOutcome.accepted?.effortMs).toBe(20 * MIN)
    expect(ticket.waits.review.ms).toBe(20 * MIN)
    expect(ticket.waits.queue.ms).toBe(5 * MIN)
  })

  it('the expired attempt ends at its lease deadline with 5 minutes of effort and 15 unknown', () => {
    const expired = ticketOf(drivenRun(), 3).attempts[0]
    expect(expired).toMatchObject({ outcome: 'lease_expired', endedAt: T('10:25') })
    expect(expired?.effort.total.ms).toBe(5 * MIN)
    expect(expired?.unknown.ms).toBe(15 * MIN)
  })

  it('the failed attempt reported nothing: its effort is missing (null, never 0) and its 10 minutes stay unknown', () => {
    const ticket = ticketOf(drivenRun(), 3)
    const failed = ticket.attempts[1]
    expect(failed?.outcome).toBe('failed')
    expect(failed?.effort.total).toMatchObject({ state: 'missing', ms: null })
    expect(failed?.unknown.ms).toBe(10 * MIN)
    expect(ticket.effortByOutcome.failed?.unreported).toBe(1)
    expect(ticket.effortByOutcome.lease_expired?.unreported).toBe(0)
  })

  it('the open ticket\'s effort is partial (1 of 2 attempts reported) and the pause after the failure is blocked', () => {
    const ticket = ticketOf(drivenRun(), 3)
    expect(ticket.cycleTime.open).toBe(true)
    expect(ticket.effort.total).toMatchObject({ state: 'partial', coverage: { covered: 1, of: 2 } })
    expect(ticket.waits.blocked.ms).toBe(8 * MIN)
  })

  it('the run keeps every unknown segment (expired 15 + failed 10 = 25 minutes) and raises no anomaly', () => {
    const timing = drivenRun()
    expect(timing.unknown.ms).toBe(25 * MIN)
    expect(timing.anomalies).toEqual([])
  })
})

describe('DM-172 c1: what the feed reads from the records', () => {
  it('a sprint checkpoint waits from the report to the approval, and the advance starts the next sprint', () => {
    const { clock, ctx, worker } = world(T('09:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1], [2]]) })
    clock.set(T('10:00'))
    const c = claim(ctx, runId, 1)
    clock.set(T('10:10'))
    submit(worker, c)
    clock.set(T('10:20'))
    acceptAttempt(ctx, { attemptId: c.attempt.id })
    clock.set(T('10:40'))
    const report = submitSprintReport(ctx, { runId, sprintId: sid(1), report: { summary: 'Sprint one done.' } })
    clock.set(T('11:00'))
    approveCheckpoint(withRole(ctx, 'desktop'), { runId, reportId: report.id })
    clock.set(T('11:10'))
    advanceSprint(ctx, { runId })
    clock.set(T('11:30'))
    const timing = projectRunTiming(ctx, { runId })
    const [first, second] = timing.sprints
    expect(first?.checkpointWait).toMatchObject({ ms: 20 * MIN, state: 'observed', open: false })
    expect(first).toMatchObject({ startedAt: T('09:00'), endedAt: T('11:10'), endedBy: 'next_sprint' })
    expect(second).toMatchObject({ sprintId: sid(2), startedAt: T('11:10'), endedBy: 'cutoff' })
    expect(ticketOf(timing, 2).readyAt).toBe(T('11:10'))
    expect(timing.waits.human_approval.ms).toBe(20 * MIN)
  })

  it('a takeover expires the lease at the takeover when that comes before the deadline; the time after waits for reconciliation', () => {
    const { clock, ctx } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const c = claim(ctx, runId, 1)
    clock.set(T('10:10'))
    takeoverRun({ ...ctx, machineId: 'mc_other' }, { runId })
    clock.set(T('10:30'))
    const ticket = ticketOf(projectRunTiming(ctx, { runId }), 1)
    const attempt = ticket.attempts[0]
    expect(attempt?.attemptId).toBe(c.attempt.id)
    expect(attempt).toMatchObject({ endedAt: T('10:10'), endedBy: 'lease_expired', outcome: 'lease_expired' })
    expect(outline(ticket.segments).at(-1)).toBe('queue/awaiting_reconciliation 10:10-10:30')
    expect(ticket.waits.queue.ms).toBe(20 * MIN)
  })
})

describe('DM-172 c1: what the feed reads from a run whose log is incomplete', () => {
  it('a resubmitted attempt with no event log (an imported run) ends at its last heartbeat, listed as an estimate', () => {
    const { clock, ctx, worker } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const c = claim(ctx, runId, 1)
    clock.set(T('10:05'))
    heartbeatAttempt(worker, { attemptId: c.attempt.id, claimToken: c.packet.claimToken })
    clock.set(T('12:00'))
    reconcileAttempt(ctx, { attemptId: c.attempt.id, resolution: 'resubmit', outputs: { summary: 'recovered' } })
    ctx.db.run('DELETE FROM events WHERE run_id = ?', runId)
    clock.set(T('12:30'))
    const timing = projectRunTiming(ctx, { runId })
    expect(ticketOf(timing, 1).attempts[0]).toMatchObject({ endedAt: T('10:05'), endedBy: 'lease_expired', submittedAt: T('12:00') })
    expect(timing.anomalies.map((a) => [a.kind, a.subject])).toEqual([['estimated_time', c.attempt.id]])
  })

  it('a paused run with no logged pause is blocked from the row\'s pause time', () => {
    const { clock, ctx } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    claim(ctx, runId, 1, { leaseSeconds: 7200 })
    clock.set(T('10:20'))
    pauseRun(ctx, { runId, reason: 'away' })
    ctx.db.run("DELETE FROM events WHERE run_id = ? AND kind = 'run.paused'", runId)
    clock.set(T('10:50'))
    expect(ticketOf(projectRunTiming(ctx, { runId }), 1).attempts[0]?.waits.blocked.ms).toBe(30 * MIN)
  })

  it('a failure is timed by its logged event, not by the row\'s later update', () => {
    const { clock, ctx, worker } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const c = claim(ctx, runId, 1)
    clock.set(T('10:10'))
    failAttempt(worker, { attemptId: c.attempt.id, claimToken: c.packet.claimToken, failure: { reason: 'broken', retryable: true } })
    ctx.db.run('UPDATE attempts SET updated_at = ? WHERE id = ?', T('11:00'), c.attempt.id)
    clock.set(T('11:30'))
    expect(ticketOf(projectRunTiming(ctx, { runId }), 1).attempts[0]).toMatchObject({ endedAt: T('10:10'), outcome: 'failed' })
  })
})

describe('DM-172: the run timing read', () => {
  it('keeps only the asked ticket, refuses a ticket the run does not hold and a malformed cutoff', () => {
    const { clock, ctx } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    claim(ctx, runId, 1)
    clock.set(T('10:30'))
    expect(getRunTiming(ctx, { runId, ticketId: tid(2) }).tickets.map((t) => t.ticketId)).toEqual([tid(2)])
    expect(getRunTiming(ctx, { runId, cutoff: T('10:10') }).asOf).toBe(T('10:10'))
    expect(errorCode(() => getRunTiming(ctx, { runId, ticketId: tid(9) }))).toBe('not_found')
    expect(errorCode(() => getRunTiming(ctx, { runId, cutoff: 'soon' }))).toBe('invalid_input')
    expect(errorCode(() => getRunTiming(withRole(ctx, 'worker', { capabilities: [] }), { runId }))).toBe('unauthorized')
  })

  it('settles only the read run\'s overdue lease: another run\'s overdue attempt and its lease stay as they were', () => {
    const { clock, ctx } = world(T('10:00'))
    const read = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const other = startedRun(ctx, { bundle: makeBundle([[2]]) })
    const mine = claim(ctx, read.runId, 1)
    const theirs = claim(ctx, other.runId, 2)
    const theirLease = attemptRow(ctx, theirs.attempt.id).lease_expires_at
    clock.set(T('11:00'))
    const timing = getRunTiming(ctx, { runId: read.runId })
    expect(ticketOf(timing, 1).attempts[0]).toMatchObject({ outcome: 'lease_expired', endedBy: 'lease_expired' })
    expect(attemptRow(ctx, mine.attempt.id).state).toBe('lease_expired')
    expect(attemptRow(ctx, theirs.attempt.id).state).toBe('claimed')
    expect(attemptRow(ctx, theirs.attempt.id).lease_expires_at).toBe(theirLease)
    expect(Date.parse(theirLease ?? '')).toBeLessThan(Date.parse(T('11:00')))
  })
})

describe('DM-172 c1: retry grants and runs that never started', () => {
  it('the time between a failure and the retry a person granted waits on that person', () => {
    const { clock, ctx, worker } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const c = claim(ctx, runId, 1)
    clock.set(T('10:10'))
    failAttempt(worker, { attemptId: c.attempt.id, claimToken: c.packet.claimToken, failure: { reason: 'broken', retryable: true } })
    clock.set(T('10:30'))
    grantRetry(withRole(ctx, 'desktop'), { runId, ticketId: tid(1) })
    clock.set(T('10:40'))
    claim(ctx, runId, 1)
    clock.set(T('11:00'))
    const ticket = ticketOf(projectRunTiming(ctx, { runId }), 1)
    expect(outline(ticket.segments)).toContain('human_approval/awaiting_retry_grant 10:10-10:30')
    expect(ticket.waits.human_approval.ms).toBe(20 * MIN)
  })

  it("the time before the orchestrator's own retry is orchestration, never a wait on a person", () => {
    const { clock, ctx, worker } = world(T('10:00'))
    const base = makeBundle([[1]])
    const { runId } = startedRun(ctx, { bundle: { ...base, policies: { ...base.policies, retryLimit: 1 } } })
    const c = claim(ctx, runId, 1)
    clock.set(T('10:10'))
    failAttempt(worker, { attemptId: c.attempt.id, claimToken: c.packet.claimToken, failure: { reason: 'broken', retryable: true } })
    clock.set(T('10:30'))
    retryTicket(ctx, {
      runId,
      ticketId: tid(1),
      failureReason: 'The build broke on a missing native module.',
      newApproach: 'Fix the environment first: install the native module, then rerun.'
    })
    clock.set(T('10:40'))
    claim(ctx, runId, 1)
    clock.set(T('11:00'))
    const ticket = ticketOf(projectRunTiming(ctx, { runId }), 1)
    expect(outline(ticket.segments)).toContain('queue/awaiting_orchestrator_retry 10:10-10:30')
    expect(outline(ticket.segments).some((line) => line.startsWith('human_approval'))).toBe(false)
    expect(ticket.waits.human_approval.ms).toBe(0)
  })

  it('a queued run that never started has no window and no sprint activation', () => {
    const { clock, ctx } = world(T('10:00'))
    const { epicId } = seedEpic(ctx, { bundle: makeBundle([[1]]) })
    const run = queueRun(withRole(ctx, 'desktop'), { epicId })
    clock.set(T('11:00'))
    const timing = projectRunTiming(ctx, { runId: run.id })
    expect([timing.startedAt, timing.elapsed.ms]).toEqual([null, null])
    expect(ticketOf(timing, 1).readyAt).toBeNull()
  })
})

describe('DM-172 c1: a cancel the log does not record', () => {
  /** Ticket 1 claimed at 10:00 and canceled with its run at 11:00, the cancel logged without its attempts and the row updated at 11:30. */
  function canceledUnlogged(): { ctx: TestCtx; runId: string } {
    const { clock, ctx } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const c = claim(ctx, runId, 1, { leaseSeconds: 7200 })
    clock.set(T('11:00'))
    cancelRun(ctx, { runId, reason: 'stop' })
    ctx.db.run("UPDATE events SET payload_json = '{}' WHERE kind = 'run.canceled'")
    ctx.db.run('UPDATE attempts SET updated_at = ? WHERE id = ?', T('11:30'), c.attempt.id)
    clock.set(T('12:00'))
    return { ctx, runId }
  }

  it('an unlogged cancel ends the attempt at the run’s end, else at the row’s last update', () => {
    const { ctx, runId } = canceledUnlogged()
    expect(ticketOf(projectRunTiming(ctx, { runId }), 1).attempts[0]).toMatchObject({ endedAt: T('11:00'), outcome: 'canceled' })
    ctx.db.run('UPDATE runs SET ended_at = NULL WHERE id = ?', runId)
    expect(ticketOf(projectRunTiming(ctx, { runId }), 1).attempts[0]).toMatchObject({ endedAt: T('11:30'), outcome: 'canceled' })
  })
})

describe('DM-172 c1: lease ends and sprint ids the log does not record', () => {
  it('a resubmitted attempt with no log and no heartbeat ends at its claim, listed as an estimate', () => {
    const { clock, ctx } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1]]) })
    const c = claim(ctx, runId, 1)
    clock.set(T('12:00'))
    reconcileAttempt(ctx, { attemptId: c.attempt.id, resolution: 'resubmit', outputs: { summary: 'recovered' } })
    ctx.db.run('DELETE FROM events WHERE run_id = ?', runId)
    clock.set(T('12:30'))
    const timing = projectRunTiming(ctx, { runId })
    expect(ticketOf(timing, 1).attempts[0]).toMatchObject({ endedAt: T('10:00'), endedBy: 'lease_expired' })
    expect(timing.anomalies.map((a) => a.detail)).toEqual([`no record of the lease deadline: the lease expiry is placed at the attempt's claim (${T('10:00')}), an estimate`])
  })

  it('an overdue lease a later takeover expired ends at its own deadline; a claim after the takeover is not expired by it', () => {
    const { clock, ctx } = world(T('10:00'))
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    claim(ctx, runId, 1, { leaseSeconds: 600 })
    clock.set(T('10:30'))
    const taker = { ...ctx, machineId: 'mc_00000000000000000000000002' }
    takeoverRun(taker, { runId })
    resumeRun(taker, { runId })
    clock.set(T('10:40'))
    claim(taker, runId, 2, { leaseSeconds: 7200 })
    clock.set(T('11:00'))
    const timing = projectRunTiming(ctx, { runId })
    expect(ticketOf(timing, 1).attempts[0]).toMatchObject({ endedAt: T('10:10'), endedBy: 'lease_expired' })
    expect(ticketOf(timing, 2).attempts[0]).toMatchObject({ endedAt: null, outcome: 'open' })
  })

  it('a sprint an adoption removed, with no sprint of its ordinal left, maps to no sprint', () => {
    const { clock, ctx } = world(T('09:00'))
    const bundle = makeBundle([[1], [2]])
    const { runId, epicId } = startedRun(ctx, { bundle })
    clock.set(T('09:10'))
    pauseRun(ctx, { runId, reason: 'replan' })
    const revision = seedRevision(ctx, epicId, { ...bundle, sprints: [makeSprint(1, [1, 2])] })
    adoptRevision(withRole(ctx, 'orchestrator'), { runId, revisionId: revision })
    const input = ctx.db.tx(() => runTimingInput(ctx, { runId }))
    expect(input.sprintAliases).toEqual({ [sid(2)]: null })
    expect(input.tickets).toEqual([
      { ticketId: tid(1), sprintId: sid(1) },
      { ticketId: tid(2), sprintId: sid(1) }
    ])
  })
})
