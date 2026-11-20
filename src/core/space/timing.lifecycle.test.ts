// DM-273: lifecycle events that arrive out of place, and spans and tickets the projection cannot attribute.
import { describe, expect, it } from 'vitest'
import { at, atm, MIN, RunBuilder, sp, tk } from '../../test/efficiencyRuns'
import { DomainError } from '../errors'
import { projectTiming, type TimingEvent } from './timing'

/** A run started at 0 with ticket 1 of sprint 1 ready at 0, read at 300 minutes. */
const oneTicket = (): RunBuilder => new RunBuilder(300).start(0).ticket(1, 1, null, 0)

const project = (run: RunBuilder) => projectTiming(run.cohortRun().timing)
const details = (run: RunBuilder): string[] => project(run).anomalies.map((anomaly) => `${anomaly.kind}|${anomaly.subject}|${anomaly.detail}`)
const attemptEvent = (kind: TimingEvent['kind'], attempt: number, m: number): TimingEvent => ({ kind, at: at(m), attemptId: atm(attempt) }) as TimingEvent

describe('DM-273: run events after the run ended', () => {
  it('a second run end is ignored and a pause after the end is listed', () => {
    const run = oneTicket()
    run.events.push({ kind: 'run_ended', at: at(100) }, { kind: 'run_paused', at: at(110) }, { kind: 'run_ended', at: at(200) })
    const timing = project(run)
    expect(timing.endedAt).toBe(at(100))
    expect(timing.elapsed.ms).toBe(100 * MIN)
    expect(details(run)).toEqual([`event_out_of_place|run|run_paused at ${at(110)}: the run had ended`])
  })
})

describe('DM-273: attempt events that contradict the attempt record', () => {
  it.each([
    ['an acceptance with no submission', [attemptEvent('attempt_accepted', 1, 20)], `attempt_accepted at ${at(20)}: no undecided submission`],
    ['a failure after acceptance', [attemptEvent('attempt_submitted', 1, 20), attemptEvent('attempt_accepted', 1, 30), attemptEvent('attempt_failed', 1, 40)], `attempt_failed at ${at(40)}: the attempt had already ended`],
    ['a lease expiring after submission', [attemptEvent('attempt_submitted', 1, 20), attemptEvent('attempt_lease_expired', 1, 25)], `attempt_lease_expired at ${at(25)}: the attempt had already ended`],
    ['a reconcile with no expired lease', [attemptEvent('attempt_submitted', 1, 20), attemptEvent('attempt_reconciled', 1, 25)], `attempt_reconciled at ${at(25)}: no expired lease to reconcile`]
  ])('%s is listed as out of place', (_label, events, detail) => {
    const run = oneTicket().claim(1, 1, 1, 10)
    run.events.push(...events)
    expect(details(run)).toEqual([`event_out_of_place|${atm(1)}|${detail}`])
  })

  it('a second claim of the same attempt is listed and the first claim stands', () => {
    const run = oneTicket().claim(1, 1, 1, 10).claim(1, 1, 1, 20)
    expect(details(run)).toEqual([`event_out_of_place|${atm(1)}|attempt_claimed at ${at(20)}: a second claim of the same attempt`])
    expect(project(run).tickets[0]?.attempts.map((attempt) => attempt.claimedAt)).toEqual([at(10)])
  })

  it('a readiness after the first claim is listed and dropped', () => {
    const run = new RunBuilder(300).start(0).ticket(1, 1, null, 30).claim(1, 1, 1, 10)
    expect(details(run)).toEqual([`event_out_of_place|${tk(1)}|ready at ${at(30)}, after its first claim`])
    expect(project(run).tickets[0]?.readyAt).toBeNull()
  })
})

describe('DM-273: a retry grant after the rejection is the wait on a person', () => {
  it('the grant after the close counts as human approval, not one before it', () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 30, decided: 40, decision: 'rejected' })
    run.events.push({ kind: 'retry_granted', at: at(35), ticketId: tk(1) }, { kind: 'retry_granted', at: at(50), ticketId: tk(1) })
    run.attempt(2, 1, 2, { claim: 60, submit: 90, decided: 100 })
    expect(project(run).tickets[0]?.waits.human_approval.ms).toBe(10 * MIN)
  })
})

