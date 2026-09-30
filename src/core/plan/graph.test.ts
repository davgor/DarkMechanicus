import { describe, expect, it } from 'vitest'
import type { DependencyEdge, PlanBundle, SprintDef } from '../../shared/domain/bundle'
import type { ValidationIssue } from '../../shared/domain/views'
import { makeBundle, makeSprint, makeTicket, sid, tid } from '../../test/bundles'
import {
  checkEdgeAddition,
  dependentsOf,
  findCycle,
  indexBundle,
  prerequisitesOf,
  sortedSprints,
  ticketLabel,
  validatePlan
} from './graph'

const LATER_SPRINT_TAIL = 'A prerequisite must be in the same sprint or an earlier one.'

function edge(from: number, to: number): DependencyEdge {
  return { from: tid(from), to: tid(to) }
}

function link(from: string, to: string): DependencyEdge {
  return { from, to }
}

function errorsOf(bundle: PlanBundle): ValidationIssue[] {
  return validatePlan(bundle).errors
}

function warningsOf(bundle: PlanBundle): ValidationIssue[] {
  return validatePlan(bundle).warnings
}

function codes(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.code)
}

/** Three linked tickets across two sprints: 1 -> 2 (same sprint), 2 -> 3 (next sprint). No warnings. */
function cleanBundle(): PlanBundle {
  return makeBundle([[1, 2], [3]], [[1, 2], [2, 3]])
}

function withPolicies(patch: Partial<PlanBundle['policies']>): PlanBundle {
  const bundle = cleanBundle()
  return { ...bundle, policies: { ...bundle.policies, ...patch } }
}

function withSprintCap(cap: number | null): PlanBundle {
  const bundle = cleanBundle()
  return { ...bundle, sprints: bundle.sprints.map((sprint, index) => (index === 0 ? { ...sprint, concurrencyCap: cap } : sprint)) }
}

describe('findCycle acyclic graphs', () => {
  it('returns null for an empty graph and for nodes without edges', () => {
    expect(findCycle([], [])).toBeNull()
    expect(findCycle(['a', 'b'], [])).toBeNull()
  })

  it('returns null for a chain and for a fork/join diamond', () => {
    expect(findCycle(['a', 'b', 'c'], [link('a', 'b'), link('b', 'c')])).toBeNull()
    const diamond = [link('a', 'b'), link('a', 'c'), link('b', 'd'), link('c', 'd')]
    expect(findCycle(['a', 'b', 'c', 'd'], diamond)).toBeNull()
  })

  it('does not mistake a node reached from later nodes for a cycle', () => {
    expect(findCycle(['a', 'b', 'c'], [link('a', 'b'), link('c', 'a')])).toBeNull()
    expect(findCycle(['x', 'a', 'b', 'c'], [link('a', 'b'), link('c', 'b'), link('x', 'c')])).toBeNull()
  })

  it('ignores edges from unknown nodes and follows edges to unknown nodes', () => {
    expect(findCycle(['a'], [link('ghost', 'a'), link('a', 'ghost')])).toBeNull()
  })
})

describe('findCycle cyclic graphs', () => {
  it('reports a self loop as a closed two-element path', () => {
    expect(findCycle(['a'], [link('a', 'a')])).toEqual(['a', 'a'])
  })

  it('reports a two-node cycle as a closed path', () => {
    expect(findCycle(['a', 'b'], [link('a', 'b'), link('b', 'a')])).toEqual(['a', 'b', 'a'])
  })

  it('reports a longer cycle in traversal order', () => {
    const edges = [link('a', 'b'), link('b', 'c'), link('c', 'a')]
    expect(findCycle(['a', 'b', 'c'], edges)).toEqual(['a', 'b', 'c', 'a'])
    expect(findCycle(['c', 'b', 'a'], edges)).toEqual(['c', 'a', 'b', 'c'])
  })

  it('starts the path at the cycle, not at the node that leads into it', () => {
    const edges = [link('x', 'a'), link('a', 'b'), link('b', 'a')]
    expect(findCycle(['x', 'a', 'b'], edges)).toEqual(['a', 'b', 'a'])
  })

  it('finds a cycle in a component the first node cannot reach', () => {
    const edges = [link('a', 'b'), link('b', 'a')]
    expect(findCycle(['x', 'a', 'b'], edges)).toEqual(['a', 'b', 'a'])
  })

  it('finds a cycle reached through a later branch of an earlier node', () => {
    const edges = [link('a', 'b'), link('a', 'c'), link('c', 'a')]
    expect(findCycle(['a', 'b', 'c'], edges)).toEqual(['a', 'c', 'a'])
  })

  it('returns a path whose consecutive nodes are connected by edges', () => {
    const edges = [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('d', 'b'), link('a', 'd')]
    const path = findCycle(['a', 'b', 'c', 'd'], edges) ?? []
    expect(path[0]).toBe(path[path.length - 1])
    const pairs = path.slice(1).map((node, index) => link(path[index] ?? '', node))
    expect(pairs.every((pair) => edges.some((candidate) => candidate.from === pair.from && candidate.to === pair.to))).toBe(true)
  })
})

