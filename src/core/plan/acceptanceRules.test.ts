/** Validation rules for sprint acceptance nodes: one per sprint, coverage, and the dependency rules. */
import { describe, expect, it } from 'vitest'
import type { DependencyEdge, PlanBundle, TicketContent } from '../../shared/domain/bundle'
import type { ValidationIssue } from '../../shared/domain/views'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { checkEdgeAddition, validatePlan } from './graph'

function edge(from: number, to: number): DependencyEdge {
  return { from: tid(from), to: tid(to) }
}

function errorsOf(bundle: PlanBundle): ValidationIssue[] {
  return validatePlan(bundle).errors
}

function codes(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => issue.code)
}

/** The warning a sprint of work tickets without an acceptance node gets. */
function missingNode(ordinal: number): ValidationIssue {
  return {
    code: 'missing_acceptance_node',
    message: `Sprint ${ordinal} has work tickets but no acceptance node.`,
    sprintIds: [sid(ordinal)]
  }
}

/** Sprint 1: work 1 and 2, acceptance 3 covering both. Sprint 2: work 4, acceptance 5 covering it. */
function acceptancePlan(): PlanBundle {
  const plan = makeBundle([[1, 2, 3], [4, 5]])
  plan.tickets = [
    makeTicket(1),
    makeTicket(2),
    makeTicket(3, {
      kind: 'acceptance',
      acceptanceCriteria: [
        { id: 'c1', text: 'DM-1 verified', covers: tid(1) },
        { id: 'c2', text: 'DM-2 verified', covers: tid(2) }
      ]
    }),
    makeTicket(4),
    makeTicket(5, { kind: 'acceptance', acceptanceCriteria: [{ id: 'c1', text: 'DM-4 verified', covers: tid(4) }] })
  ]
  return plan
}

/** `acceptancePlan` with ticket `n` replaced by the given overrides. */
function acceptancePlanWith(n: number, overrides: Partial<TicketContent>): PlanBundle {
  const plan = acceptancePlan()
  plan.tickets = plan.tickets.map((ticket) => (ticket.id === tid(n) ? { ...ticket, ...overrides } : ticket))
  return plan
}

describe('validatePlan acceptance nodes', () => {
  it('accepts a plan whose sprints each have a node that covers every required work ticket', () => {
    expect(validatePlan(acceptancePlan())).toEqual({ valid: true, errors: [], warnings: [] })
  })

  it('reports a second acceptance node in a sprint as an error naming both nodes', () => {
    const report = validatePlan(acceptancePlanWith(2, { kind: 'acceptance' }))
    expect(report.valid).toBe(false)
    expect(report.errors).toEqual([
      {
        code: 'duplicate_acceptance',
        message: 'Sprint 1 has more than one acceptance node (DM-2, DM-3); a sprint has one.',
        sprintIds: [sid(1)],
        ticketIds: [tid(2), tid(3)]
      }
    ])
  })

  it('reports each sprint that has too many nodes, and none that has one', () => {
    const plan = acceptancePlan()
    plan.tickets = plan.tickets.map((ticket) =>
      ticket.id === tid(1) || ticket.id === tid(4) ? { ...ticket, kind: 'acceptance' as const } : ticket
    )
    expect(errorsOf(plan).map((issue) => issue.sprintIds)).toEqual([[sid(1)], [sid(2)]])
    expect(errorsOf(acceptancePlan())).toEqual([])
  })

  it('warns about a sprint with work tickets and no node, without erroring', () => {
    const plan = acceptancePlan()
    plan.tickets = plan.tickets.filter((ticket) => ticket.id !== tid(5))
    plan.sprints[1].ticketIds = [tid(4)]
    const report = validatePlan(plan)
    expect(report.valid).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings.filter((issue) => issue.code === 'missing_acceptance_node')).toEqual([missingNode(2)])
  })

})

