import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { AttemptState } from '../../shared/domain/status'
import type { RowCheckView, TicketExecutionView } from '../../shared/domain/views'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { type AttemptSnapshot, computeExecution, type ExecutionSnapshot, type ReadinessInput } from './readiness'

function snap(ticket: number, state: AttemptState): AttemptSnapshot {
  return {
    id: `at-${ticket}-1`,
    ticketId: tid(ticket),
    number: 1,
    kind: 'work',
    state,
    reconciled: false,
    superseded: false
  }
}

/** A row check as the service stores it: `passed` is true only when every entry passed. */
function rowCheck(sprint: number, row: number, number: number, passed: boolean): RowCheckView {
  return {
    id: `rk-${sprint}-${row}-${number}`,
    runId: 'rn-1',
    sprintId: sid(sprint),
    row,
    number,
    commit: 'a'.repeat(40),
    checks: [{ name: 'combined tests', status: passed ? 'passed' : 'failed', detail: '' }],
    passed,
    recordedBy: 'orchestrator',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function compute(
  bundle: PlanBundle,
  attempts: AttemptSnapshot[],
  rowChecks: RowCheckView[],
  options: Partial<ReadinessInput> = {}
): ExecutionSnapshot {
  return computeExecution({
    bundle,
    activeSprintId: sid(1),
    runState: 'running',
    attempts,
    retryGrants: {},
    rowChecks,
    ...options
  })
}

function view(snapshot: ExecutionSnapshot, n: number): TicketExecutionView {
  const found = snapshot.tickets.find((item) => item.ticketId === tid(n))
  if (!found) {
    throw new Error(`ticket ${n} missing from snapshot`)
  }
  return found
}

/** Tickets 1 and 2 are row 1; 3 needs both (row 2); 4 needs 3 (row 3); 5 stands alone (row 1). */
function threeRows(): PlanBundle {
  return makeBundle([[1, 2, 3, 4, 5]], [[1, 3], [2, 3], [3, 4]])
}

const BOTH_ACCEPTED = [snap(1, 'accepted'), snap(2, 'accepted')]

describe('rows in the execution snapshot', () => {
  it('gives each ticket its row, counted from 1 within its sprint', () => {
    const snapshot = compute(makeBundle([[1, 2, 3], [4, 5]], [[1, 3], [4, 5]]), [], [])
    expect([1, 2, 3, 4, 5].map((n) => view(snapshot, n).row)).toEqual([1, 1, 2, 1, 2])
  })

  it('lists every row of every sprint with its tickets and no check yet', () => {
    const snapshot = compute(makeBundle([[1, 2], [3]], [[1, 2]]), [], [])
    expect(snapshot.rows).toEqual([
      { sprintId: sid(1), row: 1, tickets: [{ ticketId: tid(1), key: 'DM-1' }], latestCheck: null },
      { sprintId: sid(1), row: 2, tickets: [{ ticketId: tid(2), key: 'DM-2' }], latestCheck: null },
      { sprintId: sid(2), row: 1, tickets: [{ ticketId: tid(3), key: 'DM-3' }], latestCheck: null }
    ])
  })

  it('reports the check with the highest number as the latest, whatever order they arrive in', () => {
    const checks = [rowCheck(1, 1, 2, true), rowCheck(1, 1, 3, false), rowCheck(1, 1, 1, false)]
    const rowOne = compute(threeRows(), [], checks).rows[0]
    expect(rowOne?.latestCheck?.id).toBe('rk-1-1-3')
    expect(compute(threeRows(), [], checks.reverse()).rows[0]?.latestCheck?.id).toBe('rk-1-1-3')
  })

  it('keeps each row to its own checks', () => {
    const rows = compute(threeRows(), [], [rowCheck(1, 2, 1, false)]).rows
    expect(rows.map((item) => item.latestCheck?.id ?? null)).toEqual([null, 'rk-1-2-1', null])
  })
})

describe('a failed row check', () => {
  it('holds every ticket that requires a ticket in the row, as waiting with a row_check_failed blocker', () => {
    const snapshot = compute(threeRows(), BOTH_ACCEPTED, [rowCheck(1, 1, 1, false)])
    const held = view(snapshot, 3)
    expect(held.state).toBe('waiting')
    expect(held.blockers).toEqual([{ kind: 'row_check_failed', sprintId: sid(1), row: 1, checkId: 'rk-1-1-1' }])
  })

  it('names the row once even when the ticket requires several tickets in it', () => {
    const snapshot = compute(threeRows(), BOTH_ACCEPTED, [rowCheck(1, 1, 1, false)])
    expect(view(snapshot, 3).prerequisites).toHaveLength(2)
    expect(view(snapshot, 3).blockers.filter((item) => item.kind === 'row_check_failed')).toHaveLength(1)
  })

  it('leaves the row itself, tickets that do not depend on it, and later rows without a row blocker', () => {
    const snapshot = compute(threeRows(), BOTH_ACCEPTED, [rowCheck(1, 1, 1, false)])
    expect(view(snapshot, 1).state).toBe('accepted')
    expect(view(snapshot, 5)).toMatchObject({ state: 'ready', blockers: [] })
    // Ticket 4 requires ticket 3 (row 2), so it only waits on that prerequisite.
    expect(view(snapshot, 4).blockers).toEqual([{ kind: 'prerequisite', ticketId: tid(3), key: 'DM-3', state: 'waiting' }])
  })

})

describe('the latest row check decides', () => {
  it('is cleared by a later passing check', () => {
    const checks = [rowCheck(1, 1, 1, false), rowCheck(1, 1, 2, true)]
    const cleared = view(compute(threeRows(), BOTH_ACCEPTED, checks), 3)
    expect(cleared).toMatchObject({ state: 'ready', blockers: [] })
  })

  it('returns when a later check fails again', () => {
    const checks = [rowCheck(1, 1, 1, true), rowCheck(1, 1, 2, false)]
    expect(view(compute(threeRows(), BOTH_ACCEPTED, checks), 3).state).toBe('waiting')
  })

  it('does nothing for a row that has only passing checks', () => {
    expect(view(compute(threeRows(), BOTH_ACCEPTED, [rowCheck(1, 1, 1, true)]), 3).state).toBe('ready')
  })

  it('treats a missing rowChecks input as no checks', () => {
    const snapshot = computeExecution({
      bundle: threeRows(),
      activeSprintId: sid(1),
      runState: 'running',
      attempts: BOTH_ACCEPTED,
      retryGrants: {}
    })
    expect(view(snapshot, 3).state).toBe('ready')
    expect(snapshot.rows.map((item) => item.latestCheck)).toEqual([null, null, null])
  })
})

describe('what a failed row check leaves alone', () => {
  it('holds only the dependents of the row that failed', () => {
    const snapshot = compute(threeRows(), [...BOTH_ACCEPTED, snap(3, 'accepted')], [rowCheck(1, 2, 1, false)])
    expect(view(snapshot, 4).blockers).toEqual([{ kind: 'row_check_failed', sprintId: sid(1), row: 2, checkId: 'rk-1-2-1' }])
    expect(view(snapshot, 5).blockers).toEqual([])
  })

  it('does not take back an acceptance that already happened', () => {
    const snapshot = compute(threeRows(), [...BOTH_ACCEPTED, snap(3, 'accepted')], [rowCheck(1, 1, 1, false)])
    expect(view(snapshot, 3)).toMatchObject({ state: 'accepted', blockers: [] })
  })

  it('keeps a blocked ticket blocked and still names the failed row', () => {
    const attempts = [snap(1, 'accepted'), snap(2, 'failed')]
    const bundle = makeBundle([[1, 2, 3]], [[1, 3], [2, 3]])
    bundle.policies = { ...bundle.policies, retryLimit: 1 }
    const held = view(compute(bundle, attempts, [rowCheck(1, 1, 1, false)]), 3)
    expect(held.state).toBe('blocked')
    expect(held.blockers.map((item) => item.kind)).toEqual(['prerequisite', 'row_check_failed'])
  })

  it('holds a ticket of a later sprint once that sprint is active, and not before', () => {
    const bundle = makeBundle([[1], [2]], [[1, 2]])
    const attempts = [snap(1, 'accepted')]
    const checks = [rowCheck(1, 1, 1, false)]
    expect(view(compute(bundle, attempts, checks), 2)).toMatchObject({ state: 'later_sprint', blockers: [] })
    const active = compute(bundle, attempts, checks, { activeSprintId: sid(2) })
    expect(view(active, 2).state).toBe('waiting')
    expect(view(active, 2).blockers).toEqual([{ kind: 'row_check_failed', sprintId: sid(1), row: 1, checkId: 'rk-1-1-1' }])
  })
})

/**
 * Sprint 1: tickets 1 and 2 are row 1, 3 needs both (row 2), and ticket 4 is the sprint's acceptance node.
 * Sprint 2: ticket 5 and its acceptance node 6. Every work ticket of sprint 1 is accepted.
 */
function withNodes(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3, 4], [5, 6]], [[1, 3], [2, 3]])
  bundle.tickets[3] = makeTicket(4, { kind: 'acceptance' })
  bundle.tickets[5] = makeTicket(6, { kind: 'acceptance' })
  return bundle
}

