/**
 * DM-175: the P input read from stored records (`getTicketPerformance`): retry grants count from their logged time (a
 * grant with no logged time counts at every cutoff), and an attempt's end is read from the records written once,
 * falling back to the run's end and then the row only when the log holds nothing.
 */
import { describe, expect, it } from 'vitest'
import type { PerformanceAssessmentInput } from '../../shared/domain/performance'
import { tid } from '../../test/bundles'
import { claim } from '../../test/execution'
import { failClaimed, type PerformanceWorld, performanceWorld } from '../../test/performanceWorld'
import { withRole } from '../../test/testContext'
import { reconcileAttempt } from './attempts'
import { grantRetry } from './checkpoints'
import { getTicketPerformance } from './performance'
import { cancelRun, pauseRun, takeoverRun } from './runs'

const at = (hm: string): string => `2026-11-15T${hm}:00.000Z`

const read = (w: PerformanceWorld, n: number, cutoff: string): PerformanceAssessmentInput => getTicketPerformance(w.ctx, { runId: w.runId, ticketId: tid(n), cutoff })

const verdict = (input: PerformanceAssessmentInput): string[] => [input.verification.state, input.verification.reason]

/** Ticket 2 failed twice (its retry limit) by 09:06, then one more try granted at 09:30; read at 10:00. */
function exhaustedThenGranted(): PerformanceWorld {
  const w = performanceWorld()
  failClaimed(w, 2, 'broke the build')
  failClaimed(w, 2, 'broke it again')
  w.ctx.clock.set(at('09:30'))
  grantRetry(withRole(w.ctx, 'desktop'), { runId: w.runId, ticketId: tid(2) })
  w.ctx.clock.set(at('10:00'))
  return w
}

describe('getTicketPerformance: retry grants', () => {
  it('reads a ticket that used every try as a confirmed failure until a person grants one more', () => {
    const w = exhaustedThenGranted()
    expect(verdict(read(w, 2, at('09:20')))).toEqual(['failed', 'confirmed_failure'])
    expect(verdict(read(w, 2, at('09:40')))).toEqual(['pending', 'awaiting_retry'])
  })

  it('counts a grant this machine logged no time for at every cutoff', () => {
    const w = exhaustedThenGranted()
    w.ctx.db.run("DELETE FROM events WHERE kind = 'ticket.retry_granted'")
    expect(verdict(read(w, 2, at('09:20')))).toEqual(['pending', 'awaiting_retry'])
  })
})

describe('getTicketPerformance: when a canceled attempt ended', () => {
  /**
   * Ticket 3 failed by 09:03 (a logged failure); ticket 2 claimed then and canceled with its run at 09:10, the cancel's
   * log entry gone and the row updated at 09:40.
   */
  function canceledUnlogged(): PerformanceWorld {
    const w = performanceWorld()
    failClaimed(w, 3, 'broke the build')
    const claimed = claim(w.ctx, w.runId, 2, { leaseSeconds: 7200 })
    w.ctx.clock.set(at('09:10'))
    cancelRun(w.ctx, { runId: w.runId, reason: 'stop' })
    w.ctx.db.run("DELETE FROM events WHERE kind = 'run.canceled'")
    w.ctx.db.run('UPDATE attempts SET updated_at = ? WHERE id = ?', at('09:40'), claimed.attempt.id)
    w.ctx.clock.set(at('10:00'))
    return w
  }

  it('ends it at the run’s end when the cancel was not logged', () => {
    const w = canceledUnlogged()
    expect(read(w, 2, at('09:05')).verification.attemptState).toBe('running')
    expect(read(w, 2, at('09:20')).verification.attemptState).toBe('canceled')
  })

  it('ends it at the row’s last update only when neither the log nor the run shows an end', () => {
    const w = canceledUnlogged()
    w.ctx.db.run('UPDATE runs SET ended_at = NULL WHERE id = ?', w.runId)
    expect(read(w, 2, at('09:20')).verification.attemptState).toBe('running')
    expect(read(w, 2, at('09:50')).verification.attemptState).toBe('canceled')
  })
})

describe('getTicketPerformance: when a lease ended', () => {
  it('places a resubmitted lease with no deadline, log or heartbeat at its claim', () => {
    const w = performanceWorld()
    const claimed = claim(w.ctx, w.runId, 2)
    w.ctx.clock.set(at('11:00'))
    reconcileAttempt(w.ctx, { attemptId: claimed.attempt.id, resolution: 'resubmit', outputs: { summary: 'recovered' } })
    w.ctx.db.run('DELETE FROM events WHERE run_id = ?', w.runId)
    w.ctx.db.run('UPDATE attempts SET lease_expires_at = NULL WHERE id = ?', claimed.attempt.id)
    expect(read(w, 2, at('09:00')).verification.attemptState).toBe('lease_expired')
    expect(read(w, 2, at('11:00')).verification.attemptState).toBe('submitted')
  })

  it('keeps an attempt of a run paused for sign-in held past its deadline', () => {
    const w = performanceWorld()
    claim(w.ctx, w.runId, 2)
    w.ctx.clock.set(at('09:05'))
    pauseRun(withRole(w.ctx, 'desktop'), { runId: w.runId, reason: 'signed_out' })
    w.ctx.clock.set(at('12:00'))
    const input = read(w, 2, at('12:00'))
    expect(input.verification.attemptState).toBe('running')
    expect(verdict(input)).toEqual(['pending', 'in_progress'])
  })

  it('ends an overdue lease a takeover expired later at its own deadline', () => {
    const w = performanceWorld()
    claim(w.ctx, w.runId, 2, { leaseSeconds: 600 })
    w.ctx.clock.set(at('09:30'))
    takeoverRun({ ...w.ctx, machineId: 'mc_00000000000000000000000002' }, { runId: w.runId })
    expect(read(w, 2, at('09:05')).verification.attemptState).toBe('running')
    expect(read(w, 2, at('09:15')).verification.attemptState).toBe('lease_expired')
  })
})
