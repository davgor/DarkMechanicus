import { describe, expect, it } from 'vitest'
import { makeBundle, tid } from '../../test/bundles'
import {
  attemptRow,
  bundleWith,
  claim,
  completeTicket,
  domainError,
  errorCode,
  eventKinds,
  lastEventPayload,
  openAttemptIds,
  runRow,
  startedRun,
  submitClaim,
  ticketStatus
} from '../../test/execution'
import { createTestCtx, withRole } from '../../test/testContext'
import { acceptAttempt, carryForwardTicket, failAttempt, reconcileAttempt, rejectAttempt } from './attempts'
import { runExecution } from './execution'
import { cancelRun, startRun } from './runs'

describe('acceptAttempt', () => {
  it('accepts a submission, completes the ticket, and unlocks dependents', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]], [[1, 2]]) })
    const claimed = claim(ctx, runId, 1)
    submitClaim(ctx, claimed, {
      outputs: { summary: 'Built it' },
      evidence: { criteria: [{ criterionId: 'c1', met: false, note: 'pending' }, { criterionId: 'c2', met: true, note: '' }] }
    })
    ctx.clock.advanceSeconds(20)
    const reviewer = withRole(ctx, 'reviewer')
    const view = acceptAttempt(reviewer, {
      attemptId: claimed.attempt.id,
      notes: 'Looks right',
      criteria: [{ criterionId: 'c1', met: true, note: 'verified' }, { criterionId: 'c3', met: true, note: '' }]
    })
    expect(view).toMatchObject({
      state: 'accepted',
      decidedAt: '2026-01-01T00:00:20.000Z',
      decision: { outcome: 'accepted', notes: 'Looks right', reasons: [], decidedBy: 'test reviewer' }
    })
    expect(view.evidence?.criteria).toEqual([
      { criterionId: 'c1', met: true, note: 'verified' },
      { criterionId: 'c2', met: true, note: '' },
      { criterionId: 'c3', met: true, note: '' }
    ])
    expect(ticketStatus(ctx, tid(1))).toEqual({ status: 'completed', revision: 3 })
    expect(claim(ctx, runId, 2).attempt.state).toBe('claimed')
    expect(ctx.db.get<{ body: string }>("SELECT body FROM search_index WHERE doc_type = 'attempt'")?.body).toBe(
      'Built it\n\nLooks right'
    )
  })

  it('replays the original decision for a repeated key', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    submitClaim(ctx, claimed)
    const first = acceptAttempt(ctx, { attemptId: claimed.attempt.id, idempotencyKey: 'accept-1' })
    expect(acceptAttempt(ctx, { attemptId: claimed.attempt.id, idempotencyKey: 'accept-1' })).toEqual(first)
    expect(eventKinds(ctx, 'attempt.accepted')).toHaveLength(1)
  })
})

describe('acceptAttempt — rejections', () => {
  it('only decides submitted attempts of live runs this machine owns', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    const running = claim(ctx, runId, 1)
    const notSubmitted = domainError(() => acceptAttempt(ctx, { attemptId: running.attempt.id }))
    expect([notSubmitted.code, notSubmitted.message]).toEqual([
      'unauthorized_transition',
      'Only submitted attempts can be reviewed; this attempt is claimed.'
    ])
    const submitted = claim(ctx, runId, 2)
    submitClaim(ctx, submitted)
    ctx.db.run("UPDATE runs SET owner_machine_id = 'mc_other' WHERE id = ?", runId)
    expect(errorCode(() => acceptAttempt(ctx, { attemptId: submitted.attempt.id }))).toBe('run_not_owned')
    ctx.db.run("UPDATE runs SET state = 'completed' WHERE id = ?", runId)
    expect(errorCode(() => acceptAttempt(ctx, { attemptId: submitted.attempt.id }))).toBe('run_not_active')
  })

  it('is refused to workers', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    submitClaim(ctx, claimed)
    expect(errorCode(() => acceptAttempt(withRole(ctx, 'worker'), { attemptId: claimed.attempt.id }))).toBe('unauthorized')
    expect(errorCode(() => acceptAttempt(ctx, { attemptId: 'at_missing' }))).toBe('not_found')
  })
})