const SPRINT_ONE_DONE = [snap(1, 'accepted'), snap(2, 'accepted'), snap(3, 'accepted')]

function rowBlockers(snapshot: ExecutionSnapshot, n: number): unknown[] {
  return view(snapshot, n).blockers.filter((item) => item.kind === 'row_check_failed')
}

describe('acceptance nodes and rows', () => {
  it('gives an acceptance node no row and lists it in none, without moving other tickets', () => {
    const snapshot = compute(withNodes(), SPRINT_ONE_DONE, [])
    expect([1, 2, 3, 4, 5, 6].map((n) => view(snapshot, n).row)).toEqual([1, 1, 2, null, 1, null])
    const listed = snapshot.rows.flatMap((item) => item.tickets.map((ticket) => ticket.ticketId))
    expect(listed).toEqual([tid(1), tid(2), tid(3), tid(5)])
  })

  it('holds the acceptance node of a sprint while the latest check of one of its rows has not passed', () => {
    const snapshot = compute(withNodes(), SPRINT_ONE_DONE, [rowCheck(1, 2, 1, false)])
    const node = view(snapshot, 4)
    expect(node.state).toBe('waiting')
    expect(node.blockers).toEqual([{ kind: 'row_check_failed', sprintId: sid(1), row: 2, checkId: 'rk-1-2-1' }])
  })

  it('names each failed row of the sprint once, in row order', () => {
    const checks = [rowCheck(1, 2, 1, false), rowCheck(1, 1, 2, false)]
    const rows = rowBlockers(compute(withNodes(), SPRINT_ONE_DONE, checks), 4)
    expect(rows).toEqual([
      { kind: 'row_check_failed', sprintId: sid(1), row: 1, checkId: 'rk-1-1-2' },
      { kind: 'row_check_failed', sprintId: sid(1), row: 2, checkId: 'rk-1-2-1' }
    ])
  })

  it('names a row once even when the node also requires a ticket of it through an edge', () => {
    const bundle = withNodes()
    bundle.edges.push({ from: tid(1), to: tid(4) })
    const snapshot = compute(bundle, SPRINT_ONE_DONE, [rowCheck(1, 1, 1, false)])
    expect(rowBlockers(snapshot, 4)).toEqual([{ kind: 'row_check_failed', sprintId: sid(1), row: 1, checkId: 'rk-1-1-1' }])
  })

  it('releases the node when a later check of every failed row passes', () => {
    const checks = [rowCheck(1, 1, 1, false), rowCheck(1, 2, 2, false), rowCheck(1, 1, 3, true)]
    expect(rowBlockers(compute(withNodes(), SPRINT_ONE_DONE, checks), 4)).toHaveLength(1)
    const cleared = compute(withNodes(), SPRINT_ONE_DONE, [...checks, rowCheck(1, 2, 4, true)])
    expect(view(cleared, 4)).toMatchObject({ state: 'ready', blockers: [] })
  })

  it('leaves the acceptance node of another sprint alone', () => {
    const snapshot = compute(withNodes(), SPRINT_ONE_DONE, [rowCheck(1, 1, 1, false)], { activeSprintId: sid(2) })
    expect(rowBlockers(snapshot, 6)).toEqual([])
  })

  it('does not take back an acceptance that already happened', () => {
    const snapshot = compute(withNodes(), [...SPRINT_ONE_DONE, snap(4, 'accepted')], [rowCheck(1, 1, 1, false)])
    expect(view(snapshot, 4)).toMatchObject({ state: 'accepted', blockers: [] })
  })
})
