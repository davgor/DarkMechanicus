/**
 * What a sprint report vouches for: the sprint's exit criteria and its required tickets, as the plan revision the
 * run executed when the report was written had them. A later revision may move the retro's leftovers out of the
 * sprint, together with the tickets that require them (which is what redrafting the next sprint does); anything
 * else that changes the exit criteria or the required tickets leaves the report describing a different sprint.
 * Pure: two bundles in, phrases out.
 */
import type { PlanBundle, SprintDef } from '../../shared/domain/bundle'
import { canonicalJson } from '../canonical'

interface ScopeInput {
  /** The revision the report was written for. */
  before: PlanBundle
  /** The revision the run executes now. */
  after: PlanBundle
  sprintId: string
  /** Tickets the report's retro names as leftovers. */
  leftovers: readonly string[]
}

function sprintOf(bundle: PlanBundle, sprintId: string): SprintDef | undefined {
  return bundle.sprints.find((sprint) => sprint.id === sprintId)
}

/** The sprint's required (not optional) tickets, in sprint order. */
function requiredTickets(bundle: PlanBundle, sprintId: string): string[] {
  const optional = new Set(bundle.tickets.filter((ticket) => ticket.optional).map((ticket) => ticket.id))
  return (sprintOf(bundle, sprintId)?.ticketIds ?? []).filter((id) => !optional.has(id))
}

/**
 * The removed tickets that removing leftovers accounts for: each leftover that left, and each ticket that left
 * and requires one of those, directly or through others that left.
 */
function leftoverClosure(before: PlanBundle, removed: readonly string[], leftovers: readonly string[]): Set<string> {
  const gone = new Set(removed)
  const closure = new Set(leftovers.filter((id) => gone.has(id)))
  let grew = closure.size > 0
  while (grew) {
    const pulled = before.edges.filter((edge) => closure.has(edge.from) && gone.has(edge.to) && !closure.has(edge.to))
    pulled.forEach((edge) => closure.add(edge.to))
    grew = pulled.length > 0
  }
  return closure
}

function keysOf(bundle: PlanBundle, ids: string[]): string {
  const keys = new Map(bundle.tickets.map((ticket) => [ticket.id, ticket.key]))
  return ids.map((id) => keys.get(id) ?? id).join(', ')
}

/**
 * How `after` changed the sprint beyond removing leftovers, as phrases about the sprint ("its exit criteria
 * changed", "it now requires DM-5", "it no longer requires DM-1"); empty when the report still describes it.
 */
export function sprintScopeChanges(input: ScopeInput): string[] {
  const { before, after, sprintId } = input
  const exitBefore = sprintOf(before, sprintId)?.exitCriteria ?? []
  const exitAfter = sprintOf(after, sprintId)?.exitCriteria ?? []
  const requiredBefore = requiredTickets(before, sprintId)
  const requiredAfter = requiredTickets(after, sprintId)
  const added = requiredAfter.filter((id) => !requiredBefore.includes(id))
  const removed = requiredBefore.filter((id) => !requiredAfter.includes(id))
  const allowed = leftoverClosure(before, removed, input.leftovers)
  const unexplained = removed.filter((id) => !allowed.has(id))
  return [
    ...(canonicalJson(exitBefore) === canonicalJson(exitAfter) ? [] : ['its exit criteria changed']),
    ...(added.length === 0 ? [] : [`it now requires ${keysOf(after, added)}`]),
    ...(unexplained.length === 0 ? [] : [`it no longer requires ${keysOf(before, unexplained)}`])
  ]
}