describe('rejectAttempt', () => {
  it('rejects a submission and leaves the ticket retryable under the limit', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1]], [], { retryLimit: 2, onTicketFailure: 'pause_run' }) })
    const claimed = claim(ctx, runId, 1)
    submitClaim(ctx, claimed)
    const view = rejectAttempt(withRole(ctx, 'reviewer'), { attemptId: claimed.attempt.id, reasons: ['No tests'], notes: 'Add tests' })
    expect(view).toMatchObject({
      state: 'rejected',
      decision: { outcome: 'rejected', notes: 'Add tests', reasons: ['No tests'], decidedBy: 'test reviewer' }
    })
    expect(lastEventPayload(ctx, 'attempt.rejected')).toEqual({ attemptId: claimed.attempt.id, reasons: ['No tests'] })
    expect(runRow(ctx, runId).state).toBe('running')
    const retry = claim(ctx, runId, 1)
    expect([retry.attempt.number, retry.attempt.fencingToken]).toEqual([2, 2])
  })

  it('applies the failure policy when the last try is rejected', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1]], [], { retryLimit: 1, onTicketFailure: 'pause_run' }) })
    const claimed = claim(ctx, runId, 1)
    submitClaim(ctx, claimed)
    rejectAttempt(ctx, { attemptId: claimed.attempt.id, reasons: ['wrong'], idempotencyKey: 'reject-1' })
    expect(runRow(ctx, runId)).toMatchObject({ state: 'paused', pause_reason: 'ticket_failed:DM-1' })
    expect(rejectAttempt(ctx, { attemptId: claimed.attempt.id, reasons: ['wrong'], idempotencyKey: 'reject-1' }).state).toBe('rejected')
    expect(errorCode(() => rejectAttempt(ctx, { attemptId: claimed.attempt.id, reasons: ['again'] }))).toBe('unauthorized_transition')
  })
})

describe('failAttempt', () => {
  it('fails an open attempt with default failure details', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    const view = failAttempt(ctx, { attemptId: claimed.attempt.id, failure: { reason: 'Tool crashed' } })
    expect(view).toMatchObject({
      state: 'failed',
      leaseExpiresAt: null,
      failure: { reason: 'Tool crashed', details: '', retryable: true }
    })
    expect(lastEventPayload(ctx, 'attempt.failed')).toEqual({ attemptId: claimed.attempt.id, reason: 'Tool crashed' })
    const explicit = claim(ctx, runId, 1)
    const detailed = failAttempt(ctx, { attemptId: explicit.attempt.id, failure: { reason: 'r', details: 'd', retryable: false } })
    expect(detailed.failure).toEqual({ reason: 'r', details: 'd', retryable: false })
  })

  it('requires workers to present the claim token', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    const worker = withRole(ctx, 'worker')
    expect(errorCode(() => failAttempt(worker, { attemptId: claimed.attempt.id, failure: { reason: 'x' } }))).toBe('unauthorized')
    expect(errorCode(() => failAttempt(worker, { attemptId: claimed.attempt.id, claimToken: 'bad.token', failure: { reason: 'x' } }))).toBe(
      'stale_claim'
    )
    expect(failAttempt(worker, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken, failure: { reason: 'x' } }).state).toBe(
      'failed'
    )
  })

  it('lets the orchestrator fail a submission but not a decided or expired attempt', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2, 3]]) })
    const submitted = claim(ctx, runId, 1)
    submitClaim(ctx, submitted)
    expect(failAttempt(ctx, { attemptId: submitted.attempt.id, failure: { reason: 'review found a crash' } }).state).toBe('failed')
    const accepted = completeTicket(ctx, runId, 2)
    expect(errorCode(() => failAttempt(ctx, { attemptId: accepted.id, failure: { reason: 'x' } }))).toBe('unauthorized_transition')
    const expired = claim(ctx, runId, 3, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    expect(errorCode(() => failAttempt(ctx, { attemptId: expired.attempt.id, failure: { reason: 'x' } }))).toBe('unauthorized_transition')
  })

  it('replays the original failure for a repeated key', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1)
    const first = failAttempt(ctx, { attemptId: claimed.attempt.id, failure: { reason: 'x' }, idempotencyKey: 'fail-1' })
    expect(failAttempt(ctx, { attemptId: claimed.attempt.id, failure: { reason: 'x' }, idempotencyKey: 'fail-1' })).toEqual(first)
    expect(eventKinds(ctx, 'attempt.failed')).toHaveLength(1)
  })
})