describe('validatePlan valid plans', () => {
  it('accepts a clean plan without errors or warnings', () => {
    expect(validatePlan(cleanBundle())).toEqual({ valid: true, errors: [], warnings: [] })
  })

  it('accepts a fork/join plan', () => {
    const fork = makeBundle([[1, 2, 3, 4]], [[1, 2], [1, 3], [2, 4], [3, 4]])
    expect(validatePlan(fork)).toEqual({ valid: true, errors: [], warnings: [] })
  })

  it('accepts a fork across sprints and a join back', () => {
    const plan = makeBundle([[1], [2, 3], [4]], [[1, 2], [1, 3], [2, 4], [3, 4]])
    expect(validatePlan(plan).valid).toBe(true)
  })

  it('accepts prerequisites in the same sprint and in earlier sprints', () => {
    expect(errorsOf(makeBundle([[1, 2]], [[1, 2]]))).toEqual([])
    expect(errorsOf(makeBundle([[1], [2]], [[1, 2]]))).toEqual([])
  })

  it('reports valid as false as soon as there is one error, regardless of warnings', () => {
    const invalid = makeBundle([[1, 2]], [[1, 2]], { rationale: '', tickets: [] })
    expect(validatePlan(invalid).valid).toBe(false)
    expect(validatePlan(makeBundle([[1]])).valid).toBe(true)
    expect(warningsOf(makeBundle([[1], []]))).not.toEqual([])
    expect(validatePlan(makeBundle([[1], []])).valid).toBe(true)
  })
})

describe('validatePlan prerequisite ordering', () => {
  it('rejects a prerequisite in a later sprint naming both tickets and sprints', () => {
    const plan = makeBundle([[1], [2]], [[2, 1]])
    expect(errorsOf(plan)).toEqual([
      {
        code: 'later_sprint_prerequisite',
        message: `DM-1 is in Sprint 1 and can't require DM-2 in Sprint 2. ${LATER_SPRINT_TAIL}`,
        ticketIds: [tid(1), tid(2)],
        edge: edge(2, 1)
      }
    ])
  })

  it('reports the sprint ordinals rather than positions', () => {
    const plan = makeBundle([[1], [2], [3]], [[3, 2]])
    expect(errorsOf(plan)[0]?.message).toBe(
      `DM-2 is in Sprint 2 and can't require DM-3 in Sprint 3. ${LATER_SPRINT_TAIL}`
    )
  })

  it('reports every offending edge', () => {
    const plan = makeBundle([[1], [2], [3]], [[2, 1], [3, 1], [3, 2]])
    expect(codes(errorsOf(plan))).toEqual([
      'later_sprint_prerequisite',
      'later_sprint_prerequisite',
      'later_sprint_prerequisite'
    ])
  })

  it('does not report edges whose tickets are not placed in sprints', () => {
    const plan = makeBundle([[1]], [], { tickets: [makeTicket(1), makeTicket(2)], edges: [edge(1, 2)] })
    expect(codes(errorsOf(plan))).toEqual(['ticket_not_in_sprint'])
  })
})

