/** Draft operations around sprint acceptance nodes: creation, moves, dependencies, removal and covers. */
import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'
import { makeBundle, makeSprint, makeTicket, tid } from '../../test/bundles'
import { DomainError } from '../errors'
import { applyDraftOps, type DraftOpsResult } from './draftOps'
import { validatePlan } from './graph'
import { maxKeyNumber } from './normalize'

/** Readable, deterministic ids (`tk_new1`, `sp_new1`) and keys continuing after the bundle's own. */
function makeDeps(bundle: PlanBundle): { newId(kind: 'ticket' | 'sprint'): string; nextKey(): string } {
  const counters = { ticket: 0, sprint: 0 }
  let key = maxKeyNumber(bundle.tickets.map((ticket) => ticket.key))
  return {
    newId: (kind) => {
      counters[kind] += 1
      return `${kind === 'ticket' ? 'tk' : 'sp'}_new${counters[kind]}`
    },
    nextKey: () => {
      key += 1
      return `DM-${key}`
    }
  }
}

function apply(bundle: PlanBundle, ...ops: DraftOp[]): DraftOpsResult {
  return applyDraftOps(bundle, ops, makeDeps(bundle))
}

function rejection(bundle: PlanBundle, ...ops: DraftOp[]): DomainError {
  try {
    apply(bundle, ...ops)
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return error
    }
    throw error
  }
  throw new Error('Expected the ops to be rejected.')
}

/** Sprint 1: work 1, work 2, acceptance 3 (covering 1 and 2). Sprint 2: work 4. */
function acceptanceBundle(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3], [4]])
  bundle.tickets = [
    makeTicket(1),
    makeTicket(2),
    makeTicket(3, {
      kind: 'acceptance',
      title: 'Sprint 1 acceptance',
      acceptanceCriteria: [
        { id: 'c1', text: 'DM-1 verified', covers: tid(1) },
        { id: 'c2', text: 'DM-2 verified', covers: tid(2) }
      ]
    }),
    makeTicket(4)
  ]
  return bundle
}

function ticketByKey(bundle: PlanBundle, key: string): TicketContent {
  const ticket = bundle.tickets.find((item) => item.key === key)
  if (!ticket) {
    throw new Error(`No ticket ${key}`)
  }
  return ticket
}

describe('add_sprint creates the sprint acceptance node', () => {
  it('adds one node, listed in the new sprint, titled for the sprint and meant for testing', () => {
    const { bundle } = apply(makeBundle([[1]]), { op: 'add_sprint', ref: 's', sprint: { goal: 'Polish' } })
    const sprint = bundle.sprints[1]
    expect(sprint.ticketIds).toEqual(['tk_new1'])
    const node = bundle.tickets.find((ticket) => ticket.id === 'tk_new1')
    expect(node).toMatchObject({
      id: 'tk_new1',
      key: 'DM-2',
      title: 'Sprint 2 acceptance',
      kind: 'acceptance',
      optional: false,
      acceptanceCriteria: [],
      capability: { workType: 'testing' }
    })
  })

  it('titles the node by the ordinal the sprint ends up with', () => {
    const { bundle } = apply(makeBundle([[1], [2]]), { op: 'add_sprint', sprint: { goal: 'Middle' }, position: 2 })
    const middle = bundle.sprints.find((sprint) => sprint.goal === 'Middle')
    const node = bundle.tickets.find((ticket) => ticket.id === middle?.ticketIds[0])
    expect(middle?.ordinal).toBe(2)
    expect(node?.title).toBe('Sprint 2 acceptance')
  })

  it('creates one node per added sprint, with keys following the plan keys', () => {
    const { bundle } = apply(
      makeBundle([[1]]),
      { op: 'add_sprint', sprint: { goal: 'a' } },
      { op: 'add_sprint', sprint: { goal: 'b' } }
    )
    expect(bundle.tickets.filter((ticket) => ticket.kind === 'acceptance').map((ticket) => [ticket.key, ticket.title])).toEqual([
      ['DM-2', 'Sprint 2 acceptance'],
      ['DM-3', 'Sprint 3 acceptance']
    ])
  })

})

describe('add_sprint leaves the new sprint ordered and valid', () => {
  it('keeps the node last: a ticket added to the new sprint goes ahead of it', () => {
    const { bundle } = apply(
      makeBundle([[1]]),
      { op: 'add_sprint', ref: 's', sprint: { goal: 'Polish' } },
      { op: 'add_ticket', sprint: 's', ticket: { title: 'Polish it' } },
      { op: 'add_ticket', sprint: 's', ticket: { title: 'Polish more' } }
    )
    const kinds = bundle.sprints[1].ticketIds.map((id) => bundle.tickets.find((ticket) => ticket.id === id)?.kind)
    expect(kinds).toEqual([undefined, undefined, 'acceptance'])
    expect(validatePlan(bundle).errors).toEqual([])
  })

  it('keeps the plan valid, warning only about the empty sprint', () => {
    const report = validatePlan(apply(makeBundle([[1]]), { op: 'add_sprint', sprint: { goal: 'a' } }).bundle)
    expect(report.errors).toEqual([])
    expect(report.warnings.map((issue) => issue.code)).toContain('empty_sprint')
  })
})

