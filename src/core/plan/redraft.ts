/**
 * Redrafting the next sprint from a retro. The leftovers of the active sprint move to the sprint after it,
 * ahead of that sprint's acceptance node, and take with them the tickets of the active sprint that require
 * them, so every prerequisite stays in the same sprint or an earlier one. Each discovery becomes an unsized
 * ticket there, pointing at the ticket it came up on. A sprint is added after the active one when it is the
 * last. Pure: a bundle in, a changed copy and a change list out.
 *
 * It is safe to run twice over the same retro: a leftover already in the next sprint and a discovery whose
 * title a ticket already has are skipped, so the second pass changes nothing.
 */
import type { DraftOp } from '../../shared/domain/api'
import type { DependencyEdge, PlanBundle, SprintDef, TicketContent, TicketReference } from '../../shared/domain/bundle'
import type { RetroDiscovery, RetroLeftover } from '../../shared/domain/retro'
import type {
  RedraftAddedView,
  RedraftChangesView,
  RedraftDependentView,
  RedraftMovedView,
  RedraftSkippedView,
  RedraftSkipCode
} from '../../shared/domain/views'
import { fail } from '../errors'
import { acceptanceNodesOf, isAcceptanceTicket } from './acceptance'
import { applyDraftOps, type DraftDeps } from './draftOps'
import { sortedSprints } from './graph'
import { cloneBundle } from './normalize'

interface RedraftRequest {
  /** The sprint the retro belongs to: the run's active sprint, which the leftovers leave. */
  sprintId: string
  leftovers: RetroLeftover[]
  discoveries: RetroDiscovery[]
  /** Tickets the run holds a standing accepted attempt for: they are not leftovers any more. */
  accepted: ReadonlySet<string>
  /** Display key of each ticket the retro names, for a ticket the draft may no longer hold. */
  keys: ReadonlyMap<string, string>
}

export interface RedraftOutcome {
  bundle: PlanBundle
  changes: RedraftChangesView
  /** False when nothing moved and nothing was added, so the draft is as it was. */
  changed: boolean
}

interface Skip {
  code: RedraftSkipCode
  message: string
}

interface Placement {
  active: SprintDef
  /** The sprint after the active one, when the draft has one. */
  next: SprintDef | null
}

interface LeftoverPlan {
  moving: RetroLeftover[]
  skipped: RedraftSkippedView[]
}

interface NewTicket {
  title: string
  body: string
  /** Display key of the ticket the discovery came up on. */
  source: string | null
}

interface DiscoveryPlan {
  adding: NewTicket[]
  skipped: RedraftSkippedView[]
}

interface MovePlan {
  /** Everything that moves, in the order of the sprint it leaves. */
  ids: string[]
  dependents: RedraftDependentView[]
  dropped: DependencyEdge[]
}

function keyOf(bundle: PlanBundle, request: RedraftRequest, ticketId: string): string {
  return bundle.tickets.find((ticket) => ticket.id === ticketId)?.key ?? request.keys.get(ticketId) ?? ticketId
}

function sprintOfTicket(bundle: PlanBundle, ticketId: string): SprintDef | undefined {
  return bundle.sprints.find((sprint) => sprint.ticketIds.includes(ticketId))
}

// ---------------------------------------------------------------------------------------------
// Leftovers

interface LeftoverFacts {
  ticket: TicketContent | undefined
  label: string
  placement: Placement
  /** The sprint that lists the ticket. */
  sprint: SprintDef | undefined
  accepted: boolean
}

type LeftoverCheck = (facts: LeftoverFacts) => Skip | null

/** The checks a leftover passes before it moves, in order: the first that fails is why it is skipped. */
const LEFTOVER_CHECKS: LeftoverCheck[] = [
  (facts) =>
    facts.ticket === undefined
      ? { code: 'not_in_draft', message: `${facts.label} is not in the draft any more.` }
      : null,
  (facts) =>
    facts.ticket !== undefined && isAcceptanceTicket(facts.ticket)
      ? { code: 'acceptance_node', message: `${facts.label} is an acceptance node and never moves to another sprint.` }
      : null,
  (facts) =>
    facts.accepted
      ? { code: 'already_accepted', message: `${facts.label} has been accepted in this run since the retro was written.` }
      : null,
  (facts) =>
    facts.placement.next !== null && facts.sprint?.id === facts.placement.next.id
      ? { code: 'already_in_next_sprint', message: `${facts.label} is already in Sprint ${facts.placement.next.ordinal}.` }
      : null,
  (facts) =>
    facts.sprint?.id === facts.placement.active.id
      ? null
      : {
          code: 'not_in_active_sprint',
          message: `${facts.label} is ${facts.sprint === undefined ? 'in no sprint' : `in Sprint ${facts.sprint.ordinal}`}, not in Sprint ${facts.placement.active.ordinal}, so it is not a leftover of that sprint.`
        }
]