describe('validatePlan cycles and edge shape', () => {
  it('reports a cycle as a path of ticket keys', () => {
    const plan = makeBundle([[1, 2, 3]], [[1, 2], [2, 3], [3, 1]])
    expect(errorsOf(plan)).toEqual([
      {
        code: 'cycle',
        message: 'Dependency cycle: DM-1 → DM-2 → DM-3 → DM-1.',
        ticketIds: [tid(1), tid(2), tid(3)]
      }
    ])
  })

  it('reports a cycle between two tickets', () => {
    const plan = makeBundle([[1, 2]], [[1, 2], [2, 1]])
    expect(errorsOf(plan)[0]?.message).toBe('Dependency cycle: DM-1 → DM-2 → DM-1.')
  })

  it('reports self edges without also calling them cycles', () => {
    expect(errorsOf(makeBundle([[1]], [[1, 1]]))).toEqual([
      { code: 'self_edge', message: "DM-1 can't depend on itself.", ticketIds: [tid(1)], edge: edge(1, 1) }
    ])
  })

  it('reports edges to unknown tickets by id, whichever end is unknown', () => {
    const unknown = tid(99)
    const toUnknown = makeBundle([[1]], [], { edges: [{ from: tid(1), to: unknown }] })
    const fromUnknown = makeBundle([[1]], [], { edges: [{ from: unknown, to: tid(1) }] })
    const bothUnknown = makeBundle([[1]], [], { edges: [{ from: tid(98), to: unknown }] })
    expect(errorsOf(toUnknown)).toEqual([
      { code: 'edge_missing_ticket', message: `Dependency references unknown ticket ${unknown}.`, edge: { from: tid(1), to: unknown } }
    ])
    expect(errorsOf(fromUnknown)[0]?.message).toBe(`Dependency references unknown ticket ${unknown}.`)
    expect(errorsOf(bothUnknown)[0]?.message).toBe(`Dependency references unknown ticket ${tid(98)}, ${unknown}.`)
  })

  it('reports duplicate edges once per repeat', () => {
    const plan = makeBundle([[1, 2]], [[1, 2], [1, 2], [1, 2]])
    expect(errorsOf(plan)).toEqual([
      { code: 'duplicate_edge', message: 'DM-2 requires DM-1 twice.', edge: edge(1, 2) },
      { code: 'duplicate_edge', message: 'DM-2 requires DM-1 twice.', edge: edge(1, 2) }
    ])
  })

  it('does not treat reversed or distinct edges as duplicates', () => {
    const plan = makeBundle([[1, 2, 3]], [[1, 2], [2, 3], [1, 3]])
    expect(errorsOf(plan)).toEqual([])
  })

  it('still finds a cycle when other edges are invalid', () => {
    const plan = makeBundle([[1, 2]], [[1, 2], [2, 1], [2, 2]])
    expect(codes(errorsOf(plan))).toEqual(['self_edge', 'cycle'])
  })
})

describe('validatePlan identity and titles', () => {
  it('reports repeated ticket ids', () => {
    const plan = makeBundle([[1]], [], { tickets: [makeTicket(1), makeTicket(1, { key: 'DM-9' })] })
    expect(errorsOf(plan)).toEqual([
      { code: 'duplicate_ticket_id', message: `Ticket id ${tid(1)} appears more than once.`, ticketIds: [tid(1)] }
    ])
  })

  it('reports repeated sprint ids', () => {
    const plan = makeBundle([[1], [2]], [], {
      sprints: [makeSprint(1, [1]), makeSprint(1, [2], { ordinal: 2 })]
    })
    expect(errorsOf(plan)).toEqual([
      { code: 'duplicate_sprint_id', message: `Sprint id ${sid(1)} appears more than once.`, sprintIds: [sid(1)] }
    ])
  })

  it('reports an empty or blank epic title', () => {
    for (const title of ['', '   ', '\t\n']) {
      const plan = { ...cleanBundle(), epic: { ...cleanBundle().epic, title } }
      expect(errorsOf(plan)).toEqual([{ code: 'empty_title', message: 'The epic needs a title.' }])
    }
  })

  it('accepts a non-empty epic title', () => {
    const plan = { ...cleanBundle(), epic: { ...cleanBundle().epic, title: ' x ' } }
    expect(errorsOf(plan)).toEqual([])
  })

  it('reports empty or blank ticket titles with the ticket key', () => {
    const plan = cleanBundle()
    plan.tickets = [makeTicket(1), makeTicket(2, { title: '' }), makeTicket(3, { title: '  ' })]
    expect(errorsOf(plan)).toEqual([
      { code: 'empty_title', message: 'Ticket DM-2 needs a title.', ticketIds: [tid(2)] },
      { code: 'empty_title', message: 'Ticket DM-3 needs a title.', ticketIds: [tid(3)] }
    ])
  })
})