describe('validatePlan sprints with and without acceptance nodes', () => {
  it('does not warn about a missing node for a sprint that holds only its node, but still calls it empty', () => {
    const plan = makeBundle([[1]])
    plan.tickets = [makeTicket(1, { kind: 'acceptance' })]
    expect(validatePlan(plan).warnings).toEqual([
      { code: 'empty_sprint', message: 'Sprint 1 has no tickets.', sprintIds: [sid(1)] }
    ])
  })

  it('gives a sprint with no tickets at all only the empty-sprint warning', () => {
    expect(codes(validatePlan(makeBundle([[]])).warnings)).toEqual(['empty_sprint'])
  })

  it('treats a node as linked, and the required work tickets of its sprint with it', () => {
    expect(codes(validatePlan(acceptancePlan()).warnings)).not.toContain('isolated_ticket')
  })

  it('still reports an optional work ticket with no links as isolated', () => {
    const report = validatePlan(acceptancePlanWith(1, { optional: true }))
    expect(report.warnings.filter((issue) => issue.code === 'isolated_ticket').map((issue) => issue.ticketIds)).toEqual([
      [tid(1)]
    ])
  })
})

describe('validatePlan acceptance coverage', () => {
  it('warns for each required work ticket no criterion covers, naming the ticket and the node', () => {
    const plan = acceptancePlanWith(3, { acceptanceCriteria: [{ id: 'c1', text: 'DM-1 verified', covers: tid(1) }] })
    expect(validatePlan(plan).warnings).toEqual([
      {
        code: 'ticket_not_covered',
        message: "DM-2 isn't covered by any criterion of acceptance node DM-3.",
        sprintIds: [sid(1)],
        ticketIds: [tid(2), tid(3)]
      }
    ])
  })

  it('warns once per uncovered ticket when the node covers nothing', () => {
    const plan = acceptancePlanWith(3, { acceptanceCriteria: [{ id: 'c1', text: 'Everything works' }] })
    const warnings = validatePlan(plan).warnings
    expect(codes(warnings)).toEqual(['ticket_not_covered', 'ticket_not_covered'])
    expect(warnings.map((issue) => issue.ticketIds?.[0])).toEqual([tid(1), tid(2)])
  })

  it('does not ask for coverage of an optional work ticket', () => {
    const plan = acceptancePlanWith(3, { acceptanceCriteria: [{ id: 'c1', text: 'DM-1 verified', covers: tid(1) }] })
    plan.tickets = plan.tickets.map((ticket) => (ticket.id === tid(2) ? { ...ticket, optional: true } : ticket))
    expect(codes(validatePlan(plan).warnings)).not.toContain('ticket_not_covered')
  })

  it('counts several criteria covering one ticket as coverage', () => {
    const plan = acceptancePlanWith(3, {
      acceptanceCriteria: [
        { id: 'c1', text: 'DM-1 builds', covers: tid(1) },
        { id: 'c2', text: 'DM-1 is documented', covers: tid(1) },
        { id: 'c3', text: 'DM-2 verified', covers: tid(2) }
      ]
    })
    expect(validatePlan(plan).warnings).toEqual([])
  })

})

describe('validatePlan acceptance coverage of a sprint without a node and of unknown tickets', () => {
  it('leaves coverage out of a sprint with no node: only the missing-node warning is given', () => {
    const plan = acceptancePlan()
    plan.tickets = plan.tickets.filter((ticket) => ticket.id !== tid(3))
    plan.sprints[0].ticketIds = [tid(1), tid(2)]
    const warnings = validatePlan(plan).warnings
    expect(warnings).toContainEqual(missingNode(1))
    expect(codes(warnings)).not.toContain('ticket_not_covered')
  })

  it('reports a criterion that covers an unknown ticket as an error', () => {
    const plan = acceptancePlanWith(3, {
      acceptanceCriteria: [
        { id: 'c1', text: 'DM-1 verified', covers: tid(1) },
        { id: 'c2', text: 'DM-2 verified', covers: tid(2) },
        { id: 'c3', text: 'Gone', covers: 'tk_gone' }
      ]
    })
    const report = validatePlan(plan)
    expect(report.valid).toBe(false)
    expect(report.errors).toEqual([
      {
        code: 'unknown_covered_ticket',
        message: 'DM-3 criterion c3 covers unknown ticket tk_gone.',
        ticketIds: [tid(3)]
      }
    ])
  })

})

