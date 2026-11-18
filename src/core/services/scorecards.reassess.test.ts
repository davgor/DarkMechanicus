/**
 * DM-178 c4: what a dated reassessment says moved a component when the windows or the records at the approved cutoff
 * are not what the approved grade read: a ticket first dispatched after the report starts a window that cannot be
 * compared, and records missing at the approved cutoff are named as such.
 */
import { describe, expect, it } from 'vitest'
import type { ScorecardReassessment } from '../../shared/domain/spaceGrades'
import { makeTicket, tid } from '../../test/bundles'
import { adopt, deliver, report, spaceWorld } from '../../test/spaceWorld'
import { grantRetry } from './checkpoints'
import { reassessReportScorecard } from './scorecards'

const ticket = (reassessment: ScorecardReassessment, n: number) => reassessment.subjects.find((s) => s.subject.level === 'ticket' && s.subject.id === tid(n))

describe('reassessReportScorecard: a ticket first dispatched after the report', () => {
  it('reads its windows as not comparable and its moved components as a moved window start', () => {
    const w = spaceWorld({ overhead: false })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 20 })
    const first = report(w)
    // A person grants ticket 3 a try, which resumes the run waiting at its checkpoint.
    grantRetry(w.desktop, { runId: w.runId, ticketId: tid(3) })
    w.ctx.clock.advanceSeconds(60)
    const dispatchedAt = w.ctx.clock.nowIso()
    deliver(w, 3, { minutes: 20, tokens: 30_000, productive: 20 })
    const third = ticket(reassessReportScorecard(w.ctx, { reportId: first.id }), 3)
    expect(third?.windows).toMatchObject({
      approved: { from: null },
      current: { from: dispatchedAt },
      comparable: false,
      note: `not comparable: the approved window starts at no dispatch, the current one at ${dispatchedAt}`
    })
    expect(third?.differences.find((difference) => difference.component === 'A')?.causes).toEqual(['window_start_moved'])
  })
})

describe('reassessReportScorecard: a ticket that joined the sprint after the report', () => {
  it('lists it as joined with no approved grade, its inputs at the approved cutoff named against no approved value', () => {
    const w = spaceWorld({ overhead: false })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    const first = report(w)
    adopt(w, (plan) => ({ ...plan, tickets: [...plan.tickets, makeTicket(7, { size: 'medium' })], sprints: plan.sprints.map((s) => ({ ...s, ticketIds: [...s.ticketIds, tid(7)] })) }))
    grantRetry(w.desktop, { runId: w.runId, ticketId: tid(7) })
    deliver(w, 7, { minutes: 20, tokens: 30_000, productive: 20 })
    const joined = ticket(reassessReportScorecard(w.ctx, { reportId: first.id }), 7)
    expect(joined).toMatchObject({ membership: 'joined', approved: null, windows: { comparable: false } })
    expect(joined?.differences.find((difference) => difference.component === 'A')?.detail).toMatch(/^at the approved cutoff: committed — → /)
  })
})

describe('reassessReportScorecard: records at the approved cutoff changed', () => {
  it('names the change when the records the approved grade read are no longer held', () => {
    const w = spaceWorld({ overhead: false })
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    const first = report(w)
    w.ctx.db.run("DELETE FROM metric_observations WHERE ticket_id = ? AND metric = 'tokens_total'", tid(1))
    const k = ticket(reassessReportScorecard(w.ctx, { reportId: first.id }), 1)?.differences.find((difference) => difference.component === 'K')
    expect(k?.causes).toEqual(['records_at_cutoff_changed'])
    expect(k?.approved).toMatchObject({ state: 'observed' })
    expect(k?.sameWindow).toMatchObject({ state: 'missing' })
  })
})