describe('validatePlan sprint ordinals', () => {
  it('requires at least one sprint', () => {
    const plan = makeBundle([], [], { sprints: [] })
    expect(errorsOf(plan)).toEqual([{ code: 'no_sprints', message: 'The plan needs at least one sprint.' }])
  })

  it('accepts sprints stored out of order as long as ordinals are contiguous', () => {
    const plan = makeBundle([[1], [2]], [], { sprints: [makeSprint(2, [2]), makeSprint(1, [1])] })
    expect(errorsOf(plan)).toEqual([])
  })

  it.each([
    ['a gap', [1, 3]],
    ['a repeat', [1, 1]],
    ['a start at zero', [0, 1]],
    ['a start at two', [2, 3]],
    ['a descending gap', [3, 1]]
  ])('rejects ordinals with %s', (_label, ordinals) => {
    const sprints = ordinals.map((ordinal, index) => makeSprint(index + 1, [], { ordinal }))
    const plan = makeBundle([], [], { sprints })
    expect(errorsOf(plan)).toEqual([
      {
        code: 'sprint_ordinals',
        message: `Sprint ordinals must run 1..${ordinals.length} without gaps or repeats.`,
        sprintIds: sprints.map((sprint) => sprint.id)
      }
    ])
  })

  it('accepts a single sprint with ordinal 1', () => {
    expect(errorsOf(makeBundle([[]]))).toEqual([])
  })
})

describe('validatePlan sprint membership', () => {
  it('reports a ticket that no sprint lists', () => {
    const plan = makeBundle([[1]], [], { tickets: [makeTicket(1), makeTicket(2)] })
    expect(errorsOf(plan)).toEqual([
      { code: 'ticket_not_in_sprint', message: 'DM-2 is not assigned to a sprint.', ticketIds: [tid(2)] }
    ])
  })

  it('reports a ticket listed by more than one sprint', () => {
    const plan = makeBundle([[1], [2]], [], { sprints: [makeSprint(1, [1, 2]), makeSprint(2, [2])] })
    expect(errorsOf(plan)).toEqual([
      {
        code: 'ticket_in_multiple_sprints',
        message: 'DM-2 belongs to more than one sprint; a ticket appears once per plan.',
        ticketIds: [tid(2)]
      }
    ])
  })

  it('reports a ticket listed twice in the same sprint', () => {
    const plan = makeBundle([[1]], [], { sprints: [makeSprint(1, [1, 1])] })
    expect(codes(errorsOf(plan))).toEqual(['ticket_in_multiple_sprints'])
  })

  it('reports sprint entries for unknown tickets', () => {
    const unknown = tid(50)
    const plan = makeBundle([[1]], [], { sprints: [{ ...makeSprint(1, [1]), ticketIds: [tid(1), unknown] }] })
    expect(errorsOf(plan)).toEqual([
      {
        code: 'unknown_ticket_in_sprint',
        message: `Sprint 1 lists unknown ticket ${unknown}.`,
        sprintIds: [sid(1)],
        ticketIds: [unknown]
      }
    ])
  })

  it('does not report tickets listed exactly once in a known sprint', () => {
    expect(errorsOf(makeBundle([[1, 2], [3]]))).toEqual([])
  })
})

