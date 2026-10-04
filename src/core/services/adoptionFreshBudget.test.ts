/**
 * A ticket that moves to a later sprint in an adopted revision starts the new sprint with a fresh retry
 * budget: its failed, rejected and abandoned attempts are superseded (kept in history, no longer counted).
 */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { AttemptState } from '../../shared/domain/status'
import { makeBundle, makeSprint, sid, tid } from '../../test/bundles'
import {
  acceptTickets,
  eventLog,
  outboxEntries,
  seedAttempt,
  seedRevision,
  seedRun,
  type SeededRun
} from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { adoptRevision } from './adoption'
import { runExecution } from './execution'

/** Sprint 1 = {DM-1, DM-2}, sprint 2 = {DM-3}; the run waits at the first checkpoint and DM-1 is accepted. */
function atCheckpoint(): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  const run = seedRun(ctx, { state: 'awaiting_checkpoint' })
  acceptTickets(ctx, run, [1])
  return { ctx, run }
}

/** DM-2 has used its whole retry budget: the plan allows three tries. */
function exhaust(ctx: TestCtx, run: SeededRun, ticket = 2): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    seedAttempt(ctx, run, { ticket, state: 'failed' })
  }
}

function adopt(ctx: TestCtx, run: SeededRun, bundle: PlanBundle) {
  const revisionId = seedRevision(ctx, run.epicId, bundle)
  return adoptRevision(ctx, { runId: run.runId, revisionId })
}

/** `superseded_at` set or not, for each attempt of the ticket in attempt order. */
function supersededFlags(ctx: TestCtx, ticket: number): boolean[] {
  return ctx.db
    .all<{ superseded_at: string | null }>('SELECT superseded_at FROM attempts WHERE ticket_id = ? ORDER BY number', tid(ticket))
    .map((row) => row.superseded_at !== null)
}

function attemptStates(ctx: TestCtx, ticket: number): string[] {
  return ctx.db.all<{ state: string }>('SELECT state FROM attempts WHERE ticket_id = ? ORDER BY number', tid(ticket)).map((row) => row.state)
}

function executionOf(ctx: TestCtx, run: SeededRun, ticket: number) {
  return runExecution(ctx, run.runId).tickets.find((item) => item.ticketId === tid(ticket))
}

describe('a ticket that reached its retry limit and moves to a later sprint', () => {
  it('is failed at the limit before the move, and not after the revision is adopted', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run)
    expect(executionOf(ctx, run, 2)).toMatchObject({
      state: 'failed',
      attemptCount: 3,
      blockers: [{ kind: 'retry_limit', attempts: 3, limit: 3 }]
    })
    const result = adopt(ctx, run, makeBundle([[1], [2, 3]]))
    expect(result.freshBudget).toEqual([tid(2)])
    expect(executionOf(ctx, run, 2)).toMatchObject({ state: 'later_sprint', attemptCount: 0, blockers: [] })
  })

  it('is ready again with its whole budget once the run reaches the sprint it moved to', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run)
    adopt(ctx, run, makeBundle([[1], [2, 3]]))
    ctx.db.run("UPDATE runs SET active_sprint_id = ?, state = 'running' WHERE id = ?", sid(2), run.runId)
    expect(executionOf(ctx, run, 2)).toMatchObject({ state: 'ready', attemptCount: 0, blockers: [] })
    seedAttempt(ctx, run, { ticket: 2, state: 'failed' })
    seedAttempt(ctx, run, { ticket: 2, state: 'failed' })
    expect(executionOf(ctx, run, 2)).toMatchObject({ state: 'ready', attemptCount: 2 })
    seedAttempt(ctx, run, { ticket: 2, state: 'failed' })
    expect(executionOf(ctx, run, 2)).toMatchObject({ state: 'failed', blockers: [{ kind: 'retry_limit', attempts: 3, limit: 3 }] })
  })

  it('keeps the old attempts in history, still failed, marked superseded', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run)
    adopt(ctx, run, makeBundle([[1], [2, 3]]))
    expect(attemptStates(ctx, 2)).toEqual(['failed', 'failed', 'failed'])
    expect(supersededFlags(ctx, 2)).toEqual([true, true, true])
  })

})