describe('failure policy — continue_independent and grants', () => {
  it('keeps the run going and independent work claimable while dependents stay blocked', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1, 2, 3]], [[1, 2]], { retryLimit: 1 }) })
    failAttempt(ctx, { attemptId: claim(ctx, runId, 1).attempt.id, failure: { reason: 'x' } })
    expect(runRow(ctx, runId).state).toBe('running')
    expect(runExecution(ctx, runId).tickets.map((ticket) => ticket.state)).toEqual(['failed', 'blocked', 'ready'])
    expect(claim(ctx, runId, 3).attempt.state).toBe('claimed')
  })

  it('counts retry grants toward the limit before applying the policy', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1]], [], { retryLimit: 1, onTicketFailure: 'pause_run' }) })
    ctx.db.run('INSERT INTO retry_grants (run_id, ticket_id, extra) VALUES (?, ?, 1)', runId, tid(1))
    failAttempt(ctx, { attemptId: claim(ctx, runId, 1).attempt.id, failure: { reason: 'x' } })
    expect(runRow(ctx, runId).state).toBe('running')
    failAttempt(ctx, { attemptId: claim(ctx, runId, 1).attempt.id, failure: { reason: 'x' } })
    expect(runRow(ctx, runId)).toMatchObject({ state: 'paused', pause_reason: 'ticket_failed:DM-1' })
  })
})

describe('failure policy — pause_run and fail_run', () => {
  it('pauses the run only once the ticket reaches its limit', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1]], [], { retryLimit: 2, onTicketFailure: 'pause_run' }) })
    failAttempt(ctx, { attemptId: claim(ctx, runId, 1).attempt.id, failure: { reason: 'x' } })
    expect(runRow(ctx, runId).state).toBe('running')
    failAttempt(ctx, { attemptId: claim(ctx, runId, 1).attempt.id, failure: { reason: 'x' } })
    expect(runRow(ctx, runId)).toMatchObject({ state: 'paused', pause_reason: 'ticket_failed:DM-1' })
    expect(lastEventPayload(ctx, 'run.paused')).toEqual({ from: 'running', reason: 'ticket_failed:DM-1' })
  })

  it('fails the run and cancels its other open attempts', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1, 2]], [], { retryLimit: 1, onTicketFailure: 'fail_run' }) })
    const other = claim(ctx, runId, 2).attempt.id
    ctx.clock.advanceSeconds(9)
    failAttempt(ctx, { attemptId: claim(ctx, runId, 1).attempt.id, failure: { reason: 'x' } })
    expect(runRow(ctx, runId)).toMatchObject({ state: 'failed', ended_at: '2026-01-01T00:00:09.000Z', pause_reason: 'ticket_failed:DM-1' })
    expect(attemptRow(ctx, other).state).toBe('canceled')
    expect(lastEventPayload(ctx, 'run.failed')).toEqual({ reason: 'ticket_failed:DM-1', canceledAttempts: [other] })
  })

  it('does not pause a run that is already paused', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1]], [], { retryLimit: 1, onTicketFailure: 'pause_run' }) })
    const claimed = claim(ctx, runId, 1)
    ctx.db.run("UPDATE runs SET state = 'paused', pause_reason = 'manual' WHERE id = ?", runId)
    failAttempt(ctx, { attemptId: claimed.attempt.id, failure: { reason: 'x' } })
    expect(runRow(ctx, runId)).toMatchObject({ state: 'paused', pause_reason: 'manual' })
    expect(eventKinds(ctx, 'run.paused')).toEqual([])
  })
})