function leftoverSkip(bundle: PlanBundle, request: RedraftRequest, placement: Placement, ticketId: string): Skip | null {
  const facts: LeftoverFacts = {
    ticket: bundle.tickets.find((ticket) => ticket.id === ticketId),
    label: keyOf(bundle, request, ticketId),
    placement,
    sprint: sprintOfTicket(bundle, ticketId),
    accepted: request.accepted.has(ticketId)
  }
  for (const check of LEFTOVER_CHECKS) {
    const skip = check(facts)
    if (skip !== null) {
      return skip
    }
  }
  return null
}

/** Sorts the retro's leftovers into those that move and those that are skipped; a ticket listed twice counts once. */
function planLeftovers(bundle: PlanBundle, request: RedraftRequest, placement: Placement): LeftoverPlan {
  const seen = new Set<string>()
  const plan: LeftoverPlan = { moving: [], skipped: [] }
  for (const item of request.leftovers) {
    if (seen.has(item.ticket)) {
      continue
    }
    seen.add(item.ticket)
    const skip = leftoverSkip(bundle, request, placement, item.ticket)
    if (skip === null) {
      plan.moving.push(item)
    } else {
      plan.skipped.push({ kind: 'leftover', ticketId: item.ticket, label: keyOf(bundle, request, item.ticket), ...skip })
    }
  }
  return plan
}

// ---------------------------------------------------------------------------------------------
// What moves along with them

/** The first ticket of the active sprint, not moving yet and not an acceptance node, that requires a moving ticket. */
function nextDependent(
  bundle: PlanBundle,
  active: SprintDef,
  moving: ReadonlySet<string>
): { ticket: TicketContent; requires: string } | null {
  const byId = new Map(bundle.tickets.map((ticket) => [ticket.id, ticket]))
  for (const id of active.ticketIds) {
    const ticket = byId.get(id)
    if (ticket === undefined || moving.has(id) || isAcceptanceTicket(ticket)) {
      continue
    }
    const edge = bundle.edges.find((item) => item.to === id && moving.has(item.from))
    if (edge !== undefined) {
      return { ticket, requires: edge.from }
    }
  }
  return null
}

/**
 * The tickets of the active sprint that require a moving ticket, and those that require them in turn: they
 * can't stay behind, because a prerequisite must be in the same sprint or an earlier one. An acceptance node
 * never moves; its sprint's explicit dependencies on moved tickets are dropped instead, since it requires
 * every required ticket of its sprint without them.
 */
function planMoves(bundle: PlanBundle, request: RedraftRequest, active: SprintDef, leftovers: string[]): MovePlan {
  const moving = new Set(leftovers)
  const along: RedraftDependentView[] = []
  for (let found = nextDependent(bundle, active, moving); found !== null; found = nextDependent(bundle, active, moving)) {
    moving.add(found.ticket.id)
    const requires = keyOf(bundle, request, found.requires)
    along.push({ ticketId: found.ticket.id, key: found.ticket.key, title: found.ticket.title, requires })
  }
  const staying = new Set(acceptanceNodesOf(bundle, active.id).map((node) => node.id))
  const place = (view: RedraftDependentView): number => active.ticketIds.indexOf(view.ticketId)
  return {
    ids: active.ticketIds.filter((id) => moving.has(id)),
    dependents: along.sort((a, b) => place(a) - place(b)),
    dropped: bundle.edges.filter((edge) => moving.has(edge.from) && staying.has(edge.to))
  }
}

