import type { DependencyEdge, PlanBundle, SprintDef, TicketContent } from '../../shared/domain/bundle'
import type { ValidationIssue, ValidationReport } from '../../shared/domain/views'

export interface BundleIndex {
  tickets: Map<string, TicketContent>
  sprints: Map<string, SprintDef>
  /** First sprint that lists each ticket. */
  sprintOf: Map<string, SprintDef>
}

export function indexBundle(bundle: PlanBundle): BundleIndex {
  const tickets = new Map(bundle.tickets.map((ticket) => [ticket.id, ticket]))
  const sprints = new Map(bundle.sprints.map((sprint) => [sprint.id, sprint]))
  const sprintOf = new Map<string, SprintDef>()
  for (const sprint of bundle.sprints) {
    for (const ticketId of sprint.ticketIds) {
      if (!sprintOf.has(ticketId)) {
        sprintOf.set(ticketId, sprint)
      }
    }
  }
  return { tickets, sprints, sprintOf }
}

export function ticketLabel(index: BundleIndex, ticketId: string): string {
  return index.tickets.get(ticketId)?.key ?? ticketId
}

/** Returns one cycle as a closed path (`[a, b, a]`) or null when the graph is acyclic. */
export function findCycle(nodes: string[], edges: DependencyEdge[]): string[] | null {
  const next = new Map<string, string[]>(nodes.map((node) => [node, []]))
  for (const edge of edges) {
    next.get(edge.from)?.push(edge.to)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (node: string): string[] | null => {
    state.set(node, 'visiting')
    stack.push(node)
    for (const target of next.get(node) ?? []) {
      const seen = state.get(target)
      if (seen === 'visiting') {
        return [...stack.slice(stack.indexOf(target)), target]
      }
      const found = seen === undefined ? visit(target) : null
      if (found) {
        return found
      }
    }
    stack.pop()
    state.set(node, 'done')
    return null
  }
  for (const node of nodes) {
    const found = state.has(node) ? null : visit(node)
    if (found) {
      return found
    }
  }
  return null
}

function laterSprintIssue(index: BundleIndex, edge: DependencyEdge): ValidationIssue | null {
  const fromSprint = index.sprintOf.get(edge.from)
  const toSprint = index.sprintOf.get(edge.to)
  if (!fromSprint || !toSprint || fromSprint.ordinal <= toSprint.ordinal) {
    return null
  }
  const to = ticketLabel(index, edge.to)
  const from = ticketLabel(index, edge.from)
  return {
    code: 'later_sprint_prerequisite',
    message: `${to} is in Sprint ${toSprint.ordinal} and can't require ${from} in Sprint ${fromSprint.ordinal}. A prerequisite must be in the same sprint or an earlier one.`,
    ticketIds: [edge.to, edge.from],
    edge: { ...edge }
  }
}

function edgeShapeIssue(index: BundleIndex, edge: DependencyEdge): ValidationIssue | null {
  const missing = [edge.from, edge.to].filter((id) => !index.tickets.has(id))
  if (missing.length > 0) {
    return {
      code: 'edge_missing_ticket',
      message: `Dependency references unknown ticket ${missing.join(', ')}.`,
      edge: { ...edge }
    }
  }
  if (edge.from === edge.to) {
    return {
      code: 'self_edge',
      message: `${ticketLabel(index, edge.from)} can't depend on itself.`,
      ticketIds: [edge.from],
      edge: { ...edge }
    }
  }
  return null
}

function cycleIssue(cycle: string[], index: BundleIndex): ValidationIssue {
  return {
    code: 'cycle',
    message: `Dependency cycle: ${cycle.map((id) => ticketLabel(index, id)).join(' → ')}.`,
    ticketIds: [...new Set(cycle)]
  }
}

/**
 * Checks whether adding `to requires from` keeps the plan valid; returns the concrete
 * rejection reason or null. Used to reject a single edit immediately.
 */
export function checkEdgeAddition(bundle: PlanBundle, edge: DependencyEdge): ValidationIssue | null {
  const index = indexBundle(bundle)
  const shape = edgeShapeIssue(index, edge)
  if (shape) {
    return shape
  }
  if (bundle.edges.some((existing) => existing.from === edge.from && existing.to === edge.to)) {
    return {
      code: 'duplicate_edge',
      message: `${ticketLabel(index, edge.to)} already requires ${ticketLabel(index, edge.from)}.`,
      edge: { ...edge }
    }
  }
  const later = laterSprintIssue(index, edge)
  if (later) {
    return later
  }
  const cycle = findCycle(
    bundle.tickets.map((ticket) => ticket.id),
    [...bundle.edges, edge]
  )
  return cycle ? cycleIssue(cycle, index) : null
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value)
    }
    seen.add(value)
  }
  return [...repeated]
}