describe('reconcileAttempt — abandon', () => {
  it('expires an overdue lease and abandons it so the ticket can be claimed again', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    const view = reconcileAttempt(ctx, { attemptId: claimed.attempt.id, resolution: 'abandon', notes: 'worker vanished' })
    expect(view).toMatchObject({
      state: 'lease_expired',
      reconciledAt: '2026-01-01T00:01:01.000Z',
      failure: { reason: 'lease expired', details: 'worker vanished', retryable: true }
    })
    expect(lastEventPayload(ctx, 'attempt.reconciled')).toEqual({ attemptId: claimed.attempt.id, resolution: 'abandon' })
    expect(claim(ctx, runId, 1).attempt.number).toBe(2)
  })

  it('applies the failure policy when the abandoned try was the last one', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: bundleWith([[1]], [], { retryLimit: 1, onTicketFailure: 'pause_run' }) })
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    reconcileAttempt(ctx, { attemptId: claimed.attempt.id, resolution: 'abandon' })
    expect(runRow(ctx, runId)).toMatchObject({ state: 'paused', pause_reason: 'ticket_failed:DM-1' })
    expect(attemptRow(ctx, claimed.attempt.id).failure_json).toBe('{"reason":"lease expired","details":"","retryable":true}')
  })
})

describe('reconcileAttempt — resubmit', () => {
  it('records late outputs as a submission that can then be accepted', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const claimed = claim(ctx, runId, 1, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    expect(errorCode(() => reconcileAttempt(ctx, { attemptId: claimed.attempt.id, resolution: 'resubmit' }))).toBe('invalid_input')
    const view = reconcileAttempt(ctx, {
      attemptId: claimed.attempt.id,
      resolution: 'resubmit',
      outputs: { summary: 'It finished after all', commits: ['fff0000'] },
      evidence: { notes: 'checked the branch' }
    })
    expect(view).toMatchObject({
      state: 'submitted',
      reconciledAt: '2026-01-01T00:01:01.000Z',
      submittedAt: '2026-01-01T00:01:01.000Z',
      outputs: { summary: 'It finished after all', artifacts: [], commits: ['fff0000'], changedFiles: [], branch: null },
      evidence: { checks: [], criteria: [], notes: 'checked the branch' }
    })
    expect(acceptAttempt(ctx, { attemptId: claimed.attempt.id }).state).toBe('accepted')
  })

  it('refuses a resubmission while a newer attempt is open', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const old = claim(ctx, runId, 1, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    runExecution(ctx, runId)
    ctx.db.run('UPDATE attempts SET superseded_at = ? WHERE id = ?', ctx.clock.nowIso(), old.attempt.id)
    const fresh = claim(ctx, runId, 1).attempt.id
    const resubmit = (): unknown =>
      reconcileAttempt(ctx, { attemptId: old.attempt.id, resolution: 'resubmit', outputs: { summary: 'late' } })
    expect(errorCode(resubmit)).toBe('conflict')
    expect(openAttemptIds(ctx, runId)).toEqual([fresh])
  })
})