describe('validatePlan relations', () => {
  it('accepts relations between known, distinct tickets', () => {
    const plan = cleanBundle()
    plan.relations = [{ kind: 'related_to', from: tid(1), to: tid(3) }]
    expect(errorsOf(plan)).toEqual([])
  })

  it('reports relations to unknown tickets, whichever end is unknown', () => {
    const plan = cleanBundle()
    plan.relations = [
      { kind: 'related_to', from: tid(1), to: tid(77) },
      { kind: 'duplicate_of', from: tid(78), to: tid(1) },
      { kind: 'related_to', from: tid(78), to: tid(77) }
    ]
    expect(errorsOf(plan).map((issue) => issue.message)).toEqual([
      `Relation references unknown ticket ${tid(77)}.`,
      `Relation references unknown ticket ${tid(78)}.`,
      `Relation references unknown ticket ${tid(78)}, ${tid(77)}.`
    ])
    expect(new Set(codes(errorsOf(plan)))).toEqual(new Set(['relation_missing_ticket']))
  })

  it('reports a ticket related to itself', () => {
    const plan = cleanBundle()
    plan.relations = [{ kind: 'duplicate_of', from: tid(2), to: tid(2) }]
    expect(errorsOf(plan)).toEqual([
      { code: 'self_relation', message: "DM-2 can't relate to itself.", ticketIds: [tid(2)] }
    ])
  })
})

describe('validatePlan criterion ids', () => {
  it('accepts the same criterion id in different owners', () => {
    expect(errorsOf(cleanBundle())).toEqual([])
  })

  it('reports repeated epic success criterion ids', () => {
    const plan = cleanBundle()
    plan.epic.successCriteria = [{ id: 's1', text: 'a' }, { id: 's1', text: 'b' }]
    expect(errorsOf(plan)).toEqual([
      { code: 'duplicate_criterion_id', message: 'Epic success criteria reuse criterion id s1.' }
    ])
  })

  it('reports repeated ticket acceptance criterion ids with the ticket', () => {
    const plan = cleanBundle()
    plan.tickets = [makeTicket(1), makeTicket(2, { acceptanceCriteria: [{ id: 'c4', text: 'a' }, { id: 'c4', text: 'b' }] }), makeTicket(3)]
    expect(errorsOf(plan)).toEqual([
      {
        code: 'duplicate_criterion_id',
        message: 'DM-2 acceptance criteria reuse criterion id c4.',
        ticketIds: [tid(2)]
      }
    ])
  })

  it('reports a sprint id reused across entry and exit criteria', () => {
    const plan = cleanBundle()
    plan.sprints = [
      { ...plan.sprints[0], entryCriteria: [{ id: 'n1', text: 'a' }], exitCriteria: [{ id: 'n1', text: 'b' }] } as SprintDef,
      plan.sprints[1] as SprintDef
    ]
    expect(errorsOf(plan)).toEqual([
      { code: 'duplicate_criterion_id', message: 'Sprint 1 criteria reuse criterion id n1.' }
    ])
  })

  it('accepts distinct entry and exit criterion ids', () => {
    const plan = cleanBundle()
    plan.sprints = [
      { ...plan.sprints[0], entryCriteria: [{ id: 'n1', text: 'a' }], exitCriteria: [{ id: 'x1', text: 'b' }] } as SprintDef,
      plan.sprints[1] as SprintDef
    ]
    expect(errorsOf(plan)).toEqual([])
  })
})

describe('validatePlan retry limit and lease policies', () => {
  const RETRY = 'Retry limit must be a whole number of at least 1.'
  const LEASE = 'Lease duration must be at least 30 seconds.'

  it('accepts the default policies and the smallest allowed values', () => {
    expect(errorsOf(cleanBundle())).toEqual([])
    expect(errorsOf(withPolicies({ retryLimit: 1, leaseSeconds: 30 }))).toEqual([])
  })

  it.each([0, -1, 0.5, 1.5, Number.NaN])('rejects a retry limit of %s', (retryLimit) => {
    expect(errorsOf(withPolicies({ retryLimit }))).toEqual([{ code: 'invalid_policy', message: RETRY }])
  })

  it.each([29, 0, -30, 30.5, 45.25, Number.NaN])('rejects a lease of %s seconds', (leaseSeconds) => {
    expect(errorsOf(withPolicies({ leaseSeconds }))).toEqual([{ code: 'invalid_policy', message: LEASE }])
  })

  it('accepts large whole retry limits and leases', () => {
    expect(errorsOf(withPolicies({ retryLimit: 100, leaseSeconds: 86_400 }))).toEqual([])
  })
})