describe('renumbering keeps automatic acceptance titles current', () => {
  it('retitles a node that still has its automatic title when its sprint is renumbered', () => {
    const start = apply(makeBundle([[1]]), { op: 'add_sprint', ref: 'two', sprint: { goal: 'two' } }).bundle
    const { bundle } = apply(start, { op: 'add_sprint', sprint: { goal: 'inserted' }, position: 1 })
    const two = bundle.sprints.find((sprint) => sprint.goal === 'two')
    const node = bundle.tickets.find((ticket) => ticket.id === two?.ticketIds[0])
    expect(two?.ordinal).toBe(3)
    expect(node?.title).toBe('Sprint 3 acceptance')
  })

  it('leaves a title the planner changed alone', () => {
    const start = apply(makeBundle([[1]]), { op: 'add_sprint', ref: 'two', sprint: { goal: 'two' } })
    const renamed = apply(start.bundle, {
      op: 'update_ticket',
      ticket: start.bundle.sprints[1].ticketIds[0],
      patch: { title: 'Release sign-off' }
    })
    const { bundle } = apply(renamed.bundle, { op: 'add_sprint', sprint: { goal: 'inserted' }, position: 1 })
    const two = bundle.sprints.find((sprint) => sprint.goal === 'two')
    expect(bundle.tickets.find((ticket) => ticket.id === two?.ticketIds[0])?.title).toBe('Release sign-off')
  })
})

describe('add_ticket and update_ticket kind', () => {
  it('creates an acceptance node when kind is acceptance, defaulting its work type to testing', () => {
    const { bundle } = apply(makeBundle([[1]]), {
      op: 'add_ticket',
      sprint: '1',
      ticket: { title: 'Sprint 1 acceptance', kind: 'acceptance' }
    })
    expect(ticketByKey(bundle, 'DM-2')).toMatchObject({ kind: 'acceptance', capability: { workType: 'testing' } })
  })

  it('keeps an explicit work type on an acceptance node', () => {
    const { bundle } = apply(makeBundle([[1]]), {
      op: 'add_ticket',
      sprint: '1',
      ticket: { title: 'Review', kind: 'acceptance', capability: { workType: 'review' } }
    })
    expect(ticketByKey(bundle, 'DM-2').capability.workType).toBe('review')
  })

  it('stores no kind for a work ticket, whether kind is omitted or work', () => {
    const { bundle } = apply(
      makeBundle([[1]]),
      { op: 'add_ticket', sprint: '1', ticket: { title: 'Plain' } },
      { op: 'add_ticket', sprint: '1', ticket: { title: 'Explicit', kind: 'work' } }
    )
    expect(Object.keys(ticketByKey(bundle, 'DM-2'))).not.toContain('kind')
    expect(Object.keys(ticketByKey(bundle, 'DM-3'))).not.toContain('kind')
    expect(ticketByKey(bundle, 'DM-3').capability.workType).toBe('implementation')
  })

  it('accepts a second acceptance node in a sprint but reports it as a validation error', () => {
    const { bundle } = apply(acceptanceBundle(), {
      op: 'add_ticket',
      sprint: '1',
      ticket: { title: 'Another', kind: 'acceptance' }
    })
    const report = validatePlan(bundle)
    expect(report.valid).toBe(false)
    expect(report.errors.map((issue) => issue.code)).toEqual(['duplicate_acceptance'])
  })

  it('makes a work ticket an acceptance node and back, never storing work', () => {
    const made = apply(makeBundle([[1]]), { op: 'update_ticket', ticket: 'DM-1', patch: { kind: 'acceptance' } })
    expect(ticketByKey(made.bundle, 'DM-1').kind).toBe('acceptance')
    const back = apply(made.bundle, { op: 'update_ticket', ticket: 'DM-1', patch: { kind: 'work' } })
    expect(Object.keys(ticketByKey(back.bundle, 'DM-1'))).not.toContain('kind')
  })

  it('leaves the kind alone when a patch does not mention it', () => {
    const { bundle } = apply(acceptanceBundle(), { op: 'update_ticket', ticket: 'DM-3', patch: { title: 'Renamed' } })
    expect(ticketByKey(bundle, 'DM-3').kind).toBe('acceptance')
  })
})

