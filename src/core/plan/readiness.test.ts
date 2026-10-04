import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { AttemptState } from '../../shared/domain/status'
import type { TicketExecutionView } from '../../shared/domain/views'
import { makeBundle, makeSprint, sid, tid } from '../../test/bundles'
import { type AttemptSnapshot, computeExecution, type ExecutionSnapshot, type ReadinessInput } from './readiness'

function snap(
  ticket: number,
  number: number,
  state: AttemptState,
  extra: Partial<AttemptSnapshot> = {}
): AttemptSnapshot {
  return {
    id: `at-${ticket}-${number}`,
    ticketId: tid(ticket),
    number,
    kind: 'work',
    state,
    reconciled: false,
    superseded: false,
    ...extra
  }
}

function compute(
  bundle: PlanBundle,
  attempts: AttemptSnapshot[] = [],
  options: Partial<ReadinessInput> = {}
): ExecutionSnapshot {
  return computeExecution({
    bundle,
    activeSprintId: sid(1),
    runState: 'running',
    attempts,
    retryGrants: {},
    ...options
  })
}

function ticketView(snapshot: ExecutionSnapshot, n: number): TicketExecutionView {
  const found = snapshot.tickets.find((item) => item.ticketId === tid(n))
  if (!found) {
    throw new Error(`ticket ${n} missing from snapshot`)
  }
  return found
}

function states(snapshot: ExecutionSnapshot): string[] {
  return snapshot.tickets.map((item) => `${item.key}:${item.state}`)
}

describe('computeExecution — independent work', () => {
  it('makes independent tickets ready in parallel with no blockers', () => {
    const snapshot = compute(makeBundle([[1, 2, 3]]))
    expect(states(snapshot)).toEqual(['DM-1:ready', 'DM-2:ready', 'DM-3:ready'])
    expect(snapshot.tickets.map((item) => item.blockers)).toEqual([[], [], []])
    expect(snapshot.capacity).toEqual({ limit: null, inUse: 0 })
  })

  it('reports the full view shape for a ticket without attempts', () => {
    expect(ticketView(compute(makeBundle([[1]])), 1)).toEqual({
      ticketId: tid(1),
      key: 'DM-1',
      sprintId: sid(1),
      row: 1,
      state: 'ready',
      attemptCount: 0,
      latestAttemptId: null,
      blockers: [],
      prerequisites: []
    })
  })

  it('lists tickets in sprint order, then position within the sprint', () => {
    const bundle = makeBundle([[3, 1], [2]])
    bundle.sprints = [bundle.sprints[1], bundle.sprints[0]]
    expect(compute(bundle).tickets.map((item) => item.key)).toEqual(['DM-3', 'DM-1', 'DM-2'])
  })

  it('skips sprint members that are not tickets of the bundle', () => {
    const bundle = makeBundle([[1]])
    bundle.sprints[0].ticketIds.push(tid(99))
    expect(compute(bundle).tickets.map((item) => item.key)).toEqual(['DM-1'])
  })
})

describe('computeExecution — dependencies', () => {
  it('makes a dependent wait for an unaccepted prerequisite', () => {
    const view = ticketView(compute(makeBundle([[1, 2]], [[1, 2]])), 2)
    expect(view.state).toBe('waiting')
    expect(view.blockers).toEqual([{ kind: 'prerequisite', ticketId: tid(1), key: 'DM-1', state: 'ready' }])
    expect(view.prerequisites).toEqual([
      { ticketId: tid(1), key: 'DM-1', state: 'ready', acceptedAttemptId: null }
    ])
  })

  it('unlocks a dependent once the prerequisite is accepted', () => {
    const view = ticketView(compute(makeBundle([[1, 2]], [[1, 2]]), [snap(1, 1, 'accepted')]), 2)
    expect(view.state).toBe('ready')
    expect(view.blockers).toEqual([])
    expect(view.prerequisites).toEqual([
      { ticketId: tid(1), key: 'DM-1', state: 'accepted', acceptedAttemptId: 'at-1-1' }
    ])
  })

  it('does not unlock a dependent on a submitted (unaccepted) prerequisite', () => {
    const snapshot = compute(makeBundle([[1, 2]], [[1, 2]]), [snap(1, 1, 'submitted')])
    expect(ticketView(snapshot, 1).state).toBe('submitted')
    expect(ticketView(snapshot, 2).state).toBe('waiting')
    expect(ticketView(snapshot, 2).blockers).toEqual([
      { kind: 'prerequisite', ticketId: tid(1), key: 'DM-1', state: 'submitted' }
    ])
  })

  it('ignores edges from tickets that are not in the bundle', () => {
    const bundle = makeBundle([[1]])
    bundle.edges.push({ from: tid(42), to: tid(1) })
    const view = ticketView(compute(bundle), 1)
    expect(view.state).toBe('ready')
    expect(view.prerequisites).toEqual([])
  })
})