describe('reconcileAttempt — rejections', () => {
  it('only reconciles unreconciled expired attempts of active runs', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    const live = claim(ctx, runId, 1)
    expect(errorCode(() => reconcileAttempt(ctx, { attemptId: live.attempt.id, resolution: 'abandon' }))).toBe('conflict')
    const expired = claim(ctx, runId, 2, { leaseSeconds: 60 })
    ctx.clock.advanceSeconds(61)
    reconcileAttempt(ctx, { attemptId: expired.attempt.id, resolution: 'abandon' })
    const twice = domainError(() => reconcileAttempt(ctx, { attemptId: expired.attempt.id, resolution: 'abandon' }))
    expect([twice.code, twice.message]).toEqual(['conflict', 'Only an unreconciled expired attempt can be reconciled.'])
    cancelRun(ctx, { runId })
    expect(errorCode(() => reconcileAttempt(ctx, { attemptId: live.attempt.id, resolution: 'abandon' }))).toBe('run_not_active')
  })
})

describe('carryForwardTicket', () => {
  it('carries forward a ticket accepted in an earlier run, with its outputs', () => {
    const ctx = createTestCtx()
    const { epicId, runId: firstRun } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    completeTicket(ctx, firstRun, 1, { summary: 'from run 1' })
    ctx.db.run("UPDATE ticket_status SET status = 'in_progress' WHERE ticket_id = ?", tid(1))
    cancelRun(ctx, { runId: firstRun })
    const runId = startRun(ctx, { epicId }).id
    const view = carryForwardTicket(ctx, { runId, ticketId: tid(1), note: 'Unchanged since run 1' })
    expect(view).toMatchObject({
      runId,
      kind: 'carry_forward',
      state: 'accepted',
      number: 1,
      leaseExpiresAt: null,
      decidedAt: '2026-01-01T00:00:00.000Z',
      outputs: { summary: 'from run 1' },
      decision: { outcome: 'accepted', notes: 'Unchanged since run 1', reasons: [], decidedBy: 'test orchestrator' }
    })
    expect(attemptRow(ctx, view.id).claim_secret).toBeNull()
    expect(ticketStatus(ctx, tid(1))?.status).toBe('completed')
    expect(lastEventPayload(ctx, 'attempt.carried_forward')).toEqual({ attemptId: view.id, note: 'Unchanged since run 1' })
  })

  it('carries forward a ticket completed only by status, without outputs', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(2))
    expect(carryForwardTicket(ctx, { runId, ticketId: tid(2), note: 'done by hand' }).outputs).toBeNull()
  })

  it('rejects tickets without completed work, already settled in this run, or outside the plan', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]]) })
    expect(errorCode(() => carryForwardTicket(ctx, { runId, ticketId: tid(1), note: 'n' }))).toBe('unauthorized_transition')
    completeTicket(ctx, runId, 1)
    expect(errorCode(() => carryForwardTicket(ctx, { runId, ticketId: tid(1), note: 'n' }))).toBe('conflict')
    ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(2))
    claim(ctx, runId, 2)
    expect(errorCode(() => carryForwardTicket(ctx, { runId, ticketId: tid(2), note: 'n' }))).toBe('conflict')
    expect(errorCode(() => carryForwardTicket(ctx, { runId, ticketId: tid(9), note: 'n' }))).toBe('not_found')
  })
})

describe('carryForwardTicket — run checks', () => {
  it('requires an active run owned by this machine', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    ctx.db.run("UPDATE runs SET owner_machine_id = 'mc_other' WHERE id = ?", runId)
    expect(errorCode(() => carryForwardTicket(ctx, { runId, ticketId: tid(1), note: 'n' }))).toBe('run_not_owned')
    ctx.db.run("UPDATE runs SET owner_machine_id = ?, state = 'canceled' WHERE id = ?", ctx.machineId, runId)
    expect(errorCode(() => carryForwardTicket(ctx, { runId, ticketId: tid(1), note: 'n' }))).toBe('run_not_active')
    expect(errorCode(() => carryForwardTicket(withRole(ctx, 'reviewer'), { runId, ticketId: tid(1), note: 'n' }))).toBe('unauthorized')
  })
})