describe('validatePlan concurrency caps', () => {
  const CAPS = 'Concurrency caps must be whole numbers of at least 1.'

  it('accepts unlimited (null) and caps of at least 1', () => {
    expect(errorsOf(withPolicies({ maxConcurrency: null }))).toEqual([])
    expect(errorsOf(withPolicies({ maxConcurrency: 1 }))).toEqual([])
    expect(errorsOf(withPolicies({ maxConcurrency: 8 }))).toEqual([])
    expect(errorsOf(withSprintCap(1))).toEqual([])
    expect(errorsOf(withSprintCap(null))).toEqual([])
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects a plan cap of %s', (maxConcurrency) => {
    expect(errorsOf(withPolicies({ maxConcurrency }))).toEqual([{ code: 'invalid_policy', message: CAPS }])
  })

  it.each([0, -3, 2.5, Number.NaN])('rejects a sprint cap of %s', (cap) => {
    expect(errorsOf(withSprintCap(cap))).toEqual([{ code: 'invalid_policy', message: CAPS }])
  })

  it('reports each violated policy once', () => {
    const plan = withPolicies({ retryLimit: 0, leaseSeconds: 10, maxConcurrency: 0 })
    expect(codes(errorsOf(plan))).toEqual(['invalid_policy', 'invalid_policy', 'invalid_policy'])
    expect(errorsOf({ ...plan, sprints: plan.sprints.map((sprint) => ({ ...sprint, concurrencyCap: 0 })) })).toHaveLength(3)
  })
})

describe('validatePlan isolated ticket warnings', () => {
  it('warns about tickets with no prerequisites and no dependents', () => {
    const plan = makeBundle([[1, 2, 3]], [[1, 2]])
    expect(warningsOf(plan)).toEqual([
      {
        code: 'isolated_ticket',
        message: 'DM-3 has no prerequisites and nothing depends on it. It can start as soon as its sprint opens.',
        ticketIds: [tid(3)]
      }
    ])
  })

  it('warns about every ticket when there are no edges at all', () => {
    const plan = makeBundle([[1, 2]])
    expect(warningsOf(plan).map((warning) => warning.ticketIds)).toEqual([[tid(1)], [tid(2)]])
  })

  it('does not warn about a plan with a single ticket', () => {
    expect(warningsOf(makeBundle([[1]]))).toEqual([])
  })

  it('only flags the empty sprint of a plan without tickets', () => {
    expect(warningsOf(makeBundle([[]]))).toEqual([
      { code: 'empty_sprint', message: 'Sprint 1 has no tickets.', sprintIds: [sid(1)] }
    ])
  })

  it('counts both ends of an edge as linked', () => {
    const plan = makeBundle([[1, 2, 3]], [[1, 2], [3, 2]])
    expect(warningsOf(plan)).toEqual([])
  })

  it('warns as soon as there are two tickets and one is unlinked', () => {
    const plan = makeBundle([[1, 2, 3]], [[1, 2]])
    expect(codes(warningsOf(plan))).toEqual(['isolated_ticket'])
  })
})

describe('validatePlan content warnings', () => {
  it('warns when the epic has no success criteria', () => {
    const plan = cleanBundle()
    plan.epic.successCriteria = []
    expect(warningsOf(plan)).toEqual([
      { code: 'missing_success_criteria', message: 'The epic has no success criteria; completion needs them.' }
    ])
  })

  it('warns about empty sprints', () => {
    const plan = makeBundle([[1, 2], [], [3]], [[1, 2], [2, 3]])
    expect(warningsOf(plan)).toEqual([
      { code: 'empty_sprint', message: 'Sprint 2 has no tickets.', sprintIds: [sid(2)] }
    ])
  })

  it('warns about tickets without acceptance criteria', () => {
    const plan = cleanBundle()
    plan.tickets = [makeTicket(1), makeTicket(2, { acceptanceCriteria: [] }), makeTicket(3)]
    expect(warningsOf(plan)).toEqual([
      { code: 'missing_acceptance_criteria', message: 'DM-2 has no acceptance criteria.', ticketIds: [tid(2)] }
    ])
  })

  it('warns when a required ticket depends on an optional one', () => {
    const plan = cleanBundle()
    plan.tickets = [makeTicket(1, { optional: true }), makeTicket(2), makeTicket(3)]
    expect(warningsOf(plan)).toEqual([
      {
        code: 'required_depends_on_optional',
        message: 'Required ticket DM-2 depends on optional ticket DM-1.',
        ticketIds: [tid(2), tid(1)]
      }
    ])
  })

})