describe('computeExecution — fork and join', () => {
  const bundle = makeBundle([[1, 2, 3, 4]], [[1, 2], [1, 3], [2, 4], [3, 4]])

  it('runs both branches of a fork in parallel after the root is accepted', () => {
    const snapshot = compute(bundle, [snap(1, 1, 'accepted')])
    expect(states(snapshot)).toEqual(['DM-1:accepted', 'DM-2:ready', 'DM-3:ready', 'DM-4:waiting'])
  })

  it('keeps the join waiting until every incoming branch is accepted', () => {
    const snapshot = compute(bundle, [snap(1, 1, 'accepted'), snap(2, 1, 'accepted'), snap(3, 1, 'running')])
    expect(ticketView(snapshot, 4).state).toBe('waiting')
    expect(ticketView(snapshot, 4).blockers).toEqual([
      { kind: 'prerequisite', ticketId: tid(3), key: 'DM-3', state: 'running' }
    ])
  })

  it('releases the join when both branches are accepted', () => {
    const attempts = ['accepted', 'accepted', 'accepted'].map((state, i) => snap(i + 1, 1, state as AttemptState))
    const view = ticketView(compute(bundle, attempts), 4)
    expect(view.state).toBe('ready')
    expect(view.prerequisites.map((item) => item.acceptedAttemptId)).toEqual(['at-2-1', 'at-3-1'])
  })
})

describe('computeExecution — failures block dependents', () => {
  const bundle = makeBundle([[1, 2, 3]], [[1, 2], [2, 3]], {
    policies: { maxConcurrency: null, retryLimit: 1, onTicketFailure: 'continue_independent', leaseSeconds: 900 }
  })

  it('marks a ticket at its retry limit failed and blocks its dependents transitively', () => {
    const snapshot = compute(bundle, [snap(1, 1, 'failed')])
    expect(states(snapshot)).toEqual(['DM-1:failed', 'DM-2:blocked', 'DM-3:blocked'])
    expect(ticketView(snapshot, 1).blockers).toEqual([{ kind: 'retry_limit', attempts: 1, limit: 1 }])
    expect(ticketView(snapshot, 2).blockers).toEqual([
      { kind: 'prerequisite', ticketId: tid(1), key: 'DM-1', state: 'failed' }
    ])
    expect(ticketView(snapshot, 3).blockers).toEqual([
      { kind: 'prerequisite', ticketId: tid(2), key: 'DM-2', state: 'blocked' }
    ])
  })

  it('counts rejected attempts toward the limit', () => {
    expect(ticketView(compute(bundle, [snap(1, 1, 'rejected')]), 1).state).toBe('failed')
  })

  it('does not count canceled attempts toward the limit, even previously reconciled ones', () => {
    const view = ticketView(compute(bundle, [snap(1, 1, 'canceled', { reconciled: true })]), 1)
    expect(view.state).toBe('ready')
    expect(view.attemptCount).toBe(1)
  })
})

describe('computeExecution — retry limit boundary and grants', () => {
  const bundle = makeBundle([[1]], [], {
    policies: { maxConcurrency: null, retryLimit: 2, onTicketFailure: 'continue_independent', leaseSeconds: 900 }
  })

  it('keeps a ticket ready one attempt below the limit', () => {
    const view = ticketView(compute(bundle, [snap(1, 1, 'failed')]), 1)
    expect(view.state).toBe('ready')
    expect(view.attemptCount).toBe(1)
    expect(view.latestAttemptId).toBe('at-1-1')
  })

  it('fails the ticket exactly at the limit', () => {
    const view = ticketView(compute(bundle, [snap(1, 1, 'failed'), snap(1, 2, 'rejected')]), 1)
    expect(view.state).toBe('failed')
    expect(view.blockers).toEqual([{ kind: 'retry_limit', attempts: 2, limit: 2 }])
    expect(view.attemptCount).toBe(2)
  })

  it('raises the limit by the retries granted for the ticket', () => {
    const attempts = [snap(1, 1, 'failed'), snap(1, 2, 'failed')]
    expect(ticketView(compute(bundle, attempts, { retryGrants: { [tid(1)]: 1 } }), 1).state).toBe('ready')
    const exhausted = compute(bundle, [...attempts, snap(1, 3, 'failed')], { retryGrants: { [tid(1)]: 1 } })
    expect(ticketView(exhausted, 1).blockers).toEqual([{ kind: 'retry_limit', attempts: 3, limit: 3 }])
  })

  it('ignores grants for other tickets', () => {
    const attempts = [snap(1, 1, 'failed'), snap(1, 2, 'failed')]
    expect(ticketView(compute(bundle, attempts, { retryGrants: { [tid(9)]: 5 } }), 1).state).toBe('failed')
  })
})