describe('validatePlan covers that point outside the node sprint or sit on work tickets', () => {
  it('warns when a criterion covers a ticket that is not a work ticket of the node sprint', () => {
    const plan = acceptancePlanWith(5, {
      acceptanceCriteria: [
        { id: 'c1', text: 'DM-4 verified', covers: tid(4) },
        { id: 'c2', text: 'Back', covers: tid(1) }
      ]
    })
    expect(validatePlan(plan).warnings).toEqual([
      {
        code: 'covers_outside_sprint',
        message: 'DM-5 criterion c2 covers DM-1, which is not a work ticket of Sprint 2.',
        sprintIds: [sid(2)],
        ticketIds: [tid(5), tid(1)]
      }
    ])
  })

  it('warns when a criterion covers its own node', () => {
    const plan = acceptancePlanWith(3, {
      acceptanceCriteria: [
        { id: 'c1', text: 'DM-1 verified', covers: tid(1) },
        { id: 'c2', text: 'DM-2 verified', covers: tid(2) },
        { id: 'c3', text: 'Itself', covers: tid(3) }
      ]
    })
    expect(codes(validatePlan(plan).warnings)).toEqual(['covers_outside_sprint'])
  })

  it('warns that covers has no effect on a work ticket criterion', () => {
    const plan = acceptancePlanWith(1, { acceptanceCriteria: [{ id: 'c1', text: 'Works', covers: tid(2) }] })
    expect(validatePlan(plan).warnings).toEqual([
      {
        code: 'covers_on_work_ticket',
        message: "DM-1 criterion c1 names a covered ticket, but only an acceptance node's criteria cover tickets.",
        ticketIds: [tid(1)]
      }
    ])
  })
})

const withEdge = (from: number, to: number, base: PlanBundle = acceptancePlan()): PlanBundle => ({
  ...base,
  edges: [edge(from, to)]
})

const withOptional = (n: number, base: PlanBundle): PlanBundle => ({
  ...base,
  tickets: base.tickets.map((ticket) => (ticket.id === tid(n) ? { ...ticket, optional: true } : ticket))
})

describe('validatePlan acceptance dependencies', () => {
  it('rejects an edge out of a node to a ticket of its own sprint', () => {
    const report = validatePlan(withEdge(3, 2))
    expect(report.valid).toBe(false)
    expect(report.errors).toEqual([
      {
        code: 'acceptance_runs_last',
        message:
          "DM-2 can't require DM-3: DM-3 is the acceptance node of Sprint 1 and runs after every other required ticket in it.",
        ticketIds: [tid(2), tid(3)],
        edge: edge(3, 2)
      }
    ])
  })

  it('rejects an edge out of a node to an optional ticket of its own sprint', () => {
    expect(codes(errorsOf(withOptional(2, withEdge(3, 2))))).toEqual(['acceptance_runs_last'])
  })

  it('lets a later sprint depend on a node', () => {
    const report = validatePlan(withEdge(3, 4))
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('lets a node depend on a ticket of an earlier sprint without a warning', () => {
    const report = validatePlan(withEdge(1, 5))
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

})

describe('validatePlan redundant dependencies into an acceptance node', () => {
  it('warns that an edge into a node from a required ticket of its sprint is redundant', () => {
    const report = validatePlan(withEdge(1, 3))
    expect(report.valid).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([
      {
        code: 'redundant_acceptance_edge',
        message: 'DM-3 is an acceptance node and already requires DM-1; the explicit dependency is redundant.',
        ticketIds: [tid(3), tid(1)],
        edge: edge(1, 3)
      }
    ])
  })

  it('does not call an edge into a node from an optional ticket of its sprint redundant', () => {
    const report = validatePlan(withOptional(1, withEdge(1, 3)))
    expect(codes(report.warnings)).not.toContain('redundant_acceptance_edge')
  })

  it('does not call an ordinary same-sprint edge redundant', () => {
    expect(validatePlan(withEdge(1, 2)).warnings).toEqual([])
  })

  it('still reports the sprint order error for an edge out of a node to an earlier sprint', () => {
    expect(codes(errorsOf(withEdge(5, 1)))).toEqual(['later_sprint_prerequisite'])
  })
})

describe('checkEdgeAddition acceptance rules', () => {
  const plan = acceptancePlan()

  it('rejects an edge out of a node to a ticket of its own sprint with the validation issue', () => {
    const rejected = checkEdgeAddition(plan, edge(3, 2))
    expect(rejected?.code).toBe('acceptance_runs_last')
    expect(rejected).toEqual(errorsOf({ ...plan, edges: [edge(3, 2)] })[0])
  })

  it('allows an edge out of a node to a later sprint', () => {
    expect(checkEdgeAddition(plan, edge(3, 4))).toBeNull()
  })

  it('allows an edge into a node, redundant or not', () => {
    expect(checkEdgeAddition(plan, edge(1, 3))).toBeNull()
    expect(checkEdgeAddition(plan, edge(1, 5))).toBeNull()
  })
})
