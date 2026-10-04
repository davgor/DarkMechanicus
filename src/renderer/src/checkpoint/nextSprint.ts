/**
 * What it takes to put a checkpoint item into the draft's next sprint, as draft ops. A retro discovery
 * becomes a ticket there; a retro leftover moves there with the tickets of its sprint that require it (a
 * prerequisite must be in the same sprint or an earlier one), after dropping what its sprint's acceptance
 * node explicitly required of it. When the checkpoint's sprint is the last, a sprint is added to hold them.
 * An item the draft already holds yields no ops, with the sprint it is in.
 */
import type { DraftOp } from '../../../shared/domain/api'
import type { DependencyEdge, PlanBundle, SprintDef, TicketContent } from '../../../shared/domain/bundle'
import { acceptanceNodesOf, isAcceptanceTicket } from '../../../core/plan/acceptance'

/** New work found during the sprint: it becomes a ticket of the next sprint. */
export interface DiscoveryItem {
  kind: 'discovery'
  title: string
  body: string
}

/** Required work left over: the ticket moves to the next sprint. */
export interface LeftoverItem {
  kind: 'leftover'
  ticketId: string
}

export interface NextSprintPlan {
  /** What to apply to the draft, in order; empty when the draft already holds the item. */
  ops: DraftOp[]
  /** The sprint the item goes to, or is already in. */
  sprintOrdinal: number
  /** Display keys of the tickets that move, the leftover first; empty for a new ticket. */
  moved: string[]
}

/** Where items go: the sprint after the checkpoint, or the sprint added for them. */
interface Destination {
  /** The sprint's id, or the client ref of the sprint the ops add. */
  ref: string
  ordinal: number
  /** The ops that add the sprint; none for a sprint the draft has. */
  setup: DraftOp[]
  /** Where a ticket lands by default: ahead of the sprint's acceptance node, else at the end. */
  front: number
}

const NEW_SPRINT_REF = 'next'

function destinationOf(draft: PlanBundle, checkpointOrdinal: number): Destination {
  const existing = draft.sprints.find((item) => item.ordinal === checkpointOrdinal + 1)
  if (existing === undefined) {
    const goal = `Finish what Sprint ${checkpointOrdinal} left over and take up what it found.`
    const setup: DraftOp = { op: 'add_sprint', ref: NEW_SPRINT_REF, sprint: { goal }, position: checkpointOrdinal + 1 }
    return { ref: NEW_SPRINT_REF, ordinal: checkpointOrdinal + 1, setup: [setup], front: 0 }
  }
  const nodes = new Set(acceptanceNodesOf(draft, existing.id).map((node) => node.id))
  const first = existing.ticketIds.findIndex((id) => nodes.has(id))
  return { ref: existing.id, ordinal: existing.ordinal, setup: [], front: first === -1 ? existing.ticketIds.length : first }
}

function sprintOf(draft: PlanBundle, ticketId: string): SprintDef | undefined {
  return draft.sprints.find((item) => item.ticketIds.includes(ticketId))
}

function foldedTitle(title: string): string {
  return title.trim().toLowerCase()
}

/** The first work ticket of the draft that has this title, compared without case or edge spaces. */
function holderOf(draft: PlanBundle, title: string): TicketContent | undefined {
  return draft.tickets.find((ticket) => !isAcceptanceTicket(ticket) && foldedTitle(ticket.title) === foldedTitle(title))
}

function planDiscovery(item: DiscoveryItem, draft: PlanBundle, dest: Destination): NextSprintPlan {
  const holder = holderOf(draft, item.title)
  if (holder !== undefined) {
    return { ops: [], moved: [], sprintOrdinal: sprintOf(draft, holder.id)?.ordinal ?? dest.ordinal }
  }
  const ticket = { title: item.title.trim(), body: item.body }
  return { ops: [...dest.setup, { op: 'add_ticket', sprint: dest.ref, ticket }], moved: [], sprintOrdinal: dest.ordinal }
}

/** The first work ticket of the sprint, not moving yet, that requires a moving ticket. */
function nextDependent(draft: PlanBundle, source: SprintDef, moving: ReadonlySet<string>): string | null {
  const found = source.ticketIds.find((id) => {
    const ticket = draft.tickets.find((item) => item.id === id)
    const requires = draft.edges.some((edge) => edge.to === id && moving.has(edge.from))
    return ticket !== undefined && !isAcceptanceTicket(ticket) && !moving.has(id) && requires
  })
  return found ?? null
}

