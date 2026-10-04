import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { AttemptState } from '../../shared/domain/status'
import type { TicketExecutionView } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import { type AttemptSnapshot, computeExecution, type ExecutionSnapshot, type ReadinessInput } from './readiness'

function snap(ticket: number, state: AttemptState, extra: Partial<AttemptSnapshot> = {}): AttemptSnapshot {
  return {
    id: `at-${ticket}`,
    ticketId: tid(ticket),
    number: 1,
    kind: 'work',
    state,
    reconciled: false,
    superseded: false,
    ...extra
  }
}

/** `layout` as for `makeBundle`; the listed tickets become acceptance nodes and `optional` ones optional. */
function planWithNodes(
  layout: number[][],
  nodes: number[],
  options: { edges?: [number, number][]; optional?: number[] } = {}
): PlanBundle {
  const bundle = makeBundle(layout, options.edges ?? [])
  bundle.tickets = bundle.tickets.map((ticket, index) => {
    const number = layout.flat()[index] ?? 0
    return {
      ...ticket,
      ...(nodes.includes(number) ? { kind: 'acceptance' as const } : {}),
      optional: (options.optional ?? []).includes(number)
    }
  })
  return bundle
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

function view(snapshot: ExecutionSnapshot, n: number): TicketExecutionView {
  const found = snapshot.tickets.find((item) => item.ticketId === tid(n))
  if (!found) {
    throw new Error(`ticket ${n} missing from snapshot`)
  }
  return found
}

function prerequisiteBlocker(n: number, state: string) {
  return { kind: 'prerequisite', ticketId: tid(n), key: `DM-${n}`, state }
}

describe('acceptance node readiness: it runs last in its sprint', () => {
  const bundle = planWithNodes([[1, 2, 3]], [3])

  it('waits while no other ticket of its sprint is accepted, naming each as a prerequisite', () => {
    const node = view(compute(bundle), 3)
    expect(node.state).toBe('waiting')
    expect(node.blockers).toEqual([prerequisiteBlocker(1, 'ready'), prerequisiteBlocker(2, 'ready')])
    expect(node.prerequisites).toEqual([
      { ticketId: tid(1), key: 'DM-1', state: 'ready', acceptedAttemptId: null },
      { ticketId: tid(2), key: 'DM-2', state: 'ready', acceptedAttemptId: null }
    ])
  })

  it('stays waiting on the tickets still open and drops the accepted one from its blockers', () => {
    const node = view(compute(bundle, [snap(1, 'accepted'), snap(2, 'running')]), 3)
    expect(node.state).toBe('waiting')
    expect(node.blockers).toEqual([prerequisiteBlocker(2, 'running')])
    expect(node.prerequisites.map((item) => [item.key, item.state, item.acceptedAttemptId])).toEqual([
      ['DM-1', 'accepted', 'at-1'],
      ['DM-2', 'running', null]
    ])
  })

  it('does not unlock on a submission that has not been accepted', () => {
    const node = view(compute(bundle, [snap(1, 'accepted'), snap(2, 'submitted')]), 3)
    expect([node.state, node.blockers]).toEqual(['waiting', [prerequisiteBlocker(2, 'submitted')]])
  })

  it('is ready once every other ticket of the sprint is accepted', () => {
    const node = view(compute(bundle, [snap(1, 'accepted'), snap(2, 'accepted')]), 3)
    expect([node.state, node.blockers]).toEqual(['ready', []])
    expect(node.prerequisites.map((item) => item.acceptedAttemptId)).toEqual(['at-1', 'at-2'])
  })

  it('waits again when an acceptance was superseded by an adopted revision', () => {
    const attempts = [snap(1, 'accepted'), snap(2, 'accepted', { superseded: true })]
    const node = view(compute(bundle, attempts), 3)
    expect([node.state, node.blockers]).toEqual(['waiting', [prerequisiteBlocker(2, 'ready')]])
  })
})

describe('acceptance node readiness: what it requires', () => {
  it('does not require optional tickets of its sprint', () => {
    const bundle = planWithNodes([[1, 2, 3]], [3], { optional: [2] })
    const waiting = view(compute(bundle, [snap(2, 'running')]), 3)
    expect(waiting.blockers).toEqual([prerequisiteBlocker(1, 'ready')])
    expect(view(compute(bundle, [snap(1, 'accepted')]), 3).state).toBe('ready')
  })

  it('requires only its own sprint, never work of another sprint', () => {
    const bundle = planWithNodes([[1, 2], [3, 4]], [2, 4])
    const first = compute(bundle, [snap(1, 'accepted')])
    expect(view(first, 2).state).toBe('ready')
    const second = compute(bundle, [snap(1, 'accepted'), snap(2, 'accepted')], { activeSprintId: sid(2) })
    expect(view(second, 4).prerequisites.map((item) => item.key)).toEqual(['DM-3'])
    expect(view(second, 3).state).toBe('ready')
  })

  it('keeps tickets of later sprints held while the first sprint finishes', () => {
    const bundle = planWithNodes([[1, 2], [3, 4]], [2, 4])
    const snapshot = compute(bundle, [snap(1, 'accepted')])
    expect([view(snapshot, 3).state, view(snapshot, 4).state]).toEqual(['later_sprint', 'later_sprint'])
  })

  it('lists a prerequisite once when the plan also stores an edge to the node', () => {
    const bundle = planWithNodes([[1, 2, 3]], [3], { edges: [[1, 3]] })
    const node = view(compute(bundle), 3)
    expect(node.prerequisites.map((item) => item.key)).toEqual(['DM-1', 'DM-2'])
    expect(node.blockers).toEqual([prerequisiteBlocker(1, 'ready'), prerequisiteBlocker(2, 'ready')])
  })

  it('keeps the ordering that stored edges between work tickets give', () => {
    const bundle = planWithNodes([[1, 2, 3]], [3], { edges: [[1, 2]] })
    const snapshot = compute(bundle, [snap(1, 'accepted'), snap(2, 'accepted')])
    expect([view(snapshot, 2).state, view(snapshot, 3).state]).toEqual(['accepted', 'ready'])
    expect(view(compute(bundle), 2).state).toBe('waiting')
  })
})

describe('acceptance node readiness: failures and older plans', () => {
  it('blocks the node when a required ticket failed for good', () => {
    const bundle = planWithNodes([[1, 2]], [2])
    const limit = bundle.policies.retryLimit
    const attempts = Array.from({ length: limit }, (_unused, index) =>
      snap(1, 'failed', { id: `at-1-${index}`, number: index + 1 })
    )
    const node = view(compute(bundle, attempts), 2)
    expect(node.state).toBe('blocked')
    expect(node.blockers).toEqual([prerequisiteBlocker(1, 'failed')])
  })

  it('leaves a sprint without an acceptance node exactly as before', () => {
    const snapshot = compute(makeBundle([[1, 2, 3]]))
    expect(snapshot.tickets.map((item) => `${item.key}:${item.state}`)).toEqual(['DM-1:ready', 'DM-2:ready', 'DM-3:ready'])
    expect(snapshot.tickets.flatMap((item) => [...item.blockers, ...item.prerequisites])).toEqual([])
  })

  it('treats a ticket of kind work like a ticket with no kind', () => {
    const bundle = makeBundle([[1, 2]])
    bundle.tickets = bundle.tickets.map((ticket) => ({ ...ticket, kind: 'work' as const }))
    expect(compute(bundle).tickets.map((item) => item.state)).toEqual(['ready', 'ready'])
  })

  it('makes an acceptance node alone in its sprint ready at once', () => {
    expect(view(compute(planWithNodes([[1]], [1])), 1)).toMatchObject({ state: 'ready', blockers: [], prerequisites: [] })
  })
})