describe('move_ticket and acceptance nodes', () => {
  it('refuses to move a node to another sprint, naming the node and its sprint', () => {
    const failure = rejection(acceptanceBundle(), { op: 'move_ticket', ticket: 'DM-3', toSprint: '2' })
    expect(failure.code).toBe('invalid_graph')
    expect(failure.message).toBe("DM-3 is the acceptance node of Sprint 1 and can't move to another sprint.")
    expect(failure.details).toEqual({ opIndex: 0, op: 'move_ticket' })
  })

  it('refuses the move even when the target sprint has no node', () => {
    const bundle = acceptanceBundle()
    bundle.sprints.push(makeSprint(3, []))
    expect(rejection(bundle, { op: 'move_ticket', ticket: 'DM-3', toSprint: '3' }).code).toBe('invalid_graph')
  })

  it('lets a node change position inside its own sprint', () => {
    const { bundle } = apply(acceptanceBundle(), { op: 'move_ticket', ticket: 'DM-3', toSprint: '1', position: 0 })
    expect(bundle.sprints[0].ticketIds).toEqual([tid(3), tid(1), tid(2)])
  })

  it('still moves work tickets between sprints, placing one ahead of the node of its new sprint', () => {
    const { bundle } = apply(acceptanceBundle(), { op: 'move_ticket', ticket: 'DM-4', toSprint: '1' })
    expect(bundle.sprints[0].ticketIds).toEqual([tid(1), tid(2), tid(4), tid(3)])
    expect(bundle.sprints[1].ticketIds).toEqual([])
  })

  it('places a work ticket at the position asked for, even behind the node', () => {
    const { bundle } = apply(acceptanceBundle(), { op: 'move_ticket', ticket: 'DM-4', toSprint: '1', position: 3 })
    expect(bundle.sprints[0].ticketIds).toEqual([tid(1), tid(2), tid(3), tid(4)])
  })
})

describe('add_dependency and acceptance nodes', () => {
  it('rejects an edge from a node to a ticket of its own sprint', () => {
    const failure = rejection(acceptanceBundle(), { op: 'add_dependency', from: 'DM-3', to: 'DM-1' })
    expect(failure.code).toBe('invalid_graph')
    expect(failure.message).toBe(
      "Dependency not added. DM-1 can't require DM-3: DM-3 is the acceptance node of Sprint 1 and runs after every other required ticket in it."
    )
  })

  it('lets a later sprint depend on the node', () => {
    const { bundle } = apply(acceptanceBundle(), { op: 'add_dependency', from: 'DM-3', to: 'DM-4' })
    expect(bundle.edges).toEqual([{ from: tid(3), to: tid(4) }])
  })

  it('accepts an explicit edge into the node but leaves a redundancy warning', () => {
    const { bundle } = apply(acceptanceBundle(), { op: 'add_dependency', from: 'DM-1', to: 'DM-3' })
    expect(bundle.edges).toEqual([{ from: tid(1), to: tid(3) }])
    expect(validatePlan(bundle).warnings.map((issue) => issue.code)).toContain('redundant_acceptance_edge')
  })
})

describe('remove_sprint and acceptance nodes', () => {
  it('removes a sprint that holds only its node, together with the node', () => {
    const start = apply(makeBundle([[1]]), { op: 'add_sprint', sprint: { goal: 'extra' } }).bundle
    const { bundle } = apply(start, { op: 'remove_sprint', sprint: '2' })
    expect(bundle.sprints.map((sprint) => sprint.ordinal)).toEqual([1])
    expect(bundle.tickets.map((ticket) => ticket.key)).toEqual(['DM-1'])
  })

  it('drops the dependencies of the node it removes', () => {
    const plan = makeBundle([[1], [2], [3]], [[2, 3]])
    plan.tickets = plan.tickets.map((ticket) => (ticket.id === tid(2) ? { ...ticket, kind: 'acceptance' as const } : ticket))
    const { bundle } = apply(plan, { op: 'remove_sprint', sprint: '2' })
    expect(bundle.edges).toEqual([])
    expect(bundle.tickets.map((ticket) => ticket.key)).toEqual(['DM-1', 'DM-3'])
    expect(bundle.sprints.map((sprint) => [sprint.ordinal, sprint.ticketIds])).toEqual([
      [1, [tid(1)]],
      [2, [tid(3)]]
    ])
  })

  it('rejects removing a sprint that still has work tickets, counting only the work tickets', () => {
    const failure = rejection(acceptanceBundle(), { op: 'remove_sprint', sprint: '1' })
    expect(failure.code).toBe('invalid_input')
    expect(failure.message).toBe('Sprint 1 still has 2 ticket(s). Move or remove them first.')
  })

  it('still keeps the last sprint', () => {
    const bundle = makeBundle([[1]])
    bundle.tickets = [makeTicket(1, { kind: 'acceptance' })]
    expect(rejection(bundle, { op: 'remove_sprint', sprint: '1' }).message).toBe('A plan keeps at least one sprint.')
  })
})