describe('validatePlan optional ticket warnings', () => {
  it.each([
    ['optional depends on optional', true, true],
    ['optional depends on required', false, true],
    ['required depends on required', false, false]
  ])('does not warn when %s', (_label, fromOptional, toOptional) => {
    const plan = makeBundle([[1, 2]], [[1, 2]])
    plan.tickets = [makeTicket(1, { optional: fromOptional }), makeTicket(2, { optional: toOptional })]
    expect(warningsOf(plan)).toEqual([])
  })

  it('never turns warnings into errors', () => {
    const plan = makeBundle([[1, 2], []])
    plan.epic.successCriteria = []
    plan.tickets = [makeTicket(1, { acceptanceCriteria: [] }), makeTicket(2, { optional: true })]
    const report = validatePlan(plan)
    expect(report.errors).toEqual([])
    expect(new Set(codes(report.warnings))).toEqual(
      new Set(['isolated_ticket', 'missing_success_criteria', 'empty_sprint', 'missing_acceptance_criteria'])
    )
  })
})

describe('checkEdgeAddition rejections', () => {
  const plan = (): PlanBundle => makeBundle([[1, 2], [3]], [[1, 2]])

  it('rejects unknown tickets', () => {
    const unknown = tid(90)
    expect(checkEdgeAddition(plan(), { from: unknown, to: tid(1) })).toEqual({
      code: 'edge_missing_ticket',
      message: `Dependency references unknown ticket ${unknown}.`,
      edge: { from: unknown, to: tid(1) }
    })
    expect(checkEdgeAddition(plan(), { from: tid(1), to: unknown })?.code).toBe('edge_missing_ticket')
  })

  it('rejects a self edge', () => {
    expect(checkEdgeAddition(plan(), edge(2, 2))).toEqual({
      code: 'self_edge',
      message: "DM-2 can't depend on itself.",
      ticketIds: [tid(2)],
      edge: edge(2, 2)
    })
  })

  it('rejects an edge that already exists', () => {
    expect(checkEdgeAddition(plan(), edge(1, 2))).toEqual({
      code: 'duplicate_edge',
      message: 'DM-2 already requires DM-1.',
      edge: edge(1, 2)
    })
  })

  it('rejects a prerequisite in a later sprint with the concrete reason', () => {
    expect(checkEdgeAddition(plan(), edge(3, 1))).toEqual({
      code: 'later_sprint_prerequisite',
      message: `DM-1 is in Sprint 1 and can't require DM-3 in Sprint 2. ${LATER_SPRINT_TAIL}`,
      ticketIds: [tid(1), tid(3)],
      edge: edge(3, 1)
    })
  })

  it('rejects an edge that would close a cycle, naming the path', () => {
    const chain = makeBundle([[1, 2, 3]], [[1, 2], [2, 3]])
    expect(checkEdgeAddition(chain, edge(3, 1))).toEqual({
      code: 'cycle',
      message: 'Dependency cycle: DM-1 → DM-2 → DM-3 → DM-1.',
      ticketIds: [tid(1), tid(2), tid(3)]
    })
  })

})

describe('checkEdgeAddition rule precedence', () => {
  it('checks shape first, then duplicates, then sprint order, then cycles', () => {
    const invalid = makeBundle([[1], [2]], [[2, 1]])
    expect(checkEdgeAddition(invalid, edge(2, 1))?.code).toBe('duplicate_edge')
    expect(checkEdgeAddition(invalid, edge(1, 1))?.code).toBe('self_edge')
    const looped = makeBundle([[1, 2, 3], [4]], [[1, 2], [2, 3]])
    expect(checkEdgeAddition(looped, edge(4, 1))?.code).toBe('later_sprint_prerequisite')
  })
})