/** Takes the ids out of the active sprint and puts them, in that order, ahead of the next sprint's acceptance node. */
function moveTickets(bundle: PlanBundle, route: { from: string; to: string }, plan: MovePlan): void {
  const target = bundle.sprints.find((sprint) => sprint.id === route.to)
  const source = bundle.sprints.find((sprint) => sprint.id === route.from)
  if (target === undefined || source === undefined) {
    return
  }
  const moving = new Set(plan.ids)
  source.ticketIds = source.ticketIds.filter((id) => !moving.has(id))
  const nodes = new Set(acceptanceNodesOf(bundle, target.id).map((node) => node.id))
  const first = target.ticketIds.findIndex((id) => nodes.has(id))
  const at = first === -1 ? target.ticketIds.length : first
  target.ticketIds = [...target.ticketIds.slice(0, at), ...plan.ids, ...target.ticketIds.slice(at)]
  bundle.edges = bundle.edges.filter((edge) => !plan.dropped.some((gone) => gone.from === edge.from && gone.to === edge.to))
}

// ---------------------------------------------------------------------------------------------
// Discoveries

function planDiscoveries(bundle: PlanBundle, request: RedraftRequest): DiscoveryPlan {
  /** Folded title -> the key of the ticket that has it, or null for a discovery added in this pass. */
  const taken = new Map<string, string | null>()
  for (const ticket of bundle.tickets.filter((item) => !isAcceptanceTicket(item))) {
    taken.set(ticket.title.trim().toLowerCase(), taken.get(ticket.title.trim().toLowerCase()) ?? ticket.key)
  }
  const plan: DiscoveryPlan = { adding: [], skipped: [] }
  for (const item of request.discoveries) {
    const title = item.title.trim()
    const skip = discoverySkip(title, taken)
    if (skip === null) {
      taken.set(title.toLowerCase(), null)
      const source = item.ticket === null ? null : keyOf(bundle, request, item.ticket)
      plan.adding.push({ title, body: item.body, source })
    } else {
      plan.skipped.push({ kind: 'discovery', ticketId: null, label: title, ...skip })
    }
  }
  return plan
}

function discoverySkip(title: string, taken: ReadonlyMap<string, string | null>): Skip | null {
  if (title === '') {
    return { code: 'blank_title', message: 'The discovery has no title.' }
  }
  const holder = taken.get(title.toLowerCase())
  if (holder === undefined) {
    return null
  }
  const who = holder === null ? 'An earlier discovery of this retro' : holder
  return { code: 'already_drafted', message: `${who} already has the title "${title}".` }
}

function sourceReference(key: string): TicketReference {
  return { kind: 'ticket', label: key, location: key, hash: null, remoteOnly: false }
}

/** The client ref a discovery's ticket is declared under, to read its stable id back from the result. */
function refOf(position: number): string {
  return `discovery${position}`
}

function addTicketOps(sprintId: string, adding: NewTicket[]): DraftOp[] {
  return adding.map((item, position) => ({
    op: 'add_ticket' as const,
    ref: refOf(position),
    sprint: sprintId,
    ticket: { title: item.title, body: item.body, references: item.source === null ? [] : [sourceReference(item.source)] }
  }))
}

// ---------------------------------------------------------------------------------------------
// The pass

function sprintGoal(active: SprintDef): string {
  return `Finish what Sprint ${active.ordinal} left over and take up what it found.`
}

function movedViews(bundle: PlanBundle, leftovers: RetroLeftover[]): RedraftMovedView[] {
  const byId = new Map(bundle.tickets.map((ticket) => [ticket.id, ticket]))
  return leftovers.flatMap((item) => {
    const ticket = byId.get(item.ticket)
    return ticket === undefined ? [] : [{ ticketId: ticket.id, key: ticket.key, title: ticket.title, reason: item.reason }]
  })
}

function addedViews(bundle: PlanBundle, ids: string[], adding: NewTicket[]): RedraftAddedView[] {
  return ids.flatMap((id, position) => {
    const ticket = bundle.tickets.find((item) => item.id === id)
    return ticket === undefined ? [] : [{ ticketId: id, key: ticket.key, title: ticket.title, source: adding[position]?.source ?? null }]
  })
}

function ordinalOf(bundle: PlanBundle, sprintId: string | null): number | null {
  return bundle.sprints.find((sprint) => sprint.id === sprintId)?.ordinal ?? null
}