/** The leftover and everything in its sprint that requires it, directly or not, in sprint order. */
function movingGroup(draft: PlanBundle, source: SprintDef | undefined, leftover: string): string[] {
  if (source === undefined) {
    return [leftover]
  }
  const moving = new Set([leftover])
  for (let next = nextDependent(draft, source, moving); next !== null; next = nextDependent(draft, source, moving)) {
    moving.add(next)
  }
  return source.ticketIds.filter((id) => moving.has(id))
}

/**
 * The group in the order it must move: a ticket after everything in the group that requires it, so no move
 * leaves a prerequisite behind. Of those free to go, the later in sprint order goes first, since each move
 * lands ahead of the ones before it and the group keeps its sprint order.
 */
function dependentsFirst(edges: DependencyEdge[], group: string[]): string[] {
  const remaining = [...group]
  const ordered: string[] = []
  while (remaining.length > 0) {
    const free = remaining.filter((id) => !edges.some((edge) => edge.from === id && remaining.includes(edge.to)))
    // A plan without cycles always has a free ticket; take the last in order rather than loop on a broken one.
    const pick = free.at(-1) ?? remaining[remaining.length - 1] ?? ''
    ordered.push(pick)
    remaining.splice(remaining.indexOf(pick), 1)
  }
  return ordered
}

/** Drops what the sprint's acceptance nodes explicitly required of the moving tickets: they require every work ticket of their sprint anyway. */
function dropOps(draft: PlanBundle, source: SprintDef | undefined, group: string[]): DraftOp[] {
  const nodes = new Set(source === undefined ? [] : acceptanceNodesOf(draft, source.id).map((node) => node.id))
  return draft.edges
    .filter((edge) => group.includes(edge.from) && nodes.has(edge.to))
    .map((edge): DraftOp => ({ op: 'remove_dependency', from: edge.from, to: edge.to }))
}

function moveOps(draft: PlanBundle, group: string[], dest: Destination): DraftOp[] {
  return dependentsFirst(draft.edges, group).map(
    (ticket, index): DraftOp =>
      index === 0
        ? { op: 'move_ticket', ticket, toSprint: dest.ref }
        : { op: 'move_ticket', ticket, toSprint: dest.ref, position: dest.front }
  )
}

function keyOf(draft: PlanBundle, ticketId: string): string {
  return draft.tickets.find((item) => item.id === ticketId)?.key ?? ticketId
}

function planLeftover(item: LeftoverItem, draft: PlanBundle, dest: Destination): NextSprintPlan | null {
  const ticket = draft.tickets.find((entry) => entry.id === item.ticketId)
  if (ticket === undefined || isAcceptanceTicket(ticket)) {
    return null
  }
  const source = sprintOf(draft, ticket.id)
  if (source !== undefined && source.ordinal >= dest.ordinal) {
    return { ops: [], moved: [], sprintOrdinal: source.ordinal }
  }
  const group = movingGroup(draft, source, ticket.id)
  const along = group.filter((id) => id !== ticket.id)
  return {
    ops: [...dest.setup, ...dropOps(draft, source, group), ...moveOps(draft, group, dest)],
    moved: [ticket.key, ...along.map((id) => keyOf(draft, id))],
    sprintOrdinal: dest.ordinal
  }
}

/** The plan for a retro discovery or leftover; null when the draft has no sprints, or no such movable ticket. */
export function nextSprintPlan(item: DiscoveryItem | LeftoverItem, draft: PlanBundle, checkpointOrdinal: number): NextSprintPlan | null {
  if (draft.sprints.length === 0) {
    return null
  }
  const dest = destinationOf(draft, checkpointOrdinal)
  return item.kind === 'discovery' ? planDiscovery(item, draft, dest) : planLeftover(item, draft, dest)
}

/** The sprint the draft already holds the item in, so there is nothing to do; null while it still has to be added or moved. */
export function placedIn(item: DiscoveryItem | LeftoverItem, draft: PlanBundle, checkpointOrdinal: number): number | null {
  const plan = nextSprintPlan(item, draft, checkpointOrdinal)
  return plan !== null && plan.ops.length === 0 ? plan.sprintOrdinal : null
}