describe("an orchestrator's own retry is not a wait on a person", () => {
  it('the wait before it is queue time, and a later person grant in the same gap is not counted as approval', () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 30, decided: 40, decision: 'rejected' })
    run.events.push({ kind: 'auto_retry_granted', at: at(50), ticketId: tk(1) }, { kind: 'retry_granted', at: at(55), ticketId: tk(1) })
    run.attempt(2, 1, 2, { claim: 60, submit: 90, decided: 100 })
    const ticket = project(run).tickets[0]
    expect(ticket?.waits.human_approval.ms).toBe(0)
    expect(ticket?.segments.find((segment) => segment.reason === 'awaiting_orchestrator_retry')).toMatchObject({ class: 'queue', ms: 10 * MIN })
  })

  it("a person's grant that comes first in the gap is still their approval", () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 30, decided: 40, decision: 'rejected' })
    run.events.push({ kind: 'retry_granted', at: at(45), ticketId: tk(1) }, { kind: 'auto_retry_granted', at: at(50), ticketId: tk(1) })
    run.attempt(2, 1, 2, { claim: 60, submit: 90, decided: 100 })
    expect(project(run).tickets[0]?.waits.human_approval.ms).toBe(5 * MIN)
  })
})

describe('DM-273: worker evidence by source and state', () => {
  it('an agent-reported wait classifies the attempt where the host reported nothing, labelled as the agent', () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 60, decided: 70 })
    run.span({ attempt: 1, ticket: 1 }, 0, 30)
    const wait = run.wait({ attempt: 1, ticket: 1 }, 30, 60, 'build_test')
    run.observation(wait).source = { kind: 'agent', actor: 'worker-1' }
    const segments = project(run).tickets[0]?.attempts[0]?.segments ?? []
    expect(segments.map((segment) => `${segment.class}/${segment.evidence}/${segment.ms / MIN}`)).toEqual(['active/host/30', 'build_test/agent/30'])
  })

  it('an estimated span makes the attempt and ticket active time estimated', () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 60, decided: 70 })
    const span = run.span({ attempt: 1, ticket: 1 }, 0, 60)
    run.observation(span).measurement = { state: 'estimated', value: 60 * MIN, method: 'transcript gaps' }
    const ticket = project(run).tickets[0]
    expect(ticket?.attempts[0]?.active).toMatchObject({ state: 'estimated', ms: 60 * MIN })
    expect(ticket?.active).toMatchObject({ state: 'estimated', ms: 60 * MIN })
  })

  it('a ticket whose second attempt reported no activity has partial active time', () => {
    const run = oneTicket()
    run.attempt(1, 1, 1, { claim: 0, submit: 30, decided: 40, decision: 'rejected' })
    run.attempt(2, 1, 2, { claim: 50, submit: 80, decided: 90 })
    run.span({ attempt: 1, ticket: 1 }, 0, 30)
    expect(project(run).tickets[0]?.active).toMatchObject({ state: 'partial', ms: 30 * MIN, coverage: { covered: 1, of: 2 } })
  })
})

describe('DM-273: spans and tickets the projection cannot attribute', () => {
  it('a ticket in no sprint of the plan is listed and its effort counts only in the run', () => {
    const run = new RunBuilder(300).start(0)
    run.events.push({ kind: 'attempt_claimed', at: at(0), attemptId: atm(1), ticketId: tk(7), sprintId: null, number: 1, carriedForward: false })
    run.span({ ticket: 7 }, 0, 20, { role: 'reviewer', actor: 'reviewer-host' })
    const timing = project(run)
    expect(details(run)).toEqual([`unattributed|${tk(7)}|the ticket is in no sprint of the current plan; its time counts only in run totals`])
    expect(timing.tickets.map((ticket) => [ticket.ticketId, ticket.sprintId])).toEqual([[tk(7), null]])
    expect(timing.unattributedEffort.total.ms).toBe(20 * MIN)
  })

  it('a span scoped to an attempt with no claim is listed and counted as run-level work', () => {
    const run = oneTicket()
    const stray = run.span({ attempt: 9, ticket: 1 }, 10, 20)
    expect(details(run)).toEqual([`event_out_of_place|${stray}|scoped to attempt ${atm(9)}, which has no claim counted in this run`])
    expect(project(run).tickets[0]?.effortByOutcome).toMatchObject({ unscoped: { effortMs: 10 * MIN } })
  })

  it('a run-level span before the run started adds nothing to any sprint', () => {
    const run = new RunBuilder(300).start(10)
    run.span({}, 0, 5, { role: 'orchestrator' })
    run.span({}, 20, 30, { role: 'orchestrator', actor: 'orchestrator-2' })
    const [sprint] = project(run).sprints
    expect(sprint?.sprintId).toBe(sp(1))
    expect(sprint?.unattributedOverhead.ms).toBe(10 * MIN)
  })

  it('an unparseable cutoff is refused', () => {
    const input = { ...oneTicket().cohortRun().timing, asOf: 'soon' }
    expect(() => projectTiming(input)).toThrow(DomainError)
    expect(() => projectTiming(input)).toThrow('asOf soon is not a time.')
  })
})