function identityIssues(bundle: PlanBundle): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const id of duplicates(bundle.tickets.map((ticket) => ticket.id))) {
    issues.push({ code: 'duplicate_ticket_id', message: `Ticket id ${id} appears more than once.`, ticketIds: [id] })
  }
  for (const id of duplicates(bundle.sprints.map((sprint) => sprint.id))) {
    issues.push({ code: 'duplicate_sprint_id', message: `Sprint id ${id} appears more than once.`, sprintIds: [id] })
  }
  if (bundle.epic.title.trim() === '') {
    issues.push({ code: 'empty_title', message: 'The epic needs a title.' })
  }
  for (const ticket of bundle.tickets.filter((item) => item.title.trim() === '')) {
    issues.push({ code: 'empty_title', message: `Ticket ${ticket.key} needs a title.`, ticketIds: [ticket.id] })
  }
  return issues
}

function ordinalIssues(bundle: PlanBundle): ValidationIssue[] {
  if (bundle.sprints.length === 0) {
    return [{ code: 'no_sprints', message: 'The plan needs at least one sprint.' }]
  }
  const ordinals = bundle.sprints.map((sprint) => sprint.ordinal).sort((a, b) => a - b)
  const contiguous = ordinals.every((ordinal, position) => ordinal === position + 1)
  return contiguous
    ? []
    : [
        {
          code: 'sprint_ordinals',
          message: `Sprint ordinals must run 1..${bundle.sprints.length} without gaps or repeats.`,
          sprintIds: bundle.sprints.map((sprint) => sprint.id)
        }
      ]
}

function membershipIssues(bundle: PlanBundle, index: BundleIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const memberships = bundle.sprints.flatMap((sprint) => sprint.ticketIds)
  for (const id of duplicates(memberships)) {
    issues.push({
      code: 'ticket_in_multiple_sprints',
      message: `${ticketLabel(index, id)} belongs to more than one sprint; a ticket appears once per plan.`,
      ticketIds: [id]
    })
  }
  for (const sprint of bundle.sprints) {
    for (const id of sprint.ticketIds.filter((ticketId) => !index.tickets.has(ticketId))) {
      issues.push({
        code: 'unknown_ticket_in_sprint',
        message: `Sprint ${sprint.ordinal} lists unknown ticket ${id}.`,
        sprintIds: [sprint.id],
        ticketIds: [id]
      })
    }
  }
  for (const ticket of bundle.tickets.filter((item) => !index.sprintOf.has(item.id))) {
    issues.push({
      code: 'ticket_not_in_sprint',
      message: `${ticket.key} is not assigned to a sprint.`,
      ticketIds: [ticket.id]
    })
  }
  return issues
}

function edgeIssues(bundle: PlanBundle, index: BundleIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const seen = new Set<string>()
  for (const edge of bundle.edges) {
    const key = `${edge.from}->${edge.to}`
    const issue =
      edgeShapeIssue(index, edge) ??
      (seen.has(key)
        ? { code: 'duplicate_edge', message: `${ticketLabel(index, edge.to)} requires ${ticketLabel(index, edge.from)} twice.`, edge: { ...edge } }
        : laterSprintIssue(index, edge))
    seen.add(key)
    if (issue) {
      issues.push(issue)
    }
  }
  const validEdges = bundle.edges.filter((edge) => edgeShapeIssue(index, edge) === null)
  const cycle = findCycle([...index.tickets.keys()], validEdges)
  if (cycle) {
    issues.push(cycleIssue(cycle, index))
  }
  return issues
}

function relationIssues(bundle: PlanBundle, index: BundleIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const relation of bundle.relations) {
    const missing = [relation.from, relation.to].filter((id) => !index.tickets.has(id))
    if (missing.length > 0) {
      issues.push({ code: 'relation_missing_ticket', message: `Relation references unknown ticket ${missing.join(', ')}.` })
    } else if (relation.from === relation.to) {
      issues.push({ code: 'self_relation', message: `${ticketLabel(index, relation.from)} can't relate to itself.`, ticketIds: [relation.from] })
    }
  }
  return issues
}