describe('the attempts of a ticket given a fresh budget', () => {
  it('numbers its next attempt after the superseded ones', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run)
    adopt(ctx, run, makeBundle([[1], [2, 3]]))
    seedAttempt(ctx, run, { ticket: 2, state: 'running' })
    const numbers = ctx.db.all<{ number: number }>('SELECT number FROM attempts WHERE ticket_id = ? ORDER BY number', tid(2))
    expect(numbers.map((row) => row.number)).toEqual([1, 2, 3, 4])
  })

  it('also moves to a sprint several places later', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run)
    expect(adopt(ctx, run, makeBundle([[1], [3], [2]])).freshBudget).toEqual([tid(2)])
  })

  it('records the tickets given a fresh budget in the result and the event, and leaves the accepted list alone', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run)
    const result = adopt(ctx, run, makeBundle([[1], [2, 3]]))
    expect(result).toMatchObject({ kept: [tid(1)], superseded: [], freshBudget: [tid(2)] })
    expect(eventLog(ctx).at(-1)?.payload).toMatchObject({ kept: [tid(1)], superseded: [], freshBudget: [tid(2)] })
    expect(outboxEntries(ctx).map((entry) => entry.kind)).toEqual(['run_history'])
  })
})

describe('which attempts of a moved ticket are superseded', () => {
  const STATES: { state: AttemptState; reconciled?: boolean; superseded: boolean; why: string }[] = [
    { state: 'failed', superseded: true, why: 'failed' },
    { state: 'rejected', superseded: true, why: 'rejected' },
    { state: 'lease_expired', reconciled: true, superseded: true, why: 'abandoned after its lease expired' },
    { state: 'canceled', superseded: false, why: 'canceled (it never counted)' },
    { state: 'accepted', superseded: false, why: 'accepted' }
  ]

  it.each(STATES)('$why: superseded is $superseded', ({ state, reconciled, superseded }) => {
    const { ctx, run } = atCheckpoint()
    seedAttempt(ctx, run, { ticket: 2, state, ...(reconciled === true ? { reconciled } : {}) })
    adopt(ctx, run, makeBundle([[1], [2, 3]]))
    expect(supersededFlags(ctx, 2)).toEqual([superseded])
  })

  it('never supersedes the accepted attempt of a ticket that moved, and keeps its acceptance', () => {
    const { ctx, run } = atCheckpoint()
    seedAttempt(ctx, run, { ticket: 2, state: 'failed' })
    seedAttempt(ctx, run, { ticket: 2, state: 'accepted' })
    const result = adopt(ctx, run, makeBundle([[1], [2, 3]]))
    expect(supersededFlags(ctx, 2)).toEqual([true, false])
    expect(result.kept).toEqual([tid(1), tid(2)])
    expect(executionOf(ctx, run, 2)).toMatchObject({ state: 'accepted' })
  })

  it('leaves a ticket with an expired lease nobody has reconciled alone', () => {
    const { ctx, run } = atCheckpoint()
    seedAttempt(ctx, run, { ticket: 2, state: 'lease_expired' })
    adopt(ctx, run, makeBundle([[1], [2, 3]]))
    expect(supersededFlags(ctx, 2)).toEqual([false])
  })
})

describe('tickets that did not move to a later sprint', () => {
  it('keeps the attempts of a ticket that leaves the plan, and of one whose old sprint is gone', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run, 2)
    exhaust(ctx, run, 3)
    const result = adopt(ctx, run, makeBundle([[1, 3]]))
    expect(result.freshBudget).toEqual([])
    expect([supersededFlags(ctx, 2), supersededFlags(ctx, 3)]).toEqual([[false, false, false], [false, false, false]])
  })

  it('keeps the attempts of a ticket that moved to an earlier sprint', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run, 3)
    expect(adopt(ctx, run, makeBundle([[1, 2, 3], []])).freshBudget).toEqual([])
    expect(supersededFlags(ctx, 3)).toEqual([false, false, false])
  })

  it('keeps the attempts of a ticket that stays in its sprint even when its content changes', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run)
    const retitled = makeBundle([[1, 2], [3]])
    retitled.tickets = retitled.tickets.map((ticket) => (ticket.id === tid(2) ? { ...ticket, title: 'Retitled' } : ticket))
    expect(adopt(ctx, run, retitled).freshBudget).toEqual([])
    expect(supersededFlags(ctx, 2)).toEqual([false, false, false])
  })

  it('does not take a renumbered sprint for a move: the sprint is the same sprint', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run)
    const shifted = structuredClone(run.bundle)
    shifted.sprints = [
      { ...makeSprint(9, []), ordinal: 1 },
      ...shifted.sprints.map((sprint) => ({ ...sprint, ordinal: sprint.ordinal + 1 }))
    ]
    expect(adopt(ctx, run, shifted).freshBudget).toEqual([])
    expect(supersededFlags(ctx, 2)).toEqual([false, false, false])
  })

  it('counts a move into a brand-new later sprint as a move', () => {
    const { ctx, run } = atCheckpoint()
    exhaust(ctx, run)
    const rebuilt = makeBundle([[1], [3]])
    rebuilt.tickets.push(...makeBundle([[2]]).tickets)
    rebuilt.sprints = [...rebuilt.sprints, { ...makeSprint(7, [2]), ordinal: 3 }]
    expect(adopt(ctx, run, rebuilt).freshBudget).toEqual([tid(2)])
  })
})