describe('computeExecution — lease expiry and reconciliation', () => {
  const bundle = makeBundle([[1]], [], {
    policies: { maxConcurrency: null, retryLimit: 2, onTicketFailure: 'continue_independent', leaseSeconds: 900 }
  })

  it('requires reconciliation after an unreconciled lease expiry', () => {
    const view = ticketView(compute(bundle, [snap(1, 1, 'lease_expired')]), 1)
    expect(view.state).toBe('needs_reconciliation')
    expect(view.blockers).toEqual([{ kind: 'lease_expired', attemptId: 'at-1-1' }])
  })

  it('counts a reconciled expiry as a used attempt and makes the ticket ready again', () => {
    const view = ticketView(compute(bundle, [snap(1, 1, 'lease_expired', { reconciled: true })]), 1)
    expect(view.state).toBe('ready')
    expect(view.blockers).toEqual([])
  })

  it('fails a ticket whose reconciled expiries reach the limit', () => {
    const attempts = [snap(1, 1, 'lease_expired', { reconciled: true }), snap(1, 2, 'lease_expired', { reconciled: true })]
    expect(ticketView(compute(bundle, attempts), 1).blockers).toEqual([{ kind: 'retry_limit', attempts: 2, limit: 2 }])
  })

  it('judges by the latest attempt, not an older expired one', () => {
    const attempts = [snap(1, 2, 'running'), snap(1, 1, 'lease_expired', { reconciled: true })]
    const view = ticketView(compute(bundle, attempts), 1)
    expect(view.state).toBe('running')
    expect(view.latestAttemptId).toBe('at-1-2')
  })
})

describe('computeExecution — superseded attempts', () => {
  it('ignores a superseded acceptance', () => {
    const view = ticketView(compute(makeBundle([[1]]), [snap(1, 1, 'accepted', { superseded: true })]), 1)
    expect(view.state).toBe('ready')
    expect(view.attemptCount).toBe(0)
    expect(view.latestAttemptId).toBeNull()
  })

  it('ignores superseded attempts when picking the latest and counting failures', () => {
    const bundle = makeBundle([[1]], [], {
      policies: { maxConcurrency: null, retryLimit: 1, onTicketFailure: 'continue_independent', leaseSeconds: 900 }
    })
    const attempts = [snap(1, 1, 'submitted'), snap(1, 2, 'failed', { superseded: true })]
    const view = ticketView(compute(bundle, attempts), 1)
    expect(view.state).toBe('submitted')
    expect(view.latestAttemptId).toBe('at-1-1')
    expect(view.attemptCount).toBe(1)
  })

  it('treats a carry-forward acceptance as accepted without counting it as work', () => {
    const view = ticketView(compute(makeBundle([[1]]), [snap(1, 1, 'accepted', { kind: 'carry_forward' })]), 1)
    expect(view.state).toBe('accepted')
    expect(view.attemptCount).toBe(0)
    expect(view.latestAttemptId).toBe('at-1-1')
  })
})

describe('computeExecution — concurrency caps', () => {
  function capped(cap: number | null, max: number | null): PlanBundle {
    const bundle = makeBundle([[1, 2, 3]])
    bundle.sprints[0].concurrencyCap = cap
    bundle.policies.maxConcurrency = max
    return bundle
  }

  it('leaves ready tickets claimable one below the cap', () => {
    const snapshot = compute(capped(2, null), [snap(1, 1, 'claimed')])
    expect(snapshot.capacity).toEqual({ limit: 2, inUse: 1 })
    expect(ticketView(snapshot, 2).blockers).toEqual([])
  })

  it('adds a concurrency blocker exactly at the cap', () => {
    const snapshot = compute(capped(2, null), [snap(1, 1, 'claimed'), snap(2, 1, 'running')])
    expect(snapshot.capacity).toEqual({ limit: 2, inUse: 2 })
    expect(ticketView(snapshot, 3).state).toBe('ready')
    expect(ticketView(snapshot, 3).blockers).toEqual([{ kind: 'concurrency', limit: 2 }])
  })

  it('uses the smaller of the sprint cap and the plan maximum', () => {
    expect(compute(capped(3, 1)).capacity).toEqual({ limit: 1, inUse: 0 })
    expect(compute(capped(1, 3)).capacity).toEqual({ limit: 1, inUse: 0 })
    expect(compute(capped(null, 2)).capacity).toEqual({ limit: 2, inUse: 0 })
  })

  it('does not count submitted work against capacity', () => {
    const snapshot = compute(capped(1, null), [snap(1, 1, 'submitted')])
    expect(snapshot.capacity).toEqual({ limit: 1, inUse: 0 })
    expect(ticketView(snapshot, 2).blockers).toEqual([])
  })
})