function criterionIssues(bundle: PlanBundle): ValidationIssue[] {
  const owners: { label: string; ids: string[]; ticketIds?: string[] }[] = [
    { label: 'Epic success criteria', ids: bundle.epic.successCriteria.map((item) => item.id) },
    ...bundle.tickets.map((ticket) => ({
      label: `${ticket.key} acceptance criteria`,
      ids: ticket.acceptanceCriteria.map((item) => item.id),
      ticketIds: [ticket.id]
    })),
    ...bundle.sprints.map((sprint) => ({
      label: `Sprint ${sprint.ordinal} criteria`,
      ids: [...sprint.entryCriteria, ...sprint.exitCriteria].map((item) => item.id)
    }))
  ]
  return owners.flatMap((owner) =>
    duplicates(owner.ids).map((id) => ({
      code: 'duplicate_criterion_id',
      message: `${owner.label} reuse criterion id ${id}.`,
      ...(owner.ticketIds ? { ticketIds: owner.ticketIds } : {})
    }))
  )
}

function policyIssues(bundle: PlanBundle): ValidationIssue[] {
  const { policies } = bundle
  const issues: ValidationIssue[] = []
  if (!Number.isInteger(policies.retryLimit) || policies.retryLimit < 1) {
    issues.push({ code: 'invalid_policy', message: 'Retry limit must be a whole number of at least 1.' })
  }
  if (!Number.isInteger(policies.leaseSeconds) || policies.leaseSeconds < 30) {
    issues.push({ code: 'invalid_policy', message: 'Lease duration must be at least 30 seconds.' })
  }
  const caps = [policies.maxConcurrency, ...bundle.sprints.map((sprint) => sprint.concurrencyCap)]
  if (caps.some((cap) => cap !== null && (!Number.isInteger(cap) || cap < 1))) {
    issues.push({ code: 'invalid_policy', message: 'Concurrency caps must be whole numbers of at least 1.' })
  }
  return issues
}

function isolationWarnings(bundle: PlanBundle): ValidationIssue[] {
  if (bundle.tickets.length < 2) {
    return []
  }
  const linked = new Set(bundle.edges.flatMap((edge) => [edge.from, edge.to]))
  return bundle.tickets
    .filter((ticket) => !linked.has(ticket.id))
    .map((ticket) => ({
      code: 'isolated_ticket',
      message: `${ticket.key} has no prerequisites and nothing depends on it. It can start as soon as its sprint opens.`,
      ticketIds: [ticket.id]
    }))
}

function contentWarnings(bundle: PlanBundle, index: BundleIndex): ValidationIssue[] {
  const warnings: ValidationIssue[] = []
  if (bundle.epic.successCriteria.length === 0) {
    warnings.push({ code: 'missing_success_criteria', message: 'The epic has no success criteria; completion needs them.' })
  }
  for (const sprint of bundle.sprints.filter((item) => item.ticketIds.length === 0)) {
    warnings.push({ code: 'empty_sprint', message: `Sprint ${sprint.ordinal} has no tickets.`, sprintIds: [sprint.id] })
  }
  for (const ticket of bundle.tickets.filter((item) => item.acceptanceCriteria.length === 0)) {
    warnings.push({ code: 'missing_acceptance_criteria', message: `${ticket.key} has no acceptance criteria.`, ticketIds: [ticket.id] })
  }
  for (const edge of bundle.edges) {
    const from = index.tickets.get(edge.from)
    const to = index.tickets.get(edge.to)
    if (from?.optional === true && to?.optional === false) {
      warnings.push({
        code: 'required_depends_on_optional',
        message: `Required ticket ${to.key} depends on optional ticket ${from.key}.`,
        ticketIds: [to.id, from.id]
      })
    }
  }
  return warnings
}

/** Validates the whole plan as a DAG with sprint ordering; errors block Save, warnings do not. */
export function validatePlan(bundle: PlanBundle): ValidationReport {
  const index = indexBundle(bundle)
  const errors = [
    ...identityIssues(bundle),
    ...ordinalIssues(bundle),
    ...membershipIssues(bundle, index),
    ...edgeIssues(bundle, index),
    ...relationIssues(bundle, index),
    ...criterionIssues(bundle),
    ...policyIssues(bundle)
  ]
  const warnings = [...isolationWarnings(bundle), ...contentWarnings(bundle, index)]
  return { valid: errors.length === 0, errors, warnings }
}

export function prerequisitesOf(bundle: PlanBundle, ticketId: string): string[] {
  return bundle.edges.filter((edge) => edge.to === ticketId).map((edge) => edge.from)
}

export function dependentsOf(bundle: PlanBundle, ticketId: string): string[] {
  return bundle.edges.filter((edge) => edge.from === ticketId).map((edge) => edge.to)
}

export function sortedSprints(bundle: PlanBundle): SprintDef[] {
  return [...bundle.sprints].sort((a, b) => a.ordinal - b.ordinal)
}