describe('remove_ticket and covers', () => {
  it('removes a covered ticket and the covers that named it, keeping the criterion', () => {
    const { bundle } = apply(acceptanceBundle(), { op: 'remove_ticket', ticket: 'DM-2' })
    const node = ticketByKey(bundle, 'DM-3')
    expect(node.acceptanceCriteria).toEqual([
      { id: 'c1', text: 'DM-1 verified', covers: tid(1) },
      { id: 'c2', text: 'DM-2 verified' }
    ])
    expect(Object.keys(node.acceptanceCriteria[1])).not.toContain('covers')
  })

  it('leaves tickets that covered nothing removed alone', () => {
    const { bundle } = apply(acceptanceBundle(), { op: 'remove_ticket', ticket: 'DM-4' })
    expect(ticketByKey(bundle, 'DM-3').acceptanceCriteria.map((item) => item.covers)).toEqual([tid(1), tid(2)])
  })
})

describe('covers in criteria', () => {
  it('stores the stable id of a covered ticket named by key', () => {
    const { bundle } = apply(acceptanceBundle(), {
      op: 'update_ticket',
      ticket: 'DM-3',
      patch: { acceptanceCriteria: [{ text: 'DM-1 builds', covers: 'DM-1' }] }
    })
    expect(ticketByKey(bundle, 'DM-3').acceptanceCriteria).toEqual([{ id: 'c3', text: 'DM-1 builds', covers: tid(1) }])
  })

  it('resolves a client ref to a ticket added earlier in the same request', () => {
    const { bundle, refMap } = apply(
      acceptanceBundle(),
      { op: 'add_ticket', ref: 'new', sprint: '1', ticket: { title: 'New work' } },
      { op: 'update_ticket', ticket: 'DM-3', patch: { acceptanceCriteria: [{ text: 'New work verified', covers: 'new' }] } }
    )
    expect(ticketByKey(bundle, 'DM-3').acceptanceCriteria[0].covers).toBe(refMap.new)
  })

  it('stores covers given while creating a node', () => {
    const { bundle } = apply(makeBundle([[1]]), {
      op: 'add_ticket',
      sprint: '1',
      ticket: { title: 'Acceptance', kind: 'acceptance', acceptanceCriteria: [{ text: 'DM-1 verified', covers: 'DM-1' }] }
    })
    expect(ticketByKey(bundle, 'DM-2').acceptanceCriteria).toEqual([{ id: 'c1', text: 'DM-1 verified', covers: tid(1) }])
  })

  it('rejects an unknown covered ticket with the op index', () => {
    const failure = rejection(acceptanceBundle(), {
      op: 'update_ticket',
      ticket: 'DM-3',
      patch: { acceptanceCriteria: [{ text: 'Ghost', covers: 'DM-99' }] }
    })
    expect(failure.code).toBe('not_found')
    expect(failure.message).toBe('Unknown ticket "DM-99".')
    expect(failure.details).toEqual({ opIndex: 0, op: 'update_ticket' })
  })

})

describe('covers kept or cleared when criteria are patched', () => {
  it('keeps the covers of criteria that a patch repeats by id or by text', () => {
    const { bundle } = apply(acceptanceBundle(), {
      op: 'update_ticket',
      ticket: 'DM-3',
      patch: { acceptanceCriteria: [{ id: 'c1', text: 'DM-1 verified again' }, 'DM-2 verified', 'Brand new'] }
    })
    expect(ticketByKey(bundle, 'DM-3').acceptanceCriteria).toEqual([
      { id: 'c1', text: 'DM-1 verified again', covers: tid(1) },
      { id: 'c2', text: 'DM-2 verified', covers: tid(2) },
      { id: 'c3', text: 'Brand new' }
    ])
  })

  it('clears covers with null', () => {
    const { bundle } = apply(acceptanceBundle(), {
      op: 'update_ticket',
      ticket: 'DM-3',
      patch: { acceptanceCriteria: [{ id: 'c1', text: 'DM-1 verified', covers: null }, { id: 'c2', text: 'DM-2 verified' }] }
    })
    const [first, second] = ticketByKey(bundle, 'DM-3').acceptanceCriteria
    expect(Object.keys(first)).not.toContain('covers')
    expect(second.covers).toBe(tid(2))
  })
})