describe('computeExecution — sprints', () => {
  it('holds tickets of later sprints until the run advances', () => {
    const snapshot = compute(makeBundle([[1], [2]]))
    expect(states(snapshot)).toEqual(['DM-1:ready', 'DM-2:later_sprint'])
    expect(ticketView(snapshot, 2)).toMatchObject({ sprintId: sid(2), blockers: [] })
  })

  it('blocks unaccepted tickets of earlier sprints once a later sprint is active', () => {
    const snapshot = compute(makeBundle([[1, 3], [2]]), [snap(3, 1, 'accepted')], { activeSprintId: sid(2) })
    expect(states(snapshot)).toEqual(['DM-1:blocked', 'DM-3:accepted', 'DM-2:ready'])
    expect(ticketView(snapshot, 1).blockers).toEqual([])
  })

  it('counts capacity only for the active sprint', () => {
    const bundle = makeBundle([[1], [2]])
    bundle.sprints[1] = makeSprint(2, [2], { concurrencyCap: 1 })
    const snapshot = compute(bundle, [snap(1, 1, 'running')], { activeSprintId: sid(2) })
    expect(snapshot.capacity).toEqual({ limit: 1, inUse: 0 })
    expect(ticketView(snapshot, 2).blockers).toEqual([])
  })

  it('falls back to the first sprint when the active sprint id is unknown', () => {
    expect(states(compute(makeBundle([[1], [2]]), [], { activeSprintId: sid(7) }))).toEqual([
      'DM-1:ready',
      'DM-2:later_sprint'
    ])
  })
})

describe('computeExecution — run state', () => {
  it('treats sprint 1 as active for a queued run and blocks every pending ticket on the run state', () => {
    const snapshot = compute(makeBundle([[1, 2], [3]], [[1, 2]]), [], { activeSprintId: null, runState: 'queued' })
    expect(states(snapshot)).toEqual(['DM-1:ready', 'DM-2:waiting', 'DM-3:later_sprint'])
    const queued = { kind: 'run_state', state: 'queued' }
    expect(ticketView(snapshot, 1).blockers).toEqual([queued])
    expect(ticketView(snapshot, 2).blockers).toEqual([
      { kind: 'prerequisite', ticketId: tid(1), key: 'DM-1', state: 'ready' },
      queued
    ])
    expect(ticketView(snapshot, 3).blockers).toEqual([queued])
  })

  it('blocks only ready tickets on the run state while a started run is paused', () => {
    const snapshot = compute(makeBundle([[1, 2], [3]], [[1, 2]]), [], { runState: 'paused' })
    expect(ticketView(snapshot, 1).blockers).toEqual([{ kind: 'run_state', state: 'paused' }])
    expect(ticketView(snapshot, 2).blockers).toEqual([
      { kind: 'prerequisite', ticketId: tid(1), key: 'DM-1', state: 'ready' }
    ])
    expect(ticketView(snapshot, 3).blockers).toEqual([])
  })

  it('reports both run-state and capacity blockers together', () => {
    const bundle = makeBundle([[1, 2]])
    bundle.policies.maxConcurrency = 1
    const snapshot = compute(bundle, [snap(1, 1, 'running')], { runState: 'awaiting_checkpoint' })
    expect(ticketView(snapshot, 2).blockers).toEqual([
      { kind: 'run_state', state: 'awaiting_checkpoint' },
      { kind: 'concurrency', limit: 1 }
    ])
  })

  it('does not hang on a cyclic (invalid) graph', () => {
    expect(states(compute(makeBundle([[1, 2]], [[1, 2], [2, 1]])))).toEqual(['DM-1:blocked', 'DM-2:blocked'])
  })
})