describe('checkEdgeAddition acceptance', () => {
  const plan = (): PlanBundle => makeBundle([[1, 2], [3]], [[1, 2]])

  it('accepts a prerequisite in the same sprint', () => {
    expect(checkEdgeAddition(makeBundle([[1, 2]]), edge(1, 2))).toBeNull()
  })

  it('accepts a prerequisite in an earlier sprint', () => {
    expect(checkEdgeAddition(plan(), edge(1, 3))).toBeNull()
    expect(checkEdgeAddition(plan(), edge(2, 3))).toBeNull()
  })

  it('does not treat edges that share only one end as duplicates', () => {
    expect(checkEdgeAddition(plan(), edge(1, 3))).toBeNull()
    expect(checkEdgeAddition(plan(), edge(3, 3))?.code).toBe('self_edge')
    const bundle = makeBundle([[1, 2, 3]], [[1, 2]])
    expect(checkEdgeAddition(bundle, edge(3, 2))).toBeNull()
    expect(checkEdgeAddition(bundle, edge(1, 3))).toBeNull()
  })

  it('does not treat the reverse of an existing edge as a duplicate (it is a cycle)', () => {
    expect(checkEdgeAddition(makeBundle([[1, 2]], [[1, 2]]), edge(2, 1))?.code).toBe('cycle')
  })

  it('leaves the bundle unchanged', () => {
    const bundle = plan()
    checkEdgeAddition(bundle, edge(1, 3))
    expect(bundle.edges).toEqual([edge(1, 2)])
  })
})

describe('bundle lookups', () => {
  it('finds prerequisites and dependents in edge order', () => {
    const bundle = makeBundle([[1, 2, 3, 4]], [[1, 3], [2, 3], [3, 4], [1, 4]])
    expect(prerequisitesOf(bundle, tid(3))).toEqual([tid(1), tid(2)])
    expect(prerequisitesOf(bundle, tid(4))).toEqual([tid(3), tid(1)])
    expect(dependentsOf(bundle, tid(1))).toEqual([tid(3), tid(4)])
    expect(dependentsOf(bundle, tid(3))).toEqual([tid(4)])
  })

  it('returns nothing for tickets without edges and for unknown tickets', () => {
    const bundle = makeBundle([[1, 2]], [[1, 2]])
    expect(prerequisitesOf(bundle, tid(1))).toEqual([])
    expect(dependentsOf(bundle, tid(2))).toEqual([])
    expect(prerequisitesOf(bundle, tid(99))).toEqual([])
    expect(dependentsOf(bundle, tid(99))).toEqual([])
  })

  it('sorts sprints by ordinal without touching the bundle', () => {
    const bundle = makeBundle([[1], [2], [3]], [], {
      sprints: [makeSprint(3, [3]), makeSprint(1, [1]), makeSprint(2, [2])]
    })
    expect(sortedSprints(bundle).map((sprint) => sprint.ordinal)).toEqual([1, 2, 3])
    expect(bundle.sprints.map((sprint) => sprint.ordinal)).toEqual([3, 1, 2])
  })
})

describe('bundle index', () => {
  it('indexes tickets and sprints by id', () => {
    const index = indexBundle(makeBundle([[1], [2]]))
    expect([...index.tickets.keys()]).toEqual([tid(1), tid(2)])
    expect(index.tickets.get(tid(2))?.key).toBe('DM-2')
    expect([...index.sprints.keys()]).toEqual([sid(1), sid(2)])
  })

  it('maps each ticket to the first sprint that lists it', () => {
    const bundle = makeBundle([[1], [2]], [], { sprints: [makeSprint(1, [1, 2]), makeSprint(2, [2])] })
    const index = indexBundle(bundle)
    expect(index.sprintOf.get(tid(1))?.ordinal).toBe(1)
    expect(index.sprintOf.get(tid(2))?.ordinal).toBe(1)
    expect(index.sprintOf.get(tid(9))).toBeUndefined()
  })

  it('labels tickets by key and falls back to the raw id', () => {
    const index = indexBundle(makeBundle([[1]]))
    expect(ticketLabel(index, tid(1))).toBe('DM-1')
    expect(ticketLabel(index, 'tk_unknown')).toBe('tk_unknown')
  })
})
