/**
 * DM-178/DM-175: a sprint grade across adoptions. A sprint an adoption renamed (same ordinal) keeps the outcomes and
 * frozen scope of the tickets that ran under its old id, and a ticket moved out keeps the failure it had there: a
 * retry granted afterwards enables attempts elsewhere and does not count for the sprint it left.
 */
import { describe, expect, it } from 'vitest'
import { sid, tid } from '../../test/bundles'
import { adopt, deliver, moveToSprint2, reject, spaceWorld, work } from '../../test/spaceWorld'
import { grantRetry } from './checkpoints'
import { getSprintGrade, getTicketGrade } from './spaceGrades'

describe('getSprintGrade: a sprint an adoption renamed', () => {
  it('reads the tickets that ran under the old id as the renamed sprint’s, their scope frozen with its first claim', () => {
    const w = spaceWorld({ overhead: false })
    const frozenRevision = w.ctx.db.get<{ revision_id: string }>('SELECT revision_id FROM runs WHERE id = ?', w.runId)?.revision_id
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 20 })
    adopt(w, (plan) => ({ ...plan, sprints: plan.sprints.map((sprint) => ({ ...sprint, id: sid(11) })) }))
    deliver(w, 2, { minutes: 20, tokens: 30_000, productive: 20 })
    const sprint = getSprintGrade(w.ctx, { runId: w.runId, sprintId: sid(11) })
    expect(sprint.outcomes.map((outcome) => [outcome.ticketId, outcome.state, outcome.movedOut])).toEqual([
      [tid(1), 'verified', false],
      [tid(2), 'verified', false],
      [tid(3), 'missing', false]
    ])
    expect(getTicketGrade(w.ctx, { runId: w.runId, ticketId: tid(2) }).sources.signals.A.frozenRevisionId).toBe(frozenRevision)
  })
})

describe('getSprintGrade: a ticket moved out after it used every try', () => {
  it('keeps its confirmed failure with the sprint it left, though a retry was granted before the move', () => {
    const w = spaceWorld({ overhead: false, secondSprint: true, retryLimit: 2 })
    reject(w, work(w, 1, { minutes: 10, tokens: 10_000, productive: 10 }), 'not yet')
    reject(w, work(w, 1, { minutes: 10, tokens: 10_000, productive: 10 }), 'still not')
    grantRetry(w.desktop, { runId: w.runId, ticketId: tid(1) })
    w.ctx.clock.advanceSeconds(60)
    moveToSprint2(w, tid(1))
    const left = getSprintGrade(w.ctx, { runId: w.runId, sprintId: sid(1) }).outcomes.find((outcome) => outcome.ticketId === tid(1))
    expect(left).toMatchObject({ movedOut: true, state: 'failed', reason: 'confirmed_failure', counted: true })
  })

  it('counts a retry granted between its two claims there, read up to its last claim, so a try is still left', () => {
    const w = spaceWorld({ overhead: false, secondSprint: true, retryLimit: 2 })
    reject(w, work(w, 1, { minutes: 10, tokens: 10_000, productive: 10 }), 'not yet')
    w.ctx.clock.advanceSeconds(60)
    grantRetry(w.desktop, { runId: w.runId, ticketId: tid(1) })
    w.ctx.clock.advanceSeconds(60)
    reject(w, work(w, 1, { minutes: 10, tokens: 10_000, productive: 10 }), 'still not')
    w.ctx.clock.advanceSeconds(60)
    moveToSprint2(w, tid(1))
    const left = getSprintGrade(w.ctx, { runId: w.runId, sprintId: sid(1) }).outcomes.find((outcome) => outcome.ticketId === tid(1))
    expect(left).toMatchObject({ movedOut: true, state: 'pending', reason: 'awaiting_retry', counted: true })
  })
})