interface Plans {
  leftovers: LeftoverPlan
  moves: MovePlan
  discoveries: DiscoveryPlan
}

function planPass(bundle: PlanBundle, request: RedraftRequest, placement: Placement): Plans {
  const leftovers = planLeftovers(bundle, request, placement)
  const moves = planMoves(bundle, request, placement.active, leftovers.moving.map((item) => item.ticket))
  return { leftovers, moves, discoveries: planDiscoveries(bundle, request) }
}

/** What the pass left alone: its skips, except a leftover that a moving ticket pulled along after all. */
function skippedOf(plans: Plans): RedraftSkippedView[] {
  const pulled = new Set(plans.moves.dependents.map((item) => item.ticketId))
  const leftovers = plans.leftovers.skipped.filter((item) => !pulled.has(item.ticketId ?? ''))
  return [...leftovers, ...plans.discoveries.skipped]
}

/** What a pass built: the bundle so far, the sprint that receives what moves and what is added, and the ids of the added tickets. */
interface Built {
  bundle: PlanBundle
  nextId: string | null
  addedIds: string[]
}

/** The sprint after the active one, added with its acceptance node right after the active sprint. */
function withNextSprint(built: Built, active: SprintDef, deps: DraftDeps): Built {
  const op: DraftOp = { op: 'add_sprint', ref: 'next', sprint: { goal: sprintGoal(active) }, position: active.ordinal + 1 }
  const result = applyDraftOps(built.bundle, [op], deps)
  return { ...built, bundle: result.bundle, nextId: result.refMap['next'] ?? null }
}

function withDiscoveries(built: Built, adding: NewTicket[], deps: DraftDeps): Built {
  if (built.nextId === null || adding.length === 0) {
    return built
  }
  const result = applyDraftOps(built.bundle, addTicketOps(built.nextId, adding), deps)
  return { ...built, bundle: result.bundle, addedIds: adding.map((_item, position) => result.refMap[refOf(position)] ?? '') }
}

interface Route {
  active: SprintDef
  next: SprintDef | null
  deps: DraftDeps
}

/** Carries the plans out on a bundle that is the pass's own copy. */
function build(bundle: PlanBundle, plans: Plans, route: Route): Built {
  const work = plans.moves.ids.length + plans.discoveries.adding.length
  let built: Built = { bundle, nextId: route.next?.id ?? null, addedIds: [] }
  if (work > 0 && route.next === null) {
    built = withNextSprint(built, route.active, route.deps)
  }
  if (built.nextId !== null && plans.moves.ids.length > 0) {
    moveTickets(built.bundle, { from: route.active.id, to: built.nextId }, plans.moves)
  }
  return withDiscoveries(built, plans.discoveries.adding, route.deps)
}

/**
 * Applies the retro to a copy of the draft's bundle. Refuses with `conflict` when the retro's sprint is not in
 * the draft. Adds a sprint (and its acceptance node) only when something has to go in it.
 */
export function redraftBundle(input: PlanBundle, request: RedraftRequest, deps: DraftDeps): RedraftOutcome {
  const bundle = cloneBundle(input)
  const sprints = sortedSprints(bundle)
  const position = sprints.findIndex((sprint) => sprint.id === request.sprintId)
  const active = sprints[position]
  if (active === undefined) {
    fail('conflict', `Sprint ${request.sprintId} is not in the draft any more, so its retro can't be applied to it.`, {
      sprintId: request.sprintId
    })
  }
  const next = sprints[position + 1] ?? null
  const plans = planPass(bundle, request, { active, next })
  const built = build(bundle, plans, { active, next, deps })
  const changed = plans.moves.ids.length + plans.discoveries.adding.length > 0
  return {
    bundle: built.bundle,
    changed,
    changes: {
      sprintId: active.id,
      sprintOrdinal: ordinalOf(built.bundle, active.id) ?? active.ordinal,
      nextSprintId: built.nextId,
      nextSprintOrdinal: ordinalOf(built.bundle, built.nextId),
      sprintAdded: changed && next === null,
      moved: movedViews(built.bundle, plans.leftovers.moving),
      dependentsMoved: plans.moves.dependents,
      added: addedViews(built.bundle, built.addedIds, plans.discoveries.adding),
      skipped: skippedOf(plans),
      droppedDependencies: plans.moves.dropped
    }
  }
}
